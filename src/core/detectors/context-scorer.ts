/**
 * Context Scorer — converts raw findings into a risk assessment.
 *
 * Score formula: Σ weight(severity) × max(confidence) × log2(1 + count)
 *
 * Deduplication strategy (overlap-aware):
 *   1. Sort findings by startIndex.
 *   2. Walk through; when two findings overlap:
 *        - NER always beats regex (it's contextually smarter).
 *        - Within the same source, higher confidence wins.
 *        - If confidence is equal, the longer span wins (more specific).
 *   3. Non-overlapping findings are all kept.
 */

import type { Finding, RiskAssessment } from '../types';

const SEVERITY_WEIGHTS: Record<string, number> = {
  critical: 40,
  high: 25,
  medium: 12,
  low: 5,
};

/**
 * Check whether two findings' character spans overlap.
 */
function spans_overlap(a: Finding, b: Finding): boolean {
  return a.startIndex < b.endIndex && b.startIndex < a.endIndex;
}

/**
 * Given two overlapping findings, return the one to keep.
 *
 * Priority order:
 *   1. NER > regex  (model is contextually aware)
 *   2. Higher confidence
 *   3. Longer span  (more specific detection)
 */
function pickWinner(a: Finding, b: Finding): Finding {
  // NER beats regex
  if (a.source === 'ner' && b.source === 'regex') return a;
  if (b.source === 'ner' && a.source === 'regex') return b;

  // Same source → higher confidence
  if (a.confidence !== b.confidence) {
    return a.confidence > b.confidence ? a : b;
  }

  // Same confidence → longer span
  const aLen = a.endIndex - a.startIndex;
  const bLen = b.endIndex - b.startIndex;
  return aLen >= bLen ? a : b;
}

/**
 * Overlap-aware deduplication.
 *
 * Sorts by startIndex, then greedily resolves overlaps by keeping the
 * winner (per pickWinner) and discarding the loser. This is a single-pass
 * O(n log n) algorithm that handles chains of overlapping findings.
 */
function dedup(findings: Finding[]): Finding[] {
  if (findings.length <= 1) return findings;

  // Sort by startIndex, then by endIndex descending (longer span first)
  const sorted = [...findings].sort((a, b) => {
    if (a.startIndex !== b.startIndex) return a.startIndex - b.startIndex;
    return b.endIndex - a.endIndex;
  });

  const kept: Finding[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = kept[kept.length - 1];

    if (spans_overlap(last, current)) {
      // Replace last with winner
      kept[kept.length - 1] = pickWinner(last, current);
    } else {
      kept.push(current);
    }
  }

  return kept;
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
    sourceGroups: [],
  };
}
