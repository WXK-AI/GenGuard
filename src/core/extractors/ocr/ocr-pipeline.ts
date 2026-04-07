/**
 * OCR Pipeline — orchestrates File → text extraction.
 *
 *   File
 *     → ImgData (RGBA via OffscreenCanvas)
 *     → preprocessForDetection → DetTensor
 *     → runDetection → prob map
 *     → extractBoxes → axis-aligned text boxes
 *     → preprocessForRecognition → batched [N,3,H,W] tensor
 *     → runRecognition → logits [N,T,C]
 *     → ctcGreedyDecodeBatch → strings
 *     → join with newlines
 */

import { imageFileToImgData, preprocessForDetection, preprocessForRecognition } from './preprocess';
import { extractBoxes } from './db-postprocess';
import { runDetection, runRecognition, isOcrReady, getDict } from './ocr-engine';
import { ctcGreedyDecodeBatch } from './ctc-decode';

export interface OcrResult {
  text: string;
  timeMs: number;
  source: 'ocr';
}

const EMPTY: OcrResult = { text: '', timeMs: 0, source: 'ocr' };

/**
 * Run the full OCR pipeline on an image File.
 * Returns empty text if OCR sessions aren't loaded.
 */
export async function extractTextFromImageOrt(file: File): Promise<OcrResult> {
  const t0 = performance.now();

  if (!isOcrReady()) {
    console.warn('[GenGuard] OCR sessions not initialized — skipping image');
    return { ...EMPTY };
  }

  try {
    // 1. Decode image
    const img = await imageFileToImgData(file);

    // 2. Detection
    const det = preprocessForDetection(img);
    const tDetStart = performance.now();
    const probMap = await runDetection(det.tensor, det.resizedH, det.resizedW);
    const tDetEnd = performance.now();

    // 3. Extract boxes
    const boxes = extractBoxes(probMap, det.resizedH, det.resizedW, det.scaleX, det.scaleY);

    if (boxes.length === 0) {
      const timeMs = Math.round(performance.now() - t0);
      console.log(`[GenGuard] OCR — no text boxes found (det: ${Math.round(tDetEnd - tDetStart)} ms)`);
      return { text: '', timeMs, source: 'ocr' };
    }

    // 4. Recognition (single batch — sufficient for typical screenshots)
    const { batch, keptBoxIndices } = preprocessForRecognition(img, boxes);
    if (batch.count === 0) {
      const timeMs = Math.round(performance.now() - t0);
      return { text: '', timeMs, source: 'ocr' };
    }

    const tRecStart = performance.now();
    const { logits, T, C } = await runRecognition(batch.data, batch.count, batch.height, batch.width);
    const tRecEnd = performance.now();

    // 5. CTC decode
    const decoded = ctcGreedyDecodeBatch(logits, batch.count, T, C, getDict());

    // 6. Join — boxes are already row-sorted
    const lines: string[] = [];
    for (let i = 0; i < decoded.length; i++) {
      const s = decoded[i].trim();
      if (s.length > 0) lines.push(s);
    }
    const text = lines.join('\n');

    const timeMs = Math.round(performance.now() - t0);
    console.log(
      `[GenGuard] OCR — det: ${Math.round(tDetEnd - tDetStart)} ms, rec: ${Math.round(tRecEnd - tRecStart)} ms, ` +
      `${boxes.length} boxes (${keptBoxIndices.length} recognized), ${text.length} chars, total: ${timeMs} ms`,
    );

    return { text, timeMs, source: 'ocr' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[GenGuard] OCR pipeline failed:', msg);
    return { ...EMPTY, timeMs: Math.round(performance.now() - t0) };
  }
}
