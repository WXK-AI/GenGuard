/**
 * History Store — persists scan history in chrome.storage.local.
 *
 * Stores last 50 assessments. Never stores raw user content —
 * only score, level, finding types/counts, source, and timestamp.
 */

export interface HistoryEntry {
  id: string;
  timestamp: number;
  source: string; // 'manual' | 'chatgpt' | 'gemini'
  score: number;
  level: string;
  findingCount: number;
  findingTypes: string[]; // unique entity types found
  breakdown: { regexCount: number; nerCount: number; ocrCount: number };
  computeTimeMs: number;
}

const STORAGE_KEY = 'genguard_history';
const MAX_ENTRIES = 50;

export async function getHistory(): Promise<HistoryEntry[]> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return (result as Record<string, HistoryEntry[]>)[STORAGE_KEY] ?? [];
}

export async function addHistoryEntry(entry: Omit<HistoryEntry, 'id' | 'timestamp'>): Promise<void> {
  const history = await getHistory();
  const newEntry: HistoryEntry = {
    ...entry,
    id: crypto.randomUUID(),
    timestamp: Date.now(),
  };

  history.unshift(newEntry);

  // Trim to max entries
  if (history.length > MAX_ENTRIES) {
    history.length = MAX_ENTRIES;
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: history });
}

export async function clearHistory(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEY);
}
