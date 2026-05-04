---
name: ocr
description: "Skill for the Ocr area of genguard. 22 symbols across 7 files."
---

# Ocr

22 symbols | 7 files | Cohesion: 84%

## When to Use

- Working with code in `src/`
- Understanding how extractTextFromImage, imageFileToImgData, extractTextFromImageOrt work
- Modifying ocr-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/extractors/ocr/preprocess.ts` | imageFileToImgData, toImageData, floorMultiple, resizeForDetection, rgbaToNormalizedChw (+3) |
| `src/core/extractors/ocr/ocr-engine.ts` | isOcrReady, getDict, runDetection, runRecognition, initOcrSessions |
| `src/lib/ort-engine.ts` | ensureOrtEnv, initSession, warmUp |
| `src/core/extractors/ocr/db-postprocess.ts` | extractBoxes, union |
| `src/core/extractors/ocr/ctc-decode.ts` | ctcGreedyDecodeBatch, parseDict |
| `src/core/extractors/image-ocr.ts` | extractTextFromImage |
| `src/core/extractors/ocr/ocr-pipeline.ts` | extractTextFromImageOrt |

## Entry Points

Start here when exploring this area:

- **`extractTextFromImage`** (Function) — `src/core/extractors/image-ocr.ts:31`
- **`imageFileToImgData`** (Function) — `src/core/extractors/ocr/preprocess.ts:42`
- **`extractTextFromImageOrt`** (Function) — `src/core/extractors/ocr/ocr-pipeline.ts:31`
- **`isOcrReady`** (Function) — `src/core/extractors/ocr/ocr-engine.ts:56`
- **`getDict`** (Function) — `src/core/extractors/ocr/ocr-engine.ts:60`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `extractTextFromImage` | Function | `src/core/extractors/image-ocr.ts` | 31 |
| `imageFileToImgData` | Function | `src/core/extractors/ocr/preprocess.ts` | 42 |
| `extractTextFromImageOrt` | Function | `src/core/extractors/ocr/ocr-pipeline.ts` | 31 |
| `isOcrReady` | Function | `src/core/extractors/ocr/ocr-engine.ts` | 56 |
| `getDict` | Function | `src/core/extractors/ocr/ocr-engine.ts` | 60 |
| `runDetection` | Function | `src/core/extractors/ocr/ocr-engine.ts` | 68 |
| `runRecognition` | Function | `src/core/extractors/ocr/ocr-engine.ts` | 91 |
| `extractBoxes` | Function | `src/core/extractors/ocr/db-postprocess.ts` | 29 |
| `union` | Function | `src/core/extractors/ocr/db-postprocess.ts` | 59 |
| `ctcGreedyDecodeBatch` | Function | `src/core/extractors/ocr/ctc-decode.ts` | 43 |
| `preprocessForDetection` | Function | `src/core/extractors/ocr/preprocess.ts` | 122 |
| `preprocessForRecognition` | Function | `src/core/extractors/ocr/preprocess.ts` | 178 |
| `ensureOrtEnv` | Function | `src/lib/ort-engine.ts` | 22 |
| `initSession` | Function | `src/lib/ort-engine.ts` | 40 |
| `initOcrSessions` | Function | `src/core/extractors/ocr/ocr-engine.ts` | 24 |
| `parseDict` | Function | `src/core/extractors/ocr/ctc-decode.ts` | 23 |
| `toImageData` | Function | `src/core/extractors/ocr/preprocess.ts` | 37 |
| `floorMultiple` | Function | `src/core/extractors/ocr/preprocess.ts` | 56 |
| `resizeForDetection` | Function | `src/core/extractors/ocr/preprocess.ts` | 66 |
| `rgbaToNormalizedChw` | Function | `src/core/extractors/ocr/preprocess.ts` | 100 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `ExtractFileText → FloorMultiple` | cross_community | 6 |
| `ExtractFileText → ToImageData` | cross_community | 6 |
| `ExtractFileText → RgbaToNormalizedChw` | cross_community | 5 |
| `ExtractFileText → IsOcrReady` | cross_community | 4 |
| `ExtractFileText → ImageFileToImgData` | cross_community | 4 |
| `ExtractFileText → RunDetection` | cross_community | 4 |

## How to Explore

1. `gitnexus_context({name: "extractTextFromImage"})` — see callers and callees
2. `gitnexus_query({query: "ocr"})` — find related execution flows
3. Read key files listed above for implementation details
