/**
 * Pure helpers for deciding which connection a query tab actually runs against.
 *
 * A tab may carry an explicit `target` (set when the explorer opens a table, or
 * restored with a session) that overrides the connection selected in the
 * sidebar. Getting this wrong is not a cosmetic bug: it runs the user's SQL --
 * including writes -- against a different server than the one on screen.
 */

/** The connection/database a tab explicitly points at, if any. */
export interface TabTarget {
  connectionId: string;
  database?: string;
}

export interface ReconnectCheck {
  /** Whether a usable pool handle is already in hand. */
  hasHandle: boolean;
  /** The active tab's explicit target, if it has one. */
  target?: TabTarget | null;
  /** Id of the connection currently selected in the sidebar. */
  activeConnectionId?: string | null;
  /** Database currently selected on that connection. */
  selectedDatabase?: string | null;
}

/**
 * Whether a tab needs a pool other than the one already in hand.
 *
 * This exists because the original condition was "no handle, **or** the tab has
 * a target at all". Since new tabs inherit their neighbour's connection, almost
 * every tab carries a target -- so every single Run re-established a connection
 * before sending the statement, which on a distant server is a multi-second
 * handshake paid on each press of the Run button.
 *
 * A target only matters when it points somewhere other than where we already
 * are. A target whose `database` is absent means "whatever is selected", so it
 * does not by itself force a reconnect.
 */
export function needsReconnect({
  hasHandle,
  target,
  activeConnectionId,
  selectedDatabase,
}: ReconnectCheck): boolean {
  if (!hasHandle) return true;
  if (!target) return false;
  if (target.connectionId !== activeConnectionId) return true;
  return (target.database || "") !== (selectedDatabase || "");
}
