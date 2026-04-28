/**
 * OCR Preprocessing — pure DOM/canvas helpers, no ORT dependencies.
 *
 * Converts an image File into normalized Float32 tensors ready for the
 * detection and recognition ONNX models.
 */

import { OCR_MODEL_CONTRACT } from './ocr-contract';

export interface ImgData {
  data: Uint8ClampedArray; // RGBA, length = w*h*4
  w: number;
  h: number;
}

export interface DetTensor {
  tensor: Float32Array;
  resizedH: number;
  resizedW: number;
  scaleX: number; // origW / resizedW
  scaleY: number; // origH / resizedH
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RecBatch {
  data: Float32Array; // [N, 3, H, W]
  count: number;
  height: number;
  width: number;
}

function toImageData(img: ImgData): ImageData {
  return new ImageData(new Uint8ClampedArray(img.data), img.w, img.h);
}

/** Decode an image File into raw RGBA pixel data via OffscreenCanvas. */
export async function imageFileToImgData(file: File): Promise<ImgData> {
  const bitmap = await createImageBitmap(file);
  const w = bitmap.width;
  const h = bitmap.height;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
  ctx.drawImage(bitmap, 0, 0);
  const imgData = ctx.getImageData(0, 0, w, h);
  bitmap.close();
  return { data: imgData.data, w, h };
}

/** Round n down to the nearest multiple of m. */
function floorMultiple(n: number, m: number): number {
  return Math.max(m, Math.floor(n / m) * m);
}

/**
 * Resize the image so that:
 *   - longest side ≤ maxSide
 *   - both dimensions are multiples of `sizeMultiple` (32)
 * Returns the resized RGBA buffer plus the scale factors back to original.
 */
function resizeForDetection(img: ImgData): { resized: ImgData; scaleX: number; scaleY: number } {
  const { maxSide, sizeMultiple } = OCR_MODEL_CONTRACT.det;
  let ratio = 1;
  const longest = Math.max(img.w, img.h);
  if (longest > maxSide) ratio = maxSide / longest;

  const newW = floorMultiple(Math.round(img.w * ratio), sizeMultiple);
  const newH = floorMultiple(Math.round(img.h * ratio), sizeMultiple);

  const scaleX = img.w / newW;
  const scaleY = img.h / newH;

  // Resize via OffscreenCanvas (browser-native, fast bilinear)
  const src = new OffscreenCanvas(img.w, img.h);
  const sctx = src.getContext('2d')!;
  sctx.putImageData(toImageData(img), 0, 0);

  const dst = new OffscreenCanvas(newW, newH);
  const dctx = dst.getContext('2d')!;
  dctx.imageSmoothingEnabled = true;
  dctx.imageSmoothingQuality = 'high';
  dctx.drawImage(src, 0, 0, newW, newH);
  const resized = dctx.getImageData(0, 0, newW, newH);

  return {
    resized: { data: resized.data, w: newW, h: newH },
    scaleX,
    scaleY,
  };
}

/**
 * Convert resized RGBA pixel data into a normalized [1, 3, H, W] CHW Float32 tensor.
 */
function rgbaToNormalizedChw(
  img: ImgData,
  mean: readonly number[],
  std: readonly number[],
): Float32Array {
  const { w, h, data } = img;
  const out = new Float32Array(3 * h * w);
  const planeR = 0;
  const planeG = h * w;
  const planeB = 2 * h * w;

  for (let i = 0, p = 0; i < h * w; i++, p += 4) {
    out[planeR + i] = (data[p]     / 255 - mean[0]) / std[0];
    out[planeG + i] = (data[p + 1] / 255 - mean[1]) / std[1];
    out[planeB + i] = (data[p + 2] / 255 - mean[2]) / std[2];
  }
  return out;
}

/**
 * Full detection preprocessing: File → CHW Float32 tensor + scale info.
 */
export function preprocessForDetection(img: ImgData): DetTensor {
  const { resized, scaleX, scaleY } = resizeForDetection(img);
  const { mean, std } = OCR_MODEL_CONTRACT.det;
  const tensor = rgbaToNormalizedChw(resized, mean, std);
  return {
    tensor,
    resizedH: resized.h,
    resizedW: resized.w,
    scaleX,
    scaleY,
  };
}

/**
 * Crop one box (in original-image coordinates) and resize to recognition input height.
 * Returns CHW Float32 of shape [3, recH, targetW] where targetW preserves aspect ratio.
 */
function cropAndResizeBox(img: ImgData, box: Box): { data: Float32Array; w: number } | null {
  const { inputHeight, maxWidth, mean, std } = OCR_MODEL_CONTRACT.rec;

  // Clamp box to image bounds
  const x0 = Math.max(0, Math.min(img.w - 1, Math.floor(box.x)));
  const y0 = Math.max(0, Math.min(img.h - 1, Math.floor(box.y)));
  const x1 = Math.max(x0 + 1, Math.min(img.w, Math.ceil(box.x + box.w)));
  const y1 = Math.max(y0 + 1, Math.min(img.h, Math.ceil(box.y + box.h)));
  const cropW = x1 - x0;
  const cropH = y1 - y0;
  if (cropW < 2 || cropH < 2) return null;

  // Compute target width preserving aspect ratio
  const ratio = cropW / cropH;
  let targetW = Math.ceil(inputHeight * ratio);
  if (targetW < 4) targetW = 4;
  if (targetW > maxWidth) targetW = maxWidth;

  // Source canvas with the crop
  const src = new OffscreenCanvas(img.w, img.h);
  src.getContext('2d')!.putImageData(toImageData(img), 0, 0);

  // Destination canvas at recognition size
  const dst = new OffscreenCanvas(targetW, inputHeight);
  const dctx = dst.getContext('2d')!;
  dctx.imageSmoothingEnabled = true;
  dctx.imageSmoothingQuality = 'high';
  dctx.drawImage(src, x0, y0, cropW, cropH, 0, 0, targetW, inputHeight);
  const pixels = dctx.getImageData(0, 0, targetW, inputHeight);

  // Convert to CHW normalized
  const data = rgbaToNormalizedChw({ data: pixels.data, w: targetW, h: inputHeight }, mean, std);
  return { data, w: targetW };
}

/**
 * Pack multiple boxes into a single recognition batch.
 * Each crop is resized to height H, then right-padded with zeros to the batch's max width.
 */
export function preprocessForRecognition(
  img: ImgData,
  boxes: Box[],
): { batch: RecBatch; keptBoxIndices: number[] } {
  const H = OCR_MODEL_CONTRACT.rec.inputHeight;
  const crops: { data: Float32Array; w: number }[] = [];
  const keptBoxIndices: number[] = [];

  for (let i = 0; i < boxes.length; i++) {
    const c = cropAndResizeBox(img, boxes[i]);
    if (c) {
      crops.push(c);
      keptBoxIndices.push(i);
    }
  }

  if (crops.length === 0) {
    return {
      batch: { data: new Float32Array(0), count: 0, height: H, width: 0 },
      keptBoxIndices: [],
    };
  }

  const maxW = Math.max(...crops.map((c) => c.w));
  const N = crops.length;
  const batch = new Float32Array(N * 3 * H * maxW);

  for (let n = 0; n < N; n++) {
    const c = crops[n];
    const cw = c.w;
    const sliceOffset = n * 3 * H * maxW;
    // Copy each channel row by row, leaving the right side as zeros
    for (let ch = 0; ch < 3; ch++) {
      for (let y = 0; y < H; y++) {
        const srcRow = ch * H * cw + y * cw;
        const dstRow = sliceOffset + ch * H * maxW + y * maxW;
        for (let x = 0; x < cw; x++) {
          batch[dstRow + x] = c.data[srcRow + x];
        }
      }
    }
  }

  return {
    batch: { data: batch, count: N, height: H, width: maxW },
    keptBoxIndices,
  };
}
