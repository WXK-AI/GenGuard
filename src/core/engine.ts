/**
 * Engine Orchestrator — merges regex + NER detection into a single RiskAssessment.
 *
 * Pipeline:
 * 1. Regex runs synchronously (< 50 ms)
 * 2. NER runs async via ORT
 * 3. Merge findings, score, return
 */

import { detectRegex } from './detectors/regex-detector';
import { detectNER, isTokenizerReady } from './detectors/ner-detector';
import { isReady as isOrtReady } from '../lib/ort-engine';
import { scoreFindings } from './detectors/context-scorer';
import type { Finding, RiskAssessment, GenGuardSettings, DEFAULT_SETTINGS } from './types';

export interface AssessInput {
  text?: string;
  // Future: files?: File[];
}

/**
 * Run the full assessment pipeline on text input.
 */
export async function assess(
  input: AssessInput,
  settings?: Partial<GenGuardSettings>,
): Promise<RiskAssessment> {
  const t0 = performance.now();
  const text = input.text?.trim() ?? '';

  if (text.length === 0) {
    return {
      score: 0,
      level: 'Safe',
      findings: [],
      topRisks: [],
      suggestions: [],
      computeTimeMs: 0,
      breakdown: { regexCount: 0, nerCount: 0, ocrCount: 0 },
    };
  }

  const enableRegex = settings?.enableRegex ?? true;
  const enableNer = settings?.enableNer ?? true;
  const nerThreshold = settings?.nerConfidenceThreshold ?? 0.10;

  const allFindings: Finding[] = [];

  // 1. Regex — synchronous, always fast
  if (enableRegex) {
    const { findings: regexFindings } = detectRegex(text);
    allFindings.push(...regexFindings);
  }

  // 2. NER — async, only if model is loaded
  if (enableNer && isTokenizerReady() && isOrtReady()) {
    const { findings: nerFindings } = await detectNER(text, nerThreshold);
    allFindings.push(...nerFindings);
  }

  const computeTimeMs = Math.round(performance.now() - t0);

  return scoreFindings(allFindings, computeTimeMs);
}
