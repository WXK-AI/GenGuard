/**
 * NER Detector — tokenize text, run ORT inference, merge BIO tags into entity spans.
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

/**
 * Step 1: Build word-level predictions.
 * Each word (unique wordId) aggregates ALL of its subwords:
 *   - For each label seen across the word's subwords, sum their confidences
 *   - Pick the label with the highest summed confidence as the word's label
 *   - The word's confidence = max subword confidence for that winning label
 *     (more discriminating than averaging across all subwords, which dilutes
 *     strong evidence with weak continuation tokens)
 *   - startOffset from the first subword, endOffset from the last subword
 *
 * This is more accurate than the previous "first subword wins" approach,
 * which tended to mislabel words whose first subword was an ambiguous prefix
 * (e.g. "Ahmad" tokenized as "▁Ah" + "mad" — "▁Ah" alone is uninformative).
 */
interface WordPrediction {
  wordId: number;
  label: string;
  confidence: number;
  startOffset: number;
  endOffset: number;
}

interface WordAccumulator {
  wordId: number;
  startOffset: number;
  endOffset: number;
  // labelScores[label] = { sumConf, maxConf } across all subwords of this word
  labelScores: Map<string, { sumConf: number; maxConf: number }>;
}

function buildWordPredictions(
  predictions: Array<{ wordId: number | null; label: string; confidence: number }>,
  encoded: EncodeResult,
): WordPrediction[] {
  const wordMap = new Map<number, WordAccumulator>();

  for (let i = 0; i < predictions.length; i++) {
    const { wordId, label, confidence } = predictions[i];
    if (wordId === null) continue;

    const [start, end] = encoded.offsets[i];

    let acc = wordMap.get(wordId);
    if (!acc) {
      acc = {
        wordId,
        startOffset: start,
        endOffset: end,
        labelScores: new Map(),
      };
      wordMap.set(wordId, acc);
    } else {
      if (start < acc.startOffset) acc.startOffset = start;
      if (end > acc.endOffset) acc.endOffset = end;
    }

    const existing = acc.labelScores.get(label);
    if (existing) {
      existing.sumConf += confidence;
      if (confidence > existing.maxConf) existing.maxConf = confidence;
    } else {
      acc.labelScores.set(label, { sumConf: confidence, maxConf: confidence });
    }
  }

  // Resolve each accumulator into a single WordPrediction by picking the
  // label with the highest summed confidence (== majority-vote weighted by
  // model confidence). Use the max subword confidence for that winning label.
  const out: WordPrediction[] = [];
  for (const acc of wordMap.values()) {
    let bestLabel = 'O';
    let bestSum = -Infinity;
    let bestMax = 0;
    for (const [label, score] of acc.labelScores) {
      if (score.sumConf > bestSum) {
        bestSum = score.sumConf;
        bestLabel = label;
        bestMax = score.maxConf;
      }
    }
    out.push({
      wordId: acc.wordId,
      label: bestLabel,
      confidence: bestMax,
      startOffset: acc.startOffset,
      endOffset: acc.endOffset,
    });
  }

  // Return sorted by wordId (preserves order)
  return out.sort((a, b) => a.wordId - b.wordId);
}

/**
 * Step 2: BIO merge on word-level predictions.
 */
function mergeEntities(
  predictions: Array<{ wordId: number | null; label: string; confidence: number }>,
  encoded: EncodeResult,
  originalText: string,
  confidenceThreshold: number,
): Finding[] {
  const words = buildWordPredictions(predictions, encoded);
  const findings: Finding[] = [];

  let currentEntity: {
    type: string;
    startOffset: number;
    endOffset: number;
    confidences: number[];
  } | null = null;

  for (const wp of words) {
    const { label, confidence, startOffset, endOffset } = wp;

    if (label.startsWith('B-')) {
      if (currentEntity) pushEntity(currentEntity, findings, originalText, confidenceThreshold);
      currentEntity = {
        type: label.slice(2),
        startOffset,
        endOffset,
        confidences: [confidence],
      };
    } else if (label.startsWith('I-')) {
      const entityType = label.slice(2);
      if (currentEntity && entityType === currentEntity.type) {
        // Extend current entity
        currentEntity.endOffset = endOffset;
        currentEntity.confidences.push(confidence);
      } else {
        // I-X without matching B-X or type mismatch — start new entity
        if (currentEntity) pushEntity(currentEntity, findings, originalText, confidenceThreshold);
        currentEntity = {
          type: entityType,
          startOffset,
          endOffset,
          confidences: [confidence],
        };
      }
    } else {
      // O label
      if (currentEntity) {
        pushEntity(currentEntity, findings, originalText, confidenceThreshold);
        currentEntity = null;
      }
    }
  }

  if (currentEntity) pushEntity(currentEntity, findings, originalText, confidenceThreshold);

  return findings;
}

function pushEntity(
  entity: { type: string; startOffset: number; endOffset: number; confidences: number[] },
  findings: Finding[],
  originalText: string,
  confidenceThreshold: number,
): void {
  const avgConfidence = entity.confidences.reduce((a, b) => a + b, 0) / entity.confidences.length;

  if (avgConfidence < confidenceThreshold) return;

  const value = originalText.slice(entity.startOffset, entity.endOffset);
  if (value.trim().length === 0) return;

  const severity = NER_MODEL_CONTRACT.severityMap[entity.type as NEREntityType] ?? 'medium';

  findings.push({
    type: entity.type,
    value,
    startIndex: entity.startOffset,
    endIndex: entity.endOffset,
    confidence: Math.round(avgConfidence * 1000) / 1000,
    severity,
    source: 'ner',
  });
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
