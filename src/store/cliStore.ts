import { create } from "zustand";
import {
  invokeCmd,
  CachedToolDto,
  CheckSystemToolResult,
  CheckToolResult,
  CliQueryResult,
  CliToolInfoDto,
} from "../lib/ipc";

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

// Re-export for back-compat with components that import the type from this module.
export type { CliQueryResult } from "../lib/ipc";

interface CliStore {
  tools: CliToolInfo[];
  cachedTools: CachedTool[];
  isLoading: boolean;
  error: string | null;
  fetchTools: () => Promise<void>;
  listCached: () => Promise<CachedTool[]>;
  checkTool: (kind: string, majorVersion: number) => Promise<CheckToolResult>;
  checkSystemTool: (kind: string) => Promise<CheckSystemToolResult>;
  ensureTool: (kind: string, majorVersion?: number) => Promise<string>;
  getVersion: (kind: string, majorVersion?: number) => Promise<string>;
  downloadVersion: (kind: string, majorVersion: number) => Promise<string>;
  detectPgVersion: (
    host: string,
    port: number,
    database: string,
    username: string,
    password: string
  ) => Promise<number>;
  getPgVersions: () => Promise<Array<[number, string]>>;
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

function toCliToolInfo(t: CliToolInfoDto): CliToolInfo {
  return {
    kind: t.kind,
    majorVersion: t.major_version,
    available: t.available,
    path: t.path,
    systemInstallHint: t.system_install_hint,
  };
}

function toCachedTool(t: CachedToolDto): CachedTool {
  return {
    kind: t.kind,
    majorVersion: t.major_version,
    binaries: t.binaries,
    path: t.path,
  };
}

export const useCliStore = create<CliStore>((set, get) => ({
  tools: [],
  cachedTools: [],
  isLoading: false,
  error: null,

  fetchTools: async () => {
    set({ isLoading: true, error: null });
    try {
      const tools = await invokeCmd("cli_check_tools");
      set({ tools: tools.map(toCliToolInfo), isLoading: false });
    } catch (e: unknown) {
      set({ error: String(e), isLoading: false });
    }
  },

  listCached: async () => {
    const cached = await invokeCmd("cli_list_cached");
    const tools = cached.map(toCachedTool);
    set({ cachedTools: tools });
    return tools;
  },

  checkTool: (kind, majorVersion) =>
    invokeCmd("cli_check_tool", { toolKind: kind, majorVersion }),

  checkSystemTool: (kind) =>
    invokeCmd("cli_check_system_tool", { toolKind: kind }),

  ensureTool: async (kind, majorVersion) => {
    const path = await invokeCmd("cli_ensure", {
      toolKind: kind,
      majorVersion: majorVersion ?? null,
    });
    await get().fetchTools();
    return path;
  },

  getVersion: (kind, majorVersion) =>
    invokeCmd("cli_get_version", { toolKind: kind, majorVersion: majorVersion ?? null }),

  downloadVersion: async (kind, majorVersion) => {
    const path = await invokeCmd("cli_download_version", { toolKind: kind, majorVersion });
    await get().fetchTools();
    return path;
  },

  detectPgVersion: (host, port, database, username, password) =>
    invokeCmd("cli_detect_pg_version", { host, port, database, username, password }),

  getPgVersions: () => invokeCmd("cli_get_pg_versions"),

  executeQuery: (kind, query, host, port, database, username, password, majorVersion) =>
    invokeCmd("cli_execute_query", {
      toolKind: kind,
      query,
      host,
      port,
      database,
      username,
      password,
      majorVersion,
    }),

  testConnection: (kind, host, port, database, username, password, majorVersion) =>
    invokeCmd("cli_test_connection", {
      toolKind: kind,
      host,
      port,
      database,
      username,
      password,
      majorVersion,
    }),

  listDatabases: (kind, host, port, database, username, password, majorVersion) =>
    invokeCmd("cli_list_databases", {
      toolKind: kind,
      host,
      port,
      database,
      username,
      password,
      majorVersion,
    }),
}));
