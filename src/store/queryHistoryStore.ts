import { create } from "zustand";
import { invokeCmd, QueryHistoryItemDto } from "../lib/ipc";
import { logger } from "../utils/logger";

export interface QueryHistoryItem {
  id: string;
  connectionId: string;
  connectionName: string;
  query: string;
  executedAt: number;
  duration?: number;
  rowCount?: number;
  success: boolean;
}

interface QueryHistoryState {
  history: QueryHistoryItem[];
  maxHistorySize: number;
  
  addQuery: (item: Omit<QueryHistoryItem, "id" | "executedAt">) => void;
  removeQuery: (id: string) => void;
  clearHistory: () => void;
  searchHistory: (term: string) => QueryHistoryItem[];
  getRecentQueries: (limit?: number) => QueryHistoryItem[];
}

const generateId = () => Math.random().toString(36).substr(2, 9);

function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return !!w.__TAURI_INTERNALS__ || !!w.__TAURI__;
}

function fromDto(h: QueryHistoryItemDto): QueryHistoryItem {
  return {
    id: h.id,
    connectionId: h.connection_id,
    connectionName: h.connection_name,
    query: h.query,
    executedAt: h.executed_at,
    duration: h.duration ?? undefined,
    rowCount: h.row_count ?? undefined,
    success: h.success,
  };
}

function toDto(h: QueryHistoryItem): QueryHistoryItemDto {
  return {
    id: h.id,
    connection_id: h.connectionId,
    connection_name: h.connectionName,
    query: h.query,
    executed_at: h.executedAt,
    duration: h.duration ?? null,
    row_count: h.rowCount ?? null,
    success: h.success,
  };
}

const loadFromFile = async (): Promise<QueryHistoryItem[]> => {
  if (!isTauri()) return [];
  try {
    const history = await invokeCmd("load_query_history");
    return history.map(fromDto);
  } catch {
    return [];
  }
};

const saveToFile = async (history: QueryHistoryItem[]) => {
  if (!isTauri()) return;
  try {
    await invokeCmd("save_query_history", { history: history.map(toDto) });
  } catch (e) {
    logger.error("Failed to save query history:", e);
  }
};

export const useQueryHistory = create<QueryHistoryState>()((set, get) => ({
  history: [],
  maxHistorySize: 100,
  
  addQuery: async (item) => {
    const newItem: QueryHistoryItem = {
      ...item,
      id: generateId(),
      executedAt: Date.now(),
    };
    
    const newHistory = [newItem, ...get().history].slice(0, get().maxHistorySize);
    set({ history: newHistory });
    saveToFile(newHistory);
  },
  
  removeQuery: async (id) => {
    const newHistory = get().history.filter((item) => item.id !== id);
    set({ history: newHistory });
    saveToFile(newHistory);
  },
  
  clearHistory: async () => {
    set(() => ({ history: [] }));
    saveToFile([]);
  },

  searchHistory: (term: string) => {
    const lower = term.toLowerCase();
    return get().history.filter(
      (item) =>
        item.query.toLowerCase().includes(lower) ||
        item.connectionName.toLowerCase().includes(lower)
    );
  },
  
  getRecentQueries: (limit = 20) => {
    return get().history.slice(0, limit);
  },
}));

// Initialize history from file
if (typeof window !== "undefined") {
  (async () => {
    // Load from encrypted Rust storage
    const fileHistory = await loadFromFile();
    if (fileHistory && fileHistory.length > 0) {
      useQueryHistory.setState({ history: fileHistory });
    }
  })();
}