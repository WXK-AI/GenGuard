/**
 * CTC Greedy Decoder for PaddleOCR recognition models.
 *
 * Recognition output: Float32Array of shape [N, T, C] where
 *   N = batch size
 *   T = sequence length (time steps)
 *   C = num classes (blank + len(dict))
 *
 * Convention: id 0 = CTC blank, dict starts at id 1 (so charId i → dict[i-1]).
 *
 * Greedy decoding:
 *   1. Argmax along the class dim → token IDs of length T
 *   2. Collapse consecutive duplicates
 *   3. Drop blanks
 *   4. Look up remaining IDs in the character dictionary
 */

import { OCR_MODEL_CONTRACT } from './ocr-contract';

/**
 * Parse a PaddleOCR dict.txt file (one character per line, UTF-8).
 * Trailing newline is stripped; empty lines are preserved as blank chars.
 */
export function parseDict(text: string): string[] {
  // PaddleOCR dict files use \n separators; do NOT trim individual lines
  // because some chars may be whitespace
  const raw = text.replace(/\r\n/g, '\n');
  const lines = raw.split('\n');
  // Drop a single trailing empty entry from the final newline
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Decode all rows of a recognition batch using greedy CTC.
 *
 * @param logits  Float32Array of length N*T*C (already softmaxed or raw — argmax works either way)
 * @param N       batch size
 * @param T       time steps
 * @param C       num classes
 * @param dict    character dictionary (dict[i] is the char for class id i+1)
 * @returns       array of N decoded strings
 */
export function ctcGreedyDecodeBatch(
  logits: Float32Array,
  N: number,
  T: number,
  C: number,
  dict: string[],
): string[] {
  const blank = OCR_MODEL_CONTRACT.rec.blankId;
  const out: string[] = [];

  for (let n = 0; n < N; n++) {
    let prev = -1;
    const chars: string[] = [];

    for (let t = 0; t < T; t++) {
      // Argmax over the C classes for sample n at time t
      const base = n * T * C + t * C;
      let bestIdx = 0;
      let bestVal = logits[base];
      for (let c = 1; c < C; c++) {
        const v = logits[base + c];
        if (v > bestVal) {
          bestVal = v;
          bestIdx = c;
        }
      }

      // Collapse repeats + drop blanks
      if (bestIdx !== prev && bestIdx !== blank) {
        // Map class id → dict char (id 1 → dict[0])
        const dictIdx = bestIdx - 1;
        if (dictIdx >= 0 && dictIdx < dict.length) {
          chars.push(dict[dictIdx]);
        }
      }
      prev = bestIdx;
    }

    out.push(chars.join(''));
  }

  return out;
}
