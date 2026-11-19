import { useEffect, useMemo, useState, useRef } from "react";
import { AlertTriangle, Bookmark, ChevronDown, ChevronRight, Folder, Loader2, Search, Server, Trash2, X } from "lucide-react";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import type { MultiQueryTarget } from "../../utils/multiQueryTargets";
import {
  groupCheckState,
  isTargetIn,
  templateEditorView,
  toggleTargetGroup,
  type NodeConnection,
  type NodeTemplate,
} from "../../utils/multiQueryNodes";

interface NodeTemplateEditorDialogProps {
  template: NodeTemplate;
  connections: readonly (NodeConnection & { filepath?: string })[];
  availableDatabases: Readonly<Record<string, readonly string[]>>;
  loadingDatabases: ReadonlySet<string>;
  fetchDatabases: (connectionId: string) => Promise<string[]>;
  currentSelection: readonly MultiQueryTarget[];
  /** Returns a user-facing error, or null once saved. */
  onSave: (name: string, targets: MultiQueryTarget[]) => string | null;
  onDelete: () => void;
  onClose: () => void;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function NodeTemplateEditorDialog({
  template,
  connections,
  availableDatabases,
  loadingDatabases,
  fetchDatabases,
  currentSelection,
  onSave,
  onDelete,
  onClose,
}: NodeTemplateEditorDialogProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const trapFocus = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const elements = Array.from(editorRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? []).filter(el => el.getClientRects().length > 0);
      const first = elements[0], last = elements[elements.length - 1];
      if (!first) { e.preventDefault(); return; }
      if (e.shiftKey && (document.activeElement === first || !editorRef.current?.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !editorRef.current?.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", trapFocus, true);
    return () => document.removeEventListener("keydown", trapFocus, true);
  }, []);
  const [name, setName] = useState(template.name);
  const [draft, setDraft] = useState<MultiQueryTarget[]>(template.targets);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const connectionById = useMemo(() => new Map(connections.map(c => [c.id, c])), [connections]);

  // Lists are needed to flag dropped databases, and for every server once "show all" is on.
  useEffect(() => {
    const ids = showAll ? connections.map(c => c.id) : [...new Set(template.targets.map(t => t.connectionId))];
    ids.filter(id => connectionById.has(id)).forEach(id => { void fetchDatabases(id); });
    // fetchDatabases caches per connection; re-run only when the scope widens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAll]);

  // Unticking keeps the row visible (unticked) instead of making it vanish mid-edit.
  const shown = useMemo(() => {
    const extra = template.targets.filter(t => !isTargetIn(draft, t.connectionId, t.database));
    return [...draft, ...extra];
  }, [draft, template.targets]);

  const view = useMemo(
    () => templateEditorView(connections, availableDatabases, shown, { query, showAll }),
    [connections, availableDatabases, shown, query, showAll],
  );

  const serverCount = new Set(draft.map(t => t.connectionId)).size;
  const missingCount = draft.filter(t => {
    if (!connectionById.has(t.connectionId)) return true;
    const listed = availableDatabases[t.connectionId];
    return !!listed && !listed.includes(t.database);
  }).length;
  const dirty = name.trim() !== template.name || groupCheckState(draft, template.targets) !== "all" || draft.length !== template.targets.length;
  const selectionDiffers = currentSelection.length > 0 && (
    groupCheckState(draft, currentSelection) !== "all" || draft.length !== currentSelection.length
  );

  const canSave = dirty && draft.length > 0 && !!name.trim();
  const toggle = (group: MultiQueryTarget[]) => setDraft(prev => toggleTargetGroup(prev, group));
  const save = () => {
    if (!canSave) return;
    const result = onSave(name, draft);
    if (result) setError(result);
  };

  return (
    <Dialog open onClose={onClose} className="w-[560px] max-w-[95vw] h-[80vh]">
      <div ref={editorRef} className="flex flex-col min-h-0 flex-1">
      <Dialog.Title onClose={onClose}>
        <span className="flex items-center gap-2">
          <Bookmark className="w-4 h-4 text-[var(--accent-11)]" />
          Edit Node Template
        </span>
      </Dialog.Title>

      <div className="px-4 pt-4 pb-3 space-y-3 border-b border-[var(--neutral-6)] shrink-0">
        <label className="block">
          <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--neutral-11)]">Name</span>
          <input
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === "Enter") save(); }}
            className="mt-1 w-full px-2 py-1.5 text-sm rounded bg-[var(--surface-base)] border border-[var(--neutral-6)] outline-none focus:border-[var(--accent-8)]"
            autoFocus
          />
        </label>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-[var(--neutral-11)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape" && query) { e.stopPropagation(); setQuery(""); } }}
              placeholder="Filter servers or databases…"
              aria-label="Filter servers or databases"
              className="w-full pl-7 pr-7 py-1.5 text-xs rounded bg-[var(--surface-base)] border border-[var(--neutral-6)] outline-none focus:border-[var(--accent-8)]"
            />
            {query && (
              <button onClick={() => setQuery("")} className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-[var(--neutral-5)]" aria-label="Clear filter">
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
          <label className="flex items-center gap-1.5 text-[11px] text-[var(--neutral-11)] cursor-pointer select-none whitespace-nowrap" title="List every server and database so more can be added">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} className="accent-[var(--accent-9)]" />
            Show all servers
          </label>
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span className="text-[var(--neutral-11)]">
            <b className="text-[var(--neutral-12)]">{plural(draft.length, "database")}</b> on {plural(serverCount, "server")}
            {missingCount > 0 && <span className="text-[var(--warning-11)]"> • {missingCount} missing</span>}
          </span>
          <Button
            size="xs"
            variant="secondary"
            onClick={() => { setDraft([...currentSelection]); setError(null); }}
            disabled={!selectionDiffers}
            title="Replace this template's databases with the ones selected in the Nodes tree"
          >
            Use current selection ({currentSelection.length})
          </Button>
        </div>
      </div>

      <Dialog.Body className="space-y-2">
        {view.servers.length === 0 && view.orphaned.length === 0 && (
          <p className="text-center py-8 text-[11px] opacity-50">
            {query.trim() ? `Nothing matches "${query.trim()}".` : "No databases. Turn on Show all servers to add some."}
          </p>
        )}
        {view.servers.map(server => {
          const conn = connectionById.get(server.connectionId);
          if (!conn) return null;
          const members = server.databases.map(d => ({ connectionId: server.connectionId, database: d.name }));
          const included = members.filter(m => isTargetIn(draft, m.connectionId, m.database)).length;
          const isOpen = !collapsed.has(server.connectionId);
          return (
            <div key={server.connectionId} className="rounded-lg border border-[var(--neutral-6)] bg-[var(--surface-panel)]">
              <div className="flex items-center gap-2 px-2 py-2">
                <button
                  onClick={() => setCollapsed(prev => { const n = new Set(prev); if (n.has(server.connectionId)) n.delete(server.connectionId); else n.add(server.connectionId); return n; })}
                  className="p-1 rounded hover:bg-[var(--neutral-5)]"
                  aria-label={isOpen ? "Collapse" : "Expand"}
                >
                  {isOpen ? <ChevronDown className="w-4 h-4 text-[var(--accent-11)]" /> : <ChevronRight className="w-4 h-4 text-[var(--accent-11)]" />}
                </button>
                <label className="flex-1 flex items-center gap-3 cursor-pointer min-w-0">
                  <input type="checkbox" aria-label={`Include databases on ${conn.name}`} checked={groupCheckState(draft, members) === "all"} ref={el => { if (el) el.indeterminate = groupCheckState(draft, members) === "some"; }} onChange={() => toggle(members)} />
                  <Server className="w-4 h-4 text-[var(--neutral-11)] shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-semibold truncate block">{conn.name}</span>
                    <span className="text-[9px] text-[var(--neutral-11)] truncate block">{conn.type} • {conn.host ?? conn.filepath ?? ""}</span>
                  </div>
                  {loadingDatabases.has(server.connectionId) && <Loader2 className="w-3 h-3 animate-spin text-[var(--neutral-11)]" aria-label="Loading databases" />}
                  <span className="text-[10px] text-[var(--neutral-11)] tabular-nums">{included}/{members.length}</span>
                </label>
              </div>
              {isOpen && (
                <div className="ml-6 mr-2 mb-2 pl-3 border-l-2 border-[var(--neutral-6)] space-y-0.5">
                  {server.databases.map(db => {
                    const checked = isTargetIn(draft, server.connectionId, db.name);
                    return (
                      <label
                        key={db.name}
                        className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-[11px] ${checked ? "bg-[var(--accent-9)]/15 text-[var(--accent-11)]" : "text-[var(--neutral-11)] hover:bg-[var(--neutral-4)]"}`}
                        title={db.missing ? "This database no longer exists on the server" : undefined}
                      >
                        <input type="checkbox" aria-label={`Include ${conn.name} / ${db.name}`} checked={checked} onChange={() => toggle([{ connectionId: server.connectionId, database: db.name }])} />
                        {db.missing ? <AlertTriangle className="w-3.5 h-3.5 text-[var(--warning-11)] shrink-0" /> : <Folder className="w-3.5 h-3.5 shrink-0" />}
                        <span className={`truncate font-medium ${db.missing ? "text-[var(--warning-11)]" : ""}`}>{db.name}</span>
                        {db.missing && <span className="ml-auto text-[9px] text-[var(--warning-11)]">missing</span>}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
        {view.orphaned.length > 0 && (
          <div className="rounded-lg border border-[var(--warning-6)] bg-[var(--warning-3)]/40">
            <div className="flex items-center gap-2 px-3 py-2 text-[11px] font-semibold text-[var(--warning-11)]">
              <AlertTriangle className="w-4 h-4" /> Deleted connections
            </div>
            <div className="ml-6 mr-2 mb-2 pl-3 border-l-2 border-[var(--warning-6)] space-y-0.5">
              {view.orphaned.map(t => {
                const checked = isTargetIn(draft, t.connectionId, t.database);
                return (
                  <label
                    key={`${t.connectionId}/${t.database}`}
                    className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-[11px] text-[var(--warning-11)] hover:bg-[var(--neutral-4)]"
                    title="This database's connection was deleted; untick to remove it from the template"
                  >
                    <input type="checkbox" aria-label={`Include ${t.connectionId} / ${t.database}`} checked={checked} onChange={() => toggle([t])} />
                    <span className="truncate font-medium">{connectionById.get(t.connectionId)?.name ?? t.connectionId} / {t.database}</span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </Dialog.Body>

      {error && (
        <div className="mx-4 mb-2 px-3 py-2 rounded bg-[var(--danger-3)] text-[var(--danger-11)] text-xs flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {error}
        </div>
      )}
      <Dialog.Footer className="justify-between">
        <Button variant="ghost" size="sm" onClick={onDelete} leftIcon={<Trash2 className="w-3.5 h-3.5" />} className="text-[var(--danger-11)]">
          Delete
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={save} disabled={!canSave}>
            Save
          </Button>
        </div>
      </Dialog.Footer>
      </div>
    </Dialog>
  );
}
