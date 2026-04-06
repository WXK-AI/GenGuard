/**
 * Context Scorer — converts raw findings into a risk assessment.
 *
 * Score formula: Σ weight(severity) × max(confidence) × log2(1 + count)
 * Deduplication: same (type, startIndex, endIndex) counted once; if both
 * regex and NER match the same span, keep the higher-confidence one.
 */

import type { Finding, RiskAssessment } from '../types';

const SEVERITY_WEIGHTS: Record<string, number> = {
  critical: 40,
  high: 25,
  medium: 12,
  low: 5,
};

/**
 * Deduplicate findings: for overlapping spans of the same type,
 * keep the one with higher confidence.
 */
function dedup(findings: Finding[]): Finding[] {
  const map = new Map<string, Finding>();

  for (const f of findings) {
    const key = `${f.type}:${f.startIndex}:${f.endIndex}`;
    const existing = map.get(key);
    if (!existing || f.confidence > existing.confidence) {
      map.set(key, f);
    }
  }

  return Array.from(map.values());
}

/**
 * Generate user-facing suggestions based on findings.
 */
function buildSuggestions(findings: Finding[]): string[] {
  const suggestions: string[] = [];
  const seen = new Set<string>();

  // Sort by severity weight descending
  const sorted = [...findings].sort(
    (a, b) => (SEVERITY_WEIGHTS[b.severity] ?? 0) - (SEVERITY_WEIGHTS[a.severity] ?? 0),
  );

  for (const f of sorted) {
    if (seen.has(f.type)) continue;
    seen.add(f.type);

    const truncated = f.value.length > 20 ? f.value.slice(0, 20) + '...' : f.value;

    switch (f.severity) {
      case 'critical':
        suggestions.push(`Redact ${f.type.replace(/_/g, ' ')} "${truncated}" before submitting`);
        break;
      case 'high':
        suggestions.push(`Consider removing ${f.type.replace(/_/g, ' ')} "${truncated}"`);
        break;
      case 'medium':
        suggestions.push(`Review ${f.type.replace(/_/g, ' ')} mention: "${truncated}"`);
        break;
    }

    if (suggestions.length >= 5) break;
  }

  return suggestions;
}

/**
 * Score deduplicated findings into a RiskAssessment.
 */
export function scoreFindings(
  allFindings: Finding[],
  computeTimeMs: number,
): RiskAssessment {
  const findings = dedup(allFindings);

  // Group by type
  const grouped = new Map<string, Finding[]>();
  for (const f of findings) {
    const arr = grouped.get(f.type) ?? [];
    arr.push(f);
    grouped.set(f.type, arr);
  }

  // Calculate raw score
  let rawScore = 0;
  for (const [, group] of grouped) {
    const maxConf = Math.max(...group.map((f) => f.confidence));
    const weight = SEVERITY_WEIGHTS[group[0].severity] ?? 5;
    rawScore += weight * maxConf * Math.log2(1 + group.length);
  }

  const score = Math.min(100, Math.round(rawScore));

  const level: RiskAssessment['level'] =
    score < 20 ? 'Safe' : score < 50 ? 'Caution' : score < 80 ? 'High' : 'Critical';

  // Top 3 risks by severity × confidence
  const topRisks = [...findings]
    .sort((a, b) => {
      const wa = (SEVERITY_WEIGHTS[a.severity] ?? 0) * a.confidence;
      const wb = (SEVERITY_WEIGHTS[b.severity] ?? 0) * b.confidence;
      return wb - wa;
    })
    .slice(0, 3);

  const suggestions = buildSuggestions(findings);

  const breakdown = {
    regexCount: findings.filter((f) => f.source === 'regex').length,
    nerCount: findings.filter((f) => f.source === 'ner').length,
    ocrCount: findings.filter((f) => f.source === 'ocr').length,
  };

  return {
    score,
    level,
    findings,
    topRisks,
    suggestions,
    computeTimeMs,
    breakdown,
  };
}
