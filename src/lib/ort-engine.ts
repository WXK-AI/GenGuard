/**
 * ORT Engine — runs onnxruntime-web in a page context (side panel).
 *
 * MV3 CSP forbids blob: and dynamic import() of non-'self' URLs in workers.
 * The side panel is a regular page with 'self' origin, so ORT's WASM backend
 * can load its .mjs glue and .wasm binaries from chrome.runtime.getURL().
 *
 * The WASM execution itself runs off the main thread internally (ORT manages
 * its own threading via SharedArrayBuffer when available).
 */

import * as ort from 'onnxruntime-web';
import { NER_MODEL_CONTRACT } from '../core/detectors/ner-model-contract';

let session: ort.InferenceSession | null = null;
let _initialized = false;
let _envConfigured = false;

/**
 * Configure the global ORT WASM env exactly once, before any session is
 * created (NER or OCR). Safe to call multiple times.
 */
export function ensureOrtEnv() {
  if (_envConfigured) return;
  const basePath = chrome.runtime.getURL('ort/');
  ort.env.wasm.wasmPaths = basePath;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;
  ort.env.wasm.proxy = false;
  ort.env.logLevel = 'warning';
  _envConfigured = true;
}

export type OrtStatus = 'not_loaded' | 'loading' | 'ready' | 'error';
export type StatusCallback = (status: OrtStatus, error?: string) => void;

/**
 * Initialize ORT and create an inference session from a model ArrayBuffer.
 * Must be called from a page context (side panel), NOT a service worker.
 */
export async function initSession(
  modelBuffer: ArrayBuffer,
  onStatus?: StatusCallback,
): Promise<void> {
  if (_initialized && session) return;

  try {
    onStatus?.('loading');
    ensureOrtEnv();

    const t0 = performance.now();

    session = await ort.InferenceSession.create(modelBuffer, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
      executionMode: 'sequential',
      enableCpuMemArena: true,
      enableMemPattern: true,
    });

    const loadMs = Math.round(performance.now() - t0);
    console.log(`[GenGuard] ORT session created in ${loadMs} ms`);

    // Warm-up inference
    await warmUp();

    _initialized = true;
    onStatus?.('ready');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[GenGuard] ORT init failed:', msg);
    onStatus?.('error', msg);
    throw err;
  }
}

/** Run a dummy inference to pre-compile WASM. */
async function warmUp(): Promise<void> {
  if (!session) return;

  const seqLen = NER_MODEL_CONTRACT.maxSeqLen;
  const feeds = {
    input_ids: new ort.Tensor('int64', new BigInt64Array(seqLen).fill(0n), [1, seqLen]),
    attention_mask: new ort.Tensor('int64', new BigInt64Array(seqLen).fill(0n), [1, seqLen]),
  };

  const t0 = performance.now();
  await session.run(feeds);
  console.log(`[GenGuard] Warm-up inference: ${Math.round(performance.now() - t0)} ms`);
}

/** Default inference timeout (30 seconds). */
const INFERENCE_TIMEOUT_MS = 30_000;

/**
 * Run NER inference on tokenized input.
 * Returns raw logits [1, seqLen, numLabels].
 * Throws if inference takes longer than INFERENCE_TIMEOUT_MS.
 */
export async function runInference(
  inputIds: BigInt64Array,
  attentionMask: BigInt64Array,
): Promise<Float32Array> {
  if (!session) throw new Error('ORT session not initialized');

  const seqLen = NER_MODEL_CONTRACT.maxSeqLen;
  const feeds = {
    input_ids: new ort.Tensor('int64', inputIds, [1, seqLen]),
    attention_mask: new ort.Tensor('int64', attentionMask, [1, seqLen]),
  };

  const result = await Promise.race([
    session.run(feeds),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('ORT inference timed out')), INFERENCE_TIMEOUT_MS),
    ),
  ]);

  const logits = result.logits;
  return logits.data as Float32Array;
}

export function isReady(): boolean {
  return _initialized && session !== null;
}

export async function dispose(): Promise<void> {
  if (session) {
    await session.release();
    session = null;
  }
  _initialized = false;
}

export { ort };
