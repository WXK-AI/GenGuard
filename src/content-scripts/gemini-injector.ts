/**
 * GenGuard Content Script — Gemini (gemini.google.com)
 *
 * Watches the rich-textarea (contenteditable) for text changes using a hybrid approach:
 *   - `input` / `keyup` / `paste` events (immediate)
 *   - Polling fallback every 500ms (catches Angular-controlled updates)
 * Sends text to service worker → side panel for PII assessment.
 * Intercepts submit when risk score ≥ 20.
 */

console.log('[GenGuard] Gemini injector loaded');

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastSentText = '';
let lastAssessment: { score: number; level: string; findings: unknown[] } | null = null;
let currentEditor: HTMLElement | null = null;
let badge: HTMLDivElement | null = null;

// ── Communication ────────────────────────────────────────────────────────────

function sendToBackground(msg: Record<string, unknown>) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'RISK_UPDATE') {
    lastAssessment = msg.assessment;
    updateBadge();
  }
});

// ── Editor Detection ─────────────────────────────────────────────────────────

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
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(sendIfChanged, 300);
}

function sendIfChanged() {
  const el = currentEditor;
  if (!el) return;

  const text = getTextContent(el).trim();

  if (text === lastSentText) return;
  lastSentText = text;

  if (text.length > 0) {
    sendToBackground({ type: 'ASSESS_TEXT', text, source: 'gemini' });
  } else {
    lastAssessment = null;
    updateBadge();
    sendToBackground({ type: 'ASSESS_TEXT', text: '', source: 'gemini' });
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (currentEditor) sendIfChanged();
  }, 500);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ── Submit Interception ──────────────────────────────────────────────────────

function findSendButton(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    'button[aria-label*="Send" i], button.send-button, button[data-at="send"]'
  );
}

function interceptSubmit(e: Event) {
  if (!lastAssessment || lastAssessment.score < 20) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  showWarningModal();
}

function interceptKeydown(e: KeyboardEvent) {
  if (e.key !== 'Enter' || e.shiftKey) return;
  if (!lastAssessment || lastAssessment.score < 20) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  showWarningModal();
}

// ── Warning Modal ────────────────────────────────────────────────────────────

function showWarningModal() {
  if (!lastAssessment) return;
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
  const color = levelColor[lastAssessment.level] || '#eab308';

  modal.innerHTML = `
    <div style="background: #fff; border-radius: 12px; padding: 24px; max-width: 400px; width: 90%;
                box-shadow: 0 20px 60px rgba(0,0,0,0.3); text-align: center;">
      <div style="font-size: 40px; margin-bottom: 8px;">&#9888;</div>
      <h2 style="margin: 0 0 8px; font-size: 18px; color: #111;">PII Detected</h2>
      <p style="margin: 0 0 16px; font-size: 14px; color: #555;">
        Risk Score: <strong style="color: ${color}">${lastAssessment.score}</strong>
        (<strong style="color: ${color}">${lastAssessment.level}</strong>)
        &mdash; ${lastAssessment.findings.length} finding(s)
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

// ── Risk Badge ───────────────────────────────────────────────────────────────

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

// ── Attach / Detach ──────────────────────────────────────────────────────────

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
}

function detach() {
  if (currentEditor) {
    currentEditor.removeEventListener('input', scheduleAssessment);
    currentEditor.removeEventListener('keyup', scheduleAssessment);
    currentEditor.removeEventListener('paste', scheduleAssessment);
    currentEditor.removeEventListener('cut', scheduleAssessment);
    currentEditor.removeEventListener('focus', scheduleAssessment);
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
}

// ── MutationObserver ─────────────────────────────────────────────────────────

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
});

observer.observe(document.body, { childList: true, subtree: true });
