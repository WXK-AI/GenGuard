import { useState, useEffect, useRef, useCallback } from 'react';
import { getFile, hasFile, downloadTextFile } from '../lib/model-store';
import { NER_MODEL_CONTRACT } from '../core/detectors/ner-model-contract';
import { OCR_MODEL_CONTRACT } from '../core/extractors/ocr/ocr-contract';
import { initSession, dispose, isReady, type OrtStatus } from '../lib/ort-engine';
import { initTokenizer, isTokenizerReady } from '../core/detectors/ner-detector';
import { initOcrSessions, isOcrReady, disposeOcr } from '../core/extractors/ocr/ocr-engine';
import { assess } from '../core/engine';
import { addHistoryEntry, getHistory, clearHistory, type HistoryEntry } from '../lib/history-store';
import { DEFAULT_NER_CONFIDENCE_THRESHOLD, type Finding, type RiskAssessment, type GenGuardSettings } from '../core/types';

function getMaskText(finding: Finding, mask: 'brackets' | 'asterisks' | 'redacted'): string {
  switch (mask) {
    case 'brackets': return `[${finding.type}]`;
    case 'asterisks': return '*'.repeat(finding.value.length);
    case 'redacted': return '[REDACTED]';
  }
}

type DownloadStatus = 'idle' | 'downloading' | 'cached' | 'error';
type Tab = 'dashboard' | 'history' | 'settings' | 'model';

const MODEL_CACHE_KEY = `${NER_MODEL_CONTRACT.hfRepoId}/${NER_MODEL_CONTRACT.hfFilename}`;
const TOKENIZER_CACHE_KEY = `${NER_MODEL_CONTRACT.hfRepoId}/${NER_MODEL_CONTRACT.tokenizerFilename}`;
const OCR_DET_KEY  = `${OCR_MODEL_CONTRACT.hfRepoId}/${OCR_MODEL_CONTRACT.detFilename}`;
const OCR_REC_KEY  = `${OCR_MODEL_CONTRACT.hfRepoId}/${OCR_MODEL_CONTRACT.recFilename}`;
const OCR_DICT_KEY = `${OCR_MODEL_CONTRACT.hfRepoId}/${OCR_MODEL_CONTRACT.dictFilename}`;

interface ModelState {
  download: DownloadStatus;
  ort: OrtStatus;
  progress: number;
  error: string;
}

interface OcrState {
  download: DownloadStatus;
  status: 'not_loaded' | 'loading' | 'ready' | 'error';
  progress: number;
  error: string;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [model, setModel] = useState<ModelState>({
    download: 'idle',
    ort: 'not_loaded',
    progress: 0,
    error: '',
  });
  const [ocr, setOcr] = useState<OcrState>({
    download: 'idle',
    status: 'not_loaded',
    progress: 0,
    error: '',
  });

  const portRef = useRef<chrome.runtime.Port | null>(null);
  const settingsRef = useRef<Partial<GenGuardSettings>>({});
  const lastLiveTextRef = useRef<string>('');
  const lastLiveTabIdRef = useRef<number | undefined>(undefined);
  const [liveTabId, setLiveTabId] = useState<number | undefined>(undefined);
  const [redactionMask, setRedactionMask] = useState<'brackets' | 'asterisks' | 'redacted'>('brackets');

  // Load settings, keep ref in sync, and re-assess when settings change
  useEffect(() => {
    chrome.storage.local.get('genguard_settings').then((result) => {
      const stored = (result as { genguard_settings?: Partial<GenGuardSettings> }).genguard_settings;
      if (stored) {
        settingsRef.current = stored;
        setRedactionMask(stored.inlineHighlight?.redactionMask ?? 'brackets');
      }
    });

    const handleChange = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area !== 'local' || !changes.genguard_settings) return;
      settingsRef.current = changes.genguard_settings.newValue ?? {};
      setRedactionMask(settingsRef.current.inlineHighlight?.redactionMask ?? 'brackets');

      // Re-assess current live text with new settings
      const text = lastLiveTextRef.current;
      const tabId = lastLiveTabIdRef.current;
      if (text.length > 0) {
        assess({ text }, settingsRef.current).then((result) => {
          setLiveAssessment(result);
          if (tabId) {
            chrome.runtime.sendMessage({
              type: 'RISK_UPDATE_FROM_PANEL',
              assessment: { score: result.score, level: result.level, findings: result.findings },
              tabId,
            }).catch(() => {});
          }
        }).catch(() => {});
      }
    };
    chrome.storage.onChanged.addListener(handleChange);
    return () => chrome.storage.onChanged.removeListener(handleChange);
  }, []);

  /** Download tokenizer.json and init the tokenizer */
  const loadTokenizer = useCallback(async () => {
    if (isTokenizerReady()) return;
    try {
      // Check cache first, otherwise download
      let tokText: string;
      const cached = await getFile(TOKENIZER_CACHE_KEY);
      if (cached) {
        tokText = new TextDecoder().decode(cached);
      } else {
        tokText = await downloadTextFile(
          NER_MODEL_CONTRACT.hfRepoId,
          NER_MODEL_CONTRACT.tokenizerFilename,
        );
      }
      const tokJson = JSON.parse(tokText);
      initTokenizer(tokJson);
      console.log('[GenGuard] Tokenizer initialized');
    } catch (err) {
      console.error('[GenGuard] Tokenizer init failed:', err);
    }
  }, []);

  /** Read model from IndexedDB and init ORT + tokenizer */
  const loadOrtFromCache = useCallback(async () => {
    if (isReady()) {
      setModel((prev) => ({ ...prev, ort: 'ready' }));
      await loadTokenizer();
      return;
    }

    try {
      setModel((prev) => ({ ...prev, ort: 'loading', error: '' }));

      // Load tokenizer in parallel with ORT
      const tokenizerPromise = loadTokenizer();

      const buffer = await getFile(MODEL_CACHE_KEY);
      if (!buffer) {
        setModel((prev) => ({ ...prev, ort: 'error', error: 'Model not found in cache' }));
        return;
      }

      await initSession(buffer, (status, error) => {
        setModel((prev) => ({ ...prev, ort: status, error: error ?? '' }));
      });

      await tokenizerPromise;
    } catch (err) {
      setModel((prev) => ({
        ...prev,
        ort: 'error',
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [loadTokenizer]);

  /** Read OCR det/rec/dict from IndexedDB and init the OCR sessions */
  const loadOcrFromCache = useCallback(async () => {
    if (isOcrReady()) {
      setOcr((prev) => ({ ...prev, status: 'ready' }));
      return;
    }
    try {
      setOcr((prev) => ({ ...prev, status: 'loading', error: '' }));

      const [detBuf, recBuf, dictBuf] = await Promise.all([
        getFile(OCR_DET_KEY),
        getFile(OCR_REC_KEY),
        getFile(OCR_DICT_KEY),
      ]);
      if (!detBuf || !recBuf || !dictBuf) {
        setOcr((prev) => ({ ...prev, status: 'error', error: 'OCR files not in cache' }));
        return;
      }

      const dictText = new TextDecoder().decode(dictBuf);
      await initOcrSessions(detBuf, recBuf, dictText);

      setOcr((prev) => ({ ...prev, status: 'ready' }));
    } catch (err) {
      setOcr((prev) => ({
        ...prev,
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, []);

  // Live assessment state from content script
  const [liveAssessment, setLiveAssessment] = useState<RiskAssessment | null>(null);
  const [liveSource, setLiveSource] = useState<string>('');
  const [liveScanning, setLiveScanning] = useState(false);

  useEffect(() => {
    const port = chrome.runtime.connect({ name: 'sidepanel' });
    portRef.current = port;

    // Track generation to discard stale results from slow NER
    let assessGeneration = 0;

    // Persistent list of all uploaded files for the current session
    const liveFiles: File[] = [];
    let fileDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    port.onMessage.addListener((msg) => {
      if (msg.type === 'DOWNLOAD_STATUS') {
        setModel((prev) => ({
          ...prev,
          download: msg.status,
          progress: msg.progress,
          error: msg.status === 'error' ? msg.error : prev.error,
        }));
        if (msg.status === 'cached') {
          loadOrtFromCache();
        }
      } else if (msg.type === 'OCR_DOWNLOAD_STATUS') {
        setOcr((prev) => ({
          ...prev,
          download: msg.status,
          progress: msg.progress,
          error: msg.status === 'error' ? msg.error : prev.error,
        }));
        if (msg.status === 'cached') {
          loadOcrFromCache();
        }
      } else if (msg.type === 'ASSESS_TEXT') {
        const text = msg.text ?? '';
        const tabId = msg.tabId;
        const source = msg.source || '';

        lastLiveTextRef.current = text.trim();
        lastLiveTabIdRef.current = tabId;
        setLiveTabId(tabId);

        if (text.trim().length === 0 && liveFiles.length === 0) {
          assessGeneration++;
          setLiveAssessment(null);
          setLiveSource('');
          setLiveScanning(false);
          return;
        }

        const gen = ++assessGeneration;
        setLiveScanning(true);
        // Defer heavy work so React can paint the scanning indicator
        setTimeout(() => {
          assess({ text, files: liveFiles.length > 0 ? liveFiles : undefined }, settingsRef.current).then((result) => {
            if (gen !== assessGeneration) return;
            setLiveAssessment(result);
            setLiveSource(source);
            setLiveScanning(false);
            if (result.findings.length > 0) {
              addHistoryEntry({
                source: source || 'live',
                score: result.score,
                level: result.level,
                findingCount: result.findings.length,
                findingTypes: [...new Set(result.findings.map((f) => f.type))],
                breakdown: result.breakdown,
                computeTimeMs: result.computeTimeMs,
              }).catch(() => {});
            }
            chrome.runtime.sendMessage({
              type: 'RISK_UPDATE_FROM_PANEL',
              assessment: { score: result.score, level: result.level, findings: result.findings },
              tabId,
              requestId: msg.requestId,
              requestKind: msg.requestKind,
            }).catch(() => {});
          }).catch((err) => {
            console.error('[GenGuard] Live assessment failed:', err);
            setLiveScanning(false);
          });
        }, 0);
      } else if (msg.type === 'ASSESS_FILES') {
        const serializedFiles: Array<{ name: string; type: string; data: number[] }> = msg.files ?? [];
        const tabId = msg.tabId;
        const source = msg.source || '';

        if (serializedFiles.length === 0) return;

        if (msg.mode === 'replace') {
          liveFiles.length = 0;
        }

        // Add files to the current attachment set, dedup by name.
        const existingNames = new Set(liveFiles.map((f) => f.name));
        for (const sf of serializedFiles) {
          if (existingNames.has(sf.name)) continue;
          existingNames.add(sf.name);
          const bytes = new Uint8Array(sf.data);
          liveFiles.push(new File([bytes], sf.name, { type: sf.type }));
        }

        lastLiveTabIdRef.current = tabId;
        setLiveTabId(tabId);
        console.log(`[GenGuard] Files updated: ${liveFiles.map(f => f.name).join(', ')}`);
        setLiveScanning(true);

        // Debounce: wait 500ms for duplicate messages from double-listener
        if (fileDebounceTimer) clearTimeout(fileDebounceTimer);
        fileDebounceTimer = setTimeout(() => {
          fileDebounceTimer = null;
          const gen = ++assessGeneration;
          const currentText = lastLiveTextRef.current || '';

          console.log(`[GenGuard] Scanning ${liveFiles.length} file(s) from ${source}`);
          assess({ text: currentText || undefined, files: [...liveFiles] }, settingsRef.current).then((result) => {
            if (gen !== assessGeneration) return;
            setLiveAssessment(result);
            setLiveSource(source);
            setLiveScanning(false);
            if (result.findings.length > 0) {
              addHistoryEntry({
                source: source || 'live',
                score: result.score,
                level: result.level,
                findingCount: result.findings.length,
                findingTypes: [...new Set(result.findings.map((f) => f.type))],
                breakdown: result.breakdown,
                computeTimeMs: result.computeTimeMs,
              }).catch(() => {});
            }
            chrome.runtime.sendMessage({
              type: 'RISK_UPDATE_FROM_PANEL',
              assessment: { score: result.score, level: result.level, findings: result.findings },
              tabId,
              requestId: msg.requestId,
              requestKind: msg.requestKind,
            }).catch(() => {});
          }).catch((err) => {
            console.error('[GenGuard] File assessment failed:', err);
            setLiveScanning(false);
          });
        }, 500);
      } else if (msg.type === 'CLEAR_FILES') {
        const tabId = msg.tabId;
        const source = msg.source || '';
        const currentText = lastLiveTextRef.current || '';
        const gen = ++assessGeneration;
        liveFiles.length = 0;
        if (fileDebounceTimer) {
          clearTimeout(fileDebounceTimer);
          fileDebounceTimer = null;
        }

        lastLiveTabIdRef.current = tabId;
        setLiveTabId(tabId);
        setLiveAssessment(null);
        setLiveSource('');

        if (currentText.trim().length === 0) {
          setLiveScanning(false);
          chrome.runtime.sendMessage({
            type: 'RISK_UPDATE_FROM_PANEL',
            assessment: { score: 0, level: 'Safe', findings: [] },
            tabId,
            requestId: msg.requestId,
            requestKind: msg.requestKind,
          }).catch(() => {});
          return;
        }

        setLiveScanning(true);
        setTimeout(() => {
          assess({ text: currentText }, settingsRef.current).then((result) => {
            if (gen !== assessGeneration) return;
            setLiveAssessment(result);
            setLiveSource(source);
            setLiveScanning(false);
            chrome.runtime.sendMessage({
              type: 'RISK_UPDATE_FROM_PANEL',
              assessment: { score: result.score, level: result.level, findings: result.findings },
              tabId,
              requestId: msg.requestId,
              requestKind: msg.requestKind,
            }).catch(() => {});
          }).catch((err) => {
            console.error('[GenGuard] File clear reassessment failed:', err);
            setLiveScanning(false);
          });
        }, 0);
      }
    });

    hasFile(MODEL_CACHE_KEY).then((cached) => {
      if (cached) {
        setModel((prev) => ({ ...prev, download: 'cached', progress: 100 }));
        loadOrtFromCache();
      }
    });

    Promise.all([hasFile(OCR_DET_KEY), hasFile(OCR_REC_KEY), hasFile(OCR_DICT_KEY)]).then(
      ([d, r, dc]) => {
        if (d && r && dc) {
          setOcr((prev) => ({ ...prev, download: 'cached', progress: 100 }));
          loadOcrFromCache();
        }
      },
    );

    return () => { port.disconnect(); };
  }, [loadOrtFromCache, loadOcrFromCache]);

  // Scan current tab's prompt text on mount / when model becomes ready
  useEffect(() => {
    if (model.ort !== 'ready') return;

    // Get active tab and ask its content script for current prompt text
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (!tab?.id) return;
      chrome.runtime.sendMessage({ type: 'GET_PROMPT_TEXT', tabId: tab.id })
        .then((response) => {
          if (response?.text && response.text.trim().length > 0) {
            const source = response.source || '';
            assess({ text: response.text }, settingsRef.current).then((result) => {
              setLiveAssessment(result);
              setLiveSource(source);
              // Also send back to content script so it gets highlights
              chrome.runtime.sendMessage({
                type: 'RISK_UPDATE_FROM_PANEL',
                assessment: { score: result.score, level: result.level, findings: result.findings },
                tabId: tab.id,
              }).catch(() => {});
            }).catch(() => {});
          }
        })
        .catch(() => {}); // Content script may not be on a supported page
    });
  }, [model.ort]);

  const handleDownloadModel = () => {
    portRef.current?.postMessage({ type: 'DOWNLOAD_MODEL' });
  };

  const handleReloadModel = async () => {
    await dispose();
    await disposeOcr();
    setModel({ download: 'idle', ort: 'not_loaded', progress: 0, error: '' });
    setOcr({ download: 'idle', status: 'not_loaded', progress: 0, error: '' });
    portRef.current?.postMessage({ type: 'CLEAR_MODEL_CACHE' });
  };

  const handleDownloadOcr = () => {
    portRef.current?.postMessage({ type: 'DOWNLOAD_OCR_MODELS' });
  };

  const combinedStatus = model.ort === 'ready'
    ? 'ready'
    : model.download === 'downloading' ? 'downloading'
    : model.ort === 'loading' ? 'loading'
    : model.ort === 'error' || model.download === 'error' ? 'error'
    : 'not_loaded';

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100">
      <header className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">GenGuard</h1>
            <p className="text-xs text-gray-500 dark:text-gray-400">PII Detection &middot; Zero Knowledge</p>
          </div>
          <StatusBadge status={combinedStatus} />
        </div>
      </header>

      <nav className="flex border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
        {(['dashboard', 'history', 'settings', 'model'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`flex-1 py-2 text-xs font-medium capitalize transition-colors ${
              activeTab === tab
                ? 'text-blue-600 dark:text-blue-400 border-b-2 border-blue-600 dark:border-blue-400'
                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
            }`}
          >
            {tab}
          </button>
        ))}
      </nav>

      <main className="p-4">
        {activeTab === 'dashboard' && (
          <DashboardPage model={model} onDownload={handleDownloadModel} liveAssessment={liveAssessment} liveSource={liveSource} liveScanning={liveScanning} settingsRef={settingsRef} lastLiveTabIdRef={lastLiveTabIdRef} liveTabId={liveTabId} redactionMask={redactionMask} />
        )}
        {activeTab === 'history' && <HistoryPage />}
        {activeTab === 'settings' && <SettingsPage />}
        {activeTab === 'model' && (
          <ModelStatusPage
            model={model}
            ocr={ocr}
            onDownload={handleDownloadModel}
            onDownloadOcr={handleDownloadOcr}
            onReload={handleReloadModel}
          />
        )}
      </main>
    </div>
  );
}

// ── Finding Row ────────────────────────────────────────────────────────────────

function FindingRow({ f, allowRedaction, redactionMask, redactFindings }: {
  f: Finding;
  allowRedaction: boolean;
  redactionMask: 'brackets' | 'asterisks' | 'redacted';
  redactFindings: (findings: Finding[]) => void;
}) {
  const canRedact = allowRedaction && f.inputSource === 'Textbox';
  const detectorLabel = (f.detectorSources ?? [f.source]).join(' + ');
  return (
    <div className="flex items-center justify-between text-xs border-b border-gray-100 dark:border-gray-700 pb-1">
      <div className="flex items-center gap-1.5 min-w-0">
        <span className={`shrink-0 inline-block px-1.5 py-0.5 rounded text-white text-[10px] font-medium ${
          f.severity === 'critical' ? 'bg-red-600' :
          f.severity === 'high' ? 'bg-orange-500' :
          f.severity === 'medium' ? 'bg-yellow-500' :
          'bg-gray-400'
        }`}>
          {f.type}
        </span>
        <span className="font-mono truncate">{f.value}</span>
        <span className="shrink-0 text-[10px] text-gray-400 border border-gray-200 dark:border-gray-600 rounded px-1">{detectorLabel}</span>
      </div>
      <div className="flex items-center gap-1.5 shrink-0 ml-2">
        <span className="text-gray-400">{(f.confidence * 100).toFixed(1)}%</span>
        {canRedact && (
          <button
            onClick={() => redactFindings([f])}
            className="px-1.5 py-0.5 text-[10px] text-red-500 hover:text-red-700 border border-gray-200 dark:border-gray-600 rounded hover:border-red-300"
            title={`Replace with ${getMaskText(f, redactionMask)}`}
          >
            Redact
          </button>
        )}
      </div>
    </div>
  );
}

// ── Dashboard with NER Test ──────────────────────────────────────────────────

function DashboardPage({ model, onDownload, liveAssessment, liveSource, liveScanning, settingsRef, lastLiveTabIdRef, liveTabId, redactionMask }: {
  model: ModelState; onDownload: () => void;
  liveAssessment: RiskAssessment | null; liveSource: string; liveScanning: boolean;
  settingsRef: React.MutableRefObject<Partial<GenGuardSettings>>;
  lastLiveTabIdRef: React.MutableRefObject<number | undefined>;
  liveTabId: number | undefined;
  redactionMask: 'brackets' | 'asterisks' | 'redacted';
}) {
  const [testText, setTestText] = useState('');
  const [assessment, setAssessment] = useState<RiskAssessment | null>(null);
  const [scanning, setScanning] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleScan = async () => {
    if (!testText.trim() && files.length === 0) return;
    setScanning(true);
    try {
      const result = await assess({ text: testText, files: files.length > 0 ? files : undefined }, settingsRef.current);
      setAssessment(result);
      if (result.findings.length > 0) {
        addHistoryEntry({
          source: 'manual',
          score: result.score,
          level: result.level,
          findingCount: result.findings.length,
          findingTypes: [...new Set(result.findings.map((f) => f.type))],
          breakdown: result.breakdown,
          computeTimeMs: result.computeTimeMs,
        }).catch(() => {});
      }
    } catch (err) {
      console.error('Scan failed:', err);
    } finally {
      setScanning(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setFiles(Array.from(e.target.files));
    }
  };

  const removeFile = (idx: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const redactFindings = (findings: Finding[]) => {
    const replacements = findings.map((f) => ({
      startIndex: f.startIndex,
      endIndex: f.endIndex,
      replacement: getMaskText(f, redactionMask),
    }));
    const tabId = lastLiveTabIdRef.current;
    if (tabId) {
      chrome.runtime.sendMessage({
        type: 'REDACT_IN_EDITOR',
        tabId,
        replacements,
      }).catch(() => {});
    }
  };

  // Show live assessment or manual assessment
  const displayAssessment = assessment || liveAssessment;
  const isShowingLiveAssessment = !assessment && liveAssessment !== null;
  const allowRedaction = Boolean(isShowingLiveAssessment && liveTabId);
  const redactableFindings = displayAssessment?.findings.filter((f) => f.inputSource === 'Textbox') ?? [];

  return (
    <div className="space-y-4">
      {/* Live monitoring / scanning indicator */}
      {(liveAssessment || liveScanning) && (
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 border border-blue-200 dark:border-blue-700">
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${liveScanning ? 'bg-amber-500' : 'bg-blue-500'} animate-pulse`} />
            <span className="text-xs text-blue-700 dark:text-blue-300 font-medium">
              {liveScanning
                ? 'Scanning files & text...'
                : `Live monitoring: ${liveSource === 'chatgpt' ? 'ChatGPT' : liveSource === 'gemini' ? 'Gemini' : liveSource}`}
            </span>
          </div>
        </div>
      )}

      {model.download === 'idle' && model.ort === 'not_loaded' && (
        <div className="bg-yellow-50 dark:bg-yellow-900/20 rounded-lg p-4 border border-yellow-200 dark:border-yellow-700">
          <p className="text-sm text-yellow-800 dark:text-yellow-200 mb-2">
            NER model not loaded. Download to enable AI-powered PII detection.
          </p>
          <button onClick={onDownload} className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700">
            Download Model (~338 MB)
          </button>
        </div>
      )}

      {model.download === 'downloading' && (
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 border border-blue-200 dark:border-blue-700">
          <p className="text-sm text-blue-800 dark:text-blue-200 mb-2">Downloading model... {model.progress}%</p>
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
            <div className="bg-blue-600 h-2 rounded-full transition-all duration-300" style={{ width: `${model.progress}%` }} />
          </div>
        </div>
      )}

      {model.ort === 'loading' && (
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 border border-blue-200 dark:border-blue-700">
          <p className="text-sm text-blue-800 dark:text-blue-200">Loading model into ONNX Runtime (WASM)...</p>
        </div>
      )}

      {(model.ort === 'error' || model.download === 'error') && (
        <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-4 border border-red-200 dark:border-red-700">
          <p className="text-sm text-red-800 dark:text-red-200">Error: {model.error}</p>
          <button onClick={onDownload} className="mt-2 px-3 py-1.5 bg-red-600 text-white text-sm rounded hover:bg-red-700">Retry</button>
        </div>
      )}

      {/* Scan input — always show */}
      <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
        <label className="block text-xs font-medium text-gray-500 mb-1">Test PII Detection</label>
        <textarea
          value={testText}
          onChange={(e) => setTestText(e.target.value)}
          placeholder="Enter text with PII to test... e.g. Ahmad bin Ali IC 901231-14-5678 tinggal di Jalan Ampang"
          className="w-full h-24 text-sm border border-gray-300 dark:border-gray-600 rounded p-2 bg-white dark:bg-gray-700 resize-none"
        />

        {/* File upload */}
        <div className="mt-2 flex items-center gap-2">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            + Add File
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".txt,.csv,.json,.md,.log,.pdf,.docx,.jpg,.jpeg,.png,.gif,.bmp,.webp"
            onChange={handleFileChange}
            className="hidden"
          />
          <span className="text-[10px] text-gray-400">PDF, DOCX, TXT, images</span>
        </div>

        {files.length > 0 && (
          <div className="mt-2 space-y-1">
            {files.map((f, i) => (
              <div key={i} className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                <span className="truncate max-w-[180px]">{f.name}</span>
                <span className="text-[10px] text-gray-400">({(f.size / 1024).toFixed(0)} KB)</span>
                <button onClick={() => removeFile(i)} className="text-red-400 hover:text-red-600 text-xs ml-auto">&times;</button>
              </div>
            ))}
          </div>
        )}

        <button
          onClick={handleScan}
          disabled={scanning || (!testText.trim() && files.length === 0)}
          className="mt-2 px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {scanning ? 'Scanning...' : 'Scan for PII'}
        </button>
        {model.ort !== 'ready' && (
          <p className="text-[10px] text-gray-400 mt-1">NER model not loaded — regex-only mode</p>
        )}
      </div>

      {/* Risk assessment result */}
      {displayAssessment && (
        <>
          <RiskScoreCard assessment={displayAssessment} />

          {displayAssessment.suggestions.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
              <h3 className="text-xs font-semibold text-gray-500 mb-2">Suggestions</h3>
              <ul className="space-y-1">
                {displayAssessment.suggestions.map((s, i) => (
                  <li key={i} className="text-xs text-gray-700 dark:text-gray-300">&bull; {s}</li>
                ))}
              </ul>
            </div>
          )}

          {displayAssessment.findings.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
              <div className="flex justify-between items-center mb-2">
                <h3 className="text-sm font-semibold">
                  Findings ({displayAssessment.findings.length})
                </h3>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">{displayAssessment.computeTimeMs} ms</span>
                  {allowRedaction && redactableFindings.length > 0 && (
                    <button
                      onClick={() => redactFindings(redactableFindings)}
                      className="px-2 py-0.5 text-[10px] bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-700 rounded hover:bg-red-100 dark:hover:bg-red-900/40"
                    >
                      Redact All
                    </button>
                  )}
                </div>
              </div>
              <div className="text-[10px] text-gray-400 mb-2">
                NER: {displayAssessment.breakdown.nerCount} &middot; Regex: {displayAssessment.breakdown.regexCount} &middot; OCR: {displayAssessment.breakdown.ocrCount}
              </div>

              {/* Grouped by source when multiple sources exist */}
              {displayAssessment.sourceGroups.length > 1 ? (
                <div className="space-y-3">
                  {displayAssessment.sourceGroups.map((group, gi) => (
                    <div key={gi} className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                      <div className={`flex justify-between items-center px-3 py-1.5 text-xs font-medium ${
                        group.level === 'Critical' ? 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300' :
                        group.level === 'High' ? 'bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300' :
                        group.level === 'Caution' ? 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-300' :
                        'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300'
                      }`}>
                        <span>{group.label}</span>
                        <span>{group.findings.length} finding{group.findings.length !== 1 ? 's' : ''} &middot; {group.level}</span>
                      </div>
                      <div className="space-y-1 p-2">
                        {group.findings.map((f, i) => (
                          <FindingRow key={i} f={f} allowRedaction={allowRedaction} redactionMask={redactionMask} redactFindings={redactFindings} />
                        ))}
                        {group.findings.length === 0 && (
                          <p className="text-[10px] text-green-500 px-1">No PII detected</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-2">
                  {displayAssessment.findings.map((f, i) => (
                    <FindingRow key={i} f={f} allowRedaction={allowRedaction} redactionMask={redactionMask} redactFindings={redactFindings} />
                  ))}
                </div>
              )}
            </div>
          )}

          {displayAssessment.findings.length === 0 && (
            <p className="text-sm text-green-600 dark:text-green-400">No PII detected ({displayAssessment.computeTimeMs} ms)</p>
          )}
        </>
      )}
    </div>
  );
}

// ── Model Status Page ────────────────────────────────────────────────────────

function ModelStatusPage({ model, ocr, onDownload, onDownloadOcr, onReload }: {
  model: ModelState;
  ocr: OcrState;
  onDownload: () => void;
  onDownloadOcr: () => void;
  onReload: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
        <h2 className="text-sm font-semibold mb-3">NER Model</h2>
        <dl className="space-y-2 text-xs">
          <Row label="Model" value="piiranha-malaysia-v4 quantized (DeBERTa-v3)" />
          <Row label="Source" value="HuggingFace: XkAI/piiranha-malaysia-v4-fp32" />
          <Row label="File" value="model_quantized.onnx" />
          <Row label="Runtime" value="ONNX Runtime Web (WASM)" />
          <Row label="Download" value={<DownloadLabel status={model.download} />} />
          <Row label="Inference" value={<OrtLabel status={model.ort} />} />
          <Row label="Tokenizer" value={isTokenizerReady()
            ? <span className="text-green-600 dark:text-green-400">Ready</span>
            : <span className="text-gray-500">Not loaded</span>
          } />
          {model.download === 'downloading' && (
            <div>
              <div className="flex justify-between mb-1">
                <dt className="text-gray-500">Progress</dt>
                <dd>{model.progress}%</dd>
              </div>
              <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5">
                <div className="bg-blue-600 h-1.5 rounded-full transition-all" style={{ width: `${model.progress}%` }} />
              </div>
            </div>
          )}
          {model.error && <Row label="Error" value={<span className="text-red-500 truncate max-w-[200px]" title={model.error}>{model.error}</span>} />}
        </dl>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
        <h2 className="text-sm font-semibold mb-3">OCR Models (PP-OCRv5)</h2>
        <dl className="space-y-2 text-xs">
          <Row label="Detection" value="PP-OCRv5 server det (DBNet)" />
          <Row label="Recognition" value="PP-OCRv5 mobile rec (English)" />
          <Row label="Source" value="HuggingFace: monkt/paddleocr-onnx" />
          <Row label="Runtime" value="ONNX Runtime Web (WASM)" />
          <Row label="Download" value={<DownloadLabel status={ocr.download} />} />
          <Row label="Inference" value={
            ocr.status === 'ready' ? <span className="text-green-600 dark:text-green-400">Ready</span>
            : ocr.status === 'loading' ? <span className="text-yellow-600 dark:text-yellow-400">Initializing...</span>
            : ocr.status === 'error' ? <span className="text-red-500">Error</span>
            : <span className="text-gray-500">Not loaded</span>
          } />
          {ocr.download === 'downloading' && (
            <div>
              <div className="flex justify-between mb-1">
                <dt className="text-gray-500">Progress</dt>
                <dd>{ocr.progress}%</dd>
              </div>
              <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-1.5">
                <div className="bg-blue-600 h-1.5 rounded-full transition-all" style={{ width: `${ocr.progress}%` }} />
              </div>
            </div>
          )}
          {ocr.error && <Row label="Error" value={<span className="text-red-500 truncate max-w-[200px]" title={ocr.error}>{ocr.error}</span>} />}
        </dl>
        {(ocr.download === 'idle' || ocr.download === 'error') && ocr.status !== 'ready' && (
          <button onClick={onDownloadOcr} className="mt-3 w-full px-3 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700">
            Download OCR Models (~96 MB)
          </button>
        )}
      </div>

      <div className="flex gap-2">
        {(model.download === 'idle' || model.download === 'error') && model.ort !== 'ready' && (
          <button onClick={onDownload} className="flex-1 px-3 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700">Download & Load NER Model</button>
        )}
        {(model.ort === 'ready' || ocr.status === 'ready') && (
          <button onClick={onReload} className="flex-1 px-3 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 text-sm rounded hover:bg-gray-300 dark:hover:bg-gray-600">Reload Models</button>
        )}
      </div>
    </div>
  );
}

// ── History Page ─────────────────────────────────────────────────────────────

function HistoryPage() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getHistory().then((h) => { setEntries(h); setLoading(false); });
  }, []);

  const handleClear = async () => {
    await clearHistory();
    setEntries([]);
  };

  const levelColor: Record<string, string> = {
    Safe: 'text-green-600', Caution: 'text-yellow-600', High: 'text-orange-600', Critical: 'text-red-600',
  };

  if (loading) return <p className="text-sm text-gray-500">Loading...</p>;

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <h2 className="text-sm font-semibold">Scan History</h2>
        {entries.length > 0 && (
          <button onClick={handleClear} className="text-[10px] text-red-400 hover:text-red-600">Clear All</button>
        )}
      </div>

      {entries.length === 0 && (
        <p className="text-xs text-gray-500">No scans recorded yet. Scan text or browse ChatGPT/Gemini with PII to see history.</p>
      )}

      <div className="space-y-2">
        {entries.map((e) => (
          <div key={e.id} className="bg-white dark:bg-gray-800 rounded-lg p-3 border border-gray-200 dark:border-gray-700">
            <div className="flex justify-between items-center mb-1">
              <div className="flex items-center gap-2">
                <span className={`text-sm font-bold ${levelColor[e.level] ?? 'text-gray-500'}`}>{e.score}</span>
                <span className={`text-[10px] font-medium ${levelColor[e.level] ?? 'text-gray-500'}`}>{e.level}</span>
              </div>
              <span className="text-[10px] text-gray-400">{formatTime(e.timestamp)}</span>
            </div>
            <div className="flex items-center gap-2 text-[10px] text-gray-500">
              <span className="border border-gray-200 dark:border-gray-600 rounded px-1">{e.source}</span>
              <span>{e.findingCount} finding{e.findingCount !== 1 ? 's' : ''}</span>
              <span>&middot;</span>
              <span>{e.computeTimeMs}ms</span>
            </div>
            {e.findingTypes.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {e.findingTypes.map((t) => (
                  <span key={t} className="text-[10px] bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded px-1.5 py-0.5">{t}</span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ── Settings Page ────────────────────────────────────────────────────────────

function SettingsPage() {
  const [settings, setSettings] = useState<GenGuardSettings | null>(null);

  useEffect(() => {
    chrome.storage.local.get('genguard_settings').then((result) => {
      const stored = (result as { genguard_settings?: Partial<GenGuardSettings> }).genguard_settings;
      setSettings({
        enabled: stored?.enabled ?? true,
        nerConfidenceThreshold: stored?.nerConfidenceThreshold ?? DEFAULT_NER_CONFIDENCE_THRESHOLD,
        enableRegex: stored?.enableRegex ?? true,
        enableNer: stored?.enableNer ?? true,
        enableOcr: stored?.enableOcr ?? true,
        inlineHighlight: {
          enabled: stored?.inlineHighlight?.enabled ?? true,
          intensity: stored?.inlineHighlight?.intensity ?? 'normal',
          redactionMask: stored?.inlineHighlight?.redactionMask ?? 'brackets',
        },
      });
    });
  }, []);

  const save = (patch: Partial<GenGuardSettings>) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      chrome.storage.local.set({ genguard_settings: next });
      return next;
    });
  };

  const saveHighlight = (patch: Partial<GenGuardSettings['inlineHighlight']>) => {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, inlineHighlight: { ...prev.inlineHighlight, ...patch } };
      chrome.storage.local.set({ genguard_settings: next });
      return next;
    });
  };

  if (!settings) return <p className="text-sm text-gray-500">Loading...</p>;

  return (
    <div className="space-y-4">
      <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
        <h2 className="text-sm font-semibold mb-3">Detection</h2>
        <div className="space-y-3">
          <Toggle label="Enable GenGuard" checked={settings.enabled} onChange={(v) => save({ enabled: v })} />
          <Toggle label="Regex Detection" checked={settings.enableRegex} onChange={(v) => save({ enableRegex: v })} />
          <Toggle label="NER Model Detection" checked={settings.enableNer} onChange={(v) => save({ enableNer: v })} />
          <Toggle label="OCR (Image Text)" checked={settings.enableOcr} onChange={(v) => save({ enableOcr: v })} />

          <div>
            <label className="text-xs text-gray-500 block mb-1">
              NER Confidence Threshold: {(settings.nerConfidenceThreshold * 100).toFixed(0)}%
            </label>
            <input
              type="range"
              min="5" max="90" step="5"
              value={settings.nerConfidenceThreshold * 100}
              onChange={(e) => save({ nerConfidenceThreshold: parseInt(e.target.value) / 100 })}
              className="w-full h-1.5 accent-blue-600"
            />
            <div className="flex justify-between text-[10px] text-gray-400">
              <span>5% (more findings)</span>
              <span>90% (fewer, higher confidence)</span>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
        <h2 className="text-sm font-semibold mb-3">Inline Highlighting</h2>
        <div className="space-y-3">
          <Toggle label="Enable Highlights" checked={settings.inlineHighlight.enabled} onChange={(v) => saveHighlight({ enabled: v })} />

          <div>
            <label className="text-xs text-gray-500 block mb-1">Intensity</label>
            <select
              value={settings.inlineHighlight.intensity}
              onChange={(e) => saveHighlight({ intensity: e.target.value as 'subtle' | 'normal' | 'bold' })}
              className="w-full text-xs border border-gray-300 dark:border-gray-600 rounded p-1.5 bg-white dark:bg-gray-700"
            >
              <option value="subtle">Subtle</option>
              <option value="normal">Normal</option>
              <option value="bold">Bold</option>
            </select>
          </div>

          <div>
            <label className="text-xs text-gray-500 block mb-1">Redaction Mask Style</label>
            <select
              value={settings.inlineHighlight.redactionMask}
              onChange={(e) => saveHighlight({ redactionMask: e.target.value as 'brackets' | 'asterisks' | 'redacted' })}
              className="w-full text-xs border border-gray-300 dark:border-gray-600 rounded p-1.5 bg-white dark:bg-gray-700"
            >
              <option value="brackets">[IC_NUMBER]</option>
              <option value="asterisks">********</option>
              <option value="redacted">[REDACTED]</option>
            </select>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
        <h2 className="text-sm font-semibold mb-3">About</h2>
        <dl className="space-y-1 text-xs">
          <Row label="Version" value="0.1.0" />
          <Row label="Architecture" value="Zero-knowledge (client-side only)" />
          <Row label="Model" value="piiranha-malaysia-v4 quantized (DeBERTa-v3)" />
          <Row label="Runtime" value="ONNX Runtime Web (WASM)" />
        </dl>
      </div>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between cursor-pointer">
      <span className="text-xs text-gray-700 dark:text-gray-300">{label}</span>
      <div className="relative">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="sr-only" />
        <div className={`w-9 h-5 rounded-full transition-colors ${checked ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}>
          <div className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-4' : ''}`} />
        </div>
      </div>
    </label>
  );
}

// ── Shared Components ────────────────────────────────────────────────────────

function RiskScoreCard({ assessment }: { assessment: RiskAssessment }) {
  const levelColor: Record<string, string> = {
    Safe: 'text-green-600 dark:text-green-400',
    Caution: 'text-yellow-600 dark:text-yellow-400',
    High: 'text-orange-600 dark:text-orange-400',
    Critical: 'text-red-600 dark:text-red-400',
  };
  const barColor: Record<string, string> = {
    Safe: 'bg-green-500',
    Caution: 'bg-yellow-500',
    High: 'bg-orange-500',
    Critical: 'bg-red-500',
  };
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between mb-2">
        <span className={`text-2xl font-bold ${levelColor[assessment.level]}`}>{assessment.score}</span>
        <span className={`text-sm font-semibold ${levelColor[assessment.level]}`}>{assessment.level}</span>
      </div>
      <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
        <div className={`h-2 rounded-full transition-all ${barColor[assessment.level]}`} style={{ width: `${assessment.score}%` }} />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color: Record<string, string> = {
    not_loaded: 'bg-gray-400', downloading: 'bg-yellow-400 animate-pulse',
    loading: 'bg-yellow-400 animate-pulse', ready: 'bg-green-500', error: 'bg-red-500',
  };
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${color[status] ?? 'bg-gray-400'}`} title={`Model: ${status}`} />;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="flex justify-between"><dt className="text-gray-500">{label}</dt><dd>{value}</dd></div>;
}

function DownloadLabel({ status }: { status: DownloadStatus }) {
  const m: Record<DownloadStatus, [string, string]> = {
    idle: ['Not downloaded', 'text-gray-500'], downloading: ['Downloading...', 'text-yellow-600 dark:text-yellow-400'],
    cached: ['Cached in IndexedDB', 'text-green-600 dark:text-green-400'], error: ['Download failed', 'text-red-500'],
  };
  return <span className={m[status][1]}>{m[status][0]}</span>;
}

function OrtLabel({ status }: { status: OrtStatus }) {
  const m: Record<OrtStatus, [string, string]> = {
    not_loaded: ['Not loaded', 'text-gray-500'], loading: ['Initializing WASM...', 'text-yellow-600 dark:text-yellow-400'],
    ready: ['Ready', 'text-green-600 dark:text-green-400'], error: ['Error', 'text-red-500'],
  };
  return <span className={m[status][1]}>{m[status][0]}</span>;
}
