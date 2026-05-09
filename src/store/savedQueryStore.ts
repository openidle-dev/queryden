import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface SavedQuery {
  id: string;
  name: string;
  query: string;
  database: string;
  connectionId: string;
  createdAt: number;
}

interface SavedQueryState {
  queries: SavedQuery[];
  isLoading: boolean;
  addQuery: (query: Omit<SavedQuery, "id" | "createdAt">) => void;
  removeQuery: (id: string) => void;
  updateQuery: (id: string, name: string) => void;
  updateQueryText: (id: string, query: string) => void;
  findByName: (name: string) => SavedQuery | undefined;
}

const generateId = () => crypto.randomUUID();

function isTauri(): boolean {
  return typeof window !== 'undefined' && (
    !!(window as any).__TAURI_INTERNALS__ || 
    !!(window as any).__TAURI__
  );
}

const loadFromFile = async (): Promise<SavedQuery[]> => {
  if (!isTauri()) return [];
  try {
    const queries = await invoke<any[]>("load_saved_queries");
    return queries.map((q: any) => ({
      id: q.id,
      name: q.name,
      query: q.query,
      database: q.database,
      connectionId: q.connection_id,
      createdAt: q.created_at,
    }));
  } catch {
    return [];
  }
};

const saveToFile = async (queries: SavedQuery[]) => {
  if (!isTauri()) return;
  try {
    await invoke("save_saved_queries", {
      queries: queries.map((q) => ({
        id: q.id,
        name: q.name,
        query: q.query,
        database: q.database,
        connection_id: q.connectionId,
        created_at: q.createdAt,
      })),
    });
  } catch (e) {
    console.error("Failed to save saved queries:", e);
  }
};

export const useSavedQueries = create<SavedQueryState>()((set, get) => ({
  queries: [],
  isLoading: true,
  
  addQuery: async (q) => {
    const newItem: SavedQuery = {
      ...q,
      id: generateId(),
      createdAt: Date.now(),
    };
    
    const newQueries = [newItem, ...get().queries];
    set({ queries: newQueries });
    saveToFile(newQueries);
  },
  
  removeQuery: async (id) => {
    const newQueries = get().queries.filter((q) => q.id !== id);
    set({ queries: newQueries });
    saveToFile(newQueries);
  },
  
  updateQuery: async (id, name) => {
    const newQueries = get().queries.map((q) => q.id === id ? { ...q, name } : q);
    set({ queries: newQueries });
    saveToFile(newQueries);
  },
  
  updateQueryText: async (id, query) => {
    const newQueries = get().queries.map((q) => q.id === id ? { ...q, query } : q);
    set({ queries: newQueries });
    saveToFile(newQueries);
  },
  
  findByName: (name) => {
    return get().queries.find(q => q.name === name);
  },
}));

// Initialize from file on startup
if (typeof window !== "undefined") {
  (async () => {
    const fileQueries = await loadFromFile();
    useSavedQueries.setState({ 
      queries: fileQueries,
      isLoading: false 
    });
  })();
}
