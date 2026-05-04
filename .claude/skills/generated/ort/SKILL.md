---
name: ort
description: "Skill for the Ort area of genguard. 109 symbols across 2 files."
---

# Ort

109 symbols | 2 files | Cohesion: 79%

## When to Use

- Working with code in `public/`
- Understanding how u, wa, $a work
- Modifying ort-related functionality

## Key Files

| File | Symbols |
|------|---------|
| `public/ort/ort-wasm-simd-threaded.jsep.mjs` | u, wa, $a, Ne, Oe (+62) |
| `public/ort/ort-wasm-simd-threaded.mjs` | ortWasmThreaded, a, Ia, J, Ka (+37) |

## Key Symbols

| Symbol | Type | File | Line |
|--------|------|------|------|
| `Me` | Class | `public/ort/ort-wasm-simd-threaded.jsep.mjs` | 25 |
| `nd` | Class | `public/ort/ort-wasm-simd-threaded.mjs` | 20 |
| `Zc` | Class | `public/ort/ort-wasm-simd-threaded.mjs` | 14 |
| `we` | Class | `public/ort/ort-wasm-simd-threaded.jsep.mjs` | 19 |
| `u` | Function | `public/ort/ort-wasm-simd-threaded.jsep.mjs` | 8 |
| `wa` | Function | `public/ort/ort-wasm-simd-threaded.jsep.mjs` | 11 |
| `$a` | Function | `public/ort/ort-wasm-simd-threaded.jsep.mjs` | 24 |
| `Ne` | Function | `public/ort/ort-wasm-simd-threaded.jsep.mjs` | 25 |
| `Oe` | Function | `public/ort/ort-wasm-simd-threaded.jsep.mjs` | 25 |
| `fb` | Function | `public/ort/ort-wasm-simd-threaded.jsep.mjs` | 26 |
| `Ab` | Function | `public/ort/ort-wasm-simd-threaded.jsep.mjs` | 33 |
| `af` | Function | `public/ort/ort-wasm-simd-threaded.jsep.mjs` | 34 |
| `Kb` | Function | `public/ort/ort-wasm-simd-threaded.jsep.mjs` | 44 |
| `zf` | Function | `public/ort/ort-wasm-simd-threaded.jsep.mjs` | 46 |
| `Af` | Function | `public/ort/ort-wasm-simd-threaded.jsep.mjs` | 46 |
| `Bf` | Function | `public/ort/ort-wasm-simd-threaded.jsep.mjs` | 47 |
| `dc` | Function | `public/ort/ort-wasm-simd-threaded.jsep.mjs` | 52 |
| `ec` | Function | `public/ort/ort-wasm-simd-threaded.jsep.mjs` | 54 |
| `fc` | Function | `public/ort/ort-wasm-simd-threaded.jsep.mjs` | 56 |
| `jc` | Function | `public/ort/ort-wasm-simd-threaded.jsep.mjs` | 59 |

## Execution Flows

| Flow | Type | Steps |
|------|------|-------|
| `A → Qa` | cross_community | 8 |
| `OrtWasmThreaded → Wa` | cross_community | 6 |
| `OrtWasmThreaded → Ka` | intra_community | 6 |
| `OrtWasmThreaded → J` | intra_community | 6 |
| `A → Wa` | cross_community | 5 |
| `A → Ta` | cross_community | 5 |
| `Ra → Qa` | cross_community | 4 |
| `OrtWasmThreaded → Wa` | cross_community | 4 |
| `OrtWasmThreaded → Oa` | intra_community | 4 |
| `OrtWasmThreaded → Ia` | intra_community | 4 |

## How to Explore

1. `gitnexus_context({name: "u"})` — see callers and callees
2. `gitnexus_query({query: "ort"})` — find related execution flows
3. Read key files listed above for implementation details
