/**
 * Image OCR — Tesseract.js test branch.
 *
 * This branch intentionally bypasses the PaddleOCR ONNX sessions so the
 * extension can be tested with Tesseract OCR behind the same public facade.
 */

export interface OcrResult {
  text: string;
  timeMs: number;
  source: 'ocr';
}

type TesseractWorker = {
  recognize(image: File): Promise<{ data: { text?: string } }>;
};

type TesseractApi = {
  createWorker(
    langs?: string,
    oem?: number,
    options?: {
      workerPath?: string;
      corePath?: string;
      langPath?: string;
      workerBlobURL?: boolean;
      gzip?: boolean;
      cacheMethod?: 'write' | 'readOnly' | 'refresh' | 'none';
      logger?: (message: unknown) => void;
      errorHandler?: (error: unknown) => void;
    },
  ): Promise<TesseractWorker>;
};

declare global {
  interface Window {
    Tesseract?: TesseractApi;
  }
}

const TESSERACT_SCRIPT_ID = 'genguard-tesseract-js';
const REMOTE_LANG_PATH = 'https://tessdata.projectnaptha.com/4.0.0';

let workerPromise: Promise<TesseractWorker> | null = null;

/** Convert an image File to a data URL (kept for callers that still need it). */
export async function imageToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function extensionAsset(path: string): string {
  const chromeRuntime = globalThis.chrome?.runtime;
  if (chromeRuntime?.getURL) return chromeRuntime.getURL(path);
  return `/${path}`;
}

function loadTesseractScript(): Promise<TesseractApi> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('Tesseract OCR requires a browser page context'));
  }

  if (window.Tesseract) return Promise.resolve(window.Tesseract);

  return new Promise((resolve, reject) => {
    const existing = document.getElementById(TESSERACT_SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener('load', () => {
        if (window.Tesseract) resolve(window.Tesseract);
        else reject(new Error('Tesseract.js loaded without exposing window.Tesseract'));
      }, { once: true });
      existing.addEventListener('error', () => reject(new Error('Failed to load Tesseract.js')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.id = TESSERACT_SCRIPT_ID;
    script.src = extensionAsset('tesseract/tesseract.min.js');
    script.async = true;
    script.onload = () => {
      if (window.Tesseract) resolve(window.Tesseract);
      else reject(new Error('Tesseract.js loaded without exposing window.Tesseract'));
    };
    script.onerror = () => reject(new Error('Failed to load Tesseract.js'));
    document.head.appendChild(script);
  });
}

async function getTesseractWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    workerPromise = loadTesseractScript().then((Tesseract) => Tesseract.createWorker('eng', 1, {
      workerPath: extensionAsset('tesseract/worker.min.js'),
      corePath: extensionAsset('tesseract'),
      langPath: REMOTE_LANG_PATH,
      workerBlobURL: false,
      gzip: true,
      cacheMethod: 'write',
      logger: (message) => console.debug('[GenGuard][Tesseract]', message),
      errorHandler: (error) => console.error('[GenGuard][Tesseract]', error),
    }));
  }
  return workerPromise;
}

/**
 * Extract text from an image using Tesseract.js. Returns empty text on failure
 * so the engine can still scan other inputs.
 */
export async function extractTextFromImage(file: File): Promise<OcrResult> {
  const t0 = performance.now();

  try {
    const worker = await getTesseractWorker();
    const { data } = await worker.recognize(file);
    return {
      text: data.text ?? '',
      timeMs: Math.round(performance.now() - t0),
      source: 'ocr',
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[GenGuard] Tesseract OCR failed:', message);
    return {
      text: '',
      timeMs: Math.round(performance.now() - t0),
      source: 'ocr',
    };
  }
}
