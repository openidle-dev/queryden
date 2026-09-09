import { createContext, useState, useEffect, useRef, ReactNode } from "react";
import { invokeCmd, StoredConnectionDto, VaultCredentialDto, FolderDto } from "../lib/ipc";
import { wouldCreateCycle } from "../utils/folderTree";
import { useSettings } from "../store/settingsStore";
import { getDefaultDatabaseName } from "../config/app";
import { quoteIdentifier } from "../utils/sqlSecurity";
import { getDefaultPort } from "../utils/sqlDialect";
import { fetchSchemaItems } from "../utils/schemaFetch";
import {
  buildCopyInsertSql,
  buildCopyPreviewSql,
  buildCountSql,
  buildCreateDatabaseSql,
  buildDropDatabaseSql,
  buildRoleDDL,
  splitDisplayName,
} from "../utils/ddlBuilders";
import { buildConnectionString } from "../utils/connectionString";
import { logger } from "../utils/logger";

export interface DatabaseConnection {
  id: string;
  name: string;
  type: string;
  host?: string;
  port?: number;
  database: string;
  username?: string;
  password?: string;
  filepath?: string;
  color?: string;
  isVault?: boolean;
  vaultCredentialId?: string;
  /** PostgreSQL server major version (e.g. 16), populated on connect */
  serverMajorVersion?: number;
  // SSH/Tunneling fields
  sshEnabled?: boolean;
  sshHost?: string;
  sshPort?: number;
  sshUsername?: string;
  sshPassword?: string;
  sshKeyPath?: string;
  sshKeyPassphrase?: string;
  /** Folder this connection belongs to, or null/undefined for root. */
  folderId?: string | null;
}

/** Connection-explorer folder (#104). */
export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  order: number;
}

export interface VaultCredential {
  id: string;
  name: string;
  username?: string;
  password?: string;
}

/**
 * A lazily-established database handle plus everything needed to talk to
 * its server (resolved credentials, effective TCP endpoint after any SSH
 * tunnel swap, target database). See `ensureConnectionDb`.
 */
export interface EnsuredConnection {
  /** Live `tauri-plugin-sql` Database handle (cached per connection+database). */
  db: any;
  /** Connection with `serverMajorVersion` filled in when detectable. */
  connection: DatabaseConnection;
  username: string;
  password: string;
  /** Effective TCP host (127.0.0.1 when routed through an SSH tunnel). */
  host: string;
  /** Effective TCP port (tunnel local port when routed through SSH). */
  port: number;
  database: string;
}

export interface DatabaseInfo {
  connectionId: string;
  databases: string[];
  selectedDatabase: string;
}

export interface SchemaItems {
  tables: string[];
  views: string[];
  functions: string[];
  triggers: string[];
  indexes: string[];
  sequences?: string[];
  types?: string[];
  procedures?: string[];
  operators?: string[];
  foreignTables?: string[];
  eventTriggers?: string[];
  extensions?: string[];
  languages?: string[];
  columns?: { table_name: string; column_name: string }[];
  foreignKeys?: { source_table: string; source_column: string; target_table: string; target_column: string }[];
  _ts?: number;
}

interface SchemaLoadingProgress {
  phase: "idle" | "initializing" | "connecting" | "tables" | "views" | "functions" | "procedures" | "triggers" | "indexes" | "types" | "operators" | "foreign_tables" | "columns" | "foreign_keys" | "complete";
  current: number;
  total: number;
}

export interface CreateTablePayload {
  name: string;
  schema?: string;
  columns: {
    name: string;
    type: string;
    nullable: boolean;
    primaryKey?: boolean;
    defaultValue?: string;
    description?: string;
  }[];
}

export interface CreateDatabasePayload {
  name: string;
  owner?: string;
  template?: string;
  encoding?: string;
  lcCollate?: string;
  lcCtype?: string;
  tablespace?: string;
  connectionLimit?: number;
  isTemplate?: boolean;
}

export interface CreateRolePayload {
  name: string;
  password?: string;
  connectionLimit?: number;
  validUntil?: string;
  canLogin: boolean;
  superuser: boolean;
  createDatabases: boolean;
  createRoles: boolean;
  replication: boolean;
  bypassRLS: boolean;
  inherit: boolean;
}

interface ConnectionContextType {
  connections: DatabaseConnection[];
  activeConnection: DatabaseConnection | null;
  selectedDatabase: string | null;
  databases: string[];
  schemaItems: SchemaItems | null;
  roles: { login: string[], group: string[] };
  setRoles: (roles: { login: string[], group: string[] }) => void;
  tablespaces: { name: string; owner: string; location: string | null; size: string | null }[];
  isLoadingSchema: boolean;
  currentDb: any;
  schemaProgress: SchemaLoadingProgress;
  initialLoadDone: boolean;
  setActiveConnection: (conn: DatabaseConnection | null) => void;
  setSelectedDatabase: (db: string | null) => void;
  addConnection: (conn: DatabaseConnection) => void;
  removeConnection: (id: string) => void;
  updateConnection: (id: string, conn: Partial<DatabaseConnection>) => void;
  connectToDatabase: (connId: string, databaseName?: string, overrideVaultCredential?: VaultCredential) => Promise<void>;
  disconnectFromDatabase: () => Promise<void>;
  /**
   * Lazily establish (or reuse a cached) database handle for any saved
   * connection — no sidebar click required. Opening the app connects nothing
   * (session restore is metadata-only by design), and tabs keep targeting
   * their own connections, so query/save paths call this for the tab's
   * target instead of failing with "connect first" errors.
   *
   * Same semantics as the manual `connectToDatabase` (vault-credential
   * reload fallback, SSH tunnel creation, server-version detection) but with
   * NO global side effects: it never touches `currentDb`, `activeConnection`
   * or `selectedDatabase`. Handles are cached per connection+database and
   * shared across calls; use `dropCachedConnection` to evict (disconnect,
   * connection removal, or a connection-lost error).
   */
  ensureConnectionDb: (connId: string, database?: string) => Promise<EnsuredConnection>;
  /** Close + evict all cached lazy handles for a connection. */
  dropCachedConnection: (connId: string) => Promise<void>;
  loadSchema: (database: string, overrideSchemas?: string[]) => Promise<void>;
  /**
   * Fetch (or reuse a cached) schema snapshot for ANY saved connection —
   * backing tab-targeted completion for tabs whose connection was never
   * sidebar-connected. Unlike `loadSchema` it never touches global tree
   * state (`schemaItems`, progress): results live in a per-connection cache
   * keyed `${connId}::${database}`. Concurrent callers share one fetch.
   * Returns null when the connection is unknown or introspection fails, so
   * callers fall back to the global schema / static keywords.
   */
  ensureSchemaFor: (connId: string, database?: string) => Promise<SchemaItems | null>;
  getDDL: (type: string, name: string, schema?: string, table?: string) => Promise<string>;
  generateStatement: (type: "select" | "insert" | "update" | "delete", tableName: string) => Promise<string>;
  exportConnections: (path: string, includePasswords: boolean) => Promise<void>;
  importConnections: (path: string) => Promise<number>;
  copyTableData: (tableName: string, targetDB: string) => Promise<string>;
  dropDatabase: (dbName: string) => Promise<void>;
  createDatabase: (payload: CreateDatabasePayload) => Promise<void>;
  createRole: (payload: CreateRolePayload) => Promise<void>;
  dropRole: (roleName: string) => Promise<void>;
  refreshRoles: () => Promise<void>;
  createTable: (payload: CreateTablePayload) => Promise<void>;
  executeDataCopy: (sourceTable: string, targetTable: string, targetDB: string, options?: {
    method?: "insert" | "copy" | "pgdump";
    batchSize?: number;
    parallel?: number;
    compression?: boolean;
    verifyAfter?: boolean;
    allowExecute?: boolean;
  }) => Promise<{ success: boolean; rowsCopied: number; error?: string }>;
  reloadConnections: () => Promise<void>;
  vaultCredentials: VaultCredential[];
  addVaultCredential: (cred: VaultCredential) => Promise<void>;
  removeVaultCredential: (id: string) => Promise<void>;
  updateVaultCredential: (id: string, cred: Partial<VaultCredential>) => Promise<void>;
  reloadVaultCredentials: () => Promise<void>;
  loadAvailableSchemas: () => Promise<string[]>;
  getDatabaseOwners: () => Promise<string[]>;
  getDatabaseTemplates: () => Promise<string[]>;
  getSelectedSchemas: (connectionId: string, databaseName: string) => string[];
  setSelectedSchemas: (connectionId: string, databaseName: string, schemas: string[]) => Promise<void>;
  // Folder hierarchy (#104)
  folders: Folder[];
  addFolder: (name: string, parentId: string | null) => Promise<Folder>;
  renameFolder: (id: string, name: string) => Promise<void>;
  /**
   * Delete a folder. Connections in this folder are reparented to the
   * folder's own parent (so deleting `Production/EU` leaves its connections
   * under `Production`). Subfolders are reparented the same way. Returns
   * the number of affected connections + subfolders for the caller's
   * confirmation UI.
   */
  removeFolder: (id: string) => Promise<{ connections: number; subfolders: number }>;
  /** Move a connection into a folder (or to the root with `folderId = null`). */
  moveConnectionToFolder: (connectionId: string, folderId: string | null) => Promise<void>;
  /**
   * Reparent a folder. Rejects (no-op + throws) if it would create a cycle —
   * i.e. `parentId` is the folder itself or one of its descendants.
   */
  moveFolder: (id: string, parentId: string | null) => Promise<void>;
}

export const ConnectionContext = createContext<ConnectionContextType | undefined>(undefined);

const COLORS = ["#06b6d4", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444", "#ec4899", "#3b82f6"];

function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return !!w.__TAURI_INTERNALS__ || !!w.__TAURI__;
}

function dtoToConnection(c: StoredConnectionDto): DatabaseConnection {
  return {
    id: c.id,
    name: c.name,
    type: c.db_type,
    host: c.host ?? undefined,
    port: c.port ?? undefined,
    database: c.database,
    username: c.username ?? undefined,
    password: c.password ?? undefined,
    filepath: c.filepath ?? undefined,
    color: c.color ?? undefined,
    isVault: c.is_vault ?? undefined,
    vaultCredentialId: c.vault_credential_id ?? undefined,
    sshEnabled: c.ssh_enabled ?? undefined,
    sshHost: c.ssh_host ?? undefined,
    sshPort: c.ssh_port ?? undefined,
    sshUsername: c.ssh_username ?? undefined,
    sshPassword: c.ssh_password ?? undefined,
    sshKeyPath: c.ssh_key_path ?? undefined,
    sshKeyPassphrase: c.ssh_key_passphrase ?? undefined,
    folderId: c.folder_id ?? null,
  };
}

function vaultDtoToCredential(c: VaultCredentialDto): VaultCredential {
  return {
    id: c.id,
    name: c.name,
    username: c.username ?? undefined,
    password: c.password ?? undefined,
  };
}

function vaultCredentialToDto(c: VaultCredential): VaultCredentialDto {
  return {
    id: c.id,
    name: c.name,
    username: c.username ?? null,
    password: c.password ?? null,
  };
}

function connectionToDto(c: DatabaseConnection): StoredConnectionDto {
  return {
    id: c.id,
    name: c.name,
    db_type: c.type,
    host: c.host ?? null,
    port: c.port ?? null,
    database: c.database,
    username: c.username ?? null,
    password: c.password ?? null,
    filepath: c.filepath ?? null,
    color: c.color ?? null,
    is_vault: c.isVault ?? null,
    vault_credential_id: c.vaultCredentialId ?? null,
    ssh_enabled: c.sshEnabled ?? null,
    ssh_host: c.sshHost ?? null,
    ssh_port: c.sshPort ?? null,
    ssh_username: c.sshUsername ?? null,
    ssh_password: c.sshPassword ?? null,
    ssh_key_path: c.sshKeyPath ?? null,
    ssh_key_passphrase: c.sshKeyPassphrase ?? null,
    folder_id: c.folderId ?? null,
  };
}

function folderDtoToFolder(f: FolderDto): Folder {
  return {
    id: f.id,
    name: f.name,
    parentId: f.parent_id ?? null,
    order: f.order,
  };
}

function folderToDto(f: Folder): FolderDto {
  return {
    id: f.id,
    name: f.name,
    parent_id: f.parentId,
    order: f.order,
  };
}

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const schemaStore = useSettings();
  
  const [connections, setConnections] = useState<DatabaseConnection[]>([]);
  const [activeConnection, setActiveConnection] = useState<DatabaseConnection | null>(null);
  const [selectedDatabase, setSelectedDatabase] = useState<string | null>(null);
  const [databases, setDatabases] = useState<string[]>([]);
  const [schemaItems, setSchemaItems] = useState<SchemaItems | null>(null);
  const [currentDb, setCurrentDb] = useState<any>(null);
  const [isLoadingSchema, setIsLoadingSchema] = useState(false);
  const [initialLoadDone, setInitialLoadDone] = useState(false);
  const [schemaProgress, setSchemaProgress] = useState<SchemaLoadingProgress>({ phase: "idle", current: 0, total: 0 });
  const [vaultCredentials, setVaultCredentials] = useState<VaultCredential[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  /** Selected schemas per database: { "connectionId:databaseName": string[] } */
  const [selectedSchemasByDatabase, setSelectedSchemasByDatabase] = useState<Record<string, string[]>>({});
  const [roles, setRoles] = useState<{ login: string[], group: string[] }>({ login: [], group: [] });
  const [tablespaces, setTablespaces] = useState<{ name: string; owner: string; location: string | null; size: string | null }[]>([]);

  // Lazy per-connection handles for `ensureConnectionDb` (multi-connection
  // startup connects nothing, so tab-target queries establish their own).
  // Key: `${connectionId}::${database}`. Refs (not state): handles are
  // resources, not render input. `pending` dedups concurrent first-use races
  // so two simultaneous runs share one handshake instead of leaking a spare.
  const lazyHandlesRef = useRef(new Map<string, any>());
  const lazyPendingRef = useRef(new Map<string, Promise<any>>());
  // Per-connection schema snapshots backing tab-targeted completion
  // (`ensureSchemaFor`). Same key shape as the lazy handles. Cached for the
  // session — introspection is read-only catalog traffic, and eviction rides
  // on `dropCachedConnection` (disconnect / removal / connection-loss).
  const schemaCacheRef = useRef(new Map<string, SchemaItems>());
  const schemaPendingRef = useRef(new Map<string, Promise<SchemaItems | null>>());

  // Load from file storage on mount
  useEffect(() => {
    async function loadFromFile() {
      if (!isTauri()) {
        setInitialLoadDone(true);
        return;
      }

      try {
        const stored = await invokeCmd("load_connections", { vaultPassword: null });
        if (stored) {
          setConnections(stored.map(dtoToConnection));
        }
      } catch (e) {
        logger.error("Failed to load connections from file:", e);
      } finally {
        setInitialLoadDone(true);
      }
    }
    loadFromFile();
  }, []);

  // Load Vault Credentials on mount
  useEffect(() => {
    if (isTauri()) {
      reloadVaultCredentials();
    }
  }, []);

  // Load folders on mount. Standalone file (folders.json) — see
  // storage.rs::load_folders. We only save back to disk after a successful
  // load; if the load fails (e.g. file exists but parse fails on this
  // machine), we deliberately refuse to enable the save path so we don't
  // overwrite the on-disk file with an empty list. The user's mutations
  // become session-only until they reload — visible failure mode beats
  // silent data loss.
  const [foldersLoaded, setFoldersLoaded] = useState(false);
  useEffect(() => {
    if (!isTauri()) {
      setFoldersLoaded(true);
      return;
    }
    (async () => {
      try {
        const dtos = await invokeCmd("load_folders");
        if (dtos) setFolders(dtos.map(folderDtoToFolder));
        // Only flip the save gate when the load actually succeeded.
        setFoldersLoaded(true);
      } catch (e) {
        // Intentionally leave foldersLoaded=false so the save effect
        // below never fires. Logged for forensic visibility.
        logger.error("Failed to load folders — folder changes will not be persisted this session:", e);
      }
    })();
  }, []);

  // Save folders on change (after a successful initial load).
  useEffect(() => {
    if (!isTauri() || !foldersLoaded) return;
    (async () => {
      try {
        await invokeCmd("save_folders", { folders: folders.map(folderToDto) });
      } catch (e) {
        logger.error("Failed to save folders:", e);
      }
    })();
  }, [folders, foldersLoaded]);

  const reloadVaultCredentials = async () => {
    if (!isTauri()) return;
    try {
      const creds = await invokeCmd("load_vault_credentials", { vaultPassword: null });
      setVaultCredentials(creds.map(vaultDtoToCredential));
    } catch (e) {
      logger.error("Failed to load vault credentials:", e);
    }
  };

  const saveVaultCredentials = async (creds: VaultCredential[]) => {
    if (!isTauri()) return;
    try {
      await invokeCmd("save_vault_credentials", {
        credentials: creds.map(vaultCredentialToDto),
        vaultPassword: null,
      });
    } catch (e) {
      logger.error("Failed to save vault credentials:", e);
    }
  };

  // Save to file storage on change
  useEffect(() => {
    async function saveToFile() {
      if (!isTauri()) {
        return;
      }
      try {
        await invokeCmd("save_connections", {
          connections: connections.map(connectionToDto),
          vaultPassword: null,
        });
      } catch (e) {
        logger.error("Failed to save connections:", e);
      }
    }
    
    // Only save if the initial load has completed to avoid overwriting with empty state
    if (initialLoadDone) {
      saveToFile();
    }
  }, [connections, initialLoadDone]);

  const exportConnections = async (path: string, includePasswords: boolean) => {
    await invokeCmd("export_connections", { path, includePasswords, vaultPassword: null });
  };

  const reloadConnections = async () => {
    if (!isTauri()) return;
    try {
      const stored = await invokeCmd("load_connections", { vaultPassword: null });
      if (stored) {
        setConnections(stored.map(dtoToConnection));
      }
    } catch (e) {
      logger.error("Failed to reload connections:", e);
    }
  };

  const importConnections = async (path: string): Promise<number> => {
    const count = await invokeCmd("import_connections", { path, vaultPassword: null });
    await reloadConnections();
    return count;
  };

  const addConnection = (conn: DatabaseConnection) => {
    if (!conn.color) {
      conn.color = COLORS[connections.length % COLORS.length];
    }
    setConnections((prev) => [...prev, conn]);
  };

  const removeConnection = async (id: string) => {
    if (activeConnection?.id === id) {
      await disconnectFromDatabase();
    } else {
      try {
        await invokeCmd("close_ssh_tunnel", { connectionId: id });
      } catch {
        // Tunnel may not exist
      }
      await dropCachedConnection(id);
    }
    setConnections((prev) => prev.filter((c) => c.id !== id));
  };

  const updateConnection = (id: string, updates: Partial<DatabaseConnection>) => {
    setConnections((prev) => prev.map((c) => (c.id === id ? { ...c, ...updates } : c)));
    setActiveConnection((current) => {
      if (current && current.id === id) {
        return { ...current, ...updates };
      }
      return current;
    });
  };

  // ── Folder CRUD (#104) ────────────────────────────────────────────────

  /**
   * Pick the next free order index among siblings of the same parent.
   *
   * Reads `folders` from outer-scope state. Two rapid calls before re-render
   * could in theory return the same value, producing duplicate `order`
   * keys — but ties are broken deterministically by `name.localeCompare`
   * in `buildConnectionTree`, so the worst observable outcome is a
   * tie-by-name sort. Revisit if/when we add drag-reorder or bulk ops.
   */
  const nextFolderOrder = (parentId: string | null): number => {
    const siblings = folders.filter((f) => (f.parentId ?? null) === parentId);
    if (siblings.length === 0) return 0;
    return Math.max(...siblings.map((f) => f.order)) + 1;
  };

  /** Throws if `parentId` is non-null but doesn't match any existing folder.
   *  Prevents callers from orphaning a folder by passing a stale id (the
   *  result would be unreachable from the root-based tree walk). */
  const ensureValidParent = (parentId: string | null): void => {
    if (parentId !== null && !folders.some((f) => f.id === parentId)) {
      throw new Error(`Parent folder ${parentId} not found`);
    }
  };

  const addFolder = async (name: string, parentId: string | null): Promise<Folder> => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Folder name cannot be empty");
    ensureValidParent(parentId);
    const newFolder: Folder = {
      id: crypto.randomUUID(),
      name: trimmed,
      parentId,
      order: nextFolderOrder(parentId),
    };
    setFolders((prev) => [...prev, newFolder]);
    return newFolder;
  };

  const renameFolder = async (id: string, name: string): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Folder name cannot be empty");
    setFolders((prev) => prev.map((f) => (f.id === id ? { ...f, name: trimmed } : f)));
  };

  const removeFolder = async (id: string): Promise<{ connections: number; subfolders: number }> => {
    const target = folders.find((f) => f.id === id);
    if (!target) return { connections: 0, subfolders: 0 };
    const newParent = target.parentId; // null if target was at root

    // Compute counts from the captured state BEFORE the setState calls.
    // Mutating locals inside a setState updater would be doubled under
    // React Strict Mode (which is enabled in main.tsx), producing wrong
    // counts in dev — passes tests, ships, only shows up as off-by-2x
    // numbers in the confirm dialog the next time anyone uses devtools.
    const subsAffected = folders.filter((f) => f.parentId === id).length;
    const connsAffected = connections.filter((c) => c.folderId === id).length;

    // Reparent direct children (folders + connections) to the target's parent.
    setFolders((prev) =>
      prev
        .filter((f) => f.id !== id)
        .map((f) => (f.parentId === id ? { ...f, parentId: newParent } : f)),
    );

    setConnections((prev) =>
      prev.map((c) => (c.folderId === id ? { ...c, folderId: newParent } : c)),
    );

    return { connections: connsAffected, subfolders: subsAffected };
  };

  const moveConnectionToFolder = async (
    connectionId: string,
    folderId: string | null,
  ): Promise<void> => {
    setConnections((prev) =>
      prev.map((c) => (c.id === connectionId ? { ...c, folderId } : c)),
    );
  };

  const moveFolder = async (id: string, parentId: string | null): Promise<void> => {
    ensureValidParent(parentId);
    if (wouldCreateCycle(id, parentId, folders)) {
      throw new Error("Cannot move a folder into itself or one of its descendants");
    }
    setFolders((prev) =>
      prev.map((f) =>
        f.id === id
          ? { ...f, parentId, order: nextFolderOrder(parentId) }
          : f,
      ),
    );
  };

  /**
   * Resolve a connection's credentials: explicit override first, otherwise
   * the vault credential referenced by the connection — with a direct reload
   * fallback when the in-memory vault list hasn't loaded yet (e.g. a lazy
   * query seconds after app start). Shared by manual connect and lazy
   * `ensureConnectionDb` so both see the same credentials.
   */
  const resolveConnectionCredentials = async (
    conn: DatabaseConnection,
    overrideVaultCredential?: VaultCredential,
  ): Promise<{ username: string; password: string }> => {
    let username = conn.username || "";
    let password = conn.password || "";

    // If override vault credential is passed, use it directly
    if (overrideVaultCredential) {
      username = overrideVaultCredential.username || "";
      password = overrideVaultCredential.password || "";
    } else if (conn.vaultCredentialId) {
      // Otherwise try to use vault credentials from connection's vaultCredentialId
      let vaultCred = vaultCredentials.find(vc => vc.id === conn.vaultCredentialId);

      if (!vaultCred) {
        // Vault credentials not loaded yet, reload directly
        try {
          const creds = await invokeCmd("load_vault_credentials", { vaultPassword: null });
          const mapped = creds.map(vaultDtoToCredential);
          setVaultCredentials(mapped);
          vaultCred = mapped.find(vc => vc.id === conn.vaultCredentialId);
        } catch (e) {
          logger.error("Failed to reload vault credentials:", e);
        }
      }

      if (vaultCred) {
        username = vaultCred.username || "";
        password = vaultCred.password || "";
      }
    }

    return { username, password };
  };

  const connectToDatabase = async (connId: string, databaseName?: string, overrideVaultCredential?: VaultCredential) => {
    const conn = connections.find((c) => c.id === connId);
    if (!conn) return;

    try {
      const Database = (await import("@tauri-apps/plugin-sql")).default;
      let connectionString = "";
      const targetDb = databaseName || conn.database;

      // Resolve credentials - check for override first (passed directly when user selects profile)
      const { username, password } = await resolveConnectionCredentials(conn, overrideVaultCredential);

      // URL encode credentials to handle special characters in passwords/usernames
      const encodedUser = encodeURIComponent(username);
      const encodedPass = encodeURIComponent(password);

      let actualHost = conn.host || "localhost";
      let actualPort = conn.port || getDefaultPort(conn.type);

      // Create SSH tunnel if enabled
      if (conn.sshEnabled && conn.sshHost && conn.sshUsername && conn.type !== "sqlite") {
        const tunnelResult = await invokeCmd("create_ssh_tunnel", {
          connectionId: conn.id,
          sshHost: conn.sshHost,
          sshPort: conn.sshPort || 22,
          sshUsername: conn.sshUsername,
          sshPassword: conn.sshPassword || null,
          sshKeyPath: conn.sshKeyPath || null,
          sshKeyPassphrase: conn.sshKeyPassphrase || null,
          remoteHost: actualHost,
          remotePort: actualPort,
        });
        actualHost = "127.0.0.1";
        actualPort = tunnelResult.local_port;
      }

      if (conn.type === "sqlite") {
        connectionString = `sqlite:${conn.filepath || getDefaultDatabaseName()}`;
      } else if (["postgres", "supabase", "cockroach"].includes(conn.type)) {
        connectionString = `postgres://${encodedUser}:${encodedPass}@${actualHost}:${actualPort}/${targetDb}`;
      } else if (["mysql", "mariadb"].includes(conn.type)) {
        connectionString = `mysql://${encodedUser}:${encodedPass}@${actualHost}:${actualPort}/${targetDb}`;
      }

      const db = await Database.load(connectionString);
      setCurrentDb(db);

      // Build updated connection object (including server major version for psql CLI)
      const updatedConn: DatabaseConnection = { ...conn };
      if (["postgres", "supabase", "cockroach"].includes(conn.type)) {
        try {
          const [versionRow] = await db.select<any[]>("SELECT (regexp_matches(version(), E'^PostgreSQL (\\d+)'))[1]::int AS major");
          updatedConn.serverMajorVersion = versionRow?.major || undefined;
        } catch {
          // Server version query failed — not critical, psql CLI will fall back
        }
      }

      // Update the connection in state so every component sees the server version
      updateConnection(conn.id, updatedConn);
      setActiveConnection(updatedConn);
      setSelectedDatabase(targetDb);
      
      // Get available databases list if it's the first connection or if requested
      if (!databaseName) {
        if (["postgres", "supabase", "cockroach"].includes(conn.type)) {
          const result = await db.select<any[]>("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname");
          setDatabases(result.map((r: any) => r.datname));
        } else if (["mysql", "mariadb"].includes(conn.type)) {
          const result = await db.select<any[]>("SHOW DATABASES");
          setDatabases(result.map((r: any) => r.Database));
        } else {
          setDatabases([conn.database]);
        }
      }

      // Load cluster-wide roles for PostgreSQL connections
      if (["postgres", "supabase", "cockroach"].includes(conn.type)) {
        try {
          const roleRows = await db.select<any[]>("SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY rolname");
          const login: string[] = [];
          const group: string[] = [];
          for (const r of roleRows) {
            if (r.rolcanlogin) login.push(r.rolname);
            else group.push(r.rolname);
          }
          setRoles({ login, group });
        } catch (e) {
          console.error("Failed to load roles:", e);
          setRoles({ login: [], group: [] });
        }
        // Load tablespaces
        try {
          const tsRows = await db.select<any[]>(
            "SELECT spcname, spcowner::regrole AS owner, pg_tablespace_location(oid) AS location, COALESCE(pg_size_pretty(NULLIF(pg_tablespace_size(oid), 0)), '0 bytes') AS size FROM pg_tablespace ORDER BY spcname"
          );
          setTablespaces(tsRows.map((r: any) => ({ name: r.spcname, owner: r.owner, location: r.location, size: r.size })));
        } catch (e) {
          console.error("Failed to load tablespaces:", e);
          setTablespaces([]);
        }
      }
    } catch (error: any) {
      console.error("Connection failed:", error);
      throw error;
    }
  };

  const disconnectFromDatabase = async () => {
    if (activeConnection) {
      try {
        await invokeCmd("close_ssh_tunnel", { connectionId: activeConnection.id });
      } catch (e) {
        logger.error("Failed to close SSH tunnel:", e);
      }
      // Drop lazily-established handles for this connection too, so a later
      // reconnect starts clean instead of reusing a stale pooled handle.
      await dropCachedConnection(activeConnection.id);
    }
    if (currentDb) {
      try {
        await currentDb.close();
      } catch (e) {
        console.error("Failed to close database connection:", e);
      }
    }
    setCurrentDb(null);
    setActiveConnection(null);
    setSelectedDatabase(null);
    setDatabases([]);
    setSchemaItems(null);
    setRoles({ login: [], group: [] });
    setTablespaces([]);
    // Notify the Monaco editor (if loaded) to drop its module-level schema cache.
    window.dispatchEvent(new CustomEvent("connection-disconnected"));
  };

  /**
   * Close + evict every cached lazy handle for a connection (disconnect,
   * connection removal, or a connection-lost error mid-query). In-flight
   * handshakes are closed on settle so they can't leak. Cached schema
   * snapshots for the connection are evicted too so a later reconnect
   * re-introspects instead of completing against stale catalog data.
   */
  const dropCachedConnection = async (connId: string) => {
    const prefix = `${connId}::`;
    for (const key of [...schemaCacheRef.current.keys()]) {
      if (key.startsWith(prefix)) schemaCacheRef.current.delete(key);
    }
    for (const key of [...schemaPendingRef.current.keys()]) {
      if (key.startsWith(prefix)) schemaPendingRef.current.delete(key);
    }
    const settle: Promise<unknown>[] = [];
    for (const [key, pending] of lazyPendingRef.current) {
      if (key.startsWith(prefix)) {
        lazyPendingRef.current.delete(key);
        settle.push(
          pending
            .then((db: any) => {
              try {
                const r = db?.close?.();
                if (r && typeof r.then === "function") return r;
              } catch {
                /* already dead */
              }
            })
            .catch(() => undefined),
        );
      }
    }
    const closes: Promise<unknown>[] = [];
    for (const [key, db] of lazyHandlesRef.current) {
      if (key.startsWith(prefix)) {
        lazyHandlesRef.current.delete(key);
        closes.push(
          (async () => {
            try {
              await db?.close?.();
            } catch {
              /* already dead */
            }
          })(),
        );
      }
    }
    await Promise.allSettled([...settle, ...closes]);
  };

  const ensureConnectionDb = async (connId: string, database?: string): Promise<EnsuredConnection> => {
    const conn = connections.find((c) => c.id === connId);
    if (!conn) {
      throw new Error("Connection not found. It may have been deleted — re-add it in the Database Explorer.");
    }
    const targetDb = database || conn.database;

    // Resolve credentials + effective TCP endpoint first: the CLI/psql path
    // needs them even on a cache hit, and the tunnel must be up before use.
    const { username, password } = await resolveConnectionCredentials(conn);

    let host = conn.host || "localhost";
    let port = conn.port || getDefaultPort(conn.type);

    // Create SSH tunnel if enabled (same parameters as manual connect).
    if (conn.sshEnabled && conn.sshHost && conn.sshUsername && conn.type !== "sqlite") {
      const tunnelResult = await invokeCmd("create_ssh_tunnel", {
        connectionId: conn.id,
        sshHost: conn.sshHost,
        sshPort: conn.sshPort || 22,
        sshUsername: conn.sshUsername,
        sshPassword: conn.sshPassword || null,
        sshKeyPath: conn.sshKeyPath || null,
        sshKeyPassphrase: conn.sshKeyPassphrase || null,
        remoteHost: host,
        remotePort: port,
      });
      host = "127.0.0.1";
      port = tunnelResult.local_port;
    }

    const key = `${conn.id}::${targetDb}`;
    const cached = lazyHandlesRef.current.get(key);
    if (cached) {
      return { db: cached, connection: conn, username, password, host, port, database: targetDb };
    }

    // Dedup concurrent first-use races on the same key. Re-validates after
    // the await: a dropCachedConnection during the load closes the handle on
    // settle, so a fulfilled-but-evicted promise must not be reused.
    const pending = lazyPendingRef.current.get(key);
    if (pending) {
      const db = await pending;
      const stillRegistered = lazyPendingRef.current.get(key) === pending;
      const cachedNow = lazyHandlesRef.current.get(key);
      if (!stillRegistered && cachedNow !== db) {
        throw new Error("Connection was closed while connecting. Please run again to reconnect.");
      }
      return { db, connection: conn, username, password, host, port, database: targetDb };
    }

    const Database = (await import("@tauri-apps/plugin-sql")).default;
    const connectionString = buildConnectionString({
      type: conn.type,
      host,
      port,
      database: targetDb,
      username,
      password,
      filepath: conn.filepath,
    });
    const loadPromise = Database.load(connectionString);
    lazyPendingRef.current.set(key, loadPromise);
    try {
      const db = await loadPromise;
      // A dropCachedConnection that ran while loading already closed this
      // handle on settle and cleared the entries: only cache when this
      // promise is still the registered load. (The close itself is owned by
      // the drop path, so just refuse — the caller retries fresh.)
      if (lazyPendingRef.current.get(key) !== loadPromise) {
        throw new Error("Connection was closed while connecting. Please run again to reconnect.");
      }
      lazyHandlesRef.current.set(key, db);

      // Detect the server major version for the psql CLI path (server-level,
      // so one detection covers every database on the connection). Best
      // effort — a failure here must not fail the query itself.
      let connection = conn;
      if (
        conn.serverMajorVersion == null &&
        ["postgres", "supabase", "cockroach", "psql"].includes((conn.type || "").toLowerCase())
      ) {
        try {
          const [versionRow] = await db.select<any[]>(
            "SELECT (regexp_matches(version(), E'^PostgreSQL (\\d+)'))[1]::int AS major",
          );
          const major = versionRow?.major;
          if (typeof major === "number") {
            connection = { ...conn, serverMajorVersion: major };
            updateConnection(conn.id, { serverMajorVersion: major });
          }
        } catch {
          // Version query failed — the CLI path falls back to system psql.
        }
      }

      return { db, connection, username, password, host, port, database: targetDb };
    } finally {
      // Only clear our own registration — a newer load for the same key
      // (started after an eviction) must keep its entry.
      if (lazyPendingRef.current.get(key) === loadPromise) {
        lazyPendingRef.current.delete(key);
      }
    }
  };

  const loadSchema = async (_database: string, overrideSchemas?: string[]) => {
    if (!activeConnection || !currentDb) {
      setSchemaItems(null);
      return;
    }

    setIsLoadingSchema(true);
    setSchemaProgress({ phase: "initializing", current: 0, total: 12 });

    // Use overrideSchemas if provided (from SchemaSelectionDialog), otherwise read from state
    const selectedSchemas = overrideSchemas !== undefined
      ? overrideSchemas
      : getSelectedSchemas(activeConnection.id, _database);

    try {
      // Introspection itself lives in fetchSchemaItems (shared with the
      // per-tab background path `ensureSchemaFor`) so the explorer tree and
      // tab-targeted completion always see identical data.
      const schema = await fetchSchemaItems({
        db: currentDb,
        connType: activeConnection.type,
        selectedSchemas,
        onProgress: (s) => setSchemaProgress({
          phase: s.phase as SchemaLoadingProgress["phase"],
          current: s.current,
          total: s.total,
        }),
      });
      setSchemaItems(prev => ({
        ...prev,
        ...schema,
        _ts: Date.now()
      }));
      setSchemaProgress({ phase: "complete", current: 12, total: 12 });
    } catch (error) {
      console.error("Failed to load schema:", error);
      setSchemaItems(null);
    } finally {
      setIsLoadingSchema(false);
    }
  };

  /**
   * Background schema fetch for tab-targeted completion. Establishes the
   * connection lazily (vault/SSH handled inside `ensureConnectionDb`),
   * introspects via the shared `fetchSchemaItems`, and caches per
   * connection+database. Never touches global tree state. Concurrent
   * callers for the same key share one fetch; only the still-registered
   * fetch may populate the cache (eviction during flight drops the result).
   */
  const ensureSchemaFor = async (connId: string, database?: string): Promise<SchemaItems | null> => {
    const conn = connections.find((c) => c.id === connId);
    if (!conn) return null;
    const dbName = database || conn.database;
    const key = `${connId}::${dbName}`;

    const hit = schemaCacheRef.current.get(key);
    if (hit) return hit;
    const pending = schemaPendingRef.current.get(key);
    if (pending) return pending;

    // Holder for the in-flight promise so the async body can verify it is
    // still the registered fetch (an eviction mid-flight must not resurrect
    // stale data). Assigned synchronously below, before the body first runs.
    const slot: { current: Promise<SchemaItems | null> | null } = { current: null };
    const run: Promise<SchemaItems | null> = (async () => {
      try {
        const ensured = await ensureConnectionDb(connId, dbName);
        const items = await fetchSchemaItems({
          db: ensured.db,
          connType: ensured.connection.type,
          selectedSchemas: getSelectedSchemas(connId, dbName),
        });
        // An eviction that ran mid-flight already dropped our registration:
        // don't resurrect stale data (the caller retries fresh).
        if (schemaPendingRef.current.get(key) !== slot.current) return null;
        schemaCacheRef.current.set(key, items);
        return items;
      } catch (e) {
        logger.error("Background schema fetch failed:", e);
        return null;
      } finally {
        if (schemaPendingRef.current.get(key) === slot.current) {
          schemaPendingRef.current.delete(key);
        }
      }
    })();
    slot.current = run;
    schemaPendingRef.current.set(key, run);
    return run;
  };

  // Role DDL lives in ddlBuilders.buildRoleDDL (pure + adversarially
  // tested): role names/attributes come from pg_roles rows and must be
  // quoted/escaped, never interpolated raw.

  const getDDL = async (type: string, name: string, schema?: string, table?: string): Promise<string> => {
    if (!activeConnection || !currentDb) return "";

    // Parse name - could be "table" or "schema.table"
    let schemaPart = schema || 'public';
    let tablePart = name;
    
    // Handle case like "ansible.job" or "public.job"
    if (name.includes('.')) {
      const parts = name.split('.');
      if (parts.length >= 2) {
        schemaPart = parts[0];
        tablePart = parts.slice(1).join('.');
      }
    }
    
    try {
      if (["postgres", "supabase", "cockroach"].includes(activeConnection.type)) {
        if (type === "table") {
          let ddl = `CREATE TABLE ${name} (\n`;
          let ddlParts: string[] = [];
          let foundColumns = false;
          
          // Try pg_catalog first (most reliable)
          try {
            const cols = await currentDb.select(`
              SELECT column_name, data_type, is_nullable, column_default, udt_name
              FROM pg_catalog.pg_columns 
              WHERE tablename = $1 AND schemaname NOT IN ('pg_catalog', 'information_schema')
            `, [tablePart]);
            
            if (cols && cols.length > 0) {
              ddlParts = cols.map((c: any) => {
                let colDef = `${c.column_name} ${c.udt_name || c.data_type}`;
                if (c.is_nullable === 'NO') colDef += ' NOT NULL';
                if (c.column_default) colDef += ` DEFAULT ${c.column_default}`;
                return colDef;
              });
              ddl += ddlParts.map(c => "  " + c).join(",\n");
              foundColumns = true;
            }
          } catch (e) {
          }
          
          // If not found, try with explicit schema
          if (!foundColumns) {
            try {
              const cols2 = await currentDb.select(`
                SELECT column_name, data_type, is_nullable, column_default, udt_name
                FROM information_schema.columns 
                WHERE table_name = $1 AND table_schema = $2
                ORDER BY ordinal_position
              `, [tablePart, schemaPart]);
              
              if (cols2 && cols2.length > 0) {
                ddlParts = cols2.map((c: any) => {
                  let colDef = `${c.column_name} ${c.udt_name || c.data_type}`;
                  if (c.is_nullable === 'NO') colDef += ' NOT NULL';
                  if (c.column_default) colDef += ` DEFAULT ${c.column_default}`;
                  return colDef;
                });
                ddl += ddlParts.map(c => "  " + c).join(",\n");
                foundColumns = true;
              }
            } catch (e) {
            }
          }
          
          // Last resort - search in all schemas
          if (!foundColumns) {
            try {
              const cols3 = await currentDb.select(`
                SELECT column_name, data_type, is_nullable, column_default, udt_name, table_schema
                FROM information_schema.columns 
                WHERE table_name = $1
                ORDER BY table_schema, ordinal_position
                LIMIT 50
              `, [tablePart]);
              
              if (cols3 && cols3.length > 0) {
                // Use the results found
                ddlParts = cols3.map((c: any) => {
                  let colDef = `${c.column_name} ${c.udt_name || c.data_type}`;
                  if (c.is_nullable === 'NO') colDef += ' NOT NULL';
                  if (c.column_default) colDef += ` DEFAULT ${c.column_default}`;
                  return colDef;
                });
                ddl += ddlParts.map(c => "  " + c).join(",\n");
                foundColumns = true;
              }
            } catch (e) {
            }
          }
          
          if (!foundColumns || ddlParts.length === 0) {
            ddl += "  -- No columns found (table: " + tablePart + ", schema: " + schemaPart + ")";
          }

          // Primary key
          let pkColNames = "";
          try {
            const pkCols = await currentDb.select(`
              SELECT a.attname as column_name
              FROM pg_index i
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
              WHERE i.indrelid = $1::regclass AND i.indisprimary
            `, [name]);
            if (pkCols.length > 0) {
              pkColNames = pkCols.map((c: any) => c.column_name).join(", ");
              ddl += `,\n  PRIMARY KEY (${pkColNames})`;
            }
          } catch (e) {
          }

          // Foreign keys
          try {
            const fkCols: any[] = await currentDb.select(`
              SELECT 
                kcu.column_name,
                ccu.table_name AS foreign_table_name,
                ccu.column_name AS foreign_column_name
              FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu 
                ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
              JOIN information_schema.constraint_column_usage ccu
                ON ccu.constraint_name = tc.constraint_name
              WHERE tc.constraint_type = 'FOREIGN KEY'
                AND tc.table_name = $1 AND tc.table_schema = $2
            `, [tablePart, schemaPart]);
            for (const fk of fkCols) {
              const fkTable = fk.foreign_table_name.includes('.') ? fk.foreign_table_name : `${schemaPart}.${fk.foreign_table_name}`;
              ddl += `,\n  FOREIGN KEY (${fk.column_name}) REFERENCES ${fkTable}(${fk.foreign_column_name})`;
            }
          } catch (e) {
            logger.debug("FK query failed:", e);
          }

          // Unique constraints
          let uqNames = "";
          try {
            const uniqueConstraints: any[] = await currentDb.select(`
              SELECT indexname, indexdef
              FROM pg_indexes 
              WHERE tablename = $1 AND schemaname = $2
            `, [tablePart, schemaPart]);
            if (uniqueConstraints.length > 0) {
              uqNames = uniqueConstraints.map((uq: any) => {
                const match = uq.indexdef.match(/INDEX \S+ ON/i);
                return match ? match[0] : uq.indexdef;
              }).join(", ");
              if (uqNames) {
                ddl += `\n-- Unique constraints: ${uqNames}`;
              }
            }
          } catch (e) {
            logger.debug("Unique constraints query failed:", e);
          }

          ddl += "\n);";
          return ddl;
        } else if (type === "view") {
          try {
            const result = await currentDb.select("SELECT pg_get_viewdef($1::regclass, true)", [name]);
            return `CREATE VIEW ${name} AS\n${result[0].pg_get_viewdef}`;
          } catch (e) {
            return `-- Could not get view definition: ${e}`;
          }
        } else if (type === "function") {
          try {
            const result = await currentDb.select("SELECT pg_get_functiondef($1::regproc)", [name]);
            return result[0].pg_get_functiondef;
          } catch (e) {
            return `-- Could not get function definition: ${e}`;
          }
        } else if (type === "procedure") {
          try {
            const parts = name.includes('.') ? name.split('.') : ['public', name];
            const schema = parts.length >= 2 ? parts[0] : 'public';
            const procName = parts.length >= 2 ? parts.slice(1).join('.') : name;
            const result = await currentDb.select(`
              SELECT pg_get_functiondef(p.oid)
              FROM pg_proc p
              JOIN pg_namespace n ON p.pronamespace = n.oid
              WHERE p.proname = $1 AND n.nspname = $2 AND p.prokind = 'p'
            `, [procName, schema]);
            if (result && result.length > 0) return result[0].pg_get_functiondef;
            return `-- Procedure ${name} not found`;
          } catch (e) {
            return `-- Could not get procedure definition: ${e}`;
          }
        } else if (type === "operator") {
          try {
            const parts = name.includes('.') ? name.split('.') : ['public', name];
            const schema = parts.length >= 2 ? parts[0] : 'public';
            const opName = parts.length >= 2 ? parts.slice(1).join('.') : name;
            const opInfo = await currentDb.select(`
              SELECT o.oprname,
                     CASE WHEN o.oprkind = 'b' THEN 'infix' WHEN o.oprkind = 'l' THEN 'prefix' END AS kind,
                     left_type.typname AS left_type,
                     right_type.typname AS right_type,
                     result_type.typname AS result_type,
                     o.oprcode::regproc AS func_name
              FROM pg_operator o
              LEFT JOIN pg_type left_type ON o.oprleft = left_type.oid
              LEFT JOIN pg_type right_type ON o.oprright = right_type.oid
              JOIN pg_type result_type ON o.oprresult = result_type.oid
              JOIN pg_namespace n ON o.oprnamespace = n.oid
              WHERE o.oprname = $1 AND n.nspname = $2
            `, [opName, schema]);
            if (!opInfo || opInfo.length === 0) {
              return `-- Operator ${name} not found`;
            }
            const op = opInfo[0];
            let ddl = `CREATE OPERATOR ${op.oprname} (\n  FUNCTION = ${op.func_name}`;
            if (op.kind === 'prefix' || op.kind === 'infix') {
              if (op.right_type) ddl += `,\n  RIGHTARG = ${op.right_type}`;
            }
            if (op.kind === 'infix') {
              if (op.left_type) ddl += `,\n  LEFTARG = ${op.left_type}`;
            }
            ddl += `\n);`;
            return ddl;
          } catch (e) {
            return `-- Could not get operator definition: ${e}`;
          }
        } else if (type === "index") {
          try {
            const result = await currentDb.select("SELECT pg_get_indexdef($1::regclass)", [name]);
            return result[0].pg_get_indexdef;
          } catch (e) {
            return `-- Could not get index definition: ${e}`;
          }
        } else if (type === "trigger") {
          try {
            let result;
            // If schema and table are provided, constrain lookup to avoid ambiguity
            // when the same trigger name exists on different tables
            if (schema && table) {
              result = await currentDb.select(`
                SELECT pg_get_triggerdef(t.oid)
                FROM pg_trigger t
                JOIN pg_class c ON t.tgrelid = c.oid
                JOIN pg_namespace n ON c.relnamespace = n.oid
                WHERE t.tgname = $1 AND n.nspname = $2 AND c.relname = $3
              `, [name, schema, table]);
            } else {
              // Fallback: look up by trigger name alone (may be ambiguous)
              result = await currentDb.select("SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = $1", [name]);
            }
            if (result && result.length > 0) {
              const def = Object.values(result[0])[0];
              return typeof def === 'string' ? def : `-- Trigger definition found but is not a string`;
            }
            return `-- Trigger ${name} not found`;
          } catch (e) {
            return `-- Could not get trigger definition: ${e}`;
          }
        } else if (type === "sequence") {
          try {
            const result = await currentDb.select(`
              SELECT 'CREATE SEQUENCE ' || quote_ident(schemaname) || '.' || quote_ident(sequencename) ||
                     '\n  START WITH ' || start_value ||
                     '\n  INCREMENT BY ' || increment_by ||
                     '\n  MINVALUE ' || min_value ||
                     '\n  MAXVALUE ' || max_value ||
                     '\n  CACHE ' || cache_size ||
                     '\n  ' || (CASE WHEN cycle THEN 'CYCLE' ELSE 'NO CYCLE' END) || ';' as def
              FROM pg_sequences
              WHERE (schemaname || '.' || sequencename = $1)
                 OR (sequencename = $1 AND schemaname = 'public')
            `, [name]);
            if (result && result.length > 0) return result[0].def;
            
            // Relkind S is sequence
            const rels = await currentDb.select("SELECT count(*) FROM pg_class WHERE relname = $1 AND relkind = 'S'", [name]);
            if (rels && rels.length > 0 && parseInt(rels[0].count) > 0) {
               return `CREATE SEQUENCE ${name}; -- Full definition not available in pg_sequences`;
            }
            return `-- Sequence ${name} not found`;
          } catch (e) {
            return `-- Could not get sequence definition: ${e}`;
          }
        } else if (type === "type") {
          try {
            const typeInfo = await currentDb.select(`
              SELECT t.typtype, n.nspname AS schema_name, t.typname AS type_name
              FROM pg_type t
              JOIN pg_namespace n ON t.typnamespace = n.oid
              WHERE (n.nspname || '.' || t.typname = $1)
                 OR (t.typname = $1 AND n.nspname = 'public')
            `, [name]);
            if (!typeInfo || typeInfo.length === 0) {
              return `-- Type ${name} not found`;
            }
            const ti = typeInfo[0];
            if (ti.typtype === 'e') {
              const enumVals = await currentDb.select(`
                SELECT e.enumlabel
                FROM pg_enum e
                JOIN pg_type t ON e.enumtypid = t.oid
                JOIN pg_namespace n ON t.typnamespace = n.oid
                WHERE (n.nspname || '.' || t.typname = $1)
                   OR (t.typname = $1 AND n.nspname = 'public')
                ORDER BY e.enumsortorder
              `, [name]);
              const labels = enumVals.map((e: any) => `'${e.enumlabel.replace(/'/g, "''")}'`).join(', ');
              return `CREATE TYPE ${name} AS ENUM (${labels});`;
            } else if (ti.typtype === 'd') {
              const domainInfo = await currentDb.select(`
                SELECT t.typbasetype::regtype AS base_type,
                       t.typdefault,
                       (SELECT cc.consrc FROM pg_constraint cc
                        WHERE cc.contypid = t.oid AND cc.contype = 'c' LIMIT 1) AS check_expr
                FROM pg_type t
                WHERE t.oid = (SELECT t2.oid FROM pg_type t2
                               JOIN pg_namespace n2 ON t2.typnamespace = n2.oid
                               WHERE (n2.nspname || '.' || t2.typname = $1)
                                  OR (t2.typname = $1 AND n2.nspname = 'public'))
              `, [name]);
              if (domainInfo && domainInfo.length > 0) {
                let ddl = `CREATE DOMAIN ${name} AS ${domainInfo[0].base_type}`;
                if (domainInfo[0].typdefault) {
                  ddl += ` DEFAULT ${domainInfo[0].typdefault}`;
                }
                if (domainInfo[0].check_expr) {
                  ddl += ` CONSTRAINT ${ti.type_name}_check CHECK (${domainInfo[0].check_expr})`;
                }
                ddl += ';';
                return ddl;
              }
              return `-- Domain ${name} found but definition could not be reconstructed`;
            } else {
              return `-- Type ${name} (kind: ${ti.typtype}) — DDL viewer only supports ENUM and DOMAIN types`;
            }
          } catch (e) {
            return `-- Could not get type definition: ${e}`;
          }
        } else if (type === "foreign_table") {
          try {
            const ftInfo = await currentDb.select(`
              SELECT ft.foreign_table_name, ft.foreign_server_name,
                     (SELECT fdw.fdwname FROM pg_foreign_server fs
                      JOIN pg_foreign_data_wrapper fdw ON fs.srvfdw = fdw.oid
                      WHERE fs.srvname = ft.foreign_server_name) AS fdw_name
              FROM information_schema.foreign_tables ft
              WHERE ft.foreign_table_name = $1
            `, [tablePart]);
            if (!ftInfo || ftInfo.length === 0) {
              return `-- Foreign table ${name} not found`;
            }
            const cols = await currentDb.select(`
              SELECT column_name, data_type, is_nullable, column_default
              FROM information_schema.columns
              WHERE table_name = $1 AND table_schema = $2
              ORDER BY ordinal_position
            `, [tablePart, schemaPart]);
            const colDefs = cols.map((c: any) => {
              let def = `  ${c.column_name} ${c.data_type}`;
              if (c.is_nullable === 'NO') def += ' NOT NULL';
              if (c.column_default) def += ` DEFAULT ${c.column_default}`;
              return def;
            });
            const opts = await currentDb.select(`
              SELECT option_name, option_value
              FROM information_schema.foreign_table_options
              WHERE foreign_table_name = $1 AND foreign_table_schema = $2
            `, [tablePart, schemaPart]);
            const optStr = opts.map((o: any) => `${o.option_name} '${o.option_value.replace(/'/g, "''")}'`).join(',\n  ');
            let ddl = `CREATE FOREIGN TABLE ${name} (\n${colDefs.join(',\n')}\n)\n`;
            ddl += `SERVER ${ftInfo[0].foreign_server_name}`;
            if (optStr) ddl += `\nOPTIONS (\n  ${optStr}\n)`;
            ddl += ';';
            return ddl;
          } catch (e) {
            return `-- Could not get foreign table definition: ${e}`;
          }
        } else if (type === "language") {
          try {
            const langInfo = await currentDb.select(`
              SELECT lanname, lanpltrusted,
                     lanplcallfoid::regproc AS handler,
                     laninline::regproc AS inline_handler,
                     lanvalidator::regproc AS validator
              FROM pg_language
              WHERE lanname = $1 AND lanispl = true
            `, [name]);
            if (!langInfo || langInfo.length === 0) {
              return `-- Language ${name} not found`;
            }
            const li = langInfo[0];
            let ddl = `CREATE ${li.lanpltrusted ? 'TRUSTED ' : ''}PROCEDURAL LANGUAGE ${li.lanname}`;
            if (li.handler && li.handler !== '-') {
              ddl += `\n  HANDLER ${li.handler}`;
            }
            if (li.inline_handler && li.inline_handler !== '-') {
              ddl += `\n  INLINE ${li.inline_handler}`;
            }
            if (li.validator && li.validator !== '-') {
              ddl += `\n  VALIDATOR ${li.validator}`;
            }
            ddl += ';';
            return ddl;
          } catch (e) {
            return `-- Could not get language definition: ${e}`;
          }
        } else if (type === "extension") {
          try {
            const extInfo = await currentDb.select(`
              SELECT e.extname, e.extversion, n.nspname AS schema_name
              FROM pg_extension e
              JOIN pg_namespace n ON e.extnamespace = n.oid
              WHERE e.extname = $1
            `, [name]);
            if (!extInfo || extInfo.length === 0) {
              return `-- Extension ${name} not found`;
            }
            const ei = extInfo[0];
            let ddl = `CREATE EXTENSION IF NOT EXISTS ${ei.extname}`;
            if (ei.schema_name) {
              ddl += `\n  SCHEMA ${ei.schema_name}`;
            }
            if (ei.extversion) {
              ddl += `\n  VERSION '${ei.extversion.replace(/'/g, "''")}'`;
            }
            ddl += ';';
            return ddl;
          } catch (e) {
            return `-- Could not get extension definition: ${e}`;
          }
        } else if (type === "tablespace") {
          try {
            const tsInfo = await currentDb.select(`
              SELECT spcname, spcowner::regrole AS owner, pg_tablespace_location(oid) AS location, spcoptions
              FROM pg_tablespace WHERE spcname = $1
            `, [name]);
            if (!tsInfo || tsInfo.length === 0) {
              return `-- Tablespace ${name} not found`;
            }
            const ts = tsInfo[0];
            let ddl = `CREATE TABLESPACE ${ts.spcname}\n  OWNER ${ts.owner}`;
            if (ts.location) ddl += `\n  LOCATION '${ts.location.replace(/'/g, "''")}'`;
            if (ts.spcoptions) {
              ddl += `\n  WITH (${(ts.spcoptions as string[]).join(', ')})`;
            }
            ddl += ';';
            return ddl;
          } catch (e) {
            return `-- Could not get tablespace definition: ${e}`;
          }
        } else if (type === "login_role") {
          try {
            let roleInfo;
            try {
              roleInfo = await currentDb.select(`
                SELECT r.rolname, r.rolsuper, r.rolinherit, r.rolcreaterole, r.rolcreatedb, r.rolcanlogin,
                       r.rolreplication, r.rolbypassrls, r.rolconnlimit,
                       r.rolvaliduntil AT TIME ZONE 'UTC' AS rolvaliduntil,
                       (SELECT rolpassword FROM pg_authid WHERE rolname = r.rolname) AS rolpassword
                FROM pg_roles r WHERE r.rolname = $1
              `, [name]);
            } catch {
              roleInfo = await currentDb.select(`
                SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
                       rolreplication, rolbypassrls, rolconnlimit,
                       rolvaliduntil AT TIME ZONE 'UTC' AS rolvaliduntil
                FROM pg_roles WHERE rolname = $1
              `, [name]);
            }
            if (!roleInfo || roleInfo.length === 0) {
              return `-- Role ${name} not found`;
            }
            return buildRoleDDL(roleInfo[0], true, activeConnection.type);
          } catch (e) {
            return `-- Could not get role definition: ${e}`;
          }
        } else if (type === "group_role") {
          try {
            let roleInfo;
            try {
              roleInfo = await currentDb.select(`
                SELECT r.rolname, r.rolsuper, r.rolinherit, r.rolcreaterole, r.rolcreatedb, r.rolcanlogin,
                       r.rolreplication, r.rolbypassrls, r.rolconnlimit,
                       r.rolvaliduntil AT TIME ZONE 'UTC' AS rolvaliduntil,
                       (SELECT rolpassword FROM pg_authid WHERE rolname = r.rolname) AS rolpassword
                FROM pg_roles r WHERE r.rolname = $1
              `, [name]);
            } catch {
              roleInfo = await currentDb.select(`
                SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
                       rolreplication, rolbypassrls, rolconnlimit,
                       rolvaliduntil AT TIME ZONE 'UTC' AS rolvaliduntil
                FROM pg_roles WHERE rolname = $1
              `, [name]);
            }
            if (!roleInfo || roleInfo.length === 0) {
              return `-- Role ${name} not found`;
            }
            return buildRoleDDL(roleInfo[0], false, activeConnection.type);
          } catch (e) {
            return `-- Could not get role definition: ${e}`;
          }
        }
      } else if (["mysql", "mariadb"].includes(activeConnection.type)) {
        const quotedName = quoteIdentifier(name, activeConnection.type);
        const query = `SHOW CREATE ${type.toUpperCase()} ${quotedName}`;
        const result = await currentDb.select(query);
        return Object.values(result[0])[1] as string;
      } else if (activeConnection.type === "sqlite") {
        const result = await currentDb.select("SELECT sql FROM sqlite_master WHERE name = $1", [name]);
        return result[0].sql;
      }
    } catch (e) {
      console.error("Failed to get DDL:", e);
      return `-- Error fetching DDL: ${e}`;
    }
    return `-- DDL for ${type} ${name} not found or not supported for this database type`;
  };

  const generateStatement = async (type: "select" | "insert" | "update" | "delete", tableName: string): Promise<string> => {
    if (!activeConnection || !currentDb) return "";

    try {
      let cols: any[] = [];
      if (["postgres", "supabase", "cockroach"].includes(activeConnection.type)) {
        const parts = tableName.split('.');
        const schemaPart = parts.length > 1 ? parts[0] : 'public';
        const tablePart = parts.length > 1 ? parts.slice(1).join('.') : tableName;

        cols = await currentDb.select(`
          SELECT column_name FROM information_schema.columns 
          WHERE table_name = $1 AND table_schema = $2
          ORDER BY ordinal_position
        `, [tablePart, schemaPart]);
      } else if (["mysql", "mariadb"].includes(activeConnection.type)) {        cols = await currentDb.select(`DESCRIBE ${tableName}`);
        cols = cols.map((c: any) => ({ column_name: c.Field }));
      } else if (activeConnection.type === "sqlite") {
        const quotedTable = quoteIdentifier(tableName, activeConnection.type);
        cols = await currentDb.select(`PRAGMA table_info(${quotedTable})`);
        cols = cols.map((c: any) => ({ column_name: c.name }));
      }

      const colNames = cols.map(c => c.column_name);

      const quotedTable = quoteIdentifier(tableName, activeConnection.type);
      const quotedCols = colNames.map(c => quoteIdentifier(c, activeConnection.type));

      switch (type) {
        case "select":
          return `SELECT ${quotedCols.join(", ")}\nFROM ${quotedTable}\nLIMIT 100;`;
        case "insert":
          return `INSERT INTO ${quotedTable} (${quotedCols.join(", ")})\nVALUES (${colNames.map(() => "?").join(", ")});`;
        case "update":
          return `UPDATE ${quotedTable}\nSET ${quotedCols.map(c => `${c} = ?`).join(", ")}\nWHERE id = ?;`;
        case "delete":
          return `DELETE FROM ${quotedTable}\nWHERE id = ?;`;
      }
    } catch (e) {
      console.error("Failed to generate statement:", e);
      return `-- Error generating statement: ${e}`;
    }
    return `-- Statement generation for ${type} on ${tableName} failed`;
  };

  const copyTableData = async (tableName: string, targetDB: string): Promise<string> => {
    if (!activeConnection || !currentDb) return "-- Not connected to a database";
    
    try {
      // Quote-aware split (`"my.schema"."my.table"` stays two parts).
      const { schema: rawSchema, table: tablePart } = splitDisplayName(tableName);
      const schemaPart = rawSchema ?? 'public';

      if (!["postgres", "supabase", "cockroach"].includes(activeConnection.type)) {
        return `-- COPY is only supported for PostgreSQL. Consider using INSERT statements for ${activeConnection.type}.`;
      }

      // Get column names
      const cols = await currentDb.select(`
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = $1 AND table_schema = $2
        ORDER BY ordinal_position
      `, [tablePart, schemaPart]);

      if (cols.length === 0) {
        return `-- No columns found for table ${tableName}`;
      }

      const colNames = cols.map((c: any) => c.column_name);

      // Sample row for the preview INSERT. Column identifiers are quoted
      // (catalog content must never be interpolated raw); values go through
      // formatSqlLiteral inside the preview builder.
      const quotedCols = colNames.map((c: string) => quoteIdentifier(c, activeConnection.type));
      const sampleSelect = `SELECT ${quotedCols.join(", ")} FROM ${quoteIdentifier(`${schemaPart}.${tablePart}`, activeConnection.type)} LIMIT 1`;
      const sampleRow = await currentDb.select(sampleSelect);

      return buildCopyPreviewSql({
        dbType: activeConnection.type,
        tableDisplay: tableName,
        targetDb: targetDB,
        srcSchema: schemaPart,
        srcTable: tablePart,
        colNames,
        sampleRow: sampleRow.length > 0 ? sampleRow[0] : null,
        currentDbDisplay: selectedDatabase ?? "",
      });
    } catch (e) {
      console.error("Failed to generate copy SQL:", e);
      return `-- Error generating copy SQL: ${e}`;
    }
  };

  const dropDatabase = async (dbName: string) => {
    if (!activeConnection || !currentDb) return;

    if (!schemaStore.allowSqlExecute) {
      throw new Error(`Execution Denied: The "Allow SQL Execution" permission (sql:allow-execute) is disabled in settings. Please enable it to drop databases.`);
    }

    try {
      if (["postgres", "supabase", "cockroach"].includes(activeConnection.type)) {
        // If dropping the active database, we MUST switch to another one first (like 'postgres')
        if (selectedDatabase === dbName) {
          logger.debug("Switching to maintenance DB before dropping active database...");
          await connectToDatabase(activeConnection.id, "postgres");
        }
        
        // Force disconnect other users if possible (Postgres 13+)
        try {
          await currentDb.execute(`
            SELECT pg_terminate_backend(pg_stat_activity.pid)
            FROM pg_stat_activity
            WHERE pg_stat_activity.datname = $1
              AND pid <> pg_backend_pid();
          `, [dbName]);
        } catch (e) {
          // Force disconnect failed (maybe not enough permissions), proceeding anyway
        }

        await currentDb.execute(buildDropDatabaseSql(activeConnection.type, dbName));
      } else if (["mysql", "mariadb"].includes(activeConnection.type)) {
        await currentDb.execute(buildDropDatabaseSql(activeConnection.type, dbName));
      } else {
        // SQLite doesn't really have "Drop Database" in the same way, but we could delete the file
        // For now, only support server-based DBs
        throw new Error(`Drop Database is not supported for ${activeConnection.type}`);
      }

      // Refresh databases list
      if (["postgres", "supabase", "cockroach"].includes(activeConnection.type)) {
        const result = await currentDb.select("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname");
        setDatabases(result.map((r: any) => r.datname));
      } else if (["mysql", "mariadb"].includes(activeConnection.type)) {
        const result = await currentDb.select("SHOW DATABASES");
        setDatabases(result.map((r: any) => r.Database));
      }

      if (selectedDatabase === dbName) {
        setSelectedDatabase(null);
        setSchemaItems(null);
      }
    } catch (e: any) {
      console.error("Drop database failed:", e);
      throw e;
    }
  };

  const createDatabase = async (payload: CreateDatabasePayload) => {
    if (!activeConnection || !currentDb) return;
    if (!schemaStore.allowSqlExecute) {
      throw new Error(`Execution Denied: Enable "Allow SQL Execution" in settings to create databases.`);
    }

    try {
      // DDL text comes from the pure, adversarially-tested builders
      // (quoting/escaping included); unsupported engines throw there.
      await currentDb.execute(buildCreateDatabaseSql(activeConnection.type, payload));

      // Refresh databases list
      if (["postgres", "supabase", "cockroach"].includes(activeConnection.type)) {
        const result = await currentDb.select("SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname");
        setDatabases(result.map((r: any) => r.datname));
      } else if (["mysql", "mariadb"].includes(activeConnection.type)) {
        const result = await currentDb.select("SHOW DATABASES");
        setDatabases(result.map((r: any) => r.Database));
      }
    } catch (e: any) {
      console.error("Create database failed:", e);
      throw e;
    }
  };

  const refreshRoles = async () => {
    if (!currentDb) return;
    try {
      const roleRows = await currentDb.select(
        "SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY rolname"
      );
      const login: string[] = [];
      const group: string[] = [];
      for (const r of roleRows) {
        if (r.rolcanlogin) login.push(r.rolname);
        else group.push(r.rolname);
      }
      setRoles({ login, group });
    } catch (e) {
      console.error("Failed to refresh roles:", e);
    }
  };

  const createRole = async (payload: CreateRolePayload) => {
    if (!activeConnection || !currentDb) {
      throw new Error("Not connected to a database");
    }
    if (!schemaStore.allowSqlExecute) {
      throw new Error(`Execution Denied: Enable "Allow SQL Execution" in settings to create roles.`);
    }
    if (!["postgres", "supabase", "cockroach"].includes(activeConnection.type)) {
      throw new Error(`Create Role is not supported for ${activeConnection.type}`);
    }

    try {
      const name = payload.name.trim();
      if (!name) throw new Error("Role name is required");
      const quotedName = quoteIdentifier(name, activeConnection.type);

      let sql = `CREATE ROLE ${quotedName} WITH`;

      // Login / NOLOGIN — always emitted since it's the key distinction
      sql += payload.canLogin ? " LOGIN" : " NOLOGIN";

      // Password (Postgres encrypts by default since PG 10)
      if (payload.password) {
        // Escape single quotes in password
        const escaped = payload.password.replace(/'/g, "''");
        sql += ` PASSWORD '${escaped}'`;
      } else {
        sql += " PASSWORD NULL";
      }

      // Privilege clauses — only emit when set to non-default value
      if (payload.superuser) sql += " SUPERUSER";
      if (payload.createDatabases) sql += " CREATEDB";
      if (payload.createRoles) sql += " CREATEROLE";
      if (payload.replication) sql += " REPLICATION";
      if (payload.bypassRLS) sql += " BYPASSRLS";
      if (!payload.inherit) sql += " NOINHERIT";

      if (payload.connectionLimit !== undefined && payload.connectionLimit >= 0) {
        sql += ` CONNECTION LIMIT ${payload.connectionLimit}`;
      }

      if (payload.validUntil) {
        const escaped = payload.validUntil.replace(/'/g, "''");
        sql += ` VALID UNTIL '${escaped}'`;
      }

      await currentDb.execute(sql);
      await refreshRoles();
    } catch (e: any) {
      console.error("Create role failed:", e);
      throw e;
    }
  };

  const dropRole = async (roleName: string) => {
    if (!activeConnection || !currentDb) {
      throw new Error("Not connected to a database");
    }
    if (!schemaStore.allowSqlExecute) {
      throw new Error(`Execution Denied: Enable "Allow SQL Execution" in settings to drop roles.`);
    }
    if (!["postgres", "supabase", "cockroach"].includes(activeConnection.type)) {
      throw new Error(`Drop Role is not supported for ${activeConnection.type}`);
    }
    const quotedName = quoteIdentifier(roleName, activeConnection.type);
    await currentDb.execute(`DROP ROLE IF EXISTS ${quotedName}`);
    await refreshRoles();
  };

  const createTable = async (payload: CreateTablePayload) => {
    if (!activeConnection || !currentDb) return;
    if (!schemaStore.allowSqlExecute) {
      throw new Error(`Execution Denied: Enable "Allow SQL Execution" in settings to create tables.`);
    }

    try {
      const type = activeConnection.type;
      const schemaPart = payload.schema || 'public';
      const fullTableName = (type === 'postgres' && schemaPart !== 'public') 
        ? `"${schemaPart}"."${payload.name}"` 
        : quoteIdentifier(payload.name, type);
      
      let sql = `CREATE TABLE ${fullTableName} (\n`;
      const colDefs = payload.columns.map(col => {
        let def = `  ${quoteIdentifier(col.name, type)} ${col.type}`;
        if (col.primaryKey) def += " PRIMARY KEY";
        if (!col.nullable) def += " NOT NULL";
        if (col.defaultValue) def += ` DEFAULT ${col.defaultValue}`;
        return def;
      });
      sql += colDefs.join(",\n");
      sql += "\n);";

      await currentDb.execute(sql);
      
      // Refresh schema if we are in the active database
      if (selectedDatabase) {
        await loadSchema(selectedDatabase);
      }
    } catch (e: any) {
      console.error("Create table failed:", e);
      throw e;
    }
  };

  const executeDataCopy = async (
    sourceTable: string, 
    targetTable: string, 
    targetDB: string, 
    options?: {
      method?: "insert" | "copy" | "pgdump";
      batchSize?: number;
      parallel?: number;
      compression?: boolean;
      verifyAfter?: boolean;
      allowExecute?: boolean;
    }
  ): Promise<{ success: boolean; rowsCopied: number; error?: string }> => {
    if (!activeConnection || !currentDb) {
      return { success: false, rowsCopied: 0, error: "Not connected to a database" };
    }
    
    const method = options?.method || "insert";
    const allowExecute = options?.allowExecute !== false;
    
    if (!["postgres", "supabase", "cockroach"].includes(activeConnection.type)) {
      return { success: false, rowsCopied: 0, error: "Direct data copy is only supported for PostgreSQL" };
    }

    if (!allowExecute) {
      return { 
        success: false, 
        rowsCopied: 0, 
        error: "Direct execution is disabled in settings. Generated script will contain DDL only."
      };
    }
    
    try {
      // Quote-aware display-name split (`"my.schema"."my.table"` stays two
      // parts); every identifier below is quoted by the builders, never
      // interpolated raw.
      const src = splitDisplayName(sourceTable);
      const schemaPart = src.schema ?? 'public';
      const tablePart = src.table;
      const tgt = splitDisplayName(targetTable);
      const targetSchemaPart = tgt.schema ?? 'public';
      const targetTablePart = tgt.table;

      // Check if target table exists
      const checkTarget = await currentDb.select(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = $1 AND table_name = $2
        ) as exists
      `, [targetSchemaPart, targetTablePart]);

      if (!checkTarget[0]?.exists) {
        return { success: false, rowsCopied: 0, error: `Target table ${targetSchemaPart}.${targetTablePart} does not exist. Run DDL first.` };
      }

      // Get row count before
      const countBefore = await currentDb.select(buildCountSql(activeConnection.type, schemaPart, tablePart));
      const sourceCount = countBefore[0]?.count || 0;

      if (sourceCount === 0) {
        return { success: true, rowsCopied: 0, error: undefined };
      }

      let rowsCopied = 0;

      // Execute based on method
      if (method === "insert" || method === "copy") {
        // For INSERT or COPY method, use INSERT...SELECT
        // (COPY via SQL requires file system access, so we use INSERT for safety)
        const rawBatch = options?.batchSize;
        const batchSize = rawBatch !== undefined && Number.isFinite(rawBatch) && rawBatch > 0
          ? Math.floor(rawBatch)
          : 1000;

        if (sourceCount <= batchSize) {
          // Direct insert for small tables
          const result = await currentDb.execute(buildCopyInsertSql({
            dbType: activeConnection.type,
            targetDb: targetDB,
            targetSchema: targetSchemaPart,
            targetTable: targetTablePart,
            srcSchema: schemaPart,
            srcTable: tablePart,
          }));
          rowsCopied = typeof result.rowsAffected === 'number' ? result.rowsAffected : sourceCount;
        } else {
          // Batch insert for large tables
          const result = await currentDb.execute(buildCopyInsertSql({
            dbType: activeConnection.type,
            targetDb: targetDB,
            targetSchema: targetSchemaPart,
            targetTable: targetTablePart,
            srcSchema: schemaPart,
            srcTable: tablePart,
            limit: batchSize,
          }));
          rowsCopied = typeof result.rowsAffected === 'number' ? result.rowsAffected : batchSize;
        }
      } else if (method === "pgdump") {
        // pg_dump method - requires shell execution, return guidance
        return {
          success: false,
          rowsCopied: 0,
          error: "pg_dump/pg_restore requires server-side execution. Use: pg_dump -t ${tablePart} -d ${selectedDatabase} | psql -d ${targetDB}"
        };
      }

      // Verify after if requested
      if (options?.verifyAfter) {
        const countAfter = await currentDb.select(
          buildCountSql(activeConnection.type, targetSchemaPart, targetTablePart, targetDB)
        );
        const targetCount = countAfter[0]?.count || 0;
        if (targetCount !== rowsCopied) {
          return { success: false, rowsCopied, error: `Verification failed: expected ${rowsCopied}, found ${targetCount}` };
        }
      }
      
      return { 
        success: true, 
        rowsCopied,
        error: undefined 
      };
    } catch (e: any) {
      console.error("Data copy failed:", e);
      return { success: false, rowsCopied: 0, error: e.message || String(e) };
    }
  };

  const loadAvailableSchemas = async (): Promise<string[]> => {
    if (!currentDb || !activeConnection || activeConnection.type !== 'postgres') return [];
    try {
      const result = await currentDb.select(`SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'pg_extensions') ORDER BY schema_name`);
      return result.map((r: any) => r.schema_name);
    } catch (e) {
      console.error("Failed to load schemas:", e);
      return [];
    }
  };

  const getDatabaseOwners = async (): Promise<string[]> => {
    if (!currentDb || !activeConnection) return [];
    try {
      if (["postgres", "supabase", "cockroach"].includes(activeConnection.type)) {
        const result = await currentDb.select(`SELECT usename FROM pg_user ORDER BY usename`);
        return result.map((r: any) => r.usename);
      } else if (["mysql", "mariadb"].includes(activeConnection.type)) {
        const result = await currentDb.select(`SELECT User FROM mysql.user ORDER BY User`);
        return result.map((r: any) => r.User);
      }
      return [];
    } catch (e) {
      console.error("Failed to load database owners:", e);
      return [];
    }
  };

  const getDatabaseTemplates = async (): Promise<string[]> => {
    if (!currentDb || !activeConnection || !["postgres", "supabase", "cockroach"].includes(activeConnection.type)) return [];
    try {
      const result = await currentDb.select(`SELECT datname FROM pg_database WHERE datistemplate = true ORDER BY datname`);
      return result.map((r: any) => r.datname);
    } catch (e) {
      console.error("Failed to load database templates:", e);
      return [];
    }
  };

  const getSelectedSchemas = (connectionId: string, databaseName: string): string[] => {
    const key = `${connectionId}:${databaseName}`;
    return selectedSchemasByDatabase[key] || [];
  };

  const setSelectedSchemas = async (connectionId: string, databaseName: string, schemas: string[]) => {
    const key = `${connectionId}:${databaseName}`;
    setSelectedSchemasByDatabase(prev => ({ ...prev, [key]: schemas }));
  };

  return (
    <ConnectionContext.Provider
      value={{
        connections,
        activeConnection,
        selectedDatabase,
        databases,
        schemaItems,
        roles,
        setRoles,
        tablespaces,
        isLoadingSchema,
        currentDb,
        schemaProgress,
        initialLoadDone,
        setActiveConnection,
        setSelectedDatabase,
        addConnection,
        removeConnection,
        updateConnection,
        connectToDatabase,
        disconnectFromDatabase,
        ensureConnectionDb,
        dropCachedConnection,
        loadSchema,
        ensureSchemaFor,
        getDDL,
        generateStatement,
        exportConnections,
        importConnections,
        copyTableData,
        dropDatabase,
        createDatabase,
        createRole,
        dropRole,
        refreshRoles,
        createTable,
        executeDataCopy,
        reloadConnections,
        vaultCredentials,
        addVaultCredential: async (cred) => {
          const next = [...vaultCredentials, cred];
          setVaultCredentials(next);
          await saveVaultCredentials(next);
        },
        removeVaultCredential: async (id) => {
          const next = vaultCredentials.filter(c => c.id !== id);
          setVaultCredentials(next);
          await saveVaultCredentials(next);
        },
        updateVaultCredential: async (id, cred) => {
          const next = vaultCredentials.map(c => c.id === id ? { ...c, ...cred } : c);
          setVaultCredentials(next);
          await saveVaultCredentials(next);
        },
        reloadVaultCredentials,
        loadAvailableSchemas,
        getDatabaseOwners,
        getDatabaseTemplates,
        getSelectedSchemas,
        setSelectedSchemas,
        folders,
        addFolder,
        renameFolder,
        removeFolder,
        moveConnectionToFolder,
        moveFolder,
      }}
    >
      {children}
    </ConnectionContext.Provider>
  );
}