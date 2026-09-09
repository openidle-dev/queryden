/**
 * Startup auto-reconnect eligibility.
 *
 * Opening the app connects nothing (session restore is metadata-only), so a
 * connection left open at close stays dead until the user clicks it again.
 * `MainContent` auto-restores the previously-active connection on launch —
 * but only when it can connect *non-interactively*. A connection still
 * waiting for the user to pick a vault credential profile needs a modal
 * dialog, and startup must never prompt: those stay manual.
 */

/** Minimal shape needed for the eligibility check (structural subset of `DatabaseConnection`). */
export interface ReconnectCandidate {
  id: string;
  isVault?: boolean;
  vaultCredentialId?: string;
}

export function canAutoReconnect(conn: ReconnectCandidate | null | undefined): boolean {
  if (!conn) return false;
  if (conn.isVault === true && !conn.vaultCredentialId) return false;
  return true;
}
