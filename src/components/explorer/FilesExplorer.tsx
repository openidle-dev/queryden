import { useState } from "react";
import { useSavedQueries } from "../../store/savedQueryStore";
import { Folder, FileCode, Play, Trash2, Code2, Loader2, Clock } from "lucide-react";
import { LocalHistoryDialog } from "../ui/LocalHistoryDialog";

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
    <div className="h-full flex flex-col bg-[var(--surface)] text-[var(--text-primary)]">
      <div className="p-3 border-b border-[var(--border)] flex items-center justify-between shadow-sm z-10 shrink-0">
        <h2 className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] flex items-center gap-2">
          <Folder className="w-4 h-4" />
          Saved Queries
        </h2>
        <button
          onClick={() => setShowLocalHistory(true)}
          className="p-1 rounded hover:bg-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          title="Local History"
        >
          <Clock className="w-4 h-4" />
        </button>
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
            <p className="text-[10px] mt-1 text-[var(--text-secondary)]">Save queries from the main toolbar to access them here.</p>
          </div>
        ) : (
          queries.map((q) => (
            <div
              key={q.id}
              onClick={() => handleOpenQuery(q)}
              className="flex flex-col p-2 rounded hover:bg-[var(--background)] border border-transparent hover:border-[var(--border)] cursor-pointer group transition-all"
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2 overflow-hidden">
                  <Code2 className="w-3.5 h-3.5 text-[var(--color-accent)] shrink-0" />
                  <span className="text-xs font-bold truncate tracking-wide text-gray-200">{q.name}</span>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button 
                    onClick={(e) => { e.stopPropagation(); handleOpenQuery(q); }}
                    className="p-1 rounded hover:bg-[var(--color-accent)]/20 text-[var(--color-accent)]"
                    title="Open in Editor"
                  >
                    <Play className="w-3.5 h-3.5" />
                  </button>
                  <button 
                    onClick={(e) => { e.stopPropagation(); removeQuery(q.id); }}
                    className="p-1 rounded hover:bg-rose-500/20 text-rose-400"
                    title="Delete"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <div className="text-[10px] font-mono text-[var(--text-secondary)] truncate opacity-60 pl-5">
                {q.database} • {new Date(q.createdAt).toLocaleDateString()}
              </div>
            </div>
          ))
        )}
      </div>

      <LocalHistoryDialog
        isOpen={showLocalHistory}
        onClose={() => setShowLocalHistory(false)}
      />
    </div>
  );
}
