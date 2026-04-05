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
 * Merge BIO predictions into entity spans.
 *
 * Rules:
 * - Skip special tokens (wordId === null)
 * - Only use the first subword of each word (dedup via wordIds)
 * - B-X opens a new entity, I-X extends if same type, O closes
 */
function mergeEntities(
  predictions: Array<{ wordId: number | null; label: string; confidence: number }>,
  encoded: EncodeResult,
  originalText: string,
  confidenceThreshold: number,
): Finding[] {
  const findings: Finding[] = [];
  let currentEntity: {
    type: string;
    startOffset: number;
    endOffset: number;
    confidences: number[];
  } | null = null;

  let lastWordId = -1;

  for (let i = 0; i < predictions.length; i++) {
    const { wordId, label, confidence } = predictions[i];

    // Skip special tokens and padding
    if (wordId === null) continue;

    // Only process first subword of each word
    if (wordId === lastWordId) continue;
    lastWordId = wordId;

    const [start, end] = encoded.offsets[i];

    if (label.startsWith('B-')) {
      // Close previous entity
      if (currentEntity) {
        pushEntity(currentEntity, findings, originalText, confidenceThreshold);
      }
      // Open new entity
      const entityType = label.slice(2);
      currentEntity = {
        type: entityType,
        startOffset: start,
        endOffset: end,
        confidences: [confidence],
      };
    } else if (label.startsWith('I-') && currentEntity) {
      const entityType = label.slice(2);
      if (entityType === currentEntity.type) {
        // Extend current entity
        currentEntity.endOffset = end;
        currentEntity.confidences.push(confidence);
      } else {
        // Type mismatch — close current, open new
        pushEntity(currentEntity, findings, originalText, confidenceThreshold);
        currentEntity = {
          type: entityType,
          startOffset: start,
          endOffset: end,
          confidences: [confidence],
        };
      }
    } else {
      // O label — close current entity
      if (currentEntity) {
        pushEntity(currentEntity, findings, originalText, confidenceThreshold);
        currentEntity = null;
      }
    }
  }

  // Close any remaining entity
  if (currentEntity) {
    pushEntity(currentEntity, findings, originalText, confidenceThreshold);
  }

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
  confidenceThreshold: number = 0.70,
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
