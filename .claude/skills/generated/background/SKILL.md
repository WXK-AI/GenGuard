---
name: background
description: "Skill for the Background area of genguard. 13 symbols across 2 files."
---

# Background

13 symbols | 2 files | Cohesion: 92%

## When to Use

- Working with code in `src/`
- Understanding how hasFile, getFile, clearAll work
- Modifying background-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/lib/model-store.ts` | openDB, hasFile, getFile, putFile, clearAll (+2) |
| `src/background/service-worker.ts` | broadcast, sendDownloadStatus, sendOcrStatus, doDownload, doOcrDownload (+1) |

## Entry Points

Start here when exploring this area:

- **`hasFile`** (Function) — `src/lib/model-store.ts:31`
- **`getFile`** (Function) — `src/lib/model-store.ts:44`
- **`clearAll`** (Function) — `src/lib/model-store.ts:79`
- **`downloadFile`** (Function) — `src/lib/model-store.ts:105`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `hasFile` | Function | `src/lib/model-store.ts` | 31 |
| `getFile` | Function | `src/lib/model-store.ts` | 44 |
| `clearAll` | Function | `src/lib/model-store.ts` | 79 |
| `downloadFile` | Function | `src/lib/model-store.ts` | 105 |
| `openDB` | Function | `src/lib/model-store.ts` | 16 |
| `putFile` | Function | `src/lib/model-store.ts` | 60 |
| `hfUrl` | Function | `src/lib/model-store.ts` | 97 |
| `broadcast` | Function | `src/background/service-worker.ts` | 33 |
| `sendDownloadStatus` | Function | `src/background/service-worker.ts` | 39 |
| `sendOcrStatus` | Function | `src/background/service-worker.ts` | 48 |
| `doDownload` | Function | `src/background/service-worker.ts` | 98 |
| `doOcrDownload` | Function | `src/background/service-worker.ts` | 134 |
| `updateOverall` | Function | `src/background/service-worker.ts` | 163 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `App → OpenDB` | cross_community | 5 |
| `App → HfUrl` | cross_community | 4 |

## How to Explore

1. `gitnexus_context({name: "hasFile"})` — see callers and callees
2. `gitnexus_query({query: "background"})` — find related execution flows
3. Read key files listed above for implementation details
