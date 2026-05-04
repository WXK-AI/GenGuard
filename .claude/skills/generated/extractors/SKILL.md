---
name: extractors
description: "Skill for the Extractors area of genguard. 5 symbols across 3 files."
---

# Extractors

5 symbols | 3 files | Cohesion: 89%

## When to Use

- Working with code in `src/`
- Understanding how extractPdfText, extractPdfFromFile, extractDocxText work
- Modifying extractors-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/extractors/pdf-extractor.ts` | extractPdfText, extractPdfFromFile |
| `src/core/extractors/docx-extractor.ts` | extractDocxText, extractDocxFromFile |
| `src/core/engine.ts` | extractFileText |

## Entry Points

Start here when exploring this area:

- **`extractPdfText`** (Function) — `src/core/extractors/pdf-extractor.ts:24`
- **`extractPdfFromFile`** (Function) — `src/core/extractors/pdf-extractor.ts:52`
- **`extractDocxText`** (Function) — `src/core/extractors/docx-extractor.ts:21`
- **`extractDocxFromFile`** (Function) — `src/core/extractors/docx-extractor.ts:35`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `extractPdfText` | Function | `src/core/extractors/pdf-extractor.ts` | 24 |
| `extractPdfFromFile` | Function | `src/core/extractors/pdf-extractor.ts` | 52 |
| `extractDocxText` | Function | `src/core/extractors/docx-extractor.ts` | 21 |
| `extractDocxFromFile` | Function | `src/core/extractors/docx-extractor.ts` | 35 |
| `extractFileText` | Function | `src/core/engine.ts` | 63 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `ExtractFileText → FloorMultiple` | cross_community | 6 |
| `ExtractFileText → ToImageData` | cross_community | 6 |
| `ExtractFileText → RgbaToNormalizedChw` | cross_community | 5 |
| `ExtractFileText → IsOcrReady` | cross_community | 4 |
| `ExtractFileText → ImageFileToImgData` | cross_community | 4 |
| `ExtractFileText → RunDetection` | cross_community | 4 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Ocr | 1 calls |

## How to Explore

1. `gitnexus_context({name: "extractPdfText"})` — see callers and callees
2. `gitnexus_query({query: "extractors"})` — find related execution flows
3. Read key files listed above for implementation details
