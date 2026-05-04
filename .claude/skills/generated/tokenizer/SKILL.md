---
name: tokenizer
description: "Skill for the Tokenizer area of genguard. 13 symbols across 4 files."
---

# Tokenizer

13 symbols | 4 files | Cohesion: 72%

## When to Use

- Working with code in `src/`
- Understanding how downloadTextFile, App, initTokenizer work
- Modifying tokenizer-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/tokenizer/sentencepiece-tokenizer.ts` | DeBERTaTokenizer, idToToken, decode, constructor, tokenToId (+3) |
| `src/sidepanel/App.tsx` | App, ModelStatusPage |
| `src/core/detectors/ner-detector.ts` | initTokenizer, isTokenizerReady |
| `src/lib/model-store.ts` | downloadTextFile |

## Entry Points

Start here when exploring this area:

- **`downloadTextFile`** (Function) — `src/lib/model-store.ts:167`
- **`App`** (Function) — `src/sidepanel/App.tsx:42`
- **`initTokenizer`** (Function) — `src/core/detectors/ner-detector.ts:18`
- **`isTokenizerReady`** (Function) — `src/core/detectors/ner-detector.ts:23`
- **`DeBERTaTokenizer`** (Class) — `src/core/tokenizer/sentencepiece-tokenizer.ts:41`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `DeBERTaTokenizer` | Class | `src/core/tokenizer/sentencepiece-tokenizer.ts` | 41 |
| `downloadTextFile` | Function | `src/lib/model-store.ts` | 167 |
| `App` | Function | `src/sidepanel/App.tsx` | 42 |
| `initTokenizer` | Function | `src/core/detectors/ner-detector.ts` | 18 |
| `isTokenizerReady` | Function | `src/core/detectors/ner-detector.ts` | 23 |
| `idToToken` | Method | `src/core/tokenizer/sentencepiece-tokenizer.ts` | 83 |
| `decode` | Method | `src/core/tokenizer/sentencepiece-tokenizer.ts` | 261 |
| `constructor` | Method | `src/core/tokenizer/sentencepiece-tokenizer.ts` | 52 |
| `tokenToId` | Method | `src/core/tokenizer/sentencepiece-tokenizer.ts` | 79 |
| `encode` | Method | `src/core/tokenizer/sentencepiece-tokenizer.ts` | 96 |
| `metaspaceSplit` | Method | `src/core/tokenizer/sentencepiece-tokenizer.ts` | 177 |
| `unigramEncode` | Method | `src/core/tokenizer/sentencepiece-tokenizer.ts` | 210 |
| `ModelStatusPage` | Function | `src/sidepanel/App.tsx` | 801 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `HandleChange → MetaspaceSplit` | cross_community | 8 |
| `HandleChange → UnigramEncode` | cross_community | 8 |
| `HandleChange → TokenToId` | cross_community | 8 |
| `HandleScan → MetaspaceSplit` | cross_community | 8 |
| `HandleScan → UnigramEncode` | cross_community | 8 |
| `HandleScan → TokenToId` | cross_community | 8 |
| `HandleChange → IsTokenizerReady` | cross_community | 6 |
| `HandleScan → IsTokenizerReady` | cross_community | 6 |
| `App → OpenDB` | cross_community | 5 |
| `App → HfUrl` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Background | 3 calls |
| Ocr | 3 calls |
| Sidepanel | 2 calls |
| Detectors | 1 calls |

## How to Explore

1. `gitnexus_context({name: "downloadTextFile"})` — see callers and callees
2. `gitnexus_query({query: "tokenizer"})` — find related execution flows
3. Read key files listed above for implementation details
