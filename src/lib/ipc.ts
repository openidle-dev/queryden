/**
 * Typed wrapper around Tauri's `invoke()`.
 *
 * Every Tauri command exposed by the Rust backend (see
 * `src-tauri/src/lib.rs` -> `tauri::generate_handler!`) appears here as an
 * entry in the `IpcCommands` map. The shape is:
 *
 *   command_name: { args: ArgsFromRust; result: ReturnFromRust }
 *
 * Naming conventions:
 *   - Args use camelCase. Tauri auto-converts these to snake_case for the
 *     Rust side, so `{ vaultPassword }` here lands as `vault_password: ...`
 *     in the Rust handler. Match the JS side, not Rust.
 *   - DTO field names match what comes over the wire literally. Most Rust
 *     structs in this project don't use `#[serde(rename_all)]`, so their
 *     fields stay snake_case in the JSON; the few that do (LocalHistoryEntry)
 *     are noted inline.
 *
 * Adding a new command:
 *   1. Add the `#[tauri::command]` in Rust and register it in `lib.rs`.
 *   2. Add an entry to `IpcCommands` below with `args` + `result`.
 *   3. Optionally export a per-command function for ergonomics.
 *
 * Call sites should prefer `invokeCmd("name", args)` over the per-command
 * helpers when the command is rarely used; helpers are only here for the
 * hottest paths so the IPC layer doesn't balloon.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";

// ─── DTOs (wire format) ──────────────────────────────────────────────────────

/**
 * Mirrors `src-tauri/src/storage.rs::StoredConnection`.
 * Rust serialization preserves snake_case; consumers that want camelCase
 * convert at the boundary.
 */
export interface StoredConnectionDto {
  id: string;
  name: string;
  db_type: string;
  host: string | null;
  port: number | null;
  database: string;
  username: string | null;
  password?: string | null;
  filepath: string | null;
  color?: string | null;
  is_vault?: boolean | null;
  vault_credential_id?: string | null;
  ssh_enabled?: boolean | null;
  ssh_host?: string | null;
  ssh_port?: number | null;
  ssh_username?: string | null;
  ssh_password?: string | null;
  ssh_key_path?: string | null;
  ssh_key_passphrase?: string | null;
}

/** Mirrors `storage.rs::VaultCredential`. */
export interface VaultCredentialDto {
  id: string;
  name: string;
  username: string | null;
  password: string | null;
}

/** Mirrors `storage.rs::QueryHistoryItem`. */
export interface QueryHistoryItemDto {
  id: string;
  connection_id: string;
  connection_name: string;
  query: string;
  executed_at: number;
  duration: number | null;
  row_count: number | null;
  success: boolean;
}

/** Mirrors `storage.rs::SavedQueryItem`. */
export interface SavedQueryItemDto {
  id: string;
  name: string;
  query: string;
  database: string;
  connection_id: string;
  created_at: number;
}

/** Mirrors `storage.rs::LocalHistoryEntry` — NOTE: serde camelCase. */
export interface LocalHistoryEntryDto {
  timestamp: number;
  filePath: string;
  content: string;
  label: string | null;
}

/** Mirrors `ssh.rs::TunnelInfo`. */
export interface TunnelInfoDto {
  connection_id: string;
  local_port: number;
  remote_host: string;
  remote_port: number;
}

/** Mirrors `cli.rs::ToolInfo`. */
export interface CliToolInfoDto {
  kind: string;
  major_version: number | null;
  available: boolean;
  path: string | null;
  system_install_hint: string;
}

/** Mirrors `cli.rs::CachedTool`. */
export interface CachedToolDto {
  kind: string;
  major_version: number;
  binaries: string[];
  path: string;
}

/** Shape returned by `cli_check_tool` (built via `serde_json::json!`, camelCase). */
export interface CheckToolResult {
  available: boolean;
  path: string | null;
  needsDownload: boolean;
  downloadUrl: string | null;
  downloadFilename: string | null;
  cachedVersion: number | null;
}

/** Shape returned by `cli_check_system_tool` (camelCase via `json!`). */
export interface CheckSystemToolResult {
  available: boolean;
  path: string | null;
}

/** Result of `cli_execute_query`. */
export interface CliQueryResult {
  columns: string[];
  rows: string[][];
  /** Raw stdout lines exactly as the CLI printed them. */
  stdout: string[];
  rowsAffected: number;
  executionTimeMs: number;
  error: string | null;
}

/** Mirrors `sysinfo.rs::SystemInfo`. */
export interface SystemInfoDto {
  os_name: string;
  os_version: string;
  kernel_version: string;
  hostname: string;
  cpu_model: string;
  cpu_count: number;
  memory_total_kb: number;
  memory_used_kb: number;
  memory_free_kb: number;
  uptime_seconds: number;
  app_version: string;
}

// ─── Command map ─────────────────────────────────────────────────────────────

/**
 * Single source of truth for the IPC contract.
 *
 * Args of type `void` mean the command takes no arguments — call
 * `invokeCmd("name")` without a second arg.
 */
export interface IpcCommands {
  // storage — connections
  save_connections: {
    args: { connections: StoredConnectionDto[]; vaultPassword: string | null };
    result: void;
  };
  load_connections: {
    args: { vaultPassword: string | null };
    result: StoredConnectionDto[];
  };
  export_connections: {
    args: { path: string; includePasswords: boolean; vaultPassword: string | null };
    result: void;
  };
  import_connections: {
    args: { path: string; vaultPassword: string | null };
    result: number;
  };

  // storage — settings / keymaps / templates (arbitrary user JSON)
  save_settings: { args: { settings: unknown }; result: void };
  load_settings: { args: void; result: unknown };
  save_keymaps: { args: { keymaps: unknown }; result: void };
  load_keymaps: { args: void; result: unknown };
  save_templates: { args: { templates: unknown }; result: void };
  load_templates: { args: void; result: unknown };

  // storage — history
  save_query_history: { args: { history: QueryHistoryItemDto[] }; result: void };
  load_query_history: { args: void; result: QueryHistoryItemDto[] };
  save_saved_queries: { args: { queries: SavedQueryItemDto[] }; result: void };
  load_saved_queries: { args: void; result: SavedQueryItemDto[] };
  save_local_history: { args: { entries: LocalHistoryEntryDto[] }; result: void };
  load_local_history: { args: void; result: LocalHistoryEntryDto[] };
  clear_local_history: { args: void; result: void };

  // storage — vault
  save_vault_credentials: {
    args: { credentials: VaultCredentialDto[]; vaultPassword: string | null };
    result: void;
  };
  load_vault_credentials: {
    args: { vaultPassword: string | null };
    result: VaultCredentialDto[];
  };
  get_app_data_path: { args: void; result: string };

  // ssh
  create_ssh_tunnel: {
    args: {
      connectionId: string;
      sshHost: string;
      sshPort: number;
      sshUsername: string;
      sshPassword: string | null;
      sshKeyPath: string | null;
      sshKeyPassphrase: string | null;
      remoteHost: string;
      remotePort: number;
    };
    result: TunnelInfoDto;
  };
  close_ssh_tunnel: { args: { connectionId: string }; result: boolean };
  get_tunnel_status: { args: { connectionId: string }; result: TunnelInfoDto | null };
  close_all_tunnels: { args: void; result: void };

  // cli
  cli_check_tools: { args: void; result: CliToolInfoDto[] };
  cli_list_cached: { args: void; result: CachedToolDto[] };
  cli_check_tool: {
    args: { toolKind: string; majorVersion: number };
    result: CheckToolResult;
  };
  cli_check_system_tool: {
    args: { toolKind: string };
    result: CheckSystemToolResult;
  };
  cli_ensure: {
    args: { toolKind: string; majorVersion: number | null };
    result: string;
  };
  cli_get_version: {
    args: { toolKind: string; majorVersion: number | null };
    result: string;
  };
  cli_download_version: {
    args: { toolKind: string; majorVersion: number };
    result: string;
  };
  cli_detect_pg_version: {
    args: {
      host: string;
      port: number;
      database: string;
      username: string;
      password: string;
    };
    result: number;
  };
  cli_get_pg_versions: { args: void; result: Array<[number, string]> };
  cli_execute_query: {
    args: {
      toolKind: string;
      query: string;
      host: string;
      port: number;
      database: string;
      username: string;
      password: string;
      majorVersion: number;
    };
    result: CliQueryResult;
  };
  cli_test_connection: {
    args: {
      toolKind: string;
      host: string;
      port: number;
      database: string;
      username: string;
      password: string;
      majorVersion: number;
    };
    result: string;
  };
  cli_list_databases: {
    args: {
      toolKind: string;
      host: string;
      port: number;
      database: string;
      username: string;
      password: string;
      majorVersion: number;
    };
    result: string[];
  };

  // sysinfo + build info (updater itself now goes through tauri-plugin-updater)
  get_build_info: { args: void; result: string };
  get_system_info: { args: void; result: SystemInfoDto };
}

export type IpcCommandName = keyof IpcCommands;

// ─── Typed `invoke` ──────────────────────────────────────────────────────────

type ArgsOf<K extends IpcCommandName> = IpcCommands[K]["args"];
type ResultOf<K extends IpcCommandName> = IpcCommands[K]["result"];

/**
 * Typed Tauri `invoke`. Args are checked against the `IpcCommands` map and
 * the return type is inferred from it.
 *
 *   const conns = await invokeCmd("load_connections", { vaultPassword: null });
 *   //    ^? StoredConnectionDto[]
 *
 * If you need to invoke a command not yet in `IpcCommands`, add it there
 * rather than reaching for the untyped `invoke()` from `@tauri-apps/api/core`.
 */
export function invokeCmd<K extends IpcCommandName>(
  cmd: K,
  ...args: ArgsOf<K> extends void ? [] : [ArgsOf<K>]
): Promise<ResultOf<K>> {
  return tauriInvoke<ResultOf<K>>(cmd, args[0] as Record<string, unknown> | undefined);
}
