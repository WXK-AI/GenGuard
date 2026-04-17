import { describe, it, expect } from 'vitest';
import { extractBoxes } from '../../src/core/extractors/ocr/db-postprocess';

/**
 * Helper: create a probability map for a given height × width,
 * with rectangular hot regions placed at specified positions.
 *
 * Each region is { x, y, w, h, prob } where prob defaults to 0.8.
 */
function buildProbMap(
  mapH: number,
  mapW: number,
  regions: Array<{ x: number; y: number; w: number; h: number; prob?: number }>,
): Float32Array {
  const map = new Float32Array(mapH * mapW).fill(0);
  for (const r of regions) {
    const prob = r.prob ?? 0.8;
    for (let dy = 0; dy < r.h; dy++) {
      for (let dx = 0; dx < r.w; dx++) {
        const py = r.y + dy;
        const px = r.x + dx;
        if (py < mapH && px < mapW) {
          map[py * mapW + px] = prob;
        }
      }
    }
  }
  return map;
}

describe('db-postprocess / extractBoxes', () => {
  it('returns empty for an all-zero prob map', () => {
    const map = new Float32Array(32 * 32).fill(0);
    const boxes = extractBoxes(map, 32, 32, 1, 1);
    expect(boxes).toHaveLength(0);
  });

  it('detects a single text region', () => {
    // Place a 10×5 block of high-probability pixels
    const map = buildProbMap(32, 64, [{ x: 10, y: 5, w: 10, h: 5 }]);
    const boxes = extractBoxes(map, 32, 64, 1, 1);
    expect(boxes.length).toBeGreaterThanOrEqual(1);
    // The box should roughly cover the region (with unclip expansion)
    const box = boxes[0];
    expect(box.x).toBeLessThanOrEqual(10);
    expect(box.y).toBeLessThanOrEqual(5);
    expect(box.w).toBeGreaterThanOrEqual(10);
    expect(box.h).toBeGreaterThanOrEqual(5);
  });

  it('detects two separate regions', () => {
    // Two well-separated blocks
    const map = buildProbMap(64, 64, [
      { x: 5, y: 5, w: 10, h: 5 },
      { x: 40, y: 40, w: 10, h: 5 },
    ]);
    const boxes = extractBoxes(map, 64, 64, 1, 1);
    expect(boxes.length).toBe(2);
  });

  it('filters regions below boxThreshold', () => {
    // Region with low average probability
    const map = buildProbMap(32, 32, [{ x: 5, y: 5, w: 10, h: 5, prob: 0.35 }]);
    // boxThreshold is 0.5 (from contract), so avgProb of 0.35 should be filtered
    const boxes = extractBoxes(map, 32, 32, 1, 1);
    expect(boxes).toHaveLength(0);
  });

  it('filters regions smaller than minBoxSize', () => {
    // Very tiny region: 2×2 (minBoxSize is 3)
    const map = buildProbMap(32, 32, [{ x: 5, y: 5, w: 2, h: 2 }]);
    const boxes = extractBoxes(map, 32, 32, 1, 1);
    expect(boxes).toHaveLength(0);
  });

  it('scales coordinates back to original image space', () => {
    // Detection map is 32×64, original image is 64×128 (2× scale)
    const map = buildProbMap(32, 64, [{ x: 10, y: 5, w: 10, h: 6 }]);
    const boxes = extractBoxes(map, 32, 64, 2, 2);
    expect(boxes.length).toBeGreaterThanOrEqual(1);
    const box = boxes[0];
    // Box coordinates should be roughly 2× the detection map coordinates
    // Original region center ~(15, 8) → scaled ~(30, 16)
    expect(box.x).toBeGreaterThanOrEqual(10); // at least partially scaled
    expect(box.y).toBeGreaterThanOrEqual(4);
  });

  it('sorts boxes top-to-bottom, left-to-right', () => {
    // Three text lines at different y positions
    const map = buildProbMap(128, 128, [
      { x: 5, y: 80, w: 20, h: 5 },   // line 3 (bottom)
      { x: 5, y: 5, w: 20, h: 5 },    // line 1 (top)
      { x: 5, y: 40, w: 20, h: 5 },   // line 2 (middle)
    ]);
    const boxes = extractBoxes(map, 128, 128, 1, 1);
    expect(boxes.length).toBe(3);
    // Should be sorted by y coordinate
    expect(boxes[0].y).toBeLessThan(boxes[1].y);
    expect(boxes[1].y).toBeLessThan(boxes[2].y);
  });

  it('merges touching regions into one connected component', () => {
    // Two adjacent blocks that form one connected region
    const map = buildProbMap(32, 64, [
      { x: 5, y: 5, w: 10, h: 5 },
      { x: 15, y: 5, w: 10, h: 5 }, // touches the first
    ]);
    const boxes = extractBoxes(map, 32, 64, 1, 1);
    // Should detect as one box since they're 4-connected
    expect(boxes).toHaveLength(1);
    expect(boxes[0].w).toBeGreaterThanOrEqual(20);
  });
});
