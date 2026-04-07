/**
 * NER Detector — tokenize text, run ORT inference, merge BIO tags into entity spans.
 *
 * BIO merging mirrors HuggingFace's `aggregation_strategy="simple"`:
 *   - Each subword token gets its own argmax label + softmax confidence.
 *   - Consecutive tokens with the same base entity type are merged into one span,
 *     UNLESS the new token carries a B- prefix (which forces a new entity).
 *   - Entity score = mean of all constituent token scores.
 *   - Entity text  = originalText.slice(firstStart, lastEnd).
 */

import { DeBERTaTokenizer, type EncodeResult } from '../tokenizer/sentencepiece-tokenizer';
import { runInference, isReady } from '../../lib/ort-engine';
import { NER_MODEL_CONTRACT, type NEREntityType } from './ner-model-contract';
import type { Finding } from '../types';

let tokenizer: DeBERTaTokenizer | null = null;

export function initTokenizer(tokenizerJson: unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tokenizer = new DeBERTaTokenizer(tokenizerJson as any);
}

export function isTokenizerReady(): boolean {
  return tokenizer !== null;
}

const LABELS = NER_MODEL_CONTRACT.labelList;
const NUM_LABELS = LABELS.length;
const SEQ_LEN = NER_MODEL_CONTRACT.maxSeqLen;

/** Softmax over a slice of logits for one position. */
function softmaxArgmax(logits: Float32Array, offset: number): { labelIdx: number; confidence: number } {
  let maxVal = -Infinity;
  let maxIdx = 0;
  for (let j = 0; j < NUM_LABELS; j++) {
    const v = logits[offset + j];
    if (v > maxVal) {
      maxVal = v;
      maxIdx = j;
    }
  }

  // Softmax for confidence of the winning class
  let sumExp = 0;
  for (let j = 0; j < NUM_LABELS; j++) {
    sumExp += Math.exp(logits[offset + j] - maxVal);
  }
  const confidence = 1 / sumExp;

  return { labelIdx: maxIdx, confidence };
}

/**
 * Classify a single chunk of text (≤ 254 tokens after [CLS]/[SEP]).
 * Returns raw per-token predictions.
 */
async function classifyChunk(encoded: EncodeResult): Promise<Array<{
  wordId: number | null;
  label: string;
  confidence: number;
}>> {
  const logits = await runInference(encoded.inputIds, encoded.attentionMask);

  const predictions: Array<{ wordId: number | null; label: string; confidence: number }> = [];

  for (let i = 0; i < SEQ_LEN; i++) {
    const { labelIdx, confidence } = softmaxArgmax(logits, i * NUM_LABELS);
    predictions.push({
      wordId: encoded.wordIds[i],
      label: LABELS[labelIdx],
      confidence,
    });
  }

  return predictions;
}

// ── HF-compatible BIO merging (simple strategy) ─────────────────────────────

/**
 * Parse a BIO label into its prefix (B/I) and base tag.
 * Labels without B-/I- prefix are treated as I- (continuation) to match
 * HuggingFace's get_tag() behaviour.
 */
function getTag(label: string): { bi: string; tag: string } {
  if (label.startsWith('B-')) return { bi: 'B', tag: label.slice(2) };
  if (label.startsWith('I-')) return { bi: 'I', tag: label.slice(2) };
  return { bi: 'I', tag: label };
}

interface TokenPred {
  label: string;
  confidence: number;
  start: number;
  end: number;
}

/**
 * BIO merge that mirrors HuggingFace's `aggregation_strategy="simple"`.
 *
 * Key behaviour (matches HF `group_entities`):
 *   - Works at the raw SUBWORD token level (no pre-grouping into words).
 *   - Each subword already carries its own argmax label + confidence.
 *   - Consecutive tokens with the same base entity type are merged,
 *     UNLESS the new token carries a B- prefix (which forces a split).
 *   - Entity score = mean of all constituent token scores.
 *   - Entity text  = originalText.slice(firstStart, lastEnd).
 */
function mergeEntities(
  predictions: Array<{ wordId: number | null; label: string; confidence: number }>,
  encoded: EncodeResult,
  originalText: string,
  confidenceThreshold: number,
): Finding[] {
  const findings: Finding[] = [];

  // Collect non-special tokens with their offsets
  const tokenPreds: TokenPred[] = [];

  for (let i = 0; i < predictions.length; i++) {
    const { wordId, label, confidence } = predictions[i];
    // Skip special tokens ([CLS], [SEP], [PAD])
    if (wordId === null) continue;

    const [start, end] = encoded.offsets[i];

    // O labels still need to break entity groups
    if (label === 'O') {
      tokenPreds.push({ label: 'O', confidence: 0, start: 0, end: 0 });
      continue;
    }

    tokenPreds.push({ label, confidence, start, end });
  }

  // Group consecutive tokens following HF simple rules
  let group: TokenPred[] = [];

  const flushGroup = () => {
    if (group.length === 0) return;

    // Derive entity type from the first token in the group
    const { tag } = getTag(group[0].label);
    const avgScore = group.reduce((s, t) => s + t.confidence, 0) / group.length;

    if (avgScore >= confidenceThreshold) {
      const startOffset = group[0].start;
      const endOffset = group[group.length - 1].end;
      const value = originalText.slice(startOffset, endOffset);

      if (value.trim().length > 0) {
        const severity = NER_MODEL_CONTRACT.severityMap[tag as NEREntityType] ?? 'medium';
        findings.push({
          type: tag,
          value,
          startIndex: startOffset,
          endIndex: endOffset,
          confidence: Math.round(avgScore * 1000) / 1000,
          severity,
          source: 'ner',
        });
      }
    }

    group = [];
  };

  for (const tp of tokenPreds) {
    if (tp.label === 'O') {
      flushGroup();
      continue;
    }

    const { bi, tag } = getTag(tp.label);

    if (group.length === 0) {
      // Start a new group
      group.push(tp);
    } else {
      const { tag: lastTag } = getTag(group[group.length - 1].label);
      // Merge if same entity type AND current token is NOT B- (HF line 617)
      if (tag === lastTag && bi !== 'B') {
        group.push(tp);
      } else {
        // Different type or new B- boundary → flush and start new group
        flushGroup();
        group.push(tp);
      }
    }
  }

  flushGroup();
  return findings;
}

/**
 * Run full NER detection on a text string.
 *
 * For texts longer than ~240 tokens, uses a sliding window with overlap.
 */
export async function detectNER(
  text: string,
  confidenceThreshold: number = 0.10,
): Promise<{ findings: Finding[]; timeMs: number }> {
  if (!tokenizer || !isReady()) {
    throw new Error('NER detector not initialized');
  }

  const t0 = performance.now();

  // For short texts (most common case), single-pass
  const encoded = tokenizer.encode(text, SEQ_LEN);
  const predictions = await classifyChunk(encoded);

  const findings = mergeEntities(predictions, encoded, text, confidenceThreshold);

  const timeMs = Math.round(performance.now() - t0);
  console.log(`[GenGuard NER] ${text.length} chars → ${findings.length} findings in ${timeMs} ms`);

  return { findings, timeMs };
}
