export interface MultiQueryTarget {
  connectionId: string;
  database: string;
}

/**
 * Targets persisted from an earlier Multi-Query session, minus those whose
 * connection was deleted since, malformed entries and duplicates.
 */
export function restoreTargets(saved: unknown, connectionIds: readonly string[]): MultiQueryTarget[] {
  if (!Array.isArray(saved)) return [];
  const known = new Set(connectionIds);
  const seen = new Set<string>();
  const restored: MultiQueryTarget[] = [];
  for (const entry of saved) {
    if (typeof entry !== "object" || entry === null) continue;
    const { connectionId, database } = entry as Record<string, unknown>;
    if (typeof connectionId !== "string" || typeof database !== "string") continue;
    if (!known.has(connectionId) || !database) continue;
    const key = `${connectionId}\u0000${database}`;
    if (seen.has(key)) continue;
    seen.add(key);
    restored.push({ connectionId, database });
  }
  return restored;
}

/**
 * Drops targets whose database no longer exists on its server. Connections
 * missing from `listedDatabases` (list not fetched or the fetch failed) keep
 * their targets, so a transient network error doesn't wipe the selection.
 */
export function pruneMissingDatabases(
  targets: readonly MultiQueryTarget[],
  listedDatabases: Readonly<Record<string, readonly string[]>>,
): MultiQueryTarget[] {
  return targets.filter((t) => {
    const listed = listedDatabases[t.connectionId];
    return !listed || listed.includes(t.database);
  });
}

/**
 * Connection a cluster query is saved under: the one connection every target
 * shares, or "" when the targets span several (or none).
 */
export function savedQueryConnectionId(targets: readonly MultiQueryTarget[]): string {
  const ids = new Set(targets.map((t) => t.connectionId));
  return ids.size === 1 ? [...ids][0] : "";
}

export function isSaveShortcut(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): boolean {
  return (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s";
}
