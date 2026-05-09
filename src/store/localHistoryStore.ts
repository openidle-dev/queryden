import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface LocalHistoryEntry {
  timestamp: number;
  filePath: string;
  content: string;
  label?: string;
}

interface LocalHistoryState {
  entries: LocalHistoryEntry[];
  isLoading: boolean;
  addEntry: (filePath: string, content: string, label?: string) => void;
  getHistory: (filePath: string) => LocalHistoryEntry[];
  getDirectoryHistory: (dirPath: string) => { filePath: string; entries: LocalHistoryEntry[] }[];
  getAllEntries: () => LocalHistoryEntry[];
  revertToEntry: (filePath: string, timestamp: number) => Promise<string | null>;
  clearHistory: () => void;
  loadHistory: () => Promise<void>;
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && (
    !!(window as any).__TAURI_INTERNALS__ || 
    !!(window as any).__TAURI__
  );
}

export const useLocalHistory = create<LocalHistoryState>()((set, get) => ({
  entries: [],
  isLoading: false,

  addEntry: async (filePath, content, label) => {
    const entry: LocalHistoryEntry = {
      timestamp: Date.now(),
      filePath,
      content,
      label
    };
    
    const newEntries = [entry, ...get().entries].slice(0, 100);
    set({ entries: newEntries });
    
    if (isTauri()) {
      try {
        await invoke("save_local_history", { entries: newEntries });
      } catch (e) {
        console.error("Failed to save local history:", e);
      }
    }
  },

  getHistory: (filePath) => {
    return get().entries.filter(e => e.filePath === filePath);
  },

  getDirectoryHistory: (dirPath) => {
    const normalizedDir = dirPath.endsWith('/') ? dirPath : dirPath + '/';
    const fileMap = new Map<string, LocalHistoryEntry[]>();
    
    get().entries.forEach(entry => {
      if (entry.filePath.startsWith(normalizedDir) || entry.filePath === dirPath) {
        if (!fileMap.has(entry.filePath)) {
          fileMap.set(entry.filePath, []);
        }
        fileMap.get(entry.filePath)!.push(entry);
      }
    });
    
    return Array.from(fileMap.entries()).map(([filePath, entries]) => ({
      filePath,
      entries: entries.sort((a, b) => b.timestamp - a.timestamp)
    }));
  },

  getAllEntries: () => {
    return get().entries.sort((a, b) => b.timestamp - a.timestamp);
  },

  revertToEntry: async (filePath, timestamp) => {
    const entry = get().entries.find(e => e.filePath === filePath && e.timestamp === timestamp);
    if (!entry) return null;
    return entry.content;
  },

  clearHistory: async () => {
    set({ entries: [] });
    if (isTauri()) {
      try {
        await invoke("clear_local_history");
      } catch (e) {
        console.error("Failed to clear local history:", e);
      }
    }
  },

  loadHistory: async () => {
    if (!isTauri()) {
      set({ isLoading: false });
      return;
    }
    
    set({ isLoading: true });
    try {
      const entries = await invoke<LocalHistoryEntry[]>("load_local_history");
      set({ entries, isLoading: false });
    } catch (e) {
      console.error("Failed to load local history:", e);
      set({ isLoading: false });
    }
  }
}));

// Initialize from file on startup
if (typeof window !== "undefined") {
  (async () => {
    await useLocalHistory.getState().loadHistory();
  })();
}
