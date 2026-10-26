import { create } from "zustand";
import { invokeCmd } from "../lib/ipc";
import { logger } from "../utils/logger";

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
  addQuery: (query: Omit<SavedQuery, "id" | "createdAt">) => Promise<SavedQuery>;
  removeQuery: (id: string) => Promise<void>;
  updateQuery: (id: string, name: string) => Promise<void>;
  updateQueryText: (id: string, query: string, database?: string) => Promise<void>;
  /** Same name on the same connection (names may repeat across connections). */
  findByName: (name: string, connectionId?: string) => SavedQuery | undefined;
}

const generateId = () => crypto.randomUUID();

function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return !!w.__TAURI_INTERNALS__ || !!w.__TAURI__;
}

/** `null` when the file exists but could not be read. */
const loadFromFile = async (): Promise<SavedQuery[] | null> => {
  if (!isTauri()) return [];
  try {
    const queries = await invokeCmd("load_saved_queries");
    return queries.map((q) => ({
      id: q.id,
      name: q.name,
      query: q.query,
      database: q.database,
      connectionId: q.connection_id,
      createdAt: q.created_at,
    }));
  } catch (e) {
    logger.error("Failed to load saved queries — changes will not be saved this session:", e);
    return null;
  }
};

const saveToFile = async (queries: SavedQuery[]) => {
  if (!isTauri()) return;
  try {
    await invokeCmd("save_saved_queries", {
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
    logger.error("Failed to save saved queries:", e);
  }
};

// Resolves once the file has been read (true = read OK). Every write waits
// for it: writing earlier would persist `[newItem]` over the not-yet-loaded
// list, and writing after a failed read would replace the file with an empty
// list — either way every saved query on disk would be wiped.
let loaded: Promise<boolean> = Promise.resolve(true);

export const useSavedQueries = create<SavedQueryState>()((set, get) => {
  const commit = async (next: (current: SavedQuery[]) => SavedQuery[]) => {
    const readOk = await loaded;
    const queries = next(get().queries);
    set({ queries });
    if (readOk) await saveToFile(queries);
  };

  return {
    queries: [],
    isLoading: true,

    addQuery: async (q) => {
      const item: SavedQuery = { ...q, id: generateId(), createdAt: Date.now() };
      await commit((current) => [item, ...current]);
      return item;
    },

    removeQuery: (id) => commit((current) => current.filter((q) => q.id !== id)),

    updateQuery: (id, name) => commit((current) => current.map((q) => (q.id === id ? { ...q, name } : q))),

    updateQueryText: (id, query, database) =>
      commit((current) =>
        current.map((q) => (q.id === id ? { ...q, query, ...(database !== undefined ? { database } : {}) } : q)),
      ),

    findByName: (name, connectionId) => {
      const wanted = name.trim().toLowerCase();
      return get().queries.find(
        (q) => q.name.trim().toLowerCase() === wanted && (connectionId === undefined || q.connectionId === connectionId),
      );
    },
  };
});

// Initialize from file on startup
if (typeof window !== "undefined") {
  loaded = loadFromFile().then((fileQueries) => {
    useSavedQueries.setState({ queries: fileQueries ?? [], isLoading: false });
    return fileQueries !== null;
  });
}
