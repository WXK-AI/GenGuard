/**
 * DOCX Text Extractor — extracts plain text from Word (.docx) files using mammoth.js.
 *
 * Runs in the side panel page context. Fully client-side; no network calls.
 * mammoth.js reads the OOXML zip, walks the document tree, and returns raw text.
 *
 * Note: .doc (binary Word 97-2003) is NOT supported — only .docx.
 */

import mammoth from 'mammoth';

export interface DocxExtractionResult {
  text: string;
  timeMs: number;
  /** Non-fatal warnings from mammoth (e.g. unsupported styles). */
  warnings: string[];
}

/**
 * Extract text from a DOCX ArrayBuffer.
 */
export async function extractDocxText(buffer: ArrayBuffer): Promise<DocxExtractionResult> {
  const t0 = performance.now();

  const { value, messages } = await mammoth.extractRawText({ arrayBuffer: buffer });
  const warnings = messages.map((m) => `${m.type}: ${m.message}`);

  const timeMs = Math.round(performance.now() - t0);
  return { text: value ?? '', timeMs, warnings };
}

/**
 * Extract text from a DOCX File object.
 * Returns empty text on failure so a bad docx doesn't crash the full pipeline.
 */
export async function extractDocxFromFile(file: File): Promise<DocxExtractionResult> {
  try {
    const buffer = await file.arrayBuffer();
    return await extractDocxText(buffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[GenGuard] DOCX extraction failed for "${file.name}":`, msg);
    return { text: '', timeMs: 0, warnings: [msg] };
  }
}
