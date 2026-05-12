import { describe, it, expect } from 'vitest';
import { scoreFindings } from '../../src/core/detectors/context-scorer';
import type { Finding } from '../../src/core/types';

/** Helper to build a Finding with sensible defaults. */
function mkFinding(overrides: Partial<Finding> & Pick<Finding, 'type' | 'value' | 'startIndex' | 'endIndex'>): Finding {
  return {
    confidence: 0.95,
    severity: 'high',
    source: 'regex',
    ...overrides,
  };
}

describe('context-scorer', () => {
  // ── Deduplication ─────────────────────────────────────────────────────
  describe('dedup / overlap resolution', () => {
    it('keeps non-overlapping findings', () => {
      const findings: Finding[] = [
        mkFinding({ type: 'EMAIL', value: 'a@b.com', startIndex: 0, endIndex: 7 }),
        mkFinding({ type: 'PHONE', value: '0123456789', startIndex: 20, endIndex: 30 }),
      ];
      const result = scoreFindings(findings, 10);
      expect(result.findings).toHaveLength(2);
    });

    it('regex wins when it overlaps the same fuzzy NER span', () => {
      const findings: Finding[] = [
        mkFinding({ type: 'PERSON', value: 'Ahmad', startIndex: 0, endIndex: 5, source: 'ner', confidence: 0.8 }),
        mkFinding({ type: 'PERSON', value: 'Ahmad', startIndex: 0, endIndex: 5, source: 'regex', confidence: 0.99 }),
      ];
      const result = scoreFindings(findings, 10);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].source).toBe('regex');
      expect(result.findings[0].detectorSources).toEqual(['regex']);
    });

    it('keeps non-overlapping regex and NER findings separately', () => {
      const findings: Finding[] = [
        mkFinding({ type: 'ADDR', value: 'No. 12, Jalan Ampang', startIndex: 0, endIndex: 20, source: 'ner', confidence: 0.9 }),
        mkFinding({ type: 'MY_POSTCODE', value: '50450', startIndex: 22, endIndex: 27, source: 'regex', confidence: 1.0 }),
      ];
      const result = scoreFindings(findings, 10);
      expect(result.findings).toHaveLength(2);
    });

    it('merges contained postcode regex evidence into a wider NER address span', () => {
      const findings: Finding[] = [
        mkFinding({ type: 'ADDR', value: 'No. 12, Jalan Ampang, 50450', startIndex: 0, endIndex: 27, source: 'ner', confidence: 0.9 }),
        mkFinding({ type: 'MY_POSTCODE', value: '50450', startIndex: 22, endIndex: 27, source: 'regex', confidence: 1.0 }),
      ];
      const result = scoreFindings(findings, 10);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        type: 'ADDR',
        value: 'No. 12, Jalan Ampang, 50450',
        startIndex: 0,
        endIndex: 27,
        source: 'ner',
        confidence: 0.9,
        detectorSources: ['ner', 'regex'],
      });
      expect(result.breakdown.nerCount).toBe(1);
      expect(result.breakdown.regexCount).toBe(1);
    });

    it.each([
      ['MY_POSTCODE', 'Alamat: No. 88, Jalan Tun Razak, 50400 Kuala Lumpur', '50400'],
      ['SG_POSTCODE', 'Address: 10 Anson Road, International Plaza, 079903 Singapore', '079903'],
      ['PH_POSTCODE', 'Address: 123 Session Road, Baguio City, 2600 Philippines', '2600'],
    ])('keeps NER address when contained %s regex also matches', (postcodeType, address, postcode) => {
      const postcodeStart = address.indexOf(postcode);
      const findings: Finding[] = [
        mkFinding({ type: 'ADDR', value: address, startIndex: 0, endIndex: address.length, source: 'ner', confidence: 0.9 }),
        mkFinding({
          type: postcodeType,
          value: postcode,
          startIndex: postcodeStart,
          endIndex: postcodeStart + postcode.length,
          source: 'regex',
          confidence: 1.0,
          severity: 'low',
        }),
      ];

      const result = scoreFindings(findings, 10);

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]).toMatchObject({
        type: 'ADDR',
        value: address,
        startIndex: 0,
        endIndex: address.length,
        source: 'ner',
        detectorSources: ['ner', 'regex'],
      });
    });

    it('regex wins over NER for structured findings when overlapping', () => {
      const findings: Finding[] = [
        mkFinding({ type: 'PHONE', value: '012-3456789', startIndex: 0, endIndex: 11, source: 'regex', confidence: 1.0 }),
        mkFinding({ type: 'PHONE', value: '012-3456789', startIndex: 0, endIndex: 11, source: 'ner', confidence: 0.99 }),
      ];
      const result = scoreFindings(findings, 10);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].source).toBe('regex');
      expect(result.findings[0].detectorSources).toEqual(['regex']);
    });

    it('higher confidence wins within same source', () => {
      const findings: Finding[] = [
        mkFinding({ type: 'EMAIL', value: 'a@b.com', startIndex: 0, endIndex: 7, confidence: 0.6 }),
        mkFinding({ type: 'EMAIL', value: 'a@b.com', startIndex: 0, endIndex: 7, confidence: 0.9 }),
      ];
      const result = scoreFindings(findings, 10);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].confidence).toBe(0.9);
    });

    it('longer span wins when confidence is equal', () => {
      const findings: Finding[] = [
        mkFinding({ type: 'PERSON', value: 'Ahmad', startIndex: 0, endIndex: 5, confidence: 0.9 }),
        mkFinding({ type: 'PERSON', value: 'Ahmad bin Ali', startIndex: 0, endIndex: 13, confidence: 0.9 }),
      ];
      const result = scoreFindings(findings, 10);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].value).toBe('Ahmad bin Ali');
    });
  });

  // ── Score calculation ─────────────────────────────────────────────────
  describe('score calculation', () => {
    it('returns 0 score for empty findings', () => {
      const result = scoreFindings([], 5);
      expect(result.score).toBe(0);
      expect(result.level).toBe('Safe');
      expect(result.findings).toHaveLength(0);
    });

    it('caps score at 100', () => {
      // Many critical findings should still cap at 100
      const findings: Finding[] = [];
      for (let i = 0; i < 50; i++) {
        findings.push(mkFinding({
          type: 'IC_NUMBER',
          value: `90123${i}-14-5678`,
          startIndex: i * 20,
          endIndex: i * 20 + 14,
          severity: 'critical',
          confidence: 1.0,
        }));
      }
      const result = scoreFindings(findings, 10);
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it('critical findings produce higher score than low findings', () => {
      const critical = scoreFindings([
        mkFinding({ type: 'IC_NUMBER', value: '901231-14-5678', startIndex: 0, endIndex: 14, severity: 'critical', confidence: 1.0 }),
      ], 5);

      const low = scoreFindings([
        mkFinding({ type: 'IP_ADDRESS', value: '192.168.1.1', startIndex: 0, endIndex: 11, severity: 'low', confidence: 1.0 }),
      ], 5);

      expect(critical.score).toBeGreaterThan(low.score);
    });
  });

  // ── Risk levels ───────────────────────────────────────────────────────
  describe('risk levels', () => {
    it('assigns Safe for score < 20', () => {
      const result = scoreFindings([
        mkFinding({ type: 'IP_ADDRESS', value: '10.0.0.1', startIndex: 0, endIndex: 8, severity: 'low', confidence: 0.5 }),
      ], 5);
      expect(result.level).toBe('Safe');
    });

    it('assigns Critical for very high scores', () => {
      const findings: Finding[] = [];
      for (let i = 0; i < 10; i++) {
        findings.push(mkFinding({
          type: `TYPE_${i}`,
          value: `value${i}`,
          startIndex: i * 100,
          endIndex: i * 100 + 10,
          severity: 'critical',
          confidence: 1.0,
        }));
      }
      const result = scoreFindings(findings, 10);
      expect(result.level).toBe('Critical');
    });
  });

  // ── Top risks ─────────────────────────────────────────────────────────
  describe('top risks', () => {
    it('returns at most 3 top risks', () => {
      const findings: Finding[] = [];
      for (let i = 0; i < 10; i++) {
        findings.push(mkFinding({
          type: `TYPE_${i}`,
          value: `v${i}`,
          startIndex: i * 20,
          endIndex: i * 20 + 5,
          severity: 'high',
        }));
      }
      const result = scoreFindings(findings, 10);
      expect(result.topRisks.length).toBeLessThanOrEqual(3);
    });

    it('top risks are sorted by severity weight × confidence', () => {
      const findings: Finding[] = [
        mkFinding({ type: 'A', value: 'a', startIndex: 0, endIndex: 1, severity: 'low', confidence: 1.0 }),
        mkFinding({ type: 'B', value: 'b', startIndex: 10, endIndex: 11, severity: 'critical', confidence: 0.9 }),
        mkFinding({ type: 'C', value: 'c', startIndex: 20, endIndex: 21, severity: 'high', confidence: 0.8 }),
      ];
      const result = scoreFindings(findings, 10);
      expect(result.topRisks[0].type).toBe('B'); // critical × 0.9 = 36
      expect(result.topRisks[1].type).toBe('C'); // high × 0.8 = 20
    });
  });

  // ── Suggestions ───────────────────────────────────────────────────────
  describe('suggestions', () => {
    it('generates suggestions for critical findings', () => {
      const result = scoreFindings([
        mkFinding({ type: 'IC_NUMBER', value: '901231-14-5678', startIndex: 0, endIndex: 14, severity: 'critical' }),
      ], 5);
      expect(result.suggestions.length).toBeGreaterThan(0);
      expect(result.suggestions[0]).toContain('Redact');
    });

    it('truncates long values in suggestions', () => {
      const result = scoreFindings([
        mkFinding({ type: 'PRIVATE_KEY', value: 'A'.repeat(50), startIndex: 0, endIndex: 50, severity: 'critical' }),
      ], 5);
      expect(result.suggestions[0]).toContain('...');
    });

    it('caps suggestions at 5', () => {
      const findings: Finding[] = [];
      for (let i = 0; i < 10; i++) {
        findings.push(mkFinding({
          type: `TYPE_${i}`,
          value: `val${i}`,
          startIndex: i * 20,
          endIndex: i * 20 + 5,
          severity: 'critical',
        }));
      }
      const result = scoreFindings(findings, 10);
      expect(result.suggestions.length).toBeLessThanOrEqual(5);
    });

    it('does not generate suggestions for low severity', () => {
      const result = scoreFindings([
        mkFinding({ type: 'IP_ADDRESS', value: '10.0.0.1', startIndex: 0, endIndex: 8, severity: 'low' }),
      ], 5);
      expect(result.suggestions).toHaveLength(0);
    });
  });

  // ── Breakdown ─────────────────────────────────────────────────────────
  describe('breakdown', () => {
    it('correctly counts findings by source', () => {
      const findings: Finding[] = [
        mkFinding({ type: 'EMAIL', value: 'a@b.com', startIndex: 0, endIndex: 7, source: 'regex' }),
        mkFinding({ type: 'PERSON', value: 'Ahmad', startIndex: 20, endIndex: 25, source: 'ner' }),
        mkFinding({ type: 'PHONE', value: '012345', startIndex: 40, endIndex: 46, source: 'regex' }),
      ];
      const result = scoreFindings(findings, 10);
      expect(result.breakdown.regexCount).toBe(2);
      expect(result.breakdown.nerCount).toBe(1);
      expect(result.breakdown.ocrCount).toBe(0);
    });

    it('counts only the winning detector source in breakdown', () => {
      const result = scoreFindings([
        mkFinding({ type: 'EMAIL', value: 'a@b.com', startIndex: 0, endIndex: 7, source: 'regex' }),
        mkFinding({ type: 'EMAIL', value: 'a@b.com', startIndex: 0, endIndex: 7, source: 'ner' }),
      ], 10);

      expect(result.findings).toHaveLength(1);
      expect(result.breakdown.regexCount).toBe(1);
      expect(result.breakdown.nerCount).toBe(0);
    });
  });

  // ── Compute time passthrough ──────────────────────────────────────────
  it('passes through computeTimeMs', () => {
    const result = scoreFindings([], 42);
    expect(result.computeTimeMs).toBe(42);
  });
});
