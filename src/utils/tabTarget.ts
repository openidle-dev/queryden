/**
 * Resolve which connection/database a newly created editor tab targets.
 *
 * Why this exists: completion, hover and JOIN suggestions resolve against
 * the tab's OWN connection (background-fetched when never sidebar-connected).
 * A tab with no target gets no schema until the user clicks a database in
 * the explorer — so fresh tabs inherit, in order: explicit context-menu
 * params, the currently sidebar-active connection, then the previous
 * session's active connection (metadata only — inheriting never connects).
 * Unknown (deleted) connection ids and empty databases resolve to
 * `undefined` (untargeted) rather than pointing execution at a ghost.
 */

export interface TabTarget {
  connectionId: string;
  connectionName: string;
  database: string;
}

export interface KnownConnection {
  id: string;
  name: string;
  database: string;
}

export interface ResolveTabTargetArgs {
  explicitConnectionId?: string;
  explicitConnectionName?: string;
  explicitDatabase?: string;
  activeConnId?: string | null;
  activeConnName?: string | null;
  selectedDb?: string | null;
  lastSessionConnectionId?: string | null;
  lastSessionDatabase?: string | null;
  knownConnections: KnownConnection[];
}

export function resolveNewTabTarget(args: ResolveTabTargetArgs): TabTarget | undefined {
  const {
    explicitConnectionId,
    explicitConnectionName,
    explicitDatabase,
    activeConnId,
    activeConnName,
    selectedDb,
    lastSessionConnectionId,
    lastSessionDatabase,
    knownConnections,
  } = args;

  let connectionId: string | undefined;
  let connectionName = "";
  let database: string | undefined;

  if (explicitConnectionId) {
    connectionId = explicitConnectionId;
    connectionName = explicitConnectionName || activeConnName || "";
    database = explicitDatabase || selectedDb || undefined;
  } else if (activeConnId) {
    connectionId = activeConnId;
    connectionName = activeConnName || "";
    database = selectedDb || undefined;
  } else if (lastSessionConnectionId) {
    const known = knownConnections.find((c) => c.id === lastSessionConnectionId);
    if (!known) return undefined;
    connectionId = known.id;
    connectionName = known.name;
    database = lastSessionDatabase || undefined;
  } else {
    return undefined;
  }

  // The id must still exist (connections can be deleted between sessions)
  // and a target without a database is unusable — stay untargeted instead.
  const known = knownConnections.find((c) => c.id === connectionId);
  if (!known || !database) return undefined;

  return { connectionId, connectionName: connectionName || known.name, database };
}
