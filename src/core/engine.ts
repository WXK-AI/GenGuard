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
import { DEFAULT_NER_CONFIDENCE_THRESHOLD, type Finding, type RiskAssessment, type SourceGroup, type GenGuardSettings } from './types';

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

function stripHtmlToText(html: string): string {
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, style, noscript, template').forEach((el) => el.remove());
    return doc.body?.textContent ?? doc.documentElement.textContent ?? '';
  }

  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function normalizeOcrIdentifierToken(value: string): string {
  return value
    .replace(/[Oo]/g, '0')
    .replace(/[Il|!']/g, '1')
    .replace(/[Ss]/g, '5')
    .replace(/[Bb]/g, '8');
}

function formatNpwpDigits(digits: string): string {
  return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}.${digits.slice(8, 9)}-${digits.slice(9, 12)}.${digits.slice(12, 15)}`;
}

function formatIndonesianPhone(value: string): string | null {
  const digits = normalizeOcrIdentifierToken(value).replace(/\D/g, '');
  if (!digits.startsWith('62') || digits.length < 10 || digits.length > 15) return null;

  const local = digits.slice(2);
  if (local.length <= 3) return `+62 ${local}`;
  if (local.length <= 7) return `+62 ${local.slice(0, 3)} ${local.slice(3)}`;
  return `+62 ${local.slice(0, 3)} ${local.slice(3, 7)} ${local.slice(7)}`;
}

function hasStandaloneDigits(text: string, digits: string): boolean {
  return new RegExp(`(?<!\\d)${digits}(?!\\d)`).test(text);
}

function hasRawPostcodeContext(text: string, postcode: string): boolean {
  const match = new RegExp(`(?<!\\d)${postcode}(?!\\d)`).exec(text);
  if (!match) return false;
  const windowStart = Math.max(0, match.index - 80);
  const windowEnd = Math.min(text.length, match.index + postcode.length + 80);
  return /\b(?:poskod|postcode|zip|postal|kod\s?pos|alamat|address|kode?\s?pos)\b/i.test(text.slice(windowStart, windowEnd));
}

function normalizeOcrText(text: string): string {
  const normalizedLines: string[] = [];
  const compact = text.replace(/\s+/g, '');
  const upperCompact = compact.toUpperCase();
  const hasNikContext = /\bN[I1]?K\b|N[I1]?K[:：]?|NAMA.*N[I1]?K|NIK|NK/.test(upperCompact);

  if (hasNikContext) {
    for (const match of text.matchAll(/(?<!\d)\d{16}(?!\d)/g)) {
      if (!hasStandaloneDigits(text, match[0])) normalizedLines.push(`NIK: ${match[0]}`);
    }
  }

  for (const line of text.split(/\r?\n/)) {
    if (hasNikContext) {
      const trailingDigits = line.match(/[A-Za-z][A-Za-z0-9]*?(\d{16})$/);
      if (trailingDigits) {
        normalizedLines.push(`NIK: ${trailingDigits[1]}`);
      }
    }

    for (const match of line.matchAll(/\+?\s*62[\s.:-]*\d{3}[\s.:-]*\d{3,4}[\s.:-]*\d{3,5}/g)) {
      const phone = formatIndonesianPhone(match[0]);
      if (phone && /[.:-]/.test(match[0])) normalizedLines.push(`NO HP: ${phone}`);
    }

    const labelledNpwp = line.match(/NPW[A-Z]*[:：]?\s*([0-9OILS'|!.,\s-]{12,24})/i);
    if (labelledNpwp) {
      const digits = normalizeOcrIdentifierToken(labelledNpwp[1]).replace(/\D/g, '');
      if (digits.length >= 15) normalizedLines.push(`NPWP: ${formatNpwpDigits(digits.slice(0, 15))}`);
    }

    for (const match of line.matchAll(/[0-9OILS'|!]{2}\.[0-9OILS'|!]{3}\.[0-9OILS'|!]{3}\.[0-9OILS'|!]-[0-9OILS'|!]{3}\.[0-9OILS'|!]{3}/g)) {
      const digits = normalizeOcrIdentifierToken(match[0]).replace(/\D/g, '');
      if (digits.length >= 15) normalizedLines.push(`NPWP: ${formatNpwpDigits(digits.slice(0, 15))}`);
    }

    const postcodeMatch = line.match(/([0-9OIl|!']{5})\s*$/);
    if (!postcodeMatch) continue;
    const postcode = normalizeOcrIdentifierToken(postcodeMatch[1]).replace(/\D/g, '');
    if (postcode.length === 5 && /alamat|address|kode\s*pos/i.test(text) && !hasRawPostcodeContext(text, postcode)) {
      normalizedLines.push(`Alamat kode pos ${postcode}`);
    }
  }

  const uniqueLines = [...new Set(normalizedLines)];
  if (uniqueLines.length === 0) return text;
  return `${text}\n\nOCR NORMALIZED\n${uniqueLines.join('\n')}`;
}

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
  if (name.endsWith('.html') || name.endsWith('.htm') || type === 'text/html') {
    const text = stripHtmlToText(await file.text());
    return { text, source: 'file' };
  }

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
    console.log(`[GenGuard] OCR extracted ${result.text.length} chars from "${file.name}" in ${result.timeMs}ms`);
    console.log('[GenGuard][OCR raw]', file.name, result.text);
    const normalizedText = normalizeOcrText(result.text);
    if (normalizedText !== result.text) {
      console.log('[GenGuard][OCR normalized]', file.name, normalizedText);
    }
    return { text: normalizedText, source: 'ocr' };
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
  const nerThreshold = settings?.nerConfidenceThreshold ?? DEFAULT_NER_CONFIDENCE_THRESHOLD;

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
        findings: scored.findings,
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
