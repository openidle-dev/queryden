import { Suspense, lazy, useState } from "react";
import type { SavedQuery } from "../../store/savedQueryStore";
import { useConnections } from "../../contexts/useConnections";
import { Folder, Clock } from "lucide-react";
import { IconButton } from "../ui/IconButton";
import { SavedQueryList } from "./SavedQueryList";

const LocalHistoryDialog = lazy(() => import("../ui/LocalHistoryDialog").then((m) => ({ default: m.LocalHistoryDialog })));

export function FilesExplorer() {
  const { connections } = useConnections();
  const [showLocalHistory, setShowLocalHistory] = useState(false);

  // Opens the saved query on the connection + database it was saved for
  // (not whatever the sidebar has selected); ▶ also runs it.
  const openQuery = (query: SavedQuery, run: boolean) => {
    const conn = connections.find((c) => c.id === query.connectionId);
    window.dispatchEvent(
      new CustomEvent("open-query-with-text", {
        detail: {
          query: query.query,
          name: query.name,
          savedQueryName: query.name,
          connectionId: conn?.id,
          connectionName: conn?.name,
          database: query.database || undefined,
          run,
        },
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

      <div className="flex-1 overflow-y-auto p-2 custom-scrollbar">
        <SavedQueryList onOpen={(q) => openQuery(q, false)} onRun={(q) => openQuery(q, true)} />
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
