/**
 * Inline Highlighter — highlights PII findings directly in the prompt box.
 *
 * Uses the CSS Custom Highlight API (Chrome 105+) which highlights ranges
 * WITHOUT modifying the DOM — safe for React/Angular-controlled editors.
 *
 * Severity-based colours with intensity levels:
 *   subtle  → lower opacity, dotted underline
 *   normal  → default styling
 *   bold    → higher opacity, thicker underline
 */

export interface HighlightFinding {
  startIndex: number;
  endIndex: number;
  severity: string;
  type: string;
  value?: string;
  inputSource?: string;
}

export type HighlightIntensity = 'subtle' | 'normal' | 'bold';

// Check if CSS Custom Highlight API is available
const supportsHighlightApi = typeof CSS !== 'undefined' && 'highlights' in CSS;

// Highlight registries by severity
let criticalHighlight: Highlight | null = null;
let highHighlight: Highlight | null = null;
let mediumHighlight: Highlight | null = null;
let styleElement: HTMLStyleElement | null = null;
let currentIntensity: HighlightIntensity = 'normal';

/**
 * CSS rules per intensity level.
 */
function buildStyles(intensity: HighlightIntensity): string {
  const opacities = {
    subtle:  { critical: 0.15, high: 0.12, medium: 0.10 },
    normal:  { critical: 0.35, high: 0.30, medium: 0.25 },
    bold:    { critical: 0.55, high: 0.45, medium: 0.35 },
  };
  const underlines = {
    subtle:  { critical: 'underline dotted #dc2626', high: 'underline dotted #ea580c', medium: 'none' },
    normal:  { critical: 'underline wavy #dc2626', high: 'underline solid #ea580c', medium: 'underline dotted #ca8a04' },
    bold:    { critical: 'underline wavy #dc2626 2px', high: 'underline wavy #ea580c', medium: 'underline solid #ca8a04' },
  };
  const darkOpacities = {
    subtle:  { critical: 0.12, high: 0.10, medium: 0.08 },
    normal:  { critical: 0.30, high: 0.25, medium: 0.20 },
    bold:    { critical: 0.45, high: 0.38, medium: 0.30 },
  };

  const o = opacities[intensity];
  const u = underlines[intensity];
  const d = darkOpacities[intensity];

  return `
    ::highlight(genguard-critical) {
      background-color: rgba(220, 38, 38, ${o.critical});
      text-decoration: ${u.critical};
    }
    ::highlight(genguard-high) {
      background-color: rgba(234, 88, 12, ${o.high});
      text-decoration: ${u.high};
    }
    ::highlight(genguard-medium) {
      background-color: rgba(234, 179, 8, ${o.medium});
      text-decoration: ${u.medium};
    }
    @media (prefers-color-scheme: dark) {
      ::highlight(genguard-critical) {
        background-color: rgba(248, 113, 113, ${d.critical});
      }
      ::highlight(genguard-high) {
        background-color: rgba(251, 146, 60, ${d.high});
      }
      ::highlight(genguard-medium) {
        background-color: rgba(250, 204, 21, ${d.medium});
      }
    }
  `;
}

/**
 * Inject or update the CSS rules for highlight styling.
 */
function injectStyles(intensity: HighlightIntensity) {
  if (!styleElement) {
    styleElement = document.createElement('style');
    styleElement.id = 'genguard-highlight-styles';
    document.head.appendChild(styleElement);
  }
  styleElement.textContent = buildStyles(intensity);
  currentIntensity = intensity;
}

/**
 * Register highlight groups in CSS.highlights (once).
 */
function ensureRegistered(intensity: HighlightIntensity = 'normal') {
  if (!supportsHighlightApi) return;

  if (!criticalHighlight) {
    criticalHighlight = new Highlight();
    highHighlight = new Highlight();
    mediumHighlight = new Highlight();
    CSS.highlights.set('genguard-critical', criticalHighlight);
    CSS.highlights.set('genguard-high', highHighlight);
    CSS.highlights.set('genguard-medium', mediumHighlight);
  }

  injectStyles(intensity);
}

/**
 * Update the highlight intensity without re-computing ranges.
 * Called when the user changes intensity in settings.
 */
export function setIntensity(intensity: HighlightIntensity) {
  if (intensity === currentIntensity && styleElement) return;
  injectStyles(intensity);
}

/**
 * Convert a character offset range into a DOM Range within a contenteditable element.
 * Uses Range.toString() for prefix lengths so offsets follow the browser's
 * rendered text serialization across contenteditable line/block boundaries.
 */
function charOffsetToRange(
  root: HTMLElement,
  startOffset: number,
  endOffset: number,
): Range | null {
  const fullRange = document.createRange();
  fullRange.selectNodeContents(root);
  const textLength = fullRange.toString().length;
  const clampedStart = Math.max(0, Math.min(startOffset, textLength));
  const clampedEnd = Math.max(clampedStart, Math.min(endOffset, textLength));

  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (node.length > 0) textNodes.push(node);
  }
  if (textNodes.length === 0) return null;

  const prefixLength = (textNode: Text, localOffset: number): number => {
    const prefixRange = document.createRange();
    prefixRange.setStart(root, 0);
    prefixRange.setEnd(textNode, localOffset);
    return prefixRange.toString().length;
  };

  const findBoundary = (target: number): { node: Text; offset: number } | null => {
    for (const textNode of textNodes) {
      const before = prefixLength(textNode, 0);
      const after = prefixLength(textNode, textNode.length);

      if (target < before || target > after) continue;

      let low = 0;
      let high = textNode.length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (prefixLength(textNode, mid) < target) {
          low = mid + 1;
        } else {
          high = mid;
        }
      }

      return { node: textNode, offset: low };
    }
    const last = textNodes[textNodes.length - 1];
    return { node: last, offset: last.length };
  };

  const start = findBoundary(clampedStart);
  const end = findBoundary(clampedEnd);
  if (!start || !end) return null;

  try {
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  } catch {
    return null;
  }
}

function textNodeIndex(root: HTMLElement): { text: string; nodes: Array<{ node: Text; start: number; end: number }> } {
  const nodes: Array<{ node: Text; start: number; end: number }> = [];
  const parts: string[] = [];
  let offset = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Text | null;

  while ((node = walker.nextNode() as Text | null)) {
    if (node.length === 0) continue;
    nodes.push({ node, start: offset, end: offset + node.length });
    parts.push(node.data);
    offset += node.length;
  }

  return { text: parts.join(''), nodes };
}

function rawOffsetToBoundary(
  nodes: Array<{ node: Text; start: number; end: number }>,
  target: number,
): { node: Text; offset: number } | null {
  for (const entry of nodes) {
    if (target < entry.start || target > entry.end) continue;
    return { node: entry.node, offset: target - entry.start };
  }

  const last = nodes[nodes.length - 1];
  return last ? { node: last.node, offset: last.node.length } : null;
}

function valueToRange(root: HTMLElement, finding: HighlightFinding): Range | null {
  const value = finding.value?.trim();
  if (!value) return null;

  const index = textNodeIndex(root);
  if (index.text.length === 0) return null;

  const candidates: number[] = [];
  let searchFrom = 0;
  while (searchFrom <= index.text.length) {
    const found = index.text.indexOf(value, searchFrom);
    if (found === -1) break;
    candidates.push(found);
    searchFrom = found + Math.max(1, value.length);
  }
  if (candidates.length === 0) return null;

  const bestStart = candidates.reduce((best, current) => (
    Math.abs(current - finding.startIndex) < Math.abs(best - finding.startIndex) ? current : best
  ));
  const start = rawOffsetToBoundary(index.nodes, bestStart);
  const end = rawOffsetToBoundary(index.nodes, bestStart + value.length);
  if (!start || !end) return null;

  try {
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  } catch {
    return null;
  }
}

/**
 * Update highlights for a contenteditable element based on findings.
 */
export function updateHighlights(editor: HTMLElement, findings: HighlightFinding[], intensity: HighlightIntensity = 'normal') {
  if (!supportsHighlightApi) return;

  ensureRegistered(intensity);

  // Update intensity if it changed
  if (intensity !== currentIntensity) {
    injectStyles(intensity);
  }

  // Clear previous highlights
  criticalHighlight!.clear();
  highHighlight!.clear();
  mediumHighlight!.clear();

  if (findings.length === 0) return;

  for (const f of findings) {
    if (f.inputSource && f.inputSource !== 'Textbox') continue;
    const range = valueToRange(editor, f) ?? charOffsetToRange(editor, f.startIndex, f.endIndex);
    if (!range) continue;

    switch (f.severity) {
      case 'critical':
        criticalHighlight!.add(range);
        break;
      case 'high':
        highHighlight!.add(range);
        break;
      default:
        mediumHighlight!.add(range);
        break;
    }
  }
}

/**
 * Clear all GenGuard highlights.
 */
export function clearHighlights() {
  criticalHighlight?.clear();
  highHighlight?.clear();
  mediumHighlight?.clear();
}

/**
 * Check if the CSS Custom Highlight API is available.
 */
export function isHighlightSupported(): boolean {
  return supportsHighlightApi;
}
