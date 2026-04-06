/**
 * Image OCR — extracts text from images using canvas + basic approach.
 *
 * For a full OCR solution, PaddleOCR PP-OCRv5 would be used.
 * This module provides image-to-data-url conversion for future OCR integration,
 * and a placeholder that returns empty text.
 *
 * TODO: Integrate PaddleOCR PP-OCRv5 ONNX models for real OCR.
 */

export interface OcrResult {
  text: string;
  timeMs: number;
  source: 'ocr';
}

/**
 * Convert an image File to a data URL for processing.
 */
export async function imageToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * Placeholder OCR — returns empty text.
 * Will be replaced with PaddleOCR integration.
 */
export async function extractTextFromImage(_file: File): Promise<OcrResult> {
  const t0 = performance.now();
  // TODO: PaddleOCR PP-OCRv5 integration
  // For now, return empty — regex/NER won't find anything without text
  console.warn('[GenGuard] OCR not yet implemented — image text extraction skipped');
  return {
    text: '',
    timeMs: Math.round(performance.now() - t0),
    source: 'ocr',
  };
}
