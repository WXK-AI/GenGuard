import { useState, useEffect, useRef, useCallback } from 'react';
import { getFile, hasFile, downloadTextFile } from '../lib/model-store';
import { NER_MODEL_CONTRACT } from '../core/detectors/ner-model-contract';
import { initSession, dispose, isReady, type OrtStatus } from '../lib/ort-engine';
import { initTokenizer, isTokenizerReady, detectNER } from '../core/detectors/ner-detector';
import type { Finding } from '../core/types';

type DownloadStatus = 'idle' | 'downloading' | 'cached' | 'error';
type Tab = 'dashboard' | 'history' | 'settings' | 'model';

const MODEL_CACHE_KEY = `${NER_MODEL_CONTRACT.hfRepoId}/${NER_MODEL_CONTRACT.hfFilename}`;
const TOKENIZER_CACHE_KEY = `${NER_MODEL_CONTRACT.hfRepoId}/${NER_MODEL_CONTRACT.tokenizerFilename}`;

interface ModelState {
  download: DownloadStatus;
  ort: OrtStatus;
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

  const portRef = useRef<chrome.runtime.Port | null>(null);

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

  useEffect(() => {
    const port = chrome.runtime.connect({ name: 'sidepanel' });
    portRef.current = port;

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
      }
    });

    hasFile(MODEL_CACHE_KEY).then((cached) => {
      if (cached) {
        setModel((prev) => ({ ...prev, download: 'cached', progress: 100 }));
        loadOrtFromCache();
      }
    });

    return () => { port.disconnect(); };
  }, [loadOrtFromCache]);

  const handleDownloadModel = () => {
    portRef.current?.postMessage({ type: 'DOWNLOAD_MODEL' });
  };

  const handleReloadModel = async () => {
    await dispose();
    setModel({ download: 'idle', ort: 'not_loaded', progress: 0, error: '' });
    portRef.current?.postMessage({ type: 'CLEAR_MODEL_CACHE' });
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
          <DashboardPage model={model} onDownload={handleDownloadModel} />
        )}
        {activeTab === 'history' && <p className="text-sm text-gray-500">History — coming soon</p>}
        {activeTab === 'settings' && <p className="text-sm text-gray-500">Settings — coming soon</p>}
        {activeTab === 'model' && (
          <ModelStatusPage model={model} onDownload={handleDownloadModel} onReload={handleReloadModel} />
        )}
      </main>
    </div>
  );
}

// ── Dashboard with NER Test ──────────────────────────────────────────────────

function DashboardPage({ model, onDownload }: { model: ModelState; onDownload: () => void }) {
  const [testText, setTestText] = useState('');
  const [findings, setFindings] = useState<Finding[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanTime, setScanTime] = useState(0);

  const handleScan = async () => {
    if (!testText.trim()) return;
    setScanning(true);
    try {
      const result = await detectNER(testText);
      setFindings(result.findings);
      setScanTime(result.timeMs);
    } catch (err) {
      console.error('Scan failed:', err);
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="space-y-4">
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

      {model.ort === 'ready' && (
        <>
          <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
            <label className="block text-xs font-medium text-gray-500 mb-1">Test NER Detection</label>
            <textarea
              value={testText}
              onChange={(e) => setTestText(e.target.value)}
              placeholder="Enter text with PII to test... e.g. Ahmad bin Ali IC 901231-14-5678 tinggal di Jalan Ampang"
              className="w-full h-24 text-sm border border-gray-300 dark:border-gray-600 rounded p-2 bg-white dark:bg-gray-700 resize-none"
            />
            <button
              onClick={handleScan}
              disabled={scanning || !testText.trim()}
              className="mt-2 px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {scanning ? 'Scanning...' : 'Scan for PII'}
            </button>
          </div>

          {findings.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
              <div className="flex justify-between items-center mb-2">
                <h3 className="text-sm font-semibold">Findings ({findings.length})</h3>
                <span className="text-xs text-gray-500">{scanTime} ms</span>
              </div>
              <div className="space-y-2">
                {findings.map((f, i) => (
                  <div key={i} className="flex items-center justify-between text-xs border-b border-gray-100 dark:border-gray-700 pb-1">
                    <div>
                      <span className={`inline-block px-1.5 py-0.5 rounded text-white text-[10px] font-medium mr-2 ${
                        f.severity === 'critical' ? 'bg-red-600' :
                        f.severity === 'high' ? 'bg-orange-500' :
                        'bg-yellow-500'
                      }`}>
                        {f.type}
                      </span>
                      <span className="font-mono">{f.value}</span>
                    </div>
                    <span className="text-gray-400">{(f.confidence * 100).toFixed(1)}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {findings.length === 0 && testText.trim() && !scanning && scanTime > 0 && (
            <p className="text-sm text-green-600 dark:text-green-400">No PII detected ({scanTime} ms)</p>
          )}
        </>
      )}
    </div>
  );
}

// ── Model Status Page ────────────────────────────────────────────────────────

function ModelStatusPage({ model, onDownload, onReload }: { model: ModelState; onDownload: () => void; onReload: () => void }) {
  return (
    <div className="space-y-4">
      <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
        <h2 className="text-sm font-semibold mb-3">NER Model</h2>
        <dl className="space-y-2 text-xs">
          <Row label="Model" value="piiranha-malaysia-v4 (DeBERTa-v3)" />
          <Row label="Source" value="HuggingFace: XkAI/piiranha-malaysia" />
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
      <div className="flex gap-2">
        {(model.download === 'idle' || model.download === 'error') && model.ort !== 'ready' && (
          <button onClick={onDownload} className="flex-1 px-3 py-2 bg-blue-600 text-white text-sm rounded hover:bg-blue-700">Download & Load Model</button>
        )}
        {model.ort === 'ready' && (
          <button onClick={onReload} className="flex-1 px-3 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 text-sm rounded hover:bg-gray-300 dark:hover:bg-gray-600">Reload Models</button>
        )}
      </div>
    </div>
  );
}

// ── Shared Components ────────────────────────────────────────────────────────

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
