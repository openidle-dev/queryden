import { Suspense, lazy, useState } from "react";
import { useSavedQueries } from "../../store/savedQueryStore";
import { Folder, FileCode, Play, Trash2, Code2, Loader2, Clock } from "lucide-react";
import { IconButton } from "../ui/IconButton";

const LocalHistoryDialog = lazy(() => import("../ui/LocalHistoryDialog").then((m) => ({ default: m.LocalHistoryDialog })));

export function FilesExplorer() {
  const { queries, removeQuery, isLoading } = useSavedQueries();
  const [showLocalHistory, setShowLocalHistory] = useState(false);

  const handleOpenQuery = (query: any) => {
    window.dispatchEvent(
      new CustomEvent("open-query-with-text", {
        detail: { query: query.query, name: query.name },
      })
    );
  };

  return (
    <div className="h-full flex flex-col bg-[var(--surface-elevated)] text-[var(--neutral-12)]">
      <div className="p-3 border-b border-[var(--neutral-6)] flex items-center justify-between shadow-sm z-10 shrink-0">
        <h2 className="text-xs font-bold uppercase tracking-wider text-[var(--neutral-11)] flex items-center gap-2">
          <Folder className="w-4 h-4" />
          Saved Queries
        </h2>
        <IconButton size="sm" onClick={() => setShowLocalHistory(true)} title="Local History" label="Local History" icon={<Clock />} />
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1 custom-scrollbar">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center h-40 opacity-40 text-center px-4">
            <Loader2 className="w-10 h-10 mb-3 animate-spin" />
            <p className="text-sm font-bold">Loading saved queries...</p>
          </div>
        ) : queries.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-40 opacity-40 text-center px-4">
            <FileCode className="w-10 h-10 mb-3" />
            <p className="text-sm font-bold">No saved queries</p>
            <p className="text-[10px] mt-1 text-[var(--neutral-11)]">Save queries from the main toolbar to access them here.</p>
          </div>
        ) : (
          queries.map((q) => (
            <div
              key={q.id}
              onClick={() => handleOpenQuery(q)}
              className="flex flex-col p-2 rounded hover:bg-[var(--surface-base)] border border-transparent hover:border-[var(--neutral-6)] cursor-pointer group transition-all"
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2 overflow-hidden">
                  <Code2 className="w-3.5 h-3.5 text-[var(--accent-9)] shrink-0" />
                  <span className="text-xs font-bold truncate tracking-wide text-[var(--neutral-12)]">{q.name}</span>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <IconButton size="xs" onClick={(e) => { e.stopPropagation(); handleOpenQuery(q); }} title="Open in Editor" label="Open in Editor" icon={<Play />} className="text-[var(--accent-11)] hover:bg-[var(--accent-3)]" />
                  <IconButton size="xs" onClick={(e) => { e.stopPropagation(); removeQuery(q.id); }} title="Delete" label="Delete" icon={<Trash2 />} className="text-[var(--danger-11)] hover:bg-[var(--danger-3)]" />
                </div>
              </div>
              <div className="text-[10px] font-mono text-[var(--neutral-11)] truncate opacity-60 pl-5">
                {q.database} • {new Date(q.createdAt).toLocaleDateString()}
              </div>
            </div>
          ))
        )}
      </div>

      {showLocalHistory && (
        <Suspense fallback={null}>
          <LocalHistoryDialog
            isOpen={showLocalHistory}
            onClose={() => setShowLocalHistory(false)}
          />
        </Suspense>
      )}
    </div>
  );
}
