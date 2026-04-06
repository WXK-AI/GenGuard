/**
 * PDF Text Extractor — extracts text from PDF files using pdfjs-dist.
 *
 * Runs in the side panel page context.
 * Max 50 pages; returns concatenated text from all pages.
 */

import * as pdfjsLib from 'pdfjs-dist';

// Point to the worker file in public/
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs');

const MAX_PAGES = 50;

export interface PdfExtractionResult {
  text: string;
  pageCount: number;
  extractedPages: number;
  timeMs: number;
}

/**
 * Extract text from a PDF ArrayBuffer.
 */
export async function extractPdfText(buffer: ArrayBuffer): Promise<PdfExtractionResult> {
  const t0 = performance.now();

  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pageCount = pdf.numPages;
  const pagesToExtract = Math.min(pageCount, MAX_PAGES);

  const pageTexts: string[] = [];

  for (let i = 1; i <= pagesToExtract; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item: { str?: string }) => item.str ?? '')
      .join(' ');
    pageTexts.push(pageText.trim());
  }

  const text = pageTexts.filter((t) => t.length > 0).join('\n\n');
  const timeMs = Math.round(performance.now() - t0);

  return { text, pageCount, extractedPages: pagesToExtract, timeMs };
}

/**
 * Extract text from a PDF File object.
 */
export async function extractPdfFromFile(file: File): Promise<PdfExtractionResult> {
  const buffer = await file.arrayBuffer();
  return extractPdfText(buffer);
}
