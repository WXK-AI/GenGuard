---
name: detectors
description: "Skill for the Detectors area of genguard. 21 symbols across 5 files."
---

# Detectors

21 symbols | 5 files | Cohesion: 86%

## When to Use

- Working with code in `src/`
- Understanding how runInference, isReady, detectRegex work
- Modifying detectors-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/core/detectors/ner-detector.ts` | softmaxArgmax, classifyChunk, mergeAdjacentFindings, yieldToUI, detectNER (+4) |
| `src/core/detectors/context-scorer.ts` | spans_overlap, pickWinner, withSources, dedup, buildSuggestions (+1) |
| `src/core/detectors/regex-detector.ts` | luhnCheck, getPatterns, detectRegex |
| `src/lib/ort-engine.ts` | runInference, isReady |
| `src/core/engine.ts` | scanText |

## Entry Points

Start here when exploring this area:

- **`runInference`** (Function) — `src/lib/ort-engine.ts:99`
- **`isReady`** (Function) — `src/lib/ort-engine.ts:122`
- **`detectRegex`** (Function) — `src/core/detectors/regex-detector.ts:89`
- **`detectNER`** (Function) — `src/core/detectors/ner-detector.ts:320`
- **`scoreFindings`** (Function) — `src/core/detectors/context-scorer.ts:140`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `runInference` | Function | `src/lib/ort-engine.ts` | 99 |
| `isReady` | Function | `src/lib/ort-engine.ts` | 122 |
| `detectRegex` | Function | `src/core/detectors/regex-detector.ts` | 89 |
| `detectNER` | Function | `src/core/detectors/ner-detector.ts` | 320 |
| `scoreFindings` | Function | `src/core/detectors/context-scorer.ts` | 140 |
| `scanText` | Function | `src/core/engine.ts` | 39 |
| `luhnCheck` | Function | `src/core/detectors/regex-detector.ts` | 48 |
| `getPatterns` | Function | `src/core/detectors/regex-detector.ts` | 72 |
| `softmaxArgmax` | Function | `src/core/detectors/ner-detector.ts` | 32 |
| `classifyChunk` | Function | `src/core/detectors/ner-detector.ts` | 57 |
| `mergeAdjacentFindings` | Function | `src/core/detectors/ner-detector.ts` | 274 |
| `yieldToUI` | Function | `src/core/detectors/ner-detector.ts` | 312 |
| `spans_overlap` | Function | `src/core/detectors/context-scorer.ts` | 28 |
| `pickWinner` | Function | `src/core/detectors/context-scorer.ts` | 41 |
| `withSources` | Function | `src/core/detectors/context-scorer.ts` | 46 |
| `dedup` | Function | `src/core/detectors/context-scorer.ts` | 75 |
| `buildSuggestions` | Function | `src/core/detectors/context-scorer.ts` | 104 |
| `getTag` | Function | `src/core/detectors/ner-detector.ts` | 83 |
| `aggregateToWords` | Function | `src/core/detectors/ner-detector.ts` | 113 |
| `mergeEntities` | Function | `src/core/detectors/ner-detector.ts` | 192 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `HandleChange → MetaspaceSplit` | cross_community | 8 |
| `HandleChange → UnigramEncode` | cross_community | 8 |
| `HandleChange → TokenToId` | cross_community | 8 |
| `HandleChange → RunInference` | cross_community | 8 |
| `HandleScan → MetaspaceSplit` | cross_community | 8 |
| `HandleScan → UnigramEncode` | cross_community | 8 |
| `HandleScan → TokenToId` | cross_community | 8 |
| `HandleChange → GetPatterns` | cross_community | 7 |
| `HandleChange → LuhnCheck` | cross_community | 7 |
| `HandleChange → IsReady` | cross_community | 7 |

## Connected Areas

| Area | Connections |
|------|-------------|
| Tokenizer | 2 calls |

## How to Explore

1. `gitnexus_context({name: "runInference"})` — see callers and callees
2. `gitnexus_query({query: "detectors"})` — find related execution flows
3. Read key files listed above for implementation details
