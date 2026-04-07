/**
 * Regex PII Detector — fast pattern-based detection for structured PII.
 * Runs in parallel with NER as a safety net. Sub-50 ms execution.
 */

import piiPatterns from './pii-patterns.json';
import type { Finding } from '../types';
import type { Severity } from './ner-model-contract';

interface PatternDef {
  name: string;
  label: string;
  regex: string;
  severity: string;
  flags: string;
  contextRequired?: boolean;
}

/** Context keywords that must appear near a postcode for it to be flagged. */
const POSTCODE_CONTEXT = /\b(?:poskod|postcode|zip|kod\s?pos|alamat|address)\b/i;

/** Context keywords for bank account numbers. */
const BANK_CONTEXT = /\b(?:akaun|account|bank|acc|transfer|bayaran|payment|remit|wire|deposit|kredit|debit|simpanan|savings|semasa|current)\b/i;

/** Luhn checksum validation for credit card numbers. */
function luhnCheck(digits: string): boolean {
  const nums = digits.replace(/[-\s]/g, '');
  let sum = 0;
  let alt = false;
  for (let i = nums.length - 1; i >= 0; i--) {
    let n = parseInt(nums[i], 10);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Compile patterns once on first call. */
let compiledPatterns: Array<{
  name: string;
  regex: RegExp;
  severity: Severity | 'low';
  contextRequired: boolean;
}> | null = null;

function getPatterns() {
  if (compiledPatterns) return compiledPatterns;

  compiledPatterns = (piiPatterns.patterns as PatternDef[]).map((p) => ({
    name: p.name,
    regex: new RegExp(p.regex, p.flags),
    severity: p.severity as Severity | 'low',
    contextRequired: p.contextRequired ?? false,
  }));

  return compiledPatterns;
}

/**
 * Run all regex patterns against the input text.
 * Returns findings with source: 'regex'.
 */
export function detectRegex(text: string): { findings: Finding[]; timeMs: number } {
  const t0 = performance.now();
  const patterns = getPatterns();
  const findings: Finding[] = [];

  for (const pattern of patterns) {
    // Reset lastIndex for global regexes
    pattern.regex.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = pattern.regex.exec(text)) !== null) {
      const value = match[0];
      const startIndex = match.index;
      const endIndex = startIndex + value.length;

      // Context check — skip if required keywords aren't nearby
      if (pattern.contextRequired) {
        const windowStart = Math.max(0, startIndex - 80);
        const windowEnd = Math.min(text.length, endIndex + 80);
        const context = text.slice(windowStart, windowEnd);
        const contextRegex = pattern.name === 'BANK_ACCT' ? BANK_CONTEXT : POSTCODE_CONTEXT;
        if (!contextRegex.test(context)) continue;
      }

      // Luhn validation for credit cards
      if (pattern.name === 'CREDIT_CARD' && !luhnCheck(value)) continue;

      // Skip bank account pattern if it overlaps with IC number format
      if (pattern.name === 'BANK_ACCT' && /^\d{6}-\d{2}-\d{4}$/.test(value)) continue;

      findings.push({
        type: pattern.name,
        value,
        startIndex,
        endIndex,
        confidence: 1.0,
        severity: pattern.severity,
        source: 'regex',
      });
    }
  }

  const timeMs = Math.round(performance.now() - t0);
  return { findings, timeMs };
}
