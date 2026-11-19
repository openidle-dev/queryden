import type { MultiQueryTarget } from "./multiQueryTargets";

export interface NodeTemplate {
  id: string;
  name: string;
  targets: MultiQueryTarget[];
  createdAt: number;
  updatedAt: number;
}

export type NodeGroupBy = "connection" | "database";

export const NODE_GROUP_BY_OPTIONS: readonly NodeGroupBy[] = ["connection", "database"];

export function isNodeGroupBy(value: unknown): value is NodeGroupBy {
  return typeof value === "string" && (NODE_GROUP_BY_OPTIONS as readonly string[]).includes(value);
}

const targetKey = (t: MultiQueryTarget) => `${t.connectionId}\u0000${t.database}`;

function sanitizeTargets(raw: unknown): MultiQueryTarget[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const targets: MultiQueryTarget[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { connectionId, database } = entry as Record<string, unknown>;
    if (typeof connectionId !== "string" || typeof database !== "string" || !connectionId || !database) continue;
    const target = { connectionId, database };
    if (seen.has(targetKey(target))) continue;
    seen.add(targetKey(target));
    targets.push(target);
  }
  return targets;
}

/**
 * Templates read back from settings.json, which is user-editable: malformed
 * entries, empty templates and repeated ids are dropped. Targets on deleted
 * connections are kept so the template still reports them as missing.
 */
export function sanitizeTemplates(saved: unknown): NodeTemplate[] {
  if (!Array.isArray(saved)) return [];
  const ids = new Set<string>();
  const templates: NodeTemplate[] = [];
  for (const entry of saved) {
    if (typeof entry !== "object" || entry === null) continue;
    const { id, name, targets, createdAt, updatedAt } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !id || ids.has(id)) continue;
    if (typeof name !== "string" || !name.trim()) continue;
    const cleanTargets = sanitizeTargets(targets);
    if (cleanTargets.length === 0) continue;
    ids.add(id);
    const created = typeof createdAt === "number" ? createdAt : 0;
    templates.push({
      id,
      name: name.trim(),
      targets: cleanTargets,
      createdAt: created,
      updatedAt: typeof updatedAt === "number" ? updatedAt : created,
    });
  }
  return templates;
}

export function findTemplateByName(templates: readonly NodeTemplate[], name: string): NodeTemplate | undefined {
  const wanted = name.trim().toLowerCase();
  return templates.find((t) => t.name.toLowerCase() === wanted);
}

/** Saves `targets` under `name`, replacing a same-named template (case-insensitive) in place. */
export function upsertTemplate(
  templates: readonly NodeTemplate[],
  name: string,
  targets: readonly MultiQueryTarget[],
  now: number,
  newId: () => string,
): { templates: NodeTemplate[]; template: NodeTemplate; replaced: boolean } {
  const trimmed = name.trim();
  const cleanTargets = sanitizeTargets(targets);
  const existing = findTemplateByName(templates, trimmed);
  if (existing) {
    const template = { ...existing, name: trimmed, targets: cleanTargets, updatedAt: now };
    return { templates: templates.map((t) => (t.id === existing.id ? template : t)), template, replaced: true };
  }
  const template = { id: newId(), name: trimmed, targets: cleanTargets, createdAt: now, updatedAt: now };
  return { templates: [...templates, template], template, replaced: false };
}

export type TemplateMatch = "exact" | "partial" | "none";

/** How the current selection relates to a template: identical set, overlapping, or disjoint. */
export function templateMatch(template: readonly MultiQueryTarget[], selected: readonly MultiQueryTarget[]): TemplateMatch {
  const selectedKeys = new Set(selected.map(targetKey));
  const templateKeys = new Set(template.map(targetKey));
  let shared = 0;
  for (const key of templateKeys) if (selectedKeys.has(key)) shared++;
  if (shared === 0) return "none";
  return shared === templateKeys.size && shared === selectedKeys.size ? "exact" : "partial";
}

export function isTargetIn(targets: readonly MultiQueryTarget[], connectionId: string, database: string): boolean {
  return targets.some((t) => t.connectionId === connectionId && t.database === database);
}

/** Selects every target in `group`, or deselects them all when every one is already selected. */
export function toggleTargetGroup(
  selected: readonly MultiQueryTarget[],
  group: readonly MultiQueryTarget[],
): MultiQueryTarget[] {
  if (group.length === 0) return [...selected];
  const groupKeys = new Set(group.map(targetKey));
  const selectedKeys = new Set(selected.map(targetKey));
  const allSelected = [...groupKeys].every((key) => selectedKeys.has(key));
  if (allSelected) return selected.filter((t) => !groupKeys.has(targetKey(t)));
  const added = sanitizeTargets(group).filter((t) => !selectedKeys.has(targetKey(t)));
  return [...selected, ...added];
}

export interface NodeConnection {
  id: string;
  name: string;
  type: string;
  host?: string;
  database: string;
}

export interface ConnectionNode {
  connectionId: string;
  databases: string[];
}

export interface NodeFilter {
  query: string;
  selectedOnly: boolean;
}

/**
 * Connections and their databases left visible by the sidebar filter. A query
 * matching the connection's name, host or engine keeps all its databases;
 * otherwise only databases whose name matches stay. Databases not listed yet
 * fall back to the connection's default database.
 */
export function filterConnectionNodes(
  connections: readonly NodeConnection[],
  listedDatabases: Readonly<Record<string, readonly string[]>>,
  selected: readonly MultiQueryTarget[],
  filter: NodeFilter,
): ConnectionNode[] {
  const needle = filter.query.trim().toLowerCase();
  const nodes: ConnectionNode[] = [];
  for (const conn of connections) {
    const all = listedDatabases[conn.id] ?? [conn.database].filter(Boolean);
    const connMatches =
      !needle ||
      conn.name.toLowerCase().includes(needle) ||
      (conn.host ?? "").toLowerCase().includes(needle) ||
      conn.type.toLowerCase().includes(needle);
    let databases = connMatches ? [...all] : all.filter((db) => db.toLowerCase().includes(needle));
    if (filter.selectedOnly) databases = databases.filter((db) => isTargetIn(selected, conn.id, db));
    const hidden = (needle && !connMatches) || filter.selectedOnly;
    if (hidden && databases.length === 0) continue;
    nodes.push({ connectionId: conn.id, databases });
  }
  return nodes;
}

export interface DatabaseGroup {
  database: string;
  connectionIds: string[];
}

/** Same-named databases across connections, e.g. one `app` group spanning prod, staging and dev. */
export function groupNodesByDatabase(nodes: readonly ConnectionNode[]): DatabaseGroup[] {
  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    for (const db of node.databases) {
      const ids = groups.get(db);
      if (ids) ids.push(node.connectionId);
      else groups.set(db, [node.connectionId]);
    }
  }
  return [...groups.entries()]
    .map(([database, connectionIds]) => ({ database, connectionIds }))
    .sort((a, b) => b.connectionIds.length - a.connectionIds.length || a.database.localeCompare(b.database));
}

export type GroupCheckState = "all" | "some" | "none";

export function groupCheckState(selected: readonly MultiQueryTarget[], group: readonly MultiQueryTarget[]): GroupCheckState {
  if (group.length === 0) return "none";
  const hits = group.filter((t) => isTargetIn(selected, t.connectionId, t.database)).length;
  if (hits === 0) return "none";
  return hits === group.length ? "all" : "some";
}

/** Renames and/or re-targets one template; `error` is user-facing and nothing changes when set. */
export function editTemplate(
  templates: readonly NodeTemplate[],
  id: string,
  name: string,
  targets: readonly MultiQueryTarget[],
  now: number,
): { templates: NodeTemplate[]; error?: undefined } | { templates?: undefined; error: string } {
  const trimmed = name.trim();
  if (!trimmed) return { error: "Enter a template name." };
  const cleanTargets = sanitizeTargets(targets);
  if (cleanTargets.length === 0) return { error: "A template needs at least one database." };
  if (!templates.some((t) => t.id === id)) return { error: "This template no longer exists." };
  const clash = findTemplateByName(templates, trimmed);
  if (clash && clash.id !== id) return { error: `A template named "${clash.name}" already exists.` };
  return {
    templates: templates.map((t) => (t.id === id ? { ...t, name: trimmed, targets: cleanTargets, updatedAt: now } : t)),
  };
}

export interface TemplateServerDatabase {
  name: string;
  /** In the template but absent from the server's fetched database list. */
  missing: boolean;
}

export interface TemplateServerView {
  connectionId: string;
  databases: TemplateServerDatabase[];
}

/**
 * Per-server rows for the template editor. `members` are shown even before a
 * server's database list arrives (and flagged missing once it has, if gone);
 * `showAll` adds every other known database and server so they can be added.
 * Members on deleted connections come back separately as `orphaned`.
 */
export function templateEditorView(
  connections: readonly NodeConnection[],
  listedDatabases: Readonly<Record<string, readonly string[]>>,
  members: readonly MultiQueryTarget[],
  options: { query: string; showAll: boolean },
): { servers: TemplateServerView[]; orphaned: MultiQueryTarget[] } {
  const needle = options.query.trim().toLowerCase();
  const knownIds = new Set(connections.map((c) => c.id));
  const servers: TemplateServerView[] = [];
  for (const conn of connections) {
    const memberDbs = members.filter((m) => m.connectionId === conn.id).map((m) => m.database);
    const listed = listedDatabases[conn.id];
    const known = listed ?? [conn.database].filter(Boolean);
    const names = options.showAll ? [...known, ...memberDbs.filter((db) => !known.includes(db))] : memberDbs;
    const connMatches =
      !needle ||
      conn.name.toLowerCase().includes(needle) ||
      (conn.host ?? "").toLowerCase().includes(needle) ||
      conn.type.toLowerCase().includes(needle);
    const visible = connMatches ? names : names.filter((db) => db.toLowerCase().includes(needle));
    if (visible.length === 0) continue;
    servers.push({
      connectionId: conn.id,
      databases: visible.map((db) => ({ name: db, missing: !!listed && !listed.includes(db) })),
    });
  }
  const orphaned = members.filter(
    (m) => !knownIds.has(m.connectionId) && (!needle || m.database.toLowerCase().includes(needle)),
  );
  return { servers, orphaned };
}

/**
 * Selection to switch to after a template is edited: its new databases when
 * the template was in use (selection matched it, or it was the last one
 * used), so the tree follows the edit; null to leave the selection alone.
 */
export function selectionAfterTemplateEdit(
  previous: readonly MultiQueryTarget[],
  next: readonly MultiQueryTarget[],
  selected: readonly MultiQueryTarget[],
  wasCurrent: boolean,
  connectionIds: readonly string[],
): MultiQueryTarget[] | null {
  if (!wasCurrent && templateMatch(previous, selected) !== "exact") return null;
  const known = new Set(connectionIds);
  return sanitizeTargets(next).filter((t) => known.has(t.connectionId));
}
