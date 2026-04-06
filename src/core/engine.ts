/**
 * Engine Orchestrator — merges regex + NER detection into a single RiskAssessment.
 *
 * Pipeline:
 * 1. Regex runs synchronously (< 50 ms)
 * 2. NER runs async via ORT
 * 3. For files: .txt → text pool, .pdf → PDF extractor, .jpg/.png → OCR
 * 4. Feed extracted text through regex + NER
 * 5. Merge all findings, score, return
 */

import { detectRegex } from './detectors/regex-detector';
import { detectNER, isTokenizerReady } from './detectors/ner-detector';
import { isReady as isOrtReady } from '../lib/ort-engine';
import { scoreFindings } from './detectors/context-scorer';
import { extractPdfFromFile } from './extractors/pdf-extractor';
import { extractTextFromImage } from './extractors/image-ocr';
import type { Finding, RiskAssessment, GenGuardSettings } from './types';

export interface AssessInput {
  text?: string;
  files?: File[];
}

const EMPTY_RESULT: RiskAssessment = {
  score: 0,
  level: 'Safe',
  findings: [],
  topRisks: [],
  suggestions: [],
  computeTimeMs: 0,
  breakdown: { regexCount: 0, nerCount: 0, ocrCount: 0 },
};

/**
 * Run regex + NER on a block of text, returning raw findings.
 */
async function scanText(
  text: string,
  enableRegex: boolean,
  enableNer: boolean,
  nerThreshold: number,
): Promise<Finding[]> {
  const findings: Finding[] = [];

  if (enableRegex) {
    const { findings: rf } = detectRegex(text);
    findings.push(...rf);
  }

  if (enableNer && isTokenizerReady() && isOrtReady()) {
    const { findings: nf } = await detectNER(text, nerThreshold);
    findings.push(...nf);
  }

  return findings;
}

/**
 * Extract text from a file based on its type.
 */
async function extractFileText(file: File): Promise<{ text: string; source: 'file' | 'pdf' | 'ocr' }> {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();

  // Plain text files
  if (name.endsWith('.txt') || name.endsWith('.csv') || name.endsWith('.json') ||
      name.endsWith('.md') || name.endsWith('.log') || type.startsWith('text/')) {
    const text = await file.text();
    return { text, source: 'file' };
  }

  // PDF
  if (name.endsWith('.pdf') || type === 'application/pdf') {
    const result = await extractPdfFromFile(file);
    console.log(`[GenGuard] PDF extracted: ${result.extractedPages}/${result.pageCount} pages in ${result.timeMs}ms`);
    return { text: result.text, source: 'pdf' };
  }

  // Images → OCR
  if (type.startsWith('image/') || /\.(jpe?g|png|gif|bmp|webp|tiff?)$/i.test(name)) {
    const result = await extractTextFromImage(file);
    return { text: result.text, source: 'ocr' };
  }

  // Unsupported type — skip
  console.warn(`[GenGuard] Unsupported file type: ${name} (${type})`);
  return { text: '', source: 'file' };
}

/**
 * Run the full assessment pipeline on text + files.
 */
export async function assess(
  input: AssessInput,
  settings?: Partial<GenGuardSettings>,
): Promise<RiskAssessment> {
  const t0 = performance.now();

  const enableRegex = settings?.enableRegex ?? true;
  const enableNer = settings?.enableNer ?? true;
  const nerThreshold = settings?.nerConfidenceThreshold ?? 0.10;

  const allFindings: Finding[] = [];
  const textPool: string[] = [];

  // Collect main text
  const mainText = input.text?.trim() ?? '';
  if (mainText.length > 0) textPool.push(mainText);

  // Extract text from files
  if (input.files && input.files.length > 0) {
    const extractions = await Promise.all(input.files.map(extractFileText));
    for (const { text } of extractions) {
      if (text.trim().length > 0) textPool.push(text.trim());
    }
  }

  // Nothing to scan
  if (textPool.length === 0) {
    return { ...EMPTY_RESULT };
  }

  // Scan all text blocks
  const fullText = textPool.join('\n\n');
  const findings = await scanText(fullText, enableRegex, enableNer, nerThreshold);
  allFindings.push(...findings);

  const computeTimeMs = Math.round(performance.now() - t0);
  return scoreFindings(allFindings, computeTimeMs);
}
