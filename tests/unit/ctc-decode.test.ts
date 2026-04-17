import { describe, it, expect } from 'vitest';
import { parseDict, ctcGreedyDecodeBatch } from '../../src/core/extractors/ocr/ctc-decode';

// ── parseDict ───────────────────────────────────────────────────────────────

describe('parseDict', () => {
  it('splits by newline, one char per entry', () => {
    const dict = parseDict('a\nb\nc\n');
    expect(dict).toEqual(['a', 'b', 'c']);
  });

  it('handles CRLF line endings', () => {
    const dict = parseDict('a\r\nb\r\nc\r\n');
    expect(dict).toEqual(['a', 'b', 'c']);
  });

  it('does not trim whitespace chars (they are valid entries)', () => {
    const dict = parseDict(' \n\t\nx\n');
    expect(dict).toEqual([' ', '\t', 'x']);
  });

  it('returns empty array for empty string', () => {
    const dict = parseDict('');
    expect(dict).toEqual([]);
  });

  it('handles file without trailing newline', () => {
    const dict = parseDict('a\nb\nc');
    expect(dict).toEqual(['a', 'b', 'c']);
  });

  it('handles single character', () => {
    const dict = parseDict('x\n');
    expect(dict).toEqual(['x']);
  });
});

// ── ctcGreedyDecodeBatch ────────────────────────────────────────────────────

describe('ctcGreedyDecodeBatch', () => {
  const dict = ['h', 'e', 'l', 'o', ' ', 'w', 'r', 'd'];
  // dict[0]='h'=id1, dict[1]='e'=id2, dict[2]='l'=id3, dict[3]='o'=id4,
  // dict[4]=' '=id5, dict[5]='w'=id6, dict[6]='r'=id7, dict[7]='d'=id8
  // id 0 = blank

  /** Helper: build logits for one sample with T time steps and C classes.
   *  `ids` is the sequence of class IDs (argmax) at each time step. */
  function buildLogits(ids: number[], C: number): Float32Array {
    const T = ids.length;
    const logits = new Float32Array(T * C).fill(-10);
    for (let t = 0; t < T; t++) {
      logits[t * C + ids[t]] = 10; // make this class the argmax
    }
    return logits;
  }

  it('decodes a simple sequence without repeats', () => {
    // "helo" = ids [1, 2, 3, 4]
    const C = dict.length + 1; // 9 classes (0=blank + 8 dict)
    const logits = buildLogits([1, 2, 3, 4], C);
    const result = ctcGreedyDecodeBatch(logits, 1, 4, C, dict);
    expect(result).toEqual(['helo']);
  });

  it('collapses consecutive duplicates', () => {
    // "helo" but with repeated l: [1, 2, 3, 3, 4]
    const C = dict.length + 1;
    const logits = buildLogits([1, 2, 3, 3, 4], C);
    const result = ctcGreedyDecodeBatch(logits, 1, 5, C, dict);
    expect(result).toEqual(['helo']); // two 3s collapse to one 'l'
  });

  it('uses blank to separate repeated chars', () => {
    // "ll" needs blank between them: [3, 0, 3]
    const C = dict.length + 1;
    const logits = buildLogits([3, 0, 3], C);
    const result = ctcGreedyDecodeBatch(logits, 1, 3, C, dict);
    expect(result).toEqual(['ll']);
  });

  it('drops leading and trailing blanks', () => {
    const C = dict.length + 1;
    const logits = buildLogits([0, 0, 1, 2, 0, 0], C);
    const result = ctcGreedyDecodeBatch(logits, 1, 6, C, dict);
    expect(result).toEqual(['he']);
  });

  it('returns empty string for all-blank sequence', () => {
    const C = dict.length + 1;
    const logits = buildLogits([0, 0, 0, 0], C);
    const result = ctcGreedyDecodeBatch(logits, 1, 4, C, dict);
    expect(result).toEqual(['']);
  });

  it('decodes a batch of 2 samples', () => {
    const C = dict.length + 1;
    const T = 4;
    // Sample 0: "he" = [1, 2, 0, 0]
    // Sample 1: "lo" = [3, 4, 0, 0]
    const logits0 = buildLogits([1, 2, 0, 0], C);
    const logits1 = buildLogits([3, 4, 0, 0], C);
    const combined = new Float32Array(2 * T * C);
    combined.set(logits0, 0);
    combined.set(logits1, T * C);
    const result = ctcGreedyDecodeBatch(combined, 2, T, C, dict);
    expect(result).toEqual(['he', 'lo']);
  });

  it('handles full "hello world" with blanks', () => {
    const C = dict.length + 1;
    // h=1, e=2, l=3, l=3, o=4, ' '=5, w=6, o=4, r=7, l=3, d=8
    // Need blank between the two l's: [1, 2, 3, 0, 3, 4, 5, 6, 4, 7, 3, 8]
    const ids = [1, 2, 3, 0, 3, 4, 5, 6, 4, 7, 3, 8];
    const logits = buildLogits(ids, C);
    const result = ctcGreedyDecodeBatch(logits, 1, ids.length, C, dict);
    expect(result).toEqual(['hello world']);
  });
});
