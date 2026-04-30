/**
 * GenGuard Content Script — Gemini (gemini.google.com)
 *
 * Watches the rich-textarea (contenteditable) for text changes using a hybrid approach:
 *   - `input` / `keyup` / `paste` events (immediate)
 *   - Polling fallback every 500ms (catches Angular-controlled updates)
 * Sends text to service worker → side panel for PII assessment.
 * Intercepts submit when risk score ≥ 20.
 * Respects settings from chrome.storage.local (live updates via onChanged).
 */

import { updateHighlights, clearHighlights, isHighlightSupported, setIntensity } from './inline-highlighter';
import type { HighlightFinding, HighlightIntensity } from './inline-highlighter';
import type { GenGuardSettings } from '../core/types';

console.log('[GenGuard] Gemini injector loaded');

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastSentText = '';
let lastAssessedText = '';
let nextRequestId = 0;
let latestTextRequestId = 0;
let latestFileRequestId = 0;
let textAssessmentPending = false;
let fileAssessmentPending = false;
let assessmentUnavailable = false;
let fileSessionActive = false;
let lastAssessment: { score: number; level: string; findings: unknown[] } | null = null;
let currentEditor: HTMLElement | null = null;
let badge: HTMLDivElement | null = null;
const watchedFileInputs = new WeakSet<HTMLInputElement>();

// ── Settings (live-synced from chrome.storage) ───────────────��───────────────

const settings = {
  enabled: true,
  inlineHighlightEnabled: true,
  highlightIntensity: 'normal' as HighlightIntensity,
};

chrome.storage.local.get('genguard_settings').then((result) => {
  const s = (result as { genguard_settings?: Partial<GenGuardSettings> }).genguard_settings;
  if (s) {
    settings.enabled = s.enabled ?? true;
    settings.inlineHighlightEnabled = s.inlineHighlight?.enabled ?? true;
    settings.highlightIntensity = s.inlineHighlight?.intensity ?? 'normal';
  }
  if (!settings.enabled) {
    clearHighlights();
    lastAssessment = null;
    updateBadge();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.genguard_settings) return;
  const s = changes.genguard_settings.newValue as Partial<GenGuardSettings> | undefined;
  if (!s) return;

  const wasEnabled = settings.enabled;
  settings.enabled = s.enabled ?? true;
  settings.inlineHighlightEnabled = s.inlineHighlight?.enabled ?? true;
  settings.highlightIntensity = s.inlineHighlight?.intensity ?? 'normal';

  // Update CSS intensity in real-time
  setIntensity(settings.highlightIntensity);

  if (wasEnabled && !settings.enabled) {
    clearHighlights();
    lastAssessment = null;
    updateBadge();
  }

  if (!settings.inlineHighlightEnabled) {
    clearHighlights();
  }

  if (!wasEnabled && settings.enabled && currentEditor) {
    lastSentText = '';
    sendIfChanged();
  }
});

// ── File Interception ────────────────────────────────────────────────────────

const SCANNABLE_TYPES = /\.(pdf|docx|txt|csv|json|md|log|jpe?g|png|gif|bmp|webp|tiff?)$/i;
const SCANNABLE_MIME = /^(application\/pdf|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|text\/|image\/)/;
const MAX_SCANNABLE_FILE_BYTES = 8 * 1024 * 1024;

function isScannableFile(file: File): boolean {
  return SCANNABLE_MIME.test(file.type) || SCANNABLE_TYPES.test(file.name);
}

async function serializeFiles(files: File[]): Promise<Array<{ name: string; type: string; data: number[] }>> {
  const results: Array<{ name: string; type: string; data: number[] }> = [];
  for (const file of files) {
    if (!isScannableFile(file)) continue;
    if (file.size > MAX_SCANNABLE_FILE_BYTES) {
      console.warn(`[GenGuard] Skipping large file "${file.name}" (${file.size} bytes)`);
      continue;
    }
    const buf = await file.arrayBuffer();
    results.push({ name: file.name, type: file.type, data: Array.from(new Uint8Array(buf)) });
  }
  return results;
}

function sendFilesForAssessment(serialized: Array<{ name: string; type: string; data: number[] }>) {
  if (serialized.length === 0) return;
  const requestId = ++nextRequestId;
  latestFileRequestId = requestId;
  fileAssessmentPending = true;
  fileSessionActive = true;
  assessmentUnavailable = false;
  console.log(`[GenGuard] Intercepted ${serialized.length} file(s) for scanning`);
  chrome.runtime.sendMessage({
    type: 'ASSESS_FILES',
    files: serialized,
    source: 'gemini',
    requestId,
    requestKind: 'files',
    mode: 'replace',
  }).then((response) => {
    if (requestId === latestFileRequestId && response?.hasAssessor === false) {
      fileAssessmentPending = false;
      assessmentUnavailable = true;
      updateBadge();
    }
  }).catch(() => {
    if (requestId === latestFileRequestId) {
      fileAssessmentPending = false;
      assessmentUnavailable = true;
      updateBadge();
    }
  });
}

function clearFileAssessment() {
  if (!fileSessionActive && !fileAssessmentPending) return;
  const requestId = ++nextRequestId;
  latestFileRequestId = requestId;
  fileSessionActive = false;
  fileAssessmentPending = true;
  assessmentUnavailable = false;
  chrome.runtime.sendMessage({
    type: 'CLEAR_FILES',
    source: 'gemini',
    requestId,
    requestKind: 'files',
  }).then((response) => {
    if (requestId === latestFileRequestId && response?.hasAssessor === false) {
      fileAssessmentPending = false;
      assessmentUnavailable = true;
      updateBadge();
    }
  }).catch(() => {
    if (requestId === latestFileRequestId) {
      fileAssessmentPending = false;
      assessmentUnavailable = true;
      updateBadge();
    }
  });
}

function handleFileInputChange(e: Event) {
  if (!settings.enabled) return;
  const input = e.target as HTMLInputElement;
  if (!input.files || input.files.length === 0) {
    clearFileAssessment();
    return;
  }
  const files = Array.from(input.files).filter(isScannableFile);
  if (files.length === 0) {
    clearFileAssessment();
    return;
  }
  serializeFiles(files).then(sendFilesForAssessment);
}

function handlePasteWithFiles(e: ClipboardEvent) {
  if (!settings.enabled || !e.clipboardData) return;
  const files: File[] = [];
  for (const item of e.clipboardData.items) {
    const file = item.getAsFile();
    if (file && isScannableFile(file)) files.push(file);
  }
  if (files.length > 0) serializeFiles(files).then(sendFilesForAssessment);
}

function handleDropWithFiles(e: DragEvent) {
  if (!settings.enabled || !e.dataTransfer) return;
  const files = Array.from(e.dataTransfer.files).filter(isScannableFile);
  if (files.length > 0) serializeFiles(files).then(sendFilesForAssessment);
}

function isAttachmentRemoveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest<HTMLElement>('button, [role="button"], [aria-label], [title], [data-testid], [data-test-id]');
  if (!control) return false;
  const context = target.closest<HTMLElement>(
    '[data-testid*="attachment" i], [data-test-id*="attachment" i], [data-testid*="file" i], [data-test-id*="file" i], ' +
    '[aria-label*="attachment" i], [aria-label*="file" i]'
  );
  const label = [
    control.getAttribute('aria-label'),
    control.getAttribute('title'),
    control.getAttribute('data-testid'),
    control.getAttribute('data-test-id'),
    control.textContent,
    context?.getAttribute('aria-label'),
    context?.getAttribute('data-testid'),
    context?.getAttribute('data-test-id'),
    context?.textContent,
  ].filter(Boolean).join(' ').toLowerCase();
  const looksLikeFile = Boolean(context) || SCANNABLE_TYPES.test(label);
  return looksLikeFile && /(remove|delete|close|dismiss|cancel)/.test(label);
}

function handleAttachmentRemoveClick(e: MouseEvent) {
  if (!settings.enabled || !fileSessionActive || !isAttachmentRemoveTarget(e.target)) return;
  clearFileAssessment();
}

// ── Communication ─��────────────────────────────��─────────────────────────────

function sendToBackground(msg: Record<string, unknown>) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'RISK_UPDATE') {
    if (typeof msg.requestId === 'number') {
      if (msg.requestKind === 'files' && msg.requestId !== latestFileRequestId) return;
      if (msg.requestKind !== 'files' && msg.requestId !== latestTextRequestId) return;
    }
    lastAssessment = msg.assessment;
    lastAssessedText = currentEditor ? getTextContent(currentEditor).trim() : lastSentText;
    if (msg.requestKind === 'files') {
      fileAssessmentPending = false;
    } else {
      textAssessmentPending = false;
    }
    assessmentUnavailable = false;
    updateBadge();
    applyInlineHighlights(msg.assessment?.findings ?? []);
  } else if (msg.type === 'GET_PROMPT_TEXT') {
    const text = currentEditor ? getTextContent(currentEditor).trim() : '';
    sendResponse({ text, source: 'gemini' });
    return true;
  } else if (msg.type === 'REDACT_IN_EDITOR') {
    const ok = performRedactions(msg.replacements ?? []);
    sendResponse({ ok });
    return true;
  }
});

function applyInlineHighlights(findings: HighlightFinding[]) {
  if (!currentEditor || !isHighlightSupported()) return;
  if (!settings.inlineHighlightEnabled || findings.length === 0) {
    clearHighlights();
    return;
  }
  updateHighlights(currentEditor, findings, settings.highlightIntensity);
}

// ── Redaction ───────────────────────────────────────────────────────────────

function performRedactions(replacements: { startIndex: number; endIndex: number; replacement: string }[]): boolean {
  if (!currentEditor) return false;
  const text = getTextContent(currentEditor);
  const sorted = [...replacements].sort((a, b) => b.startIndex - a.startIndex);
  let result = text;
  for (const r of sorted) {
    result = result.slice(0, r.startIndex) + r.replacement + result.slice(r.endIndex);
  }
  currentEditor.innerText = result;
  currentEditor.dispatchEvent(new InputEvent('input', { bubbles: true }));
  lastSentText = '';
  scheduleAssessment();
  return true;
}

// ── Editor Detection ─��───────────────────────────────────────────────────────

function findEditor(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    'rich-textarea div[contenteditable="true"], div.ql-editor[contenteditable="true"], div[contenteditable="true"][aria-label*="prompt" i]'
  );
}

function getTextContent(el: HTMLElement): string {
  return el.innerText || el.textContent || '';
}

// ── Change Detection (hybrid: events + polling) ─────────────────────────────

function scheduleAssessment() {
  if (!settings.enabled) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(sendIfChanged, 300);
}

function sendIfChanged() {
  const el = currentEditor;
  if (!el || !settings.enabled) return;

  const text = getTextContent(el).trim();

  if (text === lastSentText) return;
  lastSentText = text;
  const requestId = ++nextRequestId;
  latestTextRequestId = requestId;
  textAssessmentPending = true;
  assessmentUnavailable = false;

  if (text.length > 0) {
    chrome.runtime.sendMessage({ type: 'ASSESS_TEXT', text, source: 'gemini', requestId, requestKind: 'text' })
      .then((response) => {
        if (requestId === latestTextRequestId && response?.hasAssessor === false) {
          textAssessmentPending = false;
          assessmentUnavailable = true;
          updateBadge();
        }
      })
      .catch(() => {
        if (requestId === latestTextRequestId) {
          textAssessmentPending = false;
          assessmentUnavailable = true;
          updateBadge();
        }
      });
  } else {
    lastAssessment = null;
    lastAssessedText = '';
    textAssessmentPending = false;
    updateBadge();
    clearHighlights();
    chrome.runtime.sendMessage({ type: 'ASSESS_TEXT', text: '', source: 'gemini', requestId, requestKind: 'text' }).catch(() => {});
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (currentEditor && settings.enabled) sendIfChanged();
  }, 500);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ── Submit Interception ────────────────────────────────��─────────────────────

function findSendButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    'button[aria-label*="Send" i], button.send-button, button[data-at="send"]'
  );
}

function interceptSubmit(e: Event) {
  if (!settings.enabled) return;
  if (!shouldBlockSubmit()) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  showWarningModal();
}

function interceptKeydown(e: KeyboardEvent) {
  if (!settings.enabled) return;
  if (e.key !== 'Enter' || e.shiftKey) return;
  if (!shouldBlockSubmit()) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  showWarningModal();
}

function shouldBlockSubmit(): boolean {
  const text = currentEditor ? getTextContent(currentEditor).trim() : '';
  if (text !== lastAssessedText) {
    sendIfChanged();
    return true;
  }
  if (textAssessmentPending || fileAssessmentPending || assessmentUnavailable) return true;
  return Boolean(lastAssessment && lastAssessment.score >= 20);
}

// ─��� Warning Modal ───────────────────────��──────────────────────────────��─────

function showWarningModal() {
  if (document.getElementById('genguard-modal')) return;

  const modal = document.createElement('div');
  modal.id = 'genguard-modal';
  modal.style.cssText = `
    position: fixed; inset: 0; z-index: 2147483647;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.5); font-family: system-ui, sans-serif;
  `;

  const levelColor: Record<string, string> = {
    Safe: '#22c55e', Caution: '#eab308', High: '#f97316', Critical: '#ef4444',
  };
  const color = lastAssessment ? levelColor[lastAssessment.level] || '#eab308' : '#2563eb';
  const title = lastAssessment && lastAssessment.score >= 20 ? 'PII Detected' : 'GenGuard Scan Required';
  const detail = lastAssessment && lastAssessment.score >= 20
    ? `Risk Score: <strong style="color: ${color}">${lastAssessment.score}</strong>
        (<strong style="color: ${color}">${lastAssessment.level}</strong>)
        &mdash; ${lastAssessment.findings.length} finding(s)`
    : assessmentUnavailable
      ? 'GenGuard needs the side panel open before it can assess this prompt.'
      : 'GenGuard is still assessing the latest prompt or file. Review before sending.';

  modal.innerHTML = `
    <div style="background: #fff; border-radius: 12px; padding: 24px; max-width: 400px; width: 90%;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3); text-align: center;">
      <div style="font-size: 40px; margin-bottom: 8px;">&#9888;</div>
      <h2 style="margin: 0 0 8px; font-size: 18px; color: #111;">${title}</h2>
      <p style="margin: 0 0 16px; font-size: 14px; color: #555;">
        ${detail}
      </p>
      <div style="display: flex; gap: 8px; justify-content: center;">
        <button id="genguard-proceed" style="
          padding: 8px 20px; border-radius: 8px; border: 1px solid #ddd;
          background: #f3f4f6; color: #374151; cursor: pointer; font-size: 13px;
        ">Send Anyway</button>
        <button id="genguard-review" style="
          padding: 8px 20px; border-radius: 8px; border: none;
          background: #2563eb; color: #fff; cursor: pointer; font-size: 13px;
        ">Review in GenGuard</button>
        <button id="genguard-cancel" style="
          padding: 8px 20px; border-radius: 8px; border: 1px solid #ddd;
          background: #f3f4f6; color: #374151; cursor: pointer; font-size: 13px;
        ">Cancel</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  document.getElementById('genguard-proceed')!.addEventListener('click', () => {
    modal.remove();
    const btn = findSendButton();
    if (btn) {
      btn.removeEventListener('click', interceptSubmit, true);
      btn.click();
      setTimeout(() => btn.addEventListener('click', interceptSubmit, { capture: true }), 100);
    }
  });

  document.getElementById('genguard-review')!.addEventListener('click', () => {
    modal.remove();
    sendToBackground({ type: 'OPEN_SIDE_PANEL' });
  });

  document.getElementById('genguard-cancel')!.addEventListener('click', () => {
    modal.remove();
  });

  const escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { modal.remove(); document.removeEventListener('keydown', escHandler); }
  };
  document.addEventListener('keydown', escHandler);
}

// ── Risk Badge ──────���────────────────────────────────────────────────────────

function createBadge(): HTMLDivElement {
  const el = document.createElement('div');
  el.id = 'genguard-badge';
  el.style.cssText = `
    position: absolute; top: -8px; right: -8px; z-index: 10000;
    width: 22px; height: 22px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 10px; font-weight: 700; color: #fff;
    cursor: pointer; transition: all 0.2s;
    box-shadow: 0 2px 6px rgba(0,0,0,0.2);
    font-family: system-ui, sans-serif;
  `;
  el.title = 'GenGuard — click to open';
  el.addEventListener('click', () => sendToBackground({ type: 'OPEN_SIDE_PANEL' }));
  return el;
}

function updateBadge() {
  if (!badge) return;

  if (!lastAssessment || lastAssessment.score === 0) {
    badge.style.display = 'none';
    return;
  }

  badge.style.display = 'flex';
  const { score, level } = lastAssessment;

  const colors: Record<string, string> = {
    Safe: '#22c55e', Caution: '#eab308', High: '#f97316', Critical: '#ef4444',
  };
  badge.style.background = colors[level] || '#6b7280';
  badge.textContent = String(score);
  badge.title = `GenGuard: ${level} (${score}) — ${lastAssessment.findings.length} finding(s)`;
}

// ── Attach / Detach ────���───────────────────���─────────────────────────────────

function attach(el: HTMLElement) {
  if (currentEditor === el) return;
  detach();

  currentEditor = el;
  lastSentText = '';

  el.addEventListener('input', scheduleAssessment);
  el.addEventListener('keyup', scheduleAssessment);
  el.addEventListener('paste', scheduleAssessment);
  el.addEventListener('cut', scheduleAssessment);
  el.addEventListener('focus', scheduleAssessment);

  // File interception (paste on editor — drops handled at document level)
  el.addEventListener('paste', handlePasteWithFiles as EventListener);

  startPolling();

  el.addEventListener('keydown', interceptKeydown, { capture: true });

  const parent = el.closest('form') || el.parentElement;
  if (parent && parent instanceof HTMLElement) {
    if (getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }
    badge = createBadge();
    badge.style.display = 'none';
    parent.appendChild(badge);
  }

  const sendBtn = findSendButton();
  if (sendBtn) {
    sendBtn.addEventListener('click', interceptSubmit, { capture: true });
  }

  console.log('[GenGuard] Attached to Gemini editor');

  // Scan any pre-existing text immediately
  if (settings.enabled) {
    sendIfChanged();
  }
}

function detach() {
  if (currentEditor) {
    currentEditor.removeEventListener('input', scheduleAssessment);
    currentEditor.removeEventListener('keyup', scheduleAssessment);
    currentEditor.removeEventListener('paste', scheduleAssessment);
    currentEditor.removeEventListener('cut', scheduleAssessment);
    currentEditor.removeEventListener('focus', scheduleAssessment);
    currentEditor.removeEventListener('paste', handlePasteWithFiles as EventListener);
    currentEditor.removeEventListener('keydown', interceptKeydown, true);
    currentEditor = null;
  }
  stopPolling();
  if (badge) {
    badge.remove();
    badge = null;
  }
  lastAssessment = null;
  lastSentText = '';
  lastAssessedText = '';
  textAssessmentPending = false;
  fileAssessmentPending = false;
  fileSessionActive = false;
  assessmentUnavailable = false;
}

// ── MutationObserver ───────��──────────────────────────���──────────────────────

function tryAttach() {
  const el = findEditor();
  if (el && el !== currentEditor) {
    attach(el);
  } else if (!el && currentEditor) {
    detach();
  }
}

tryAttach();

const observer = new MutationObserver(() => {
  tryAttach();

  if (currentEditor) {
    const sendBtn = findSendButton();
    if (sendBtn) {
      sendBtn.removeEventListener('click', interceptSubmit, true);
      sendBtn.addEventListener('click', interceptSubmit, { capture: true });
    }
  }

  // Watch for file inputs — scan light DOM and shadow DOMs
  scanForFileInputs(document.body);
});

observer.observe(document.body, { childList: true, subtree: true });
document.addEventListener('click', handleAttachmentRemoveClick, { capture: true });

// ── Document-level file interception (Gemini drops files on a zone, not the editor) ─

// Capture drop events on the entire document — Gemini's drop zone is not the editor
document.addEventListener('drop', handleDropWithFiles as EventListener, { capture: true });

// Capture change events on file inputs anywhere (including dynamically added ones)
document.addEventListener('change', (e: Event) => {
  const target = e.target;
  if (target instanceof HTMLInputElement && target.type === 'file') {
    handleFileInputChange(e);
  }
}, { capture: true });

/**
 * Recursively scan for file inputs in light and shadow DOMs.
 * Gemini wraps some UI in shadow roots that querySelectorAll can't reach.
 */
function scanForFileInputs(root: Element | Document | ShadowRoot) {
  // Check direct file inputs
  root.querySelectorAll<HTMLInputElement>('input[type="file"]').forEach((input) => {
    if (watchedFileInputs.has(input)) return;
    watchedFileInputs.add(input);
    input.addEventListener('change', handleFileInputChange);
  });

  // Recurse into shadow DOMs
  root.querySelectorAll('*').forEach((el) => {
    if (el.shadowRoot) {
      scanForFileInputs(el.shadowRoot);
    }
  });
}
