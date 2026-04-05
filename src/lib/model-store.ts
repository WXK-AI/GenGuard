/**
 * Model Store — downloads ONNX model + tokenizer from HuggingFace,
 * caches in IndexedDB so we only download once.
 */

const DB_NAME = 'genguard-models';
const DB_VERSION = 1;
const STORE_NAME = 'files';

interface StoredFile {
  key: string;
  data: ArrayBuffer;
  size: number;
  downloadedAt: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Check if a file is already cached in IndexedDB */
export async function hasFile(key: string): Promise<boolean> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.count(key);
    req.onsuccess = () => resolve(req.result > 0);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

/** Read a cached file from IndexedDB as ArrayBuffer */
export async function getFile(key: string): Promise<ArrayBuffer | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(key);
    req.onsuccess = () => {
      const result = req.result as StoredFile | undefined;
      resolve(result?.data ?? null);
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

/** Store a file in IndexedDB */
async function putFile(key: string, data: ArrayBuffer): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const entry: StoredFile = {
      key,
      data,
      size: data.byteLength,
      downloadedAt: Date.now(),
    };
    const req = store.put(entry);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

/** Delete all cached files (for "Reload models" button) */
export async function clearAll(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

export type ProgressCallback = (downloaded: number, total: number) => void;

/**
 * Build the HuggingFace download URL for a file in a repo.
 * Format: https://huggingface.co/{repoId}/resolve/main/{filename}
 */
function hfUrl(repoId: string, filename: string): string {
  return `https://huggingface.co/${repoId}/resolve/main/${filename}`;
}

/**
 * Download a file from HuggingFace with progress tracking.
 * Caches the result in IndexedDB. Returns the ArrayBuffer.
 */
export async function downloadFile(
  repoId: string,
  filename: string,
  onProgress?: ProgressCallback,
): Promise<ArrayBuffer> {
  const cacheKey = `${repoId}/${filename}`;

  // Check cache first
  const cached = await getFile(cacheKey);
  if (cached) {
    onProgress?.(cached.byteLength, cached.byteLength);
    return cached;
  }

  // Download from HuggingFace
  const url = hfUrl(repoId, filename);
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download ${filename}: ${response.status} ${response.statusText}`);
  }

  const contentLength = Number(response.headers.get('content-length') ?? 0);
  const reader = response.body?.getReader();

  if (!reader) {
    // Fallback: no streaming support
    const data = await response.arrayBuffer();
    await putFile(cacheKey, data);
    onProgress?.(data.byteLength, data.byteLength);
    return data;
  }

  // Stream download with progress
  const chunks: Uint8Array[] = [];
  let downloaded = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    downloaded += value.byteLength;
    onProgress?.(downloaded, contentLength);
  }

  // Merge chunks into single ArrayBuffer
  const merged = new Uint8Array(downloaded);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const buffer = merged.buffer as ArrayBuffer;
  await putFile(cacheKey, buffer);
  return buffer;
}

/**
 * Download a text/JSON file from HuggingFace (with caching).
 * Returns the parsed string.
 */
export async function downloadTextFile(
  repoId: string,
  filename: string,
): Promise<string> {
  const buffer = await downloadFile(repoId, filename);
  return new TextDecoder().decode(buffer);
}
