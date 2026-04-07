/**
 * Image OCR — extracts text from images using PaddleOCR PP-OCRv5 (ONNX).
 *
 * Delegates to the OCR pipeline when sessions are loaded; falls back to an
 * empty result with a console warning when the OCR models haven't been
 * downloaded yet (graceful degradation).
 */

import { isOcrReady } from './ocr/ocr-engine';
import { extractTextFromImageOrt } from './ocr/ocr-pipeline';

export interface OcrResult {
  text: string;
  timeMs: number;
  source: 'ocr';
}

/** Convert an image File to a data URL (kept for callers that still need it). */
export async function imageToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Extract text from an image. Uses the PP-OCRv5 pipeline when available;
 * returns empty text otherwise (so the engine can still scan other inputs).
 */
export async function extractTextFromImage(file: File): Promise<OcrResult> {
  if (!isOcrReady()) {
    console.warn('[GenGuard] OCR models not loaded — image text extraction skipped');
    return { text: '', timeMs: 0, source: 'ocr' };
  }
  return extractTextFromImageOrt(file);
}
