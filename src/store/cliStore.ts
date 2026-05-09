import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface CliToolInfo {
  kind: string;
  majorVersion: number | null;
  available: boolean;
  path: string | null;
  systemInstallHint: string;
}

export interface CachedTool {
  kind: string;
  majorVersion: number;
  binaries: string[];
  path: string;
}

/** Result returned by the psql CLI query execution */
export interface CliQueryResult {
  columns: string[];
  rows: string[][];
  /** Raw stdout lines exactly as psql printed them */
  stdout: string[];
  rowsAffected: number;
  executionTimeMs: number;
  error: string | null;
}

interface CliStore {
  tools: CliToolInfo[];
  cachedTools: CachedTool[];
  isLoading: boolean;
  error: string | null;
  fetchTools: () => Promise<void>;
  listCached: () => Promise<CachedTool[]>;
  checkTool: (kind: string, majorVersion: number) => Promise<{
    available: boolean;
    path: string | null;
    needsDownload: boolean;
    downloadUrl: string | null;
    downloadFilename: string | null;
    cachedVersion: number | null;
  }>;
  checkSystemTool: (kind: string) => Promise<{ available: boolean; path: string | null }>;
  ensureTool: (kind: string, majorVersion?: number) => Promise<string>;
  getVersion: (kind: string, majorVersion?: number) => Promise<string>;
  downloadVersion: (kind: string, majorVersion: number) => Promise<string>;
  detectPgVersion: (host: string, port: number, database: string, username: string, password: string) => Promise<number>;
  getPgVersions: () => Promise<[number, string][]>;
  executeQuery: (
    kind: string,
    query: string,
    host: string,
    port: number,
    database: string,
    username: string,
    password: string,
    majorVersion: number
  ) => Promise<CliQueryResult>;
  testConnection: (
    kind: string,
    host: string,
    port: number,
    database: string,
    username: string,
    password: string,
    majorVersion: number
  ) => Promise<string>;
  listDatabases: (
    kind: string,
    host: string,
    port: number,
    database: string,
    username: string,
    password: string,
    majorVersion: number
  ) => Promise<string[]>;
}

export const useCliStore = create<CliStore>((set, get) => ({
  tools: [],
  cachedTools: [],
  isLoading: false,
  error: null,

  fetchTools: async () => {
    set({ isLoading: true, error: null });
    try {
      const tools = await invoke<any[]>("cli_check_tools");
      set({
        tools: tools.map(t => ({
          kind: t.kind,
          majorVersion: t.major_version,
          available: t.available,
          path: t.path,
          systemInstallHint: t.system_install_hint,
        })),
        isLoading: false,
      });
    } catch (e: any) {
      set({ error: String(e), isLoading: false });
    }
  },

  listCached: async () => {
    const cached = await invoke<any[]>("cli_list_cached");
    const tools = cached.map(t => ({
      kind: t.kind,
      majorVersion: t.major_version,
      binaries: t.binaries,
      path: t.path,
    }));
    set({ cachedTools: tools });
    return tools;
  },

  checkTool: async (kind: string, majorVersion: number) => {
    return invoke<any>("cli_check_tool", { toolKind: kind, majorVersion });
  },

  checkSystemTool: async (kind: string) => {
    return invoke<any>("cli_check_system_tool", { toolKind: kind });
  },

  ensureTool: async (kind: string, majorVersion?: number) => {
    const path = await invoke<string>("cli_ensure", { toolKind: kind, majorVersion: majorVersion ?? null });
    await get().fetchTools();
    return path;
  },

  getVersion: async (kind: string, majorVersion?: number) => {
    return invoke<string>("cli_get_version", { toolKind: kind, majorVersion: majorVersion ?? null });
  },

  downloadVersion: async (kind: string, majorVersion: number) => {
    const path = await invoke<string>("cli_download_version", { toolKind: kind, majorVersion });
    await get().fetchTools();
    return path;
  },

  detectPgVersion: async (host, port, database, username, password) => {
    return invoke<number>("cli_detect_pg_version", { host, port, database, username, password });
  },

  getPgVersions: async () => {
    return invoke<[number, string][]>("cli_get_pg_versions");
  },

  executeQuery: async (kind, query, host, port, database, username, password, majorVersion) => {
    return invoke<CliQueryResult>("cli_execute_query", {
      toolKind: kind,
      query,
      host,
      port,
      database,
      username,
      password,
      majorVersion,
    });
  },

  testConnection: async (kind, host, port, database, username, password, majorVersion) => {
    return invoke<string>("cli_test_connection", {
      toolKind: kind,
      host,
      port,
      database,
      username,
      password,
      majorVersion,
    });
  },

  listDatabases: async (kind, host, port, database, username, password, majorVersion) => {
    return invoke<string[]>("cli_list_databases", {
      toolKind: kind,
      host,
      port,
      database,
      username,
      password,
      majorVersion,
    });
  },
}));
