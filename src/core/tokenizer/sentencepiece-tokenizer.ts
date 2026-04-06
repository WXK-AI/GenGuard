/**
 * Pure-TS Unigram SentencePiece tokenizer for DeBERTa-v3.
 * Reads HuggingFace tokenizer.json format. No transformers.js dependency.
 *
 * Pipeline: normalize → pre-tokenize (metaspace) → unigram encode → post-process ([CLS]/[SEP]/pad)
 */

// ── Types ────────────────────────────────────────────────────────────────────

interface TokenizerJSON {
  model: {
    type: 'Unigram';
    unk_id: number;
    vocab: [string, number][]; // [token, log_prob]
  };
  added_tokens: Array<{
    id: number;
    content: string;
    special: boolean;
  }>;
  normalizer: {
    type: string;
    normalizers?: Array<{ type: string; [k: string]: unknown }>;
    [k: string]: unknown;
  };
  pre_tokenizer: {
    type: string;
    pretokenizers?: Array<{ type: string; replacement?: string; prepend_scheme?: string; split?: boolean }>;
  };
}

export interface EncodeResult {
  inputIds: BigInt64Array;
  attentionMask: BigInt64Array;
  tokens: string[];
  wordIds: (number | null)[];     // maps each token position → original word index
  offsets: [number, number][];    // char offsets in original text per token
}

// ── Tokenizer Class ──────────────────────────────────────────────────────────

export class DeBERTaTokenizer {
  private vocab: Map<string, { id: number; score: number }>;
  private idToTokenMap: Map<number, string>;
  private unkId: number;
  private clsId: number;
  private sepId: number;
  private padId: number;

  // Trie for fast longest-prefix vocab lookup
  private maxTokenLen: number;

  constructor(tokenizerJson: TokenizerJSON) {
    this.vocab = new Map();
    this.idToTokenMap = new Map();
    this.maxTokenLen = 0;

    // Load vocab
    for (let i = 0; i < tokenizerJson.model.vocab.length; i++) {
      const [token, score] = tokenizerJson.model.vocab[i];
      this.vocab.set(token, { id: i, score });
      this.idToTokenMap.set(i, token);
      if (token.length > this.maxTokenLen) {
        this.maxTokenLen = token.length;
      }
    }

    // Override with added tokens (special tokens may have different IDs)
    for (const at of tokenizerJson.added_tokens) {
      this.vocab.set(at.content, { id: at.id, score: 0 });
      this.idToTokenMap.set(at.id, at.content);
    }

    this.unkId = tokenizerJson.model.unk_id;
    this.clsId = this.tokenToId('[CLS]') ?? 1;
    this.sepId = this.tokenToId('[SEP]') ?? 2;
    this.padId = this.tokenToId('[PAD]') ?? 0;
  }

  tokenToId(token: string): number | undefined {
    return this.vocab.get(token)?.id;
  }

  idToToken(id: number): string | undefined {
    return this.idToTokenMap.get(id);
  }

  /**
   * Encode text to model inputs.
   * - Normalizes (strip whitespace)
   * - Pre-tokenizes with Metaspace (▁ prefix)
   * - Unigram encodes each word
   * - Wraps with [CLS] ... [SEP]
   * - Pads/truncates to maxLength
   * - Tracks word IDs and character offsets for BIO merging
   */
  encode(text: string, maxLength: number = 256): EncodeResult {
    // 1. Normalize: strip leading/trailing whitespace, NFC
    const normalized = text.trim().normalize('NFC');

    // 2. Pre-tokenize: split into words by Metaspace rules
    //    Metaspace with prepend_scheme=always: prepend ▁ to all pieces,
    //    split on whitespace, each piece gets ▁ prefix
    const words = this.metaspaceSplit(normalized);

    // 3. Unigram encode each word, tracking offsets
    const allTokens: string[] = [];
    const allIds: number[] = [];
    const allWordIds: (number | null)[] = [];
    const allOffsets: [number, number][] = [];

    for (let wordIdx = 0; wordIdx < words.length; wordIdx++) {
      const { text: wordText, originalStart } = words[wordIdx];
      const subTokens = this.unigramEncode(wordText);

      let localOffset = 0;
      for (const st of subTokens) {
        const tokenId = this.tokenToId(st) ?? this.unkId;
        allTokens.push(st);
        allIds.push(tokenId);
        allWordIds.push(wordIdx);

        // Calculate char offset in original text
        // Remove ▁ prefix for offset calculation
        const cleanLen = st.startsWith('▁') ? st.length - 1 : st.length;
        const startChar = originalStart + localOffset;
        allOffsets.push([startChar, startChar + cleanLen]);
        localOffset += cleanLen;
      }
    }

    // 4. Post-process: [CLS] + tokens + [SEP], truncate to maxLength - 2
    const maxTokens = maxLength - 2; // room for [CLS] and [SEP]
    const truncatedIds = allIds.slice(0, maxTokens);
    const truncatedTokens = allTokens.slice(0, maxTokens);
    const truncatedWordIds = allWordIds.slice(0, maxTokens);
    const truncatedOffsets = allOffsets.slice(0, maxTokens);

    // Build final arrays
    const finalIds: number[] = [this.clsId, ...truncatedIds, this.sepId];
    const finalTokens: string[] = ['[CLS]', ...truncatedTokens, '[SEP]'];
    const finalWordIds: (number | null)[] = [null, ...truncatedWordIds, null];
    const finalOffsets: [number, number][] = [[0, 0], ...truncatedOffsets, [0, 0]];

    // 5. Pad to maxLength
    const padCount = maxLength - finalIds.length;
    for (let i = 0; i < padCount; i++) {
      finalIds.push(this.padId);
      finalTokens.push('[PAD]');
      finalWordIds.push(null);
      finalOffsets.push([0, 0]);
    }

    // Build BigInt64Arrays
    const inputIds = new BigInt64Array(maxLength);
    const attentionMask = new BigInt64Array(maxLength);

    for (let i = 0; i < maxLength; i++) {
      inputIds[i] = BigInt(finalIds[i]);
      attentionMask[i] = finalIds[i] !== this.padId ? 1n : 0n;
    }

    return {
      inputIds,
      attentionMask,
      tokens: finalTokens,
      wordIds: finalWordIds,
      offsets: finalOffsets,
    };
  }

  /**
   * Metaspace pre-tokenization:
   * - Replace all spaces with ▁
   * - Prepend ▁ to the entire string
   * - Split on ▁ boundaries (each piece starts with ▁)
   */
  private metaspaceSplit(text: string): Array<{ text: string; originalStart: number }> {
    if (text.length === 0) return [];

    const results: Array<{ text: string; originalStart: number }> = [];

    // Split by whitespace first, track positions
    const parts: Array<{ word: string; start: number }> = [];
    let i = 0;
    while (i < text.length) {
      // Skip whitespace
      while (i < text.length && /\s/.test(text[i])) i++;
      if (i >= text.length) break;

      const start = i;
      while (i < text.length && !/\s/.test(text[i])) i++;
      parts.push({ word: text.slice(start, i), start });
    }

    // Each word gets ▁ prepended (Metaspace prepend_scheme=always)
    for (const { word, start } of parts) {
      results.push({ text: '▁' + word, originalStart: start });
    }

    return results;
  }

  /**
   * Unigram (Viterbi) segmentation.
   *
   * Forward DP: for each position, find the best scoring tokenization
   * ending at that position by trying all possible last tokens.
   * Then backtrack to get the optimal segmentation.
   */
  private unigramEncode(text: string): string[] {
    if (text.length === 0) return [];

    const n = text.length;

    // best[i] = { score, tokenLen } for best segmentation of text[0..i)
    const best: Array<{ score: number; tokenLen: number }> = new Array(n + 1);
    best[0] = { score: 0, tokenLen: 0 };

    for (let i = 1; i <= n; i++) {
      best[i] = { score: -Infinity, tokenLen: 0 };

      // Try all possible last tokens ending at position i
      const maxLen = Math.min(i, this.maxTokenLen);
      for (let len = 1; len <= maxLen; len++) {
        const substr = text.slice(i - len, i);
        const entry = this.vocab.get(substr);
        if (entry) {
          const candidate = best[i - len].score + entry.score;
          if (candidate > best[i].score) {
            best[i] = { score: candidate, tokenLen: len };
          }
        }
      }

      // If no token found, fall back to single character (UNK)
      if (best[i].score === -Infinity) {
        best[i] = { score: best[i - 1].score + -100, tokenLen: 1 };
      }
    }

    // Backtrack to get tokens
    const tokens: string[] = [];
    let pos = n;
    while (pos > 0) {
      const { tokenLen } = best[pos];
      const token = text.slice(pos - tokenLen, pos);
      const entry = this.vocab.get(token);
      if (entry) {
        tokens.push(token);
      } else {
        // Unknown character — push as-is, will map to UNK id
        tokens.push(token);
      }
      pos -= tokenLen;
    }

    tokens.reverse();
    return tokens;
  }

  decode(ids: number[]): string {
    const tokens = ids
      .map((id) => this.idToToken(id) ?? '')
      .filter((t) => t !== '[CLS]' && t !== '[SEP]' && t !== '[PAD]');

    return tokens.join('').replace(/▁/g, ' ').trim();
  }
}
