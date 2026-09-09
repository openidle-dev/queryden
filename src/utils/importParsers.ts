import { StoredConnectionDto, VaultCredentialDto } from "../lib/ipc";
import { getDefaultPort } from "./sqlDialect";

export interface ParseResult {
  source: string;
  connections: StoredConnectionDto[];
  vaultCredentials: VaultCredentialDto[];
}

type ParserFn = (content: string) => ParseResult | null;

function newId(): string {
  return crypto.randomUUID();
}

function stableId(c: { name: string; db_type: string; host: string | null; port: number | null; database: string }): string {
  const raw = `${c.name}|${c.db_type}|${c.host ?? ""}|${c.port ?? ""}|${c.database}`;
  let h = 0;
  for (let i = 0; i < raw.length; i++) {
    h = ((h << 5) - h + raw.charCodeAt(i)) | 0;
  }
  const hex = Math.abs(h).toString(16).padStart(8, "0");
  return `${hex}-${hex.substring(0, 4)}-${hex.substring(4, 8)}`;
}

function makeConn(overrides: Partial<StoredConnectionDto> & { name: string; db_type: string; host: string | null; port: number | null; database: string }): StoredConnectionDto {
  return {
    id: stableId({ name: overrides.name, db_type: overrides.db_type, host: overrides.host, port: overrides.port, database: overrides.database }),
    name: overrides.name,
    db_type: overrides.db_type,
    host: overrides.host,
    port: overrides.port,
    database: overrides.database,
    username: overrides.username ?? null,
    password: overrides.password ?? null,
    filepath: overrides.filepath ?? null,
    color: overrides.color ?? null,
    is_vault: overrides.is_vault ?? null,
    vault_credential_id: overrides.vault_credential_id ?? null,
    folder_id: overrides.folder_id ?? null,
  };
}

function parsePort(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (isNaN(n) || n < 1 || n > 65535) return null;
  return n;
}

function safePort(raw: unknown, fallback: number): number {
  return parsePort(raw) ?? fallback;
}

function mapProvider(provider: string | undefined | null): string {
  const lower = (provider || "").toLowerCase();
  if (lower.includes("postgres") || lower.includes("postgre")) return "postgres";
  if (lower.includes("supabase")) return "supabase";
  if (lower.includes("mysql") || lower.includes("maria")) return "mysql";
  if (lower.includes("sqlite")) return "sqlite";
  if (lower.includes("cockroach")) return "cockroach";
  return "postgres";
}

function parseQueryDen(content: string): ParseResult | null {
  try {
    const data = JSON.parse(content);
    if (!data.connections || !Array.isArray(data.connections)) return null;
    const conns: StoredConnectionDto[] = data.connections.map((c: any) => ({
      id: c.id || newId(),
      name: c.name || "Imported",
      db_type: c.db_type || "postgres",
      host: c.host ?? null,
      port: c.port ?? null,
      database: c.database || "postgres",
      username: c.username ?? null,
      password: c.password ?? null,
      filepath: c.filepath ?? null,
      color: c.color ?? null,
      is_vault: c.is_vault ?? null,
      vault_credential_id: c.vault_credential_id ?? null,
      ssh_enabled: c.ssh_enabled ?? null,
      ssh_host: c.ssh_host ?? null,
      ssh_port: c.ssh_port ?? null,
      ssh_username: c.ssh_username ?? null,
      ssh_password: c.ssh_password ?? null,
      ssh_key_path: c.ssh_key_path ?? null,
      ssh_key_passphrase: c.ssh_key_passphrase ?? null,
      folder_id: c.folder_id ?? null,
    }));
    const vaultCreds: VaultCredentialDto[] = Array.isArray(data.vault_credentials)
      ? data.vault_credentials.map((vc: any) => ({
          id: vc.id || newId(),
          name: vc.name || "Imported",
          username: vc.username ?? null,
          password: vc.password ?? null,
        }))
      : [];
    return { source: "QueryDen", connections: conns, vaultCredentials: vaultCreds };
  } catch {
    return null;
  }
}

// ── DBeaver format ─────────────────────────────────────────────────────────

function parseDBeaverDataSources(content: string): ParseResult | null {
  try {
    const data = JSON.parse(content);
    const connections = data.connections;
    if (!connections || typeof connections !== "object") return null;

    const result: StoredConnectionDto[] = [];
    const vaultCreds: VaultCredentialDto[] = [];

    for (const [_key, entry] of Object.entries(connections) as [string, any][]) {
      if (!entry || !entry.configuration) continue;

      const cfg = entry.configuration;
      let host = cfg.host || "";
      let port: number | null = parsePort(cfg.port);
      const database = cfg.database || "";
      const user = cfg.properties?.user || entry.user || "";

      if (!host && cfg.url) {
        const m = cfg.url.match(/jdbc:\w+:\/\/([^:/]+)(?::(\d+))?/);
        if (m) {
          host = m[1] || "";
          if (m[2]) port = parsePort(m[2]);
        }
      }

      let dbName = database;
      if (!dbName && cfg.url) {
        const m = cfg.url.match(/jdbc:\w+:\/\/(?:[^:/]+(?::\d+)?\/)([^?]+)/);
        if (m) dbName = m[1] || "";
      }

      const dbType = mapProvider(entry.provider);
      if (!port) {
        port = getDefaultPort(dbType);
      }

      host = host || "localhost";

      const name = entry.name || `${user}@${host}`;

      if (user) {
        const vcId = newId();
        vaultCreds.push({
          id: vcId,
          name: `${name} credentials`,
          username: user,
          password: entry["save-password"] ? (entry.password ?? null) : null,
        });
        result.push(makeConn({
          name,
          db_type: dbType,
          host,
          port,
          database: dbName || "postgres",
          is_vault: true,
          vault_credential_id: vcId,
        }));
      } else {
        result.push(makeConn({
          name,
          db_type: dbType,
          host,
          port,
          database: dbName || "postgres",
        }));
      }
    }

    if (result.length === 0) return null;
    return { source: "DBeaver", connections: result, vaultCredentials: vaultCreds };
  } catch {
    return null;
  }
}

function parseDBeaverCredentialsConfig(content: string): ParseResult | null {
  try {
    const data = JSON.parse(content);
    if (!data || typeof data !== "object") return null;

    const connections: StoredConnectionDto[] = [];
    const vaultCreds: VaultCredentialDto[] = [];

    for (const [key, entry] of Object.entries(data) as [string, any][]) {
      if (!entry || !entry.properties) continue;
      const props = entry.properties;
      let host = props.host || "";
      let port: number | null = parsePort(props.port);
      const database = props.database || "";
      const user = props.user || "";

      if (!host && entry.url) {
        const m = entry.url.match(/jdbc:\w+:\/\/([^:/]+)(?::(\d+))?/);
        if (m) {
          host = m[1] || "";
          if (m[2]) port = parsePort(m[2]);
        }
      }

      let dbName = database;
      if (!dbName && entry.url) {
        const m = entry.url.match(/jdbc:\w+:\/\/(?:[^:/]+(?::\d+)?\/)([^?]+)/);
        if (m) dbName = m[1] || "";
      }

      const provider = key.includes("postgres") ? "postgres" : key.includes("mysql") ? "mysql" : "postgres";
      if (!port) {
        port = getDefaultPort(provider);
      }

      host = host || "localhost";

      const name = props.name || `${user}@${host}`;

      if (user) {
        const vcId = newId();
        vaultCreds.push({
          id: vcId,
          name: `${name} credentials`,
          username: user,
          password: props.password ?? null,
        });
        connections.push(makeConn({
          name,
          db_type: provider,
          host,
          port,
          database: dbName || "postgres",
          is_vault: true,
          vault_credential_id: vcId,
        }));
      } else {
        connections.push(makeConn({
          name,
          db_type: provider,
          host,
          port,
          database: dbName || "postgres",
        }));
      }
    }

    if (connections.length === 0) return null;
    return { source: "DBeaver (credentials)", connections, vaultCredentials: vaultCreds };
  } catch {
    return null;
  }
}

// ── DataGrip format ────────────────────────────────────────────────────────

/**
 * Decode XML character data: predefined entities (`&amp;` etc.) plus decimal
 * and hexadecimal numeric references. `&amp;` is replaced last so
 * `&amp;lt;` decodes to the literal text `&lt;` (single-pass semantics).
 * Out-of-range code points keep their original text instead of throwing.
 */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (m, d) => {
      try {
        return String.fromCodePoint(parseInt(d, 10));
      } catch {
        return m;
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => {
      try {
        return String.fromCodePoint(parseInt(h, 16));
      } catch {
        return m;
      }
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractXmlTag(block: string, tags: string[]): string {
  for (const tag of tags) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
    const m = block.match(re);
    if (m) {
      const raw = (m[1] || "").trim();
      // CDATA sections are literal character data: unwrap without entity
      // decoding (`<![CDATA[a&amp;b]]>` means the seven characters `a&amp;b`).
      // A CDATA-wrapped JDBC URL would otherwise fail the URL matcher on `&`.
      if (raw.startsWith("<![CDATA[") && raw.endsWith("]]>")) {
        return raw.slice(9, -3);
      }
      return decodeXmlEntities(raw);
    }
  }
  return "";
}

function parseDataGripXML(content: string): ParseResult | null {
  try {
    if (!content.includes("<data-source") && !content.includes("<dataSources") && !content.includes("<dataSource")) return null;

    // Regex-based extraction (works in Node tests and browsers without a
    // DOMParser dependency). Matches <data-source name="…">…</data-source>
    // and camelCase <dataSource> variants.
    const blocks: Array<{ name: string; body: string }> = [];
    const dsRe = /<(?:data-source|dataSource)\b([^>]*)>([\s\S]*?)<\/(?:data-source|dataSource)>/gi;
    let m: RegExpExecArray | null;
    while ((m = dsRe.exec(content)) !== null) {
      const attrs = m[1] || "";
      const body = m[2] || "";
      const nameM = attrs.match(/\bname\s*=\s*"([^"]*)"/i);
      // Attribute values are XML character data too (`name="a &amp; b"`).
      blocks.push({ name: nameM ? decodeXmlEntities(nameM[1]) : "", body });
    }
    if (blocks.length === 0) return null;

    const connections: StoredConnectionDto[] = [];
    const vaultCreds: VaultCredentialDto[] = [];

    for (const ds of blocks) {
      const name = ds.name || "";
      const url = extractXmlTag(ds.body, ["database-url", "databaseUrl"]);
      const user = extractXmlTag(ds.body, ["user-name", "userName"]);
      const driver = extractXmlTag(ds.body, ["driver"]);

      let host = "localhost";
      let port: number | null = null;
      let dbName = "";
      let dbType = "postgres";

      if (url) {
        const um = url.match(/jdbc:(\w+):\/\/([^:/]+)(?::(\d+))?(?:\/([^?]+))?/);
        if (um) {
          if (um[1]) {
            dbType = mapProvider(um[1]);
          }
          if (um[2]) host = um[2];
          if (um[3]) port = parsePort(um[3]);
          if (um[4]) dbName = um[4];
        }
      }

      // Resolve the driver type BEFORE assigning the default port — a
      // driver-only MySQL source has no URL, so dbType would still be the
      // "postgres" default and receive 5432 instead of 3306.
      if (driver && !url) {
        const mapped = mapProvider(driver);
        // mapProvider falls back to "postgres" for unknown drivers; only
        // override when it recognized something (or mysql explicitly).
        if (mapped !== "postgres" || driver.toLowerCase().includes("mysql")) {
          dbType = mapped;
        }
      }

      if (!port) {
        port = getDefaultPort(dbType);
      }

      if (user) {
        const vcId = newId();
        vaultCreds.push({
          id: vcId,
          name: `${name || user} credentials`,
          username: user,
          password: null,
        });
        connections.push(makeConn({
          name: name || `${user}@${host}`,
          db_type: dbType,
          host,
          port,
          database: dbName || "postgres",
          is_vault: true,
          vault_credential_id: vcId,
        }));
      } else {
        connections.push(makeConn({
          name: name || `${host}`,
          db_type: dbType,
          host,
          port,
          database: dbName || "postgres",
        }));
      }
    }

    if (connections.length === 0) return null;
    return { source: "DataGrip", connections, vaultCredentials: vaultCreds };
  } catch {
    return null;
  }
}

// ── pgAdmin (SQLite dump as JSON) ──────────────────────────────────────────

function parsePgAdmin(content: string): ParseResult | null {
  try {
    const data = JSON.parse(content);
    if (!data.servers && !data.Servers) return null;

    const servers = data.servers || data.Servers || [];
    if (!Array.isArray(servers) || servers.length === 0) return null;

    const connections: StoredConnectionDto[] = [];
    const vaultCreds: VaultCredentialDto[] = [];

    for (const srv of servers) {
      const name = srv.name || srv.Name || "";
      const host = srv.host || srv.Host || srv.hostaddr || srv.HostAddr || "localhost";
      const port = safePort(srv.port ?? srv.Port, 5432);
      const database = srv.database || srv.Database || srv.maintenance_db || srv.MaintenanceDB || "postgres";
      const user = srv.username || srv.Username || srv.user || srv.User || "";

      if (user) {
        const vcId = newId();
        vaultCreds.push({
          id: vcId,
          name: `${name} credentials`,
          username: user,
          password: srv.password ?? srv.Password ?? null,
        });
        connections.push(makeConn({
          name: name || `${user}@${host}`,
          db_type: "postgres",
          host,
          port,
          database,
          is_vault: true,
          vault_credential_id: vcId,
        }));
      } else {
        connections.push(makeConn({
          name: name || `${host}`,
          db_type: "postgres",
          host,
          port,
          database,
        }));
      }
    }

    if (connections.length === 0) return null;
    return { source: "pgAdmin", connections, vaultCredentials: vaultCreds };
  } catch {
    return null;
  }
}

// ── TablePlus JSON export ─────────────────────────────────────────────────

function parseTablePlus(content: string): ParseResult | null {
  try {
    const data = JSON.parse(content);
    const groups = data.connections || data.Connections || data;
    if (!groups || typeof groups !== "object") return null;

    const connections: StoredConnectionDto[] = [];
    const vaultCreds: VaultCredentialDto[] = [];

    const entries: any[] = [];
    for (const [, val] of Object.entries(groups)) {
      if (Array.isArray(val)) entries.push(...val);
      else if (typeof val === "object" && val && (val as any).host) entries.push(val);
    }

    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const host = entry.host || entry.Host || "localhost";
      const port = parsePort(entry.port ?? entry.Port);
      const database = entry.database || entry.Database || entry.db || "";
      const user = entry.user || entry.User || entry.username || "";
      const driver = (entry.driver || entry.Driver || "").toLowerCase();
      const group = entry.groupName || entry.GroupName || entry.group || "";

      const dbType = mapProvider(driver || (group.includes("mysql") ? "mysql" : ""));

      const finalPort = port ?? getDefaultPort(dbType);
      const name = entry.name || entry.Name || `${user}@${host}`;

      if (user) {
        const vcId = newId();
        vaultCreds.push({
          id: vcId,
          name: `${name} credentials`,
          username: user,
          password: entry.password ?? entry.Password ?? null,
        });
        connections.push(makeConn({
          name,
          db_type: dbType,
          host,
          port: finalPort,
          database: database || "postgres",
          is_vault: true,
          vault_credential_id: vcId,
        }));
      } else {
        connections.push(makeConn({
          name,
          db_type: dbType,
          host,
          port: finalPort,
          database: database || "postgres",
        }));
      }
    }

    if (connections.length === 0) return null;
    return { source: "TablePlus", connections, vaultCredentials: vaultCreds };
  } catch {
    return null;
  }
}

// ── Parsers in priority order ──────────────────────────────────────────────

const PARSERS: { name: string; fn: ParserFn }[] = [
  { name: "QueryDen", fn: parseQueryDen },
  { name: "DBeaver", fn: parseDBeaverDataSources },
  { name: "DBeaver (credentials)", fn: parseDBeaverCredentialsConfig },
  { name: "DataGrip", fn: parseDataGripXML },
  { name: "pgAdmin", fn: parsePgAdmin },
  { name: "TablePlus", fn: parseTablePlus },
];

export function parseImport(content: string): ParseResult {
  for (const parser of PARSERS) {
    const result = parser.fn(content);
    if (result) return result;
  }

  throw new Error(
    "Could not parse the file. Supported formats:\n" +
      "- QueryDen JSON export\n" +
      "- DBeaver data-sources.json / credentials-config.json\n" +
      "- JetBrains DataGrip dataSources.xml\n" +
      "- pgAdmin server export (JSON)\n" +
      "- TablePlus connection export (JSON)"
  );
}

export function detectFormat(content: string): string {
  for (const parser of PARSERS) {
    const result = parser.fn(content);
    if (result) return parser.name;
  }
  return "Unknown";
}
