import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, RefreshCw, Search, Unplug } from "lucide-react";
import { useConnections } from "../../contexts/useConnections";
import { useConfirmDialog } from "../ui/ConfirmDialog";
import { formatDurationShort, type DatabaseSession } from "../../utils/ddlBuilders";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { cn } from "../../lib/cn";

interface DisconnectSessionsDialogProps {
  open: boolean;
  connection: { id: string; name: string };
  database: string;
  onClose: () => void;
}

const errorText = (e: unknown) => (typeof e === "string" ? e : (e as { message?: string })?.message || String(e));

/**
 * Every other session on a database in a fixed-height, scrollable, searchable
 * table. The sessions to end are ticked here and confirmed once more before
 * anything is disconnected; only those exact sessions are ended.
 */
export function DisconnectSessionsDialog({ open, connection, database, onClose }: DisconnectSessionsDialogProps) {
  const { listDatabaseSessions, terminateDatabaseSessions } = useConnections();
  const confirmDialog = useConfirmDialog();
  const [sessions, setSessions] = useState<DatabaseSession[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(async (keepSelection: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listDatabaseSessions(connection.id, database);
      setSessions(rows);
      setSelected((prev) => {
        const pids = new Set(rows.map((r) => r.pid));
        // Fresh list: everything ticked. Refresh: keep ticks on sessions still there.
        return keepSelection ? new Set([...prev].filter((p) => pids.has(p))) : pids;
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id, database]);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setResult(null);
    void load(false);
  }, [open, load]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return sessions;
    return sessions.filter((s) =>
      [String(s.pid), s.usename, s.application_name, s.client_addr, s.state, s.query]
        .some((v) => v?.toLowerCase().includes(term)));
  }, [sessions, search]);

  const visibleSelected = visible.filter((s) => selected.has(s.pid)).length;
  const allVisibleSelected = visible.length > 0 && visibleSelected === visible.length;
  const toggleAllVisible = () => setSelected((prev) => {
    const next = new Set(prev);
    for (const s of visible) {
      if (allVisibleSelected) next.delete(s.pid);
      else next.add(s.pid);
    }
    return next;
  });
  const toggle = (pid: number) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(pid)) next.delete(pid);
    else next.add(pid);
    return next;
  });

  // Only ticked sessions that are on screen: a filter never hides one that would be ended.
  const targets = visible.filter((s) => selected.has(s.pid));

  const handleDisconnect = async () => {
    const pids = targets.map((s) => s.pid);
    if (pids.length === 0) return;
    const n = pids.length;
    const ok = await confirmDialog.confirm({
      title: `Disconnect ${n} Session${n === 1 ? "" : "s"}?`,
      message: `This ends ${n === 1 ? "the selected session" : `the ${n} selected sessions`} on "${database}" (${connection.name}). Their running queries stop, open transactions are rolled back, and their applications lose the connection. This cannot be undone.`,
      confirmLabel: `Disconnect ${n}`,
      cancelLabel: "Cancel",
      type: "danger",
    });
    if (!ok) return;
    setBusy(true);
    setResult(null);
    try {
      const ended = await terminateDatabaseSessions(connection.id, database, pids);
      const gone = n - ended;
      setResult(`Disconnected ${ended} session${ended === 1 ? "" : "s"}.${gone > 0 ? ` ${gone} had already ended.` : ""}`);
      await load(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const th = "sticky top-0 z-10 bg-[var(--surface-panel)] px-2 py-1.5 text-left text-[10px] font-bold uppercase tracking-wider text-[var(--neutral-11)] border-b border-[var(--neutral-6)]";
  const selectedCount = targets.length;

  return (
    <Dialog open={open} onClose={onClose} className="max-w-5xl" dismissOnBackdrop={!busy} dismissOnEsc={!busy}>
      <Dialog.Title onClose={busy ? undefined : onClose}>
        <span className="flex items-center gap-2">
          <Unplug className="w-4 h-4 text-[var(--danger-11)]" />
          Disconnect Sessions: {database} ({connection.name})
        </span>
      </Dialog.Title>

      <div className="px-4 pt-3 shrink-0 space-y-2">
        <div className="flex items-start gap-2 rounded-md border border-[var(--danger-6)] bg-[var(--danger-3)]/40 p-2.5 text-xs text-[var(--danger-11)]">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-px" />
          <span>
            Disconnecting a session stops its running query, rolls back its open transaction and drops its application's
            connection, including QueryDen's own editor tabs on this database. Untick any session you want to keep.
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--neutral-9)]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by user, application, client, state, query or pid"
              className="w-full h-7 pl-7 pr-2 rounded-md bg-[var(--surface-base)] border border-[var(--neutral-7)] text-xs outline-none focus:border-[var(--accent-8)]"
            />
          </div>
          <Button size="sm" variant="secondary" onClick={() => void load(true)} disabled={loading || busy} leftIcon={<RefreshCw className={cn("w-3.5 h-3.5", loading && "animate-spin")} />}>
            Refresh
          </Button>
        </div>
        {error && <div className="text-xs text-[var(--danger-11)]">{error}</div>}
        {result && <div className="text-xs text-[var(--success-11)]">{result}</div>}
      </div>

      <div className="mx-4 my-2 h-[45vh] overflow-auto rounded-md border border-[var(--neutral-6)]">
        {sessions.length === 0 ? (
          <div className="h-full flex items-center justify-center text-xs text-[var(--neutral-11)]">
            {loading ? "Loading sessions…" : `Nobody else is connected to "${database}".`}
          </div>
        ) : (
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr>
                <th className={cn(th, "w-8")}>
                  <input type="checkbox" className="accent-[var(--danger-9)]" checked={allVisibleSelected} onChange={toggleAllVisible} aria-label="Select all shown sessions" />
                </th>
                <th className={th}>PID</th>
                <th className={th}>User</th>
                <th className={th}>Application</th>
                <th className={th}>Client</th>
                <th className={th}>State</th>
                <th className={th}>Connected</th>
                <th className={th}>Query</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((s) => (
                <tr
                  key={s.pid}
                  onClick={() => toggle(s.pid)}
                  className={cn("cursor-pointer border-b border-[var(--neutral-5)] hover:bg-[var(--neutral-3)]", selected.has(s.pid) && "bg-[var(--danger-3)]/25")}
                >
                  <td className="px-2 py-1" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" className="accent-[var(--danger-9)]" checked={selected.has(s.pid)} onChange={() => toggle(s.pid)} aria-label={`Select session ${s.pid}`} />
                  </td>
                  <td className="px-2 py-1 font-mono">{s.pid}</td>
                  <td className="px-2 py-1">{s.usename || "—"}</td>
                  <td className="px-2 py-1 max-w-[160px] truncate" title={s.application_name || undefined}>{s.application_name || "—"}</td>
                  <td className="px-2 py-1 font-mono">{s.client_addr || "local"}</td>
                  <td className="px-2 py-1 whitespace-nowrap">
                    <span className={cn(s.state === "active" && "text-[var(--success-11)]", s.state?.startsWith("idle in transaction") && "text-[var(--warning-11)]")}>
                      {s.state || "—"}
                    </span>
                    {s.state_secs != null && <span className="ml-1 opacity-50">{formatDurationShort(s.state_secs)}</span>}
                  </td>
                  <td className="px-2 py-1 whitespace-nowrap opacity-80">{formatDurationShort(s.connected_secs)}</td>
                  <td className="px-2 py-1 max-w-[320px] truncate font-mono opacity-80" title={s.query || undefined}>{s.query || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Dialog.Footer>
        <span className="mr-auto text-[11px] text-[var(--neutral-11)]">
          {sessions.length} session{sessions.length === 1 ? "" : "s"}
          {search && ` · ${visible.length} shown`} · {selectedCount} selected
        </span>
        <Button size="sm" variant="secondary" onClick={onClose} disabled={busy}>Close</Button>
        <Button size="sm" variant="destructive" onClick={() => void handleDisconnect()} loading={busy} disabled={selectedCount === 0 || loading}>
          Disconnect {selectedCount > 0 ? selectedCount : ""} selected
        </Button>
      </Dialog.Footer>
    </Dialog>
  );
}
