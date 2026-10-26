import { useMemo, useState } from "react";
import { Code2, FileCode, Loader2, Play, Search, Trash2 } from "lucide-react";
import { useSavedQueries, type SavedQuery } from "../../store/savedQueryStore";
import { useConnections } from "../../contexts/useConnections";
import { useConfirmDialog } from "../ui/ConfirmDialog";
import { IconButton } from "../ui/IconButton";

interface SavedQueryListProps {
  /** Row click: open/load the query. */
  onOpen: (query: SavedQuery) => void;
  /** ▶ button: open/load and run it. */
  onRun: (query: SavedQuery) => void;
  runLabel?: string;
  emptyHint?: string;
}

/**
 * The saved-queries list shared by Files → Saved Queries and the Multi Query
 * dialog, so both look and behave the same: search by name or SQL, one row
 * per query with its database and date, hover actions to run or delete.
 */
export function SavedQueryList({
  onOpen,
  onRun,
  runLabel = "Open and run",
  emptyHint = "Save queries from the main toolbar (Ctrl+S) to access them here.",
}: SavedQueryListProps) {
  const { queries, removeQuery, isLoading } = useSavedQueries();
  const { connections } = useConnections();
  const confirmDialog = useConfirmDialog();
  const [search, setSearch] = useState("");

  const confirmRemove = async (q: SavedQuery) => {
    const ok = await confirmDialog.confirm({
      title: "Delete saved query",
      message: `Delete "${q.name}" from your saved queries? This cannot be undone.`,
      confirmLabel: "Delete",
      type: "danger",
    });
    if (ok) await removeQuery(q.id);
  };

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return queries;
    return queries.filter((q) => q.name.toLowerCase().includes(needle) || q.query.toLowerCase().includes(needle));
  }, [queries, search]);

  const connectionName = (id: string) => connections.find((c) => c.id === id)?.name;

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-40 opacity-40 text-center px-4">
        <Loader2 className="w-10 h-10 mb-3 animate-spin" />
        <p className="text-sm font-bold">Loading saved queries...</p>
      </div>
    );
  }

  if (queries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-40 opacity-40 text-center px-4">
        <FileCode className="w-10 h-10 mb-3" />
        <p className="text-sm font-bold">No saved queries</p>
        <p className="text-[10px] mt-1 text-[var(--neutral-11)]">{emptyHint}</p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div className="relative mb-2">
        <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--neutral-11)]" />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search saved queries…"
          className="w-full pl-7 pr-2 py-1.5 text-xs rounded bg-[var(--surface-base)] border border-[var(--neutral-6)] outline-none focus:border-[var(--accent-8)] text-[var(--neutral-12)]"
        />
      </div>

      {visible.length === 0 && (
        <p className="text-center py-6 text-[11px] opacity-40">No results for "{search}"</p>
      )}

      {visible.map((q) => {
        const conn = connectionName(q.connectionId);
        return (
          <div
            key={q.id}
            onClick={() => onOpen(q)}
            title={`${conn ? `${conn} / ` : ""}${q.database || "(default database)"}\n\n${q.query.slice(0, 500)}`}
            className="flex flex-col p-2 rounded hover:bg-[var(--surface-base)] border border-transparent hover:border-[var(--neutral-6)] cursor-pointer group transition-all"
          >
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2 overflow-hidden">
                <Code2 className="w-3.5 h-3.5 text-[var(--accent-9)] shrink-0" />
                <span className="text-xs font-bold truncate tracking-wide text-[var(--neutral-12)]">{q.name}</span>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <IconButton
                  size="xs"
                  onClick={(e) => { e.stopPropagation(); onRun(q); }}
                  title={runLabel}
                  label={runLabel}
                  icon={<Play />}
                  className="text-[var(--accent-11)] hover:bg-[var(--accent-3)]"
                />
                <IconButton
                  size="xs"
                  onClick={(e) => { e.stopPropagation(); void confirmRemove(q); }}
                  title="Delete"
                  label="Delete"
                  icon={<Trash2 />}
                  className="text-[var(--danger-11)] hover:bg-[var(--danger-3)]"
                />
              </div>
            </div>
            <div className="text-[10px] font-mono text-[var(--neutral-11)] truncate opacity-60 pl-5">
              {q.database || conn || "—"} • {new Date(q.createdAt).toLocaleDateString()}
            </div>
          </div>
        );
      })}
    </div>
  );
}
