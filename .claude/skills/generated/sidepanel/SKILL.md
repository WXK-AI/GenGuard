---
name: sidepanel
description: "Skill for the Sidepanel area of genguard. 22 symbols across 5 files."
---

# Sidepanel

22 symbols | 5 files | Cohesion: 88%

## When to Use

- Working with code in `src/`
- Understanding how getHistory, addHistoryEntry, handleChange work
- Modifying sidepanel-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/sidepanel/App.tsx` | getMaskText, FindingRow, DashboardPage, removeFile, redactFindings (+9) |
| `src/lib/history-store.ts` | getHistory, addHistoryEntry, clearHistory |
| `src/core/engine.ts` | scanSource, assess, assessInner |
| `src/lib/ort-engine.ts` | dispose |
| `src/core/extractors/ocr/ocr-engine.ts` | disposeOcr |

## Entry Points

Start here when exploring this area:

- **`getHistory`** (Function) — `src/lib/history-store.ts:22`
- **`addHistoryEntry`** (Function) — `src/lib/history-store.ts:27`
- **`handleChange`** (Function) — `src/sidepanel/App.tsx:74`
- **`assess`** (Function) — `src/core/engine.ts:128`
- **`dispose`** (Function) — `src/lib/ort-engine.ts:126`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `getHistory` | Function | `src/lib/history-store.ts` | 22 |
| `addHistoryEntry` | Function | `src/lib/history-store.ts` | 27 |
| `handleChange` | Function | `src/sidepanel/App.tsx` | 74 |
| `assess` | Function | `src/core/engine.ts` | 128 |
| `dispose` | Function | `src/lib/ort-engine.ts` | 126 |
| `handleReloadModel` | Function | `src/sidepanel/App.tsx` | 435 |
| `disposeOcr` | Function | `src/core/extractors/ocr/ocr-engine.ts` | 114 |
| `clearHistory` | Function | `src/lib/history-store.ts` | 45 |
| `getMaskText` | Function | `src/sidepanel/App.tsx` | 11 |
| `FindingRow` | Function | `src/sidepanel/App.tsx` | 504 |
| `DashboardPage` | Function | `src/sidepanel/App.tsx` | 544 |
| `removeFile` | Function | `src/sidepanel/App.tsx` | 588 |
| `redactFindings` | Function | `src/sidepanel/App.tsx` | 593 |
| `handleScan` | Function | `src/sidepanel/App.tsx` | 558 |
| `HistoryPage` | Function | `src/sidepanel/App.tsx` | 886 |
| `formatTime` | Function | `src/sidepanel/App.tsx` | 948 |
| `scanSource` | Function | `src/core/engine.ts` | 106 |
| `assessInner` | Function | `src/core/engine.ts` | 139 |
| `SettingsPage` | Function | `src/sidepanel/App.tsx` | 960 |
| `save` | Function | `src/sidepanel/App.tsx` | 981 |

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
| Detectors | 2 calls |

## How to Explore

1. `gitnexus_context({name: "getHistory"})` — see callers and callees
2. `gitnexus_query({query: "sidepanel"})` — find related execution flows
3. Read key files listed above for implementation details
