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

// ── Word-level aggregation + BIO merging ────────────────────────────────────

/**
 * Parse a BIO label into its prefix (B/I) and base tag.
 */
function getTag(label: string): { bi: string; tag: string } {
  if (label.startsWith('B-')) return { bi: 'B', tag: label.slice(2) };
  if (label.startsWith('I-')) return { bi: 'I', tag: label.slice(2) };
  return { bi: 'I', tag: label };
}

interface WordPred {
  wordId: number;
  label: string;   // best non-O label (or 'O')
  confidence: number;
  start: number;    // char offset in original text
  end: number;
}

const ENTITY_CONFIDENCE_FLOORS: Partial<Record<NEREntityType, number>> = {
  ORG: 0.65,
  PERSON: 0.45,
  ADDRESS: 0.45,
};

/**
 * Step 1: Aggregate subword predictions → one prediction per word.
 *
 * For each wordId, collect all subword labels. Pick the dominant non-O label
 * (by summed confidence). If no non-O label, the word is O. The word's
 * confidence = max confidence among subwords that voted for the winning label.
 * The word's char span covers all its subwords.
 */
function aggregateToWords(
  predictions: Array<{ wordId: number | null; label: string; confidence: number }>,
  encoded: EncodeResult,
): WordPred[] {
  const wordMap = new Map<number, {
    start: number;
    end: number;
    labelScores: Map<string, { sum: number; max: number; bi: string }>;
  }>();

  for (let i = 0; i < predictions.length; i++) {
    const { wordId, label, confidence } = predictions[i];
    if (wordId === null) continue;

    const [start, end] = encoded.offsets[i];

    let acc = wordMap.get(wordId);
    if (!acc) {
      acc = { start, end, labelScores: new Map() };
      wordMap.set(wordId, acc);
    } else {
      if (start < acc.start) acc.start = start;
      if (end > acc.end) acc.end = end;
    }

    // Track scores per base tag (strip B-/I- prefix for grouping)
    const { bi, tag } = getTag(label);
    const key = label === 'O' ? 'O' : tag;
    const existing = acc.labelScores.get(key);
    if (existing) {
      existing.sum += confidence;
      if (confidence > existing.max) existing.max = confidence;
      // Keep the first B- prefix seen for this tag
    } else {
      acc.labelScores.set(key, { sum: confidence, max: confidence, bi });
    }
  }

  // Convert to sorted array
  const words: WordPred[] = [];
  for (const [wordId, acc] of wordMap) {
    // Pick best non-O label by summed confidence
    let bestTag = 'O';
    let bestSum = -Infinity;
    let bestMax = 0;
    let bestBi = 'B';
    for (const [tag, score] of acc.labelScores) {
      if (tag === 'O') continue;
      if (score.sum > bestSum) {
        bestSum = score.sum;
        bestTag = tag;
        bestMax = score.max;
        bestBi = score.bi;
      }
    }

    if (bestTag === 'O') {
      words.push({ wordId, label: 'O', confidence: 0, start: acc.start, end: acc.end });
    } else {
      words.push({
        wordId,
        label: `${bestBi}-${bestTag}`,
        confidence: bestMax,
        start: acc.start,
        end: acc.end,
      });
    }
  }

  return words.sort((a, b) => a.wordId - b.wordId);
}

/**
 * Step 2: BIO merge on word-level predictions → entity spans.
 *
 * Consecutive words with the same base entity type are merged into one Finding.
 * A B- prefix forces a new entity. Adjacent same-type words (even if both B-)
 * are merged when separated only by whitespace.
 */
function mergeEntities(
  predictions: Array<{ wordId: number | null; label: string; confidence: number }>,
  encoded: EncodeResult,
  originalText: string,
  confidenceThreshold: number,
): Finding[] {
  const words = aggregateToWords(predictions, encoded);
  const findings: Finding[] = [];

  let group: WordPred[] = [];

  const flushGroup = () => {
    if (group.length === 0) return;

    const { tag } = getTag(group[0].label);
    const avgScore = group.reduce((s, w) => s + w.confidence, 0) / group.length;

    const entityThreshold = Math.max(
      confidenceThreshold,
      ENTITY_CONFIDENCE_FLOORS[tag as NEREntityType] ?? confidenceThreshold,
    );

    if (avgScore >= entityThreshold) {
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

  for (const wp of words) {
    if (wp.label === 'O') {
      flushGroup();
      continue;
    }

    const { tag } = getTag(wp.label);

    if (group.length === 0) {
      group.push(wp);
    } else {
      const { tag: lastTag } = getTag(group[group.length - 1].label);

      if (tag === lastTag) {
        // Same type — merge regardless of B/I prefix
        // (model often emits B- for every word in a multi-word name)
        group.push(wp);
      } else {
        flushGroup();
        group.push(wp);
      }
    }
  }

  flushGroup();
  return findings;
}

/**
 * Merge adjacent findings of the same type when they are separated only by
 * whitespace (or directly adjacent).  This handles the common case where the
 * model emits B-PERSON for every word in a multi-word name instead of using
 * I-PERSON continuations.
 */
function mergeAdjacentFindings(findings: Finding[], originalText: string): Finding[] {
  if (findings.length <= 1) return findings;

  const merged: Finding[] = [findings[0]];
  for (let i = 1; i < findings.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = findings[i];

    // Same entity type AND the gap between them is only whitespace (or no gap)
    const gap = originalText.slice(prev.endIndex, curr.startIndex);
    if (curr.type === prev.type && /^\s*$/.test(gap)) {
      // Compute weighted average BEFORE extending
      const prevLen = prev.value.length;
      const currLen = curr.value.length;
      const totalLen = prevLen + currLen;
      prev.confidence = totalLen > 0
        ? Math.round(((prev.confidence * prevLen + curr.confidence * currLen) / totalLen) * 1000) / 1000
        : prev.confidence;
      // Extend the previous finding
      prev.endIndex = curr.endIndex;
      prev.value = originalText.slice(prev.startIndex, prev.endIndex);
    } else {
      merged.push(curr);
    }
  }
  return merged;
}

// ── Sliding window constants ────────────────────────────────────────────────

/** Usable tokens per chunk after [CLS] and [SEP]. */
const USABLE = SEQ_LEN - 2;
/** Overlap in tokens between consecutive windows. */
const STRIDE_OVERLAP = 48;
/** Advance per window. */
const STRIDE = USABLE - STRIDE_OVERLAP;

/** Yield to the event loop so the UI stays responsive during long scans. */
const yieldToUI = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Run full NER detection on a text string.
 *
 * For texts longer than one chunk, uses a sliding window with overlap so
 * that no token is left unprocessed.
 */
export async function detectNER(
  text: string,
  confidenceThreshold: number = 0.10,
): Promise<{ findings: Finding[]; timeMs: number }> {
  if (!tokenizer || !isReady()) {
    throw new Error('NER detector not initialized');
  }

  const t0 = performance.now();

  // Tokenize with a large limit to count real tokens without truncation
  const fullEncoded = tokenizer.encode(text, SEQ_LEN);
  // If the tokenizer filled all USABLE slots, the text was likely truncated
  const realTokenCount = fullEncoded.wordIds.filter(w => w !== null).length;
  const needsSliding = realTokenCount >= USABLE;

  // Short text → single pass (most common case)
  if (!needsSliding) {
    const predictions = await classifyChunk(fullEncoded);
    let findings = mergeEntities(predictions, fullEncoded, text, confidenceThreshold);
    findings = mergeAdjacentFindings(findings, text);
    const timeMs = Math.round(performance.now() - t0);
    console.log(`[GenGuard NER] ${text.length} chars → ${findings.length} findings in ${timeMs} ms`);
    return { findings, timeMs };
  }

  // Long text → sliding window over the raw text
  console.log(`[GenGuard NER] Long text (${text.length} chars, ≥${USABLE} tokens) — using sliding window`);
  const allFindings: Finding[] = [];
  const seenSpans = new Set<string>();
  let charStart = 0;
  let windowCount = 0;

  while (charStart < text.length) {
    // Take a generous char slice; the tokenizer will truncate to SEQ_LEN
    const charEnd = Math.min(text.length, charStart + USABLE * 5);
    const chunk = text.slice(charStart, charEnd);

    const encoded = tokenizer.encode(chunk, SEQ_LEN);
    const predictions = await classifyChunk(encoded);
    const chunkFindings = mergeEntities(predictions, encoded, chunk, confidenceThreshold);
    windowCount++;

    // Yield every 4 windows so the UI stays responsive
    if (windowCount % 4 === 0) await yieldToUI();

    // Adjust offsets back to the original text and dedupe
    for (const f of chunkFindings) {
      f.startIndex += charStart;
      f.endIndex += charStart;
      f.value = text.slice(f.startIndex, f.endIndex);
      const spanKey = `${f.type}:${f.startIndex}:${f.endIndex}`;
      if (!seenSpans.has(spanKey)) {
        seenSpans.add(spanKey);
        allFindings.push(f);
      }
    }

    // Advance: figure out how many chars the first STRIDE tokens covered
    let tokIdx = 0;
    let lastCharEnd = 0;
    for (let i = 0; i < encoded.offsets.length; i++) {
      if (encoded.wordIds[i] === null) continue;
      tokIdx++;
      if (tokIdx >= STRIDE) {
        lastCharEnd = encoded.offsets[i][1];
        break;
      }
    }

    if (lastCharEnd <= 0 || charStart + lastCharEnd >= text.length) break;
    charStart += lastCharEnd;
  }

  // Sort by position and merge adjacent same-type
  allFindings.sort((a, b) => a.startIndex - b.startIndex);
  const findings = mergeAdjacentFindings(allFindings, text);

  const timeMs = Math.round(performance.now() - t0);
  console.log(`[GenGuard NER] ${text.length} chars → ${findings.length} findings in ${timeMs} ms (${windowCount} windows)`);

  return { findings, timeMs };
}

// Exported for unit testing only
export const _testInternals = {
  softmaxArgmax,
  getTag,
  aggregateToWords,
  mergeEntities,
  mergeAdjacentFindings,
};
