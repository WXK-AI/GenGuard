/**
 * DB Postprocess — extracts text bounding boxes from the detection model's
 * probability map using a simplified, pure-JS pipeline:
 *
 *   1. Threshold the prob map → binary "is text" mask
 *   2. Two-pass connected components labelling (4-connectivity, union-find)
 *   3. Per component: axis-aligned bounding box + average probability
 *   4. Filter by box size and box-mean probability
 *   5. Expand each box outward by `unclipRatio`
 *   6. Map coordinates back to original image space using scaleX/scaleY
 *   7. Sort top-to-bottom, left-to-right
 *
 * Note: this is intentionally simpler than the official PaddleOCR DB decoder
 * (no rotated polygons, no Vatti clipping). It works well for screenshots and
 * documents where text is roughly horizontal — which is the GenGuard use case.
 */

import { OCR_MODEL_CONTRACT } from './ocr-contract';
import type { Box } from './preprocess';

/**
 * Extract axis-aligned text boxes from a DB probability map.
 *
 * @param probMap   Float32Array of length h*w (single-channel sigmoid output)
 * @param h         detection map height (== resized image height)
 * @param w         detection map width (== resized image width)
 * @param scaleX    origW / resizedW
 * @param scaleY    origH / resizedH
 */
export function extractBoxes(
  probMap: Float32Array,
  h: number,
  w: number,
  scaleX: number,
  scaleY: number,
): Box[] {
  const { binaryThreshold, boxThreshold, minBoxSize, unclipRatio } = OCR_MODEL_CONTRACT.det;

  // ── 1. Threshold ────────────────────────────────────────────────────────
  const total = h * w;
  const isText = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if (probMap[i] >= binaryThreshold) isText[i] = 1;
  }

  // ── 2. Connected components (union-find, 4-connectivity) ────────────────
  const labels = new Int32Array(total); // 0 = background
  const parent: number[] = [0];

  function find(x: number): number {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  }
  function union(a: number, b: number) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  let nextLabel = 1;
  // First pass
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (!isText[idx]) continue;

      const left  = x > 0 ? labels[idx - 1] : 0;
      const above = y > 0 ? labels[idx - w] : 0;

      if (left === 0 && above === 0) {
        labels[idx] = nextLabel;
        parent[nextLabel] = nextLabel;
        nextLabel++;
      } else if (left !== 0 && above === 0) {
        labels[idx] = left;
      } else if (left === 0 && above !== 0) {
        labels[idx] = above;
      } else {
        const m = left < above ? left : above;
        labels[idx] = m;
        if (left !== above) union(left, above);
      }
    }
  }

  // ── 3. Resolve labels + compute per-component stats ─────────────────────
  interface Stat {
    minX: number; minY: number; maxX: number; maxY: number;
    sumProb: number; count: number;
  }
  const stats = new Map<number, Stat>();

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      const lbl = labels[idx];
      if (lbl === 0) continue;
      const root = find(lbl);
      let s = stats.get(root);
      if (!s) {
        s = { minX: x, minY: y, maxX: x, maxY: y, sumProb: 0, count: 0 };
        stats.set(root, s);
      }
      if (x < s.minX) s.minX = x;
      if (x > s.maxX) s.maxX = x;
      if (y < s.minY) s.minY = y;
      if (y > s.maxY) s.maxY = y;
      s.sumProb += probMap[idx];
      s.count++;
    }
  }

  // ── 4. Filter, 5. unclip, 6. map back to original coords ────────────────
  const boxes: Box[] = [];
  for (const s of stats.values()) {
    const bw = s.maxX - s.minX + 1;
    const bh = s.maxY - s.minY + 1;
    if (bw < minBoxSize || bh < minBoxSize) continue;

    const avgProb = s.sumProb / s.count;
    if (avgProb < boxThreshold) continue;

    // Unclip: expand the box by ((unclipRatio - 1) * shorter_side / 2) on each side
    const expand = Math.round(((unclipRatio - 1) * Math.min(bw, bh)) / 2);
    const ex0 = s.minX - expand;
    const ey0 = s.minY - expand;
    const ex1 = s.maxX + expand;
    const ey1 = s.maxY + expand;

    // Map back to original-image coordinates
    const ox = Math.max(0, Math.floor(ex0 * scaleX));
    const oy = Math.max(0, Math.floor(ey0 * scaleY));
    const ow = Math.ceil((ex1 - ex0 + 1) * scaleX);
    const oh = Math.ceil((ey1 - ey0 + 1) * scaleY);

    boxes.push({ x: ox, y: oy, w: ow, h: oh });
  }

  // ── 7. Sort top-to-bottom, then left-to-right ───────────────────────────
  // Use a row-tolerance equal to half the median box height to group lines
  if (boxes.length > 1) {
    const heights = boxes.map((b) => b.h).sort((a, b) => a - b);
    const median = heights[heights.length >> 1];
    const rowTol = Math.max(4, Math.round(median * 0.5));

    boxes.sort((a, b) => {
      const dy = a.y - b.y;
      if (Math.abs(dy) > rowTol) return dy;
      return a.x - b.x;
    });
  }

  return boxes;
}
