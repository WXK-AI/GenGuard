---
name: content-scripts
description: "Skill for the Content-scripts area of genguard. 69 symbols across 3 files."
---

# Content-scripts

69 symbols | 3 files | Cohesion: 86%

## When to Use

- Working with code in `src/`
- Understanding how setIntensity, updateHighlights, clearHighlights work
- Modifying content-scripts-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `src/content-scripts/gemini-injector.ts` | sendToBackground, performRedactions, getTextContent, scheduleAssessment, sendIfChanged (+23) |
| `src/content-scripts/chatgpt-injector.ts` | sendToBackground, performRedactions, getTextContent, scheduleAssessment, sendIfChanged (+23) |
| `src/content-scripts/inline-highlighter.ts` | buildStyles, injectStyles, ensureRegistered, setIntensity, charOffsetToRange (+8) |

## Entry Points

Start here when exploring this area:

- **`setIntensity`** (Function) — `src/content-scripts/inline-highlighter.ts:119`
- **`updateHighlights`** (Function) — `src/content-scripts/inline-highlighter.ts:260`
- **`clearHighlights`** (Function) — `src/content-scripts/inline-highlighter.ts:299`
- **`isHighlightSupported`** (Function) — `src/content-scripts/inline-highlighter.ts:308`

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `setIntensity` | Function | `src/content-scripts/inline-highlighter.ts` | 119 |
| `updateHighlights` | Function | `src/content-scripts/inline-highlighter.ts` | 260 |
| `clearHighlights` | Function | `src/content-scripts/inline-highlighter.ts` | 299 |
| `isHighlightSupported` | Function | `src/content-scripts/inline-highlighter.ts` | 308 |
| `sendToBackground` | Function | `src/content-scripts/gemini-injector.ts` | 226 |
| `performRedactions` | Function | `src/content-scripts/gemini-injector.ts` | 268 |
| `getTextContent` | Function | `src/content-scripts/gemini-injector.ts` | 291 |
| `scheduleAssessment` | Function | `src/content-scripts/gemini-injector.ts` | 297 |
| `sendIfChanged` | Function | `src/content-scripts/gemini-injector.ts` | 303 |
| `startPolling` | Function | `src/content-scripts/gemini-injector.ts` | 342 |
| `findSendButton` | Function | `src/content-scripts/gemini-injector.ts` | 358 |
| `interceptSubmit` | Function | `src/content-scripts/gemini-injector.ts` | 364 |
| `interceptKeydown` | Function | `src/content-scripts/gemini-injector.ts` | 373 |
| `shouldBlockSubmit` | Function | `src/content-scripts/gemini-injector.ts` | 383 |
| `showWarningModal` | Function | `src/content-scripts/gemini-injector.ts` | 395 |
| `createBadge` | Function | `src/content-scripts/gemini-injector.ts` | 473 |
| `attach` | Function | `src/content-scripts/gemini-injector.ts` | 511 |
| `sendToBackground` | Function | `src/content-scripts/chatgpt-injector.ts` | 229 |
| `performRedactions` | Function | `src/content-scripts/chatgpt-injector.ts` | 271 |
| `getTextContent` | Function | `src/content-scripts/chatgpt-injector.ts` | 301 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `UpdateHighlights → BuildStyles` | intra_community | 4 |
| `UpdateHighlights → PrefixLength` | intra_community | 4 |
| `Attach → GetTextContent` | intra_community | 4 |
| `Attach → UpdateBadge` | cross_community | 4 |
| `Attach → ClearHighlights` | cross_community | 4 |
| `Attach → GetTextContent` | intra_community | 4 |
| `Attach → UpdateBadge` | cross_community | 4 |
| `Attach → ClearHighlights` | cross_community | 4 |

## How to Explore

1. `gitnexus_context({name: "setIntensity"})` — see callers and callees
2. `gitnexus_query({query: "content-scripts"})` — find related execution flows
3. Read key files listed above for implementation details
