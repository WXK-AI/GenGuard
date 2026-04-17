/**
 * Engine Orchestrator — merges regex + NER detection into a single RiskAssessment.
 *
 * Pipeline:
 * 1. Regex runs synchronously (< 50 ms)
 * 2. NER runs async via ORT
 * 3. For files: .txt → text pool, .pdf → PDF extractor, .docx → DOCX extractor, .jpg/.png → OCR
 * 4. Feed extracted text through regex + NER
 * 5. Merge all findings, score, return
 */

import { detectRegex } from './detectors/regex-detector';
import { detectNER, isTokenizerReady } from './detectors/ner-detector';
import { isReady as isOrtReady } from '../lib/ort-engine';
import { scoreFindings } from './detectors/context-scorer';
import { extractPdfFromFile } from './extractors/pdf-extractor';
import { extractDocxFromFile } from './extractors/docx-extractor';
import { extractTextFromImage } from './extractors/image-ocr';
import type { Finding, RiskAssessment, SourceGroup, GenGuardSettings } from './types';

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
  sourceGroups: [],
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
async function extractFileText(file: File): Promise<{ text: string; source: 'file' | 'pdf' | 'docx' | 'ocr' }> {
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

  // DOCX (Word 2007+). Note: legacy .doc (binary) is NOT supported.
  if (name.endsWith('.docx') ||
      type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const result = await extractDocxFromFile(file);
    console.log(`[GenGuard] DOCX extracted: ${result.text.length} chars in ${result.timeMs}ms`);
    if (result.warnings.length > 0) {
      console.debug(`[GenGuard] DOCX warnings for "${file.name}":`, result.warnings.slice(0, 5));
    }
    return { text: result.text, source: 'docx' };
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
 * Scan a single source and tag every finding with its inputSource label.
 */
async function scanSource(
  text: string,
  label: string,
  enableRegex: boolean,
  enableNer: boolean,
  nerThreshold: number,
): Promise<Finding[]> {
  const findings = await scanText(text, enableRegex, enableNer, nerThreshold);
  for (const f of findings) f.inputSource = label;
  return findings;
}

// ── Mutex: ORT WASM only supports one inference at a time ──────────────────

let _assessLock: Promise<void> = Promise.resolve();

/**
 * Run the full assessment pipeline on text + files.
 * Each input (textbox, each file) is scanned independently so findings are
 * properly attributed and NER context doesn't bleed across sources.
 * Serialized via a mutex because ORT WASM can't run concurrent sessions.
 */
export function assess(
  input: AssessInput,
  settings?: Partial<GenGuardSettings>,
): Promise<RiskAssessment> {
  // Chain onto the lock so only one assess() runs at a time
  const result = _assessLock.then(() => assessInner(input, settings));
  // Update the lock (swallow errors so the chain doesn't break)
  _assessLock = result.then(() => {}, () => {});
  return result;
}

async function assessInner(
  input: AssessInput,
  settings?: Partial<GenGuardSettings>,
): Promise<RiskAssessment> {
  const t0 = performance.now();

  const enableRegex = settings?.enableRegex ?? true;
  const enableNer = settings?.enableNer ?? true;
  const nerThreshold = settings?.nerConfidenceThreshold ?? 0.10;

  // Build a list of { text, label } sources to scan independently
  const sources: Array<{ text: string; label: string }> = [];

  const mainText = input.text?.trim() ?? '';
  if (mainText.length > 0) {
    sources.push({ text: mainText, label: 'Textbox' });
  }

  if (input.files && input.files.length > 0) {
    const extractions = await Promise.all(input.files.map(extractFileText));
    for (let i = 0; i < extractions.length; i++) {
      const { text } = extractions[i];
      if (text.trim().length > 0) {
        sources.push({ text: text.trim(), label: input.files[i].name });
      }
    }
  }

  if (sources.length === 0) {
    return { ...EMPTY_RESULT };
  }

  // Scan each source sequentially — ORT WASM doesn't support concurrent sessions
  const sourceResults: Finding[][] = [];
  for (const s of sources) {
    sourceResults.push(await scanSource(s.text, s.label, enableRegex, enableNer, nerThreshold));
  }

  // Build source groups and collect all findings
  const allFindings: Finding[] = [];
  const sourceGroups: SourceGroup[] = [];

  for (let i = 0; i < sources.length; i++) {
    const findings = sourceResults[i];
    allFindings.push(...findings);
    if (findings.length > 0 || sources.length > 1) {
      const scored = scoreFindings(findings, 0);
      sourceGroups.push({
        label: sources[i].label,
        findings,
        score: scored.score,
        level: scored.level,
      });
    }
  }

  const computeTimeMs = Math.round(performance.now() - t0);
  const result = scoreFindings(allFindings, computeTimeMs);
  result.sourceGroups = sourceGroups;
  return result;
}
