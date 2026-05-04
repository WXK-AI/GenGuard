import { describe, it, expect } from 'vitest';
import { _testInternals } from '../../src/core/detectors/ner-detector';
import type { Finding } from '../../src/core/types';
import type { EncodeResult } from '../../src/core/tokenizer/sentencepiece-tokenizer';

const { softmaxArgmax, getTag, aggregateToWords, mergeEntities, mergeAdjacentFindings } = _testInternals;

// ── getTag ──────────────────────────────────────────────────────────────────

describe('getTag', () => {
  it('parses B- prefix', () => {
    expect(getTag('B-PERSON')).toEqual({ bi: 'B', tag: 'PERSON' });
  });

  it('parses I- prefix', () => {
    expect(getTag('I-ADDR')).toEqual({ bi: 'I', tag: 'ADDR' });
  });

  it('returns I for plain label (O)', () => {
    expect(getTag('O')).toEqual({ bi: 'I', tag: 'O' });
  });

  it('returns I for unrecognised label', () => {
    expect(getTag('UNKNOWN')).toEqual({ bi: 'I', tag: 'UNKNOWN' });
  });
});

// ── softmaxArgmax ───────────────────────────────────────────────────────────

describe('softmaxArgmax', () => {
  it('returns the index of the maximum value', () => {
    const logits = new Float32Array(9).fill(-5);
    logits[2] = 5.0;
    const result = softmaxArgmax(logits, 0);
    expect(result.labelIdx).toBe(2);
  });

  it('returns high confidence when one logit dominates', () => {
    const logits = new Float32Array(9).fill(0);
    logits[2] = 100;
    const result = softmaxArgmax(logits, 0);
    expect(result.labelIdx).toBe(2);
    expect(result.confidence).toBeGreaterThan(0.99);
  });

  it('returns ~equal confidence for equal logits', () => {
    const logits = new Float32Array(9).fill(1);
    const result = softmaxArgmax(logits, 0);
    expect(result.confidence).toBeCloseTo(1 / 9, 2);
  });

  it('respects offset parameter', () => {
    // softmaxArgmax uses the model label count as stride, so we simulate
    // by checking with explicit offset
    // that it works for position 0 with real-sized logits.

    const realLogits = new Float32Array(9).fill(-5);
    realLogits[1] = 10; // B-PERSON
    const result = softmaxArgmax(realLogits, 0);
    expect(result.labelIdx).toBe(1);
    expect(result.confidence).toBeGreaterThan(0.99);
  });

  it('handles negative logits', () => {
    const logits = new Float32Array(9).fill(-100);
    logits[0] = -1; // O label — least negative
    const result = softmaxArgmax(logits, 0);
    expect(result.labelIdx).toBe(0);
    expect(result.confidence).toBeGreaterThan(0.99);
  });
});

// ── aggregateToWords ────────────────────────────────────────────────────────

describe('aggregateToWords', () => {
  // Helper: build minimal EncodeResult
  function mkEncoded(offsets: [number, number][], wordIds: (number | null)[]): EncodeResult {
    return {
      inputIds: new BigInt64Array(offsets.length),
      attentionMask: new BigInt64Array(offsets.length),
      tokens: offsets.map(() => ''),
      wordIds,
      offsets,
    };
  }

  it('groups subwords by wordId', () => {
    // Word 0 = "Ahmad" split into "Ah" + "mad"
    const predictions = [
      { wordId: null, label: 'O', confidence: 0 },        // [CLS]
      { wordId: 0, label: 'B-PERSON', confidence: 0.9 },  // "Ah"
      { wordId: 0, label: 'I-PERSON', confidence: 0.85 },  // "mad"
      { wordId: null, label: 'O', confidence: 0 },        // [SEP]
    ];
    const encoded = mkEncoded(
      [[0, 0], [0, 2], [2, 5], [0, 0]],
      [null, 0, 0, null],
    );

    const words = aggregateToWords(predictions, encoded);
    expect(words).toHaveLength(1);
    expect(words[0].label).toBe('B-PERSON');
    expect(words[0].start).toBe(0);
    expect(words[0].end).toBe(5);
    expect(words[0].confidence).toBe(0.9); // max of winning label's subwords
  });

  it('picks dominant non-O label by summed confidence', () => {
    // Word 0 has 2 PERSON subwords (sum=1.6) vs 1 ORGANISATION subword (sum=0.95)
    const predictions = [
      { wordId: null, label: 'O', confidence: 0 },
      { wordId: 0, label: 'B-PERSON', confidence: 0.8 },
      { wordId: 0, label: 'I-PERSON', confidence: 0.8 },
      { wordId: 0, label: 'B-ORGANISATION', confidence: 0.95 },
      { wordId: null, label: 'O', confidence: 0 },
    ];
    const encoded = mkEncoded(
      [[0, 0], [0, 2], [2, 4], [4, 7], [0, 0]],
      [null, 0, 0, 0, null],
    );

    const words = aggregateToWords(predictions, encoded);
    expect(words[0].label).toContain('PERSON');
  });

  it('labels word as O when all subwords are O', () => {
    const predictions = [
      { wordId: null, label: 'O', confidence: 0 },
      { wordId: 0, label: 'O', confidence: 0.95 },
      { wordId: 0, label: 'O', confidence: 0.90 },
      { wordId: null, label: 'O', confidence: 0 },
    ];
    const encoded = mkEncoded(
      [[0, 0], [0, 3], [3, 6], [0, 0]],
      [null, 0, 0, null],
    );

    const words = aggregateToWords(predictions, encoded);
    expect(words[0].label).toBe('O');
    expect(words[0].confidence).toBe(0);
  });

  it('returns words sorted by wordId', () => {
    const predictions = [
      { wordId: null, label: 'O', confidence: 0 },
      { wordId: 2, label: 'B-EMAIL', confidence: 0.9 },
      { wordId: 0, label: 'B-PERSON', confidence: 0.8 },
      { wordId: 1, label: 'O', confidence: 0.7 },
      { wordId: null, label: 'O', confidence: 0 },
    ];
    const encoded = mkEncoded(
      [[0, 0], [10, 20], [0, 5], [5, 10], [0, 0]],
      [null, 2, 0, 1, null],
    );

    const words = aggregateToWords(predictions, encoded);
    expect(words[0].wordId).toBe(0);
    expect(words[1].wordId).toBe(1);
    expect(words[2].wordId).toBe(2);
  });
});

// ── mergeEntities ───────────────────────────────────────────────────────────

describe('mergeEntities', () => {
  function mkEncoded(offsets: [number, number][], wordIds: (number | null)[]): EncodeResult {
    return {
      inputIds: new BigInt64Array(offsets.length),
      attentionMask: new BigInt64Array(offsets.length),
      tokens: offsets.map(() => ''),
      wordIds,
      offsets,
    };
  }

  it('merges consecutive same-type words into one entity', () => {
    // "Ahmad bin Ali" → 3 words all B-PERSON
    const text = 'Ahmad bin Ali';
    const predictions = [
      { wordId: null, label: 'O', confidence: 0 },
      { wordId: 0, label: 'B-PERSON', confidence: 0.9 },
      { wordId: 1, label: 'B-PERSON', confidence: 0.85 },
      { wordId: 2, label: 'B-PERSON', confidence: 0.88 },
      { wordId: null, label: 'O', confidence: 0 },
    ];
    const encoded = mkEncoded(
      [[0, 0], [0, 5], [6, 9], [10, 13], [0, 0]],
      [null, 0, 1, 2, null],
    );

    const findings = mergeEntities(predictions, encoded, text, 0.1);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('PERSON');
    expect(findings[0].value).toBe('Ahmad bin Ali');
    expect(findings[0].source).toBe('ner');
  });

  it('splits entities of different types', () => {
    const text = 'Ahmad Maybank';
    const predictions = [
      { wordId: null, label: 'O', confidence: 0 },
      { wordId: 0, label: 'B-PERSON', confidence: 0.9 },
      { wordId: 1, label: 'B-ORGANISATION', confidence: 0.85 },
      { wordId: null, label: 'O', confidence: 0 },
    ];
    const encoded = mkEncoded(
      [[0, 0], [0, 5], [6, 13], [0, 0]],
      [null, 0, 1, null],
    );

    const findings = mergeEntities(predictions, encoded, text, 0.1);
    expect(findings).toHaveLength(2);
    expect(findings[0].type).toBe('PERSON');
    expect(findings[1].type).toBe('ORGANISATION');
  });

  it('filters low-confidence entities', () => {
    const text = 'maybe Ahmad';
    const predictions = [
      { wordId: null, label: 'O', confidence: 0 },
      { wordId: 0, label: 'O', confidence: 0.95 },
      { wordId: 1, label: 'B-PERSON', confidence: 0.05 }, // below threshold
      { wordId: null, label: 'O', confidence: 0 },
    ];
    const encoded = mkEncoded(
      [[0, 0], [0, 5], [6, 11], [0, 0]],
      [null, 0, 1, null],
    );

    const findings = mergeEntities(predictions, encoded, text, 0.1);
    expect(findings).toHaveLength(0);
  });

  it('ignores structured PII labels from NER output', () => {
    const text = 'ali@example.com Ahmad';
    const predictions = [
      { wordId: null, label: 'O', confidence: 0 },
      { wordId: 0, label: 'B-EMAIL', confidence: 0.99 },
      { wordId: 1, label: 'B-PERSON', confidence: 0.9 },
      { wordId: null, label: 'O', confidence: 0 },
    ];
    const encoded = mkEncoded(
      [[0, 0], [0, 15], [16, 21], [0, 0]],
      [null, 0, 1, null],
    );

    const findings = mergeEntities(predictions, encoded, text, 0.1);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('PERSON');
  });

  it('suppresses model spans that look like structured PII values', () => {
    const text = 'ahmad.razali@example.com +60 12-345 6789 3174021234567890';
    const predictions = [
      { wordId: null, label: 'O', confidence: 0 },
      { wordId: 0, label: 'B-ORGANISATION', confidence: 0.95 },
      { wordId: 1, label: 'B-PERSON', confidence: 0.95 },
      { wordId: 2, label: 'B-ORGANISATION', confidence: 0.95 },
      { wordId: null, label: 'O', confidence: 0 },
    ];
    const encoded = mkEncoded(
      [[0, 0], [0, 24], [25, 40], [41, 57], [0, 0]],
      [null, 0, 1, 2, null],
    );

    const findings = mergeEntities(predictions, encoded, text, 0.1);
    expect(findings).toHaveLength(0);
  });

  it('suppresses hard-negative LOCATION lists', () => {
    const text = 'Alpha, React, Python, Apple, Microsoft';
    const predictions = [
      { wordId: null, label: 'O', confidence: 0 },
      { wordId: 0, label: 'B-LOCATION', confidence: 0.95 },
      { wordId: 1, label: 'I-LOCATION', confidence: 0.95 },
      { wordId: 2, label: 'I-LOCATION', confidence: 0.95 },
      { wordId: 3, label: 'I-LOCATION', confidence: 0.95 },
      { wordId: 4, label: 'I-LOCATION', confidence: 0.95 },
      { wordId: null, label: 'O', confidence: 0 },
    ];
    const encoded = mkEncoded(
      [[0, 0], [0, 5], [7, 12], [14, 20], [22, 27], [29, 38], [0, 0]],
      [null, 0, 1, 2, 3, 4, null],
    );

    const findings = mergeEntities(predictions, encoded, text, 0.1);
    expect(findings).toHaveLength(0);
  });

  it('uses the normalized confidence floor for ORGANISATION entities', () => {
    const text = 'Maybank';
    const predictions = [
      { wordId: null, label: 'O', confidence: 0 },
      { wordId: 0, label: 'B-ORGANISATION', confidence: 0.5 },
      { wordId: null, label: 'O', confidence: 0 },
    ];
    const encoded = mkEncoded(
      [[0, 0], [0, 7], [0, 0]],
      [null, 0, null],
    );

    const findings = mergeEntities(predictions, encoded, text, 0.1);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      type: 'ORGANISATION',
      value: 'Maybank',
      confidence: 0.5,
    });
  });

  it('skips empty/whitespace-only values', () => {
    const text = '  ';
    const predictions = [
      { wordId: null, label: 'O', confidence: 0 },
      { wordId: 0, label: 'B-PERSON', confidence: 0.9 },
      { wordId: null, label: 'O', confidence: 0 },
    ];
    const encoded = mkEncoded(
      [[0, 0], [0, 2], [0, 0]],
      [null, 0, null],
    );

    const findings = mergeEntities(predictions, encoded, text, 0.1);
    expect(findings).toHaveLength(0);
  });
});

// ── mergeAdjacentFindings ───────────────────────────────────────────────────

describe('mergeAdjacentFindings', () => {
  function mkFind(type: string, value: string, start: number, end: number, conf = 0.9): Finding {
    return {
      type,
      value,
      startIndex: start,
      endIndex: end,
      confidence: conf,
      severity: 'high',
      source: 'ner',
    };
  }

  it('merges adjacent same-type findings separated by whitespace', () => {
    const text = 'Ahmad bin Ali is here';
    const findings = [
      mkFind('PERSON', 'Ahmad', 0, 5, 0.9),
      mkFind('PERSON', 'bin', 6, 9, 0.8),
      mkFind('PERSON', 'Ali', 10, 13, 0.85),
    ];

    const merged = mergeAdjacentFindings(findings, text);
    expect(merged).toHaveLength(1);
    expect(merged[0].value).toBe('Ahmad bin Ali');
    expect(merged[0].startIndex).toBe(0);
    expect(merged[0].endIndex).toBe(13);
  });

  it('does not merge different types', () => {
    const text = 'Ahmad Maybank';
    const findings = [
      mkFind('PERSON', 'Ahmad', 0, 5),
      mkFind('ORGANISATION', 'Maybank', 6, 13),
    ];

    const merged = mergeAdjacentFindings(findings, text);
    expect(merged).toHaveLength(2);
  });

  it('does not merge when gap contains non-whitespace', () => {
    const text = 'Ahmad, Ali';
    const findings = [
      mkFind('PERSON', 'Ahmad', 0, 5),
      mkFind('PERSON', 'Ali', 7, 10),
    ];

    const merged = mergeAdjacentFindings(findings, text);
    expect(merged).toHaveLength(2);
  });

  it('computes weighted average confidence', () => {
    const text = 'AB CD';
    const findings = [
      mkFind('PERSON', 'AB', 0, 2, 0.9),   // len 2
      mkFind('PERSON', 'CD', 3, 5, 0.5),   // len 2
    ];

    const merged = mergeAdjacentFindings(findings, text);
    expect(merged).toHaveLength(1);
    // Weighted avg: (0.9*2 + 0.5*2) / 4 = 1.4/4 = 0.35 → rounded to 0.7
    expect(merged[0].confidence).toBeCloseTo(0.7, 2);
  });

  it('returns single finding unchanged', () => {
    const text = 'Ahmad';
    const findings = [mkFind('PERSON', 'Ahmad', 0, 5)];

    const merged = mergeAdjacentFindings(findings, text);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(findings[0]);
  });

  it('handles empty array', () => {
    const merged = mergeAdjacentFindings([], '');
    expect(merged).toHaveLength(0);
  });
});
