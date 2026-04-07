/**
 * OCR Engine — manages PaddleOCR PP-OCRv5 detection + recognition ONNX sessions.
 *
 * Mirrors the pattern in `lib/ort-engine.ts`: must run in the side panel page
 * context (not service worker) because of MV3 WASM CSP.
 *
 * Reuses the `ort` instance and WASM paths set up by `ort-engine.ts`. As long
 * as that module has been imported once before initOcrSessions is called, the
 * WASM backend is already configured.
 */

import { ort } from '../../../lib/ort-engine';
import { OCR_MODEL_CONTRACT } from './ocr-contract';
import { parseDict } from './ctc-decode';

let detSession: ort.InferenceSession | null = null;
let recSession: ort.InferenceSession | null = null;
let dict: string[] = [];

export type OcrEngineStatus = 'not_loaded' | 'loading' | 'ready' | 'error';

/**
 * Initialize both OCR sessions from in-memory ArrayBuffers + dict text.
 */
export async function initOcrSessions(
  detBuffer: ArrayBuffer,
  recBuffer: ArrayBuffer,
  dictText: string,
): Promise<void> {
  if (detSession && recSession) return;

  const sessionOptions: ort.InferenceSession.SessionOptions = {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
    executionMode: 'sequential',
    enableCpuMemArena: true,
    enableMemPattern: true,
  };

  const t0 = performance.now();
  detSession = await ort.InferenceSession.create(detBuffer, sessionOptions);
  const t1 = performance.now();
  recSession = await ort.InferenceSession.create(recBuffer, sessionOptions);
  const t2 = performance.now();

  dict = parseDict(dictText);

  console.log(
    `[GenGuard] OCR sessions ready — det: ${Math.round(t1 - t0)} ms, rec: ${Math.round(t2 - t1)} ms, dict: ${dict.length} chars`,
  );
}

export function isOcrReady(): boolean {
  return detSession !== null && recSession !== null && dict.length > 0;
}

export function getDict(): string[] {
  return dict;
}

/**
 * Run the detection model on a [1, 3, H, W] tensor.
 * Returns the probability map as a Float32Array of length H*W.
 */
export async function runDetection(
  tensor: Float32Array,
  h: number,
  w: number,
): Promise<Float32Array> {
  if (!detSession) throw new Error('OCR det session not initialized');

  const input = new ort.Tensor('float32', tensor, [1, 3, h, w]);
  const feeds: Record<string, ort.Tensor> = {};
  // Try the configured input name; fall back to whatever the session reports
  const inputName = detSession.inputNames[0] ?? OCR_MODEL_CONTRACT.detIo.inputName;
  feeds[inputName] = input;

  const results = await detSession.run(feeds);
  const outName = detSession.outputNames[0];
  const out = results[outName];
  return out.data as Float32Array;
}

/**
 * Run the recognition model on a [N, 3, H, W] batch.
 * Returns logits + dimensions for CTC decoding.
 */
export async function runRecognition(
  batch: Float32Array,
  N: number,
  H: number,
  W: number,
): Promise<{ logits: Float32Array; T: number; C: number }> {
  if (!recSession) throw new Error('OCR rec session not initialized');

  const input = new ort.Tensor('float32', batch, [N, 3, H, W]);
  const feeds: Record<string, ort.Tensor> = {};
  const inputName = recSession.inputNames[0] ?? OCR_MODEL_CONTRACT.recIo.inputName;
  feeds[inputName] = input;

  const results = await recSession.run(feeds);
  const outName = recSession.outputNames[0];
  const out = results[outName];
  // Expected shape: [N, T, C]
  const dims = out.dims;
  const T = dims[1];
  const C = dims[2];
  return { logits: out.data as Float32Array, T, C };
}

export async function disposeOcr(): Promise<void> {
  if (detSession) {
    await detSession.release();
    detSession = null;
  }
  if (recSession) {
    await recSession.release();
    recSession = null;
  }
  dict = [];
}
