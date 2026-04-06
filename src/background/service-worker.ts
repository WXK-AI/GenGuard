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

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

const MODEL_CACHE_KEY = `${NER_MODEL_CONTRACT.hfRepoId}/${NER_MODEL_CONTRACT.hfFilename}`;

let downloadStatus: 'idle' | 'downloading' | 'cached' | 'error' = 'idle';
let downloadProgress = 0;
let downloadError = '';

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

  port.onDisconnect.addListener(() => ports.delete(port));

  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'DOWNLOAD_MODEL') {
      await doDownload();
    } else if (msg.type === 'CLEAR_MODEL_CACHE') {
      await clearModelCache();
      downloadStatus = 'idle';
      downloadProgress = 0;
      downloadError = '';
      sendDownloadStatus();
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
    // Content script requests to open the side panel
    if (sender.tab?.id) {
      chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {});
    }
    sendResponse({ ok: true });
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
