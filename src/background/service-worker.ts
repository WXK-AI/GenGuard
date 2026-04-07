/**
 * GenGuard Service Worker — Chrome MV3
 *
 * Responsibilities:
 * - Opens side panel on toolbar click
 * - Downloads model from HuggingFace → IndexedDB (pure fetch, no ORT)
 * - Routes messages between content scripts and side panel
 *
 * ORT inference runs in a Web Worker spawned from the side panel.
 * The service worker never imports onnxruntime-web.
 */

import { downloadFile, hasFile, clearAll as clearModelCache } from '../lib/model-store';
import { NER_MODEL_CONTRACT } from '../core/detectors/ner-model-contract';
import { OCR_MODEL_CONTRACT } from '../core/extractors/ocr/ocr-contract';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

const MODEL_CACHE_KEY = `${NER_MODEL_CONTRACT.hfRepoId}/${NER_MODEL_CONTRACT.hfFilename}`;
const OCR_DET_KEY  = `${OCR_MODEL_CONTRACT.hfRepoId}/${OCR_MODEL_CONTRACT.detFilename}`;
const OCR_REC_KEY  = `${OCR_MODEL_CONTRACT.hfRepoId}/${OCR_MODEL_CONTRACT.recFilename}`;
const OCR_DICT_KEY = `${OCR_MODEL_CONTRACT.hfRepoId}/${OCR_MODEL_CONTRACT.dictFilename}`;

let downloadStatus: 'idle' | 'downloading' | 'cached' | 'error' = 'idle';
let downloadProgress = 0;
let downloadError = '';

let ocrStatus: 'idle' | 'downloading' | 'cached' | 'error' = 'idle';
let ocrProgress = 0;
let ocrError = '';

const ports = new Set<chrome.runtime.Port>();

function broadcast(msg: Record<string, unknown>) {
  for (const port of ports) {
    try { port.postMessage(msg); } catch { ports.delete(port); }
  }
}

function sendDownloadStatus() {
  broadcast({
    type: 'DOWNLOAD_STATUS',
    status: downloadStatus,
    progress: downloadProgress,
    error: downloadError,
  });
}

function sendOcrStatus() {
  broadcast({
    type: 'OCR_DOWNLOAD_STATUS',
    status: ocrStatus,
    progress: ocrProgress,
    error: ocrError,
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'sidepanel') return;

  ports.add(port);
  // Send current status immediately to the new connection
  port.postMessage({
    type: 'DOWNLOAD_STATUS',
    status: downloadStatus,
    progress: downloadProgress,
    error: downloadError,
  });

  // Also send current OCR status
  port.postMessage({
    type: 'OCR_DOWNLOAD_STATUS',
    status: ocrStatus,
    progress: ocrProgress,
    error: ocrError,
  });

  port.onDisconnect.addListener(() => ports.delete(port));

  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'DOWNLOAD_MODEL') {
      await doDownload();
    } else if (msg.type === 'CLEAR_MODEL_CACHE') {
      await clearModelCache();
      downloadStatus = 'idle';
      downloadProgress = 0;
      downloadError = '';
      ocrStatus = 'idle';
      ocrProgress = 0;
      ocrError = '';
      sendDownloadStatus();
      sendOcrStatus();
    } else if (msg.type === 'DOWNLOAD_OCR_MODELS') {
      await doOcrDownload();
    }
  });
});

async function doDownload() {
  if (downloadStatus === 'downloading') return;

  // Check if already cached
  if (await hasFile(MODEL_CACHE_KEY)) {
    downloadStatus = 'cached';
    downloadProgress = 100;
    sendDownloadStatus();
    return;
  }

  try {
    downloadStatus = 'downloading';
    downloadProgress = 0;
    downloadError = '';
    sendDownloadStatus();

    await downloadFile(
      NER_MODEL_CONTRACT.hfRepoId,
      NER_MODEL_CONTRACT.hfFilename,
      (downloaded, total) => {
        downloadProgress = total > 0 ? Math.round((downloaded / total) * 100) : 0;
        sendDownloadStatus();
      },
    );

    downloadStatus = 'cached';
    downloadProgress = 100;
    sendDownloadStatus();
  } catch (err) {
    downloadStatus = 'error';
    downloadError = err instanceof Error ? err.message : String(err);
    sendDownloadStatus();
  }
}

async function doOcrDownload() {
  if (ocrStatus === 'downloading') return;

  // Check if all 3 files are already cached
  const [hasDet, hasRec, hasDict] = await Promise.all([
    hasFile(OCR_DET_KEY),
    hasFile(OCR_REC_KEY),
    hasFile(OCR_DICT_KEY),
  ]);
  if (hasDet && hasRec && hasDict) {
    ocrStatus = 'cached';
    ocrProgress = 100;
    sendOcrStatus();
    return;
  }

  try {
    ocrStatus = 'downloading';
    ocrProgress = 0;
    ocrError = '';
    sendOcrStatus();

    // Files have very different sizes; weight progress by approximate bytes
    // det ≈ 88MB, rec ≈ 8MB, dict ≈ tiny
    const W_DET = 0.91;
    const W_REC = 0.085;
    const W_DICT = 0.005;

    let detPct = 0, recPct = 0, dictPct = 0;
    const updateOverall = () => {
      ocrProgress = Math.round((detPct * W_DET + recPct * W_REC + dictPct * W_DICT) * 100);
      sendOcrStatus();
    };

    // Download det
    await downloadFile(
      OCR_MODEL_CONTRACT.hfRepoId,
      OCR_MODEL_CONTRACT.detFilename,
      (d, t) => { detPct = t > 0 ? d / t : 0; updateOverall(); },
    );
    detPct = 1; updateOverall();

    // Download rec
    await downloadFile(
      OCR_MODEL_CONTRACT.hfRepoId,
      OCR_MODEL_CONTRACT.recFilename,
      (d, t) => { recPct = t > 0 ? d / t : 0; updateOverall(); },
    );
    recPct = 1; updateOverall();

    // Download dict
    await downloadFile(
      OCR_MODEL_CONTRACT.hfRepoId,
      OCR_MODEL_CONTRACT.dictFilename,
      (d, t) => { dictPct = t > 0 ? d / t : 0; updateOverall(); },
    );
    dictPct = 1;

    ocrStatus = 'cached';
    ocrProgress = 100;
    sendOcrStatus();
  } catch (err) {
    ocrStatus = 'error';
    ocrError = err instanceof Error ? err.message : String(err);
    sendOcrStatus();
  }
}

// ── Message routing from content scripts ────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ASSESS_TEXT') {
    // Forward text from content script to side panel for assessment
    broadcast({ type: 'ASSESS_TEXT', text: msg.text, source: msg.source, tabId: sender.tab?.id });
    sendResponse({ ok: true });
  } else if (msg.type === 'RISK_UPDATE_FROM_PANEL') {
    // Side panel sends back assessment — relay to the originating content script tab
    if (msg.tabId) {
      chrome.tabs.sendMessage(msg.tabId, {
        type: 'RISK_UPDATE',
        assessment: msg.assessment,
      }).catch(() => {});
    }
    sendResponse({ ok: true });
  } else if (msg.type === 'OPEN_SIDE_PANEL') {
    if (sender.tab?.id) {
      chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
    }
    sendResponse({ ok: true });
  } else if (msg.type === 'GET_PROMPT_TEXT') {
    // Side panel asking for current tab's prompt text — forward to content script
    const tabId = msg.tabId;
    if (tabId) {
      chrome.tabs.sendMessage(tabId, { type: 'GET_PROMPT_TEXT' })
        .then((response) => sendResponse(response))
        .catch(() => sendResponse({ text: '', source: '' }));
      return true; // async response
    }
    sendResponse({ text: '', source: '' });
  } else if (msg.type === 'REDACT_IN_EDITOR') {
    // Side panel requesting redaction in the content script editor
    const tabId = msg.tabId;
    if (tabId) {
      chrome.tabs.sendMessage(tabId, {
        type: 'REDACT_IN_EDITOR',
        replacements: msg.replacements,
      }).then((response) => sendResponse(response))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }
    sendResponse({ ok: false });
  }
  return false;
});

// Check cache on startup
hasFile(MODEL_CACHE_KEY).then((cached) => {
  if (cached) {
    downloadStatus = 'cached';
    downloadProgress = 100;
  }
});

Promise.all([hasFile(OCR_DET_KEY), hasFile(OCR_REC_KEY), hasFile(OCR_DICT_KEY)]).then(
  ([d, r, dc]) => {
    if (d && r && dc) {
      ocrStatus = 'cached';
      ocrProgress = 100;
    }
  },
);
