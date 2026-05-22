import { useState, useEffect, useMemo, useCallback } from "react";
import { Download, Upload, FileJson, Database, AlertTriangle, CheckCircle, Loader2, X, Shield, Search, ChevronDown, ChevronRight, Server, MinusSquare, CheckSquare, Square, ChevronLeft } from "lucide-react";
import { useConnections } from "../../contexts/useConnections";
import { useConfirmDialog } from "../ui/ConfirmDialog";
import { save, open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getConnectionsFileName } from "../../config/app";
import { parseImport, type ParseResult } from "../../utils/importParsers";
import { StoredConnectionDto } from "../../lib/ipc";

type ConnMap = Record<string, StoredConnectionDto[]>;
type ImportMode = "upsert" | "override" | "skip";
type ImportStep = 1 | 2 | 3 | 4;

interface Props {
  onClose: () => void;
}

const DB_LABELS: Record<string, string> = {
  postgres: "PostgreSQL", mysql: "MySQL", mariadb: "MariaDB",
  sqlite: "SQLite", cockroach: "CockroachDB", supabase: "Supabase",
};

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e ?? "Unknown error");
}

export function ImportExportDialog({ onClose }: Props) {
  const { exportConnections, connections, vaultCredentials: existingVaultCreds, reloadConnections } = useConnections();
  const confirmDialog = useConfirmDialog();
  const [tab, setTab] = useState<"export" | "import">("import");

  const [exporting, setExporting] = useState(false);

  const [step, setStep] = useState<ImportStep>(1);
  const [importMode, setImportMode] = useState<ImportMode>("upsert");
  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<string | null>(null);
  const [selectedConns, setSelectedConns] = useState<Set<string>>(new Set());
  const [connFilter, setConnFilter] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [connVaultMap, setConnVaultMap] = useState<Map<string, string>>(new Map());
  const [bulkSelection, setBulkSelection] = useState("");
  const [vaultPage, setVaultPage] = useState(0);
  const [showFormats, setShowFormats] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const VAULT_PAGE_SIZE = 5;

  const hasVaultCreds = existingVaultCreds.length > 0;
  const maxSteps: ImportStep = hasVaultCreds ? 4 : 3;

  const stepLabels = useMemo(() => {
    if (hasVaultCreds) return ["Select File", "Choose Connections", "Vault Credentials", "Configure & Import"];
    return ["Select File", "Choose Connections", "Configure & Import"];
  }, [hasVaultCreds]);

  useEffect(() => {
    if (importResult) {
      const t = setTimeout(() => setImportResult(null), 5000);
      return () => clearTimeout(t);
    }
  }, [importResult]);

  useEffect(() => {
    setStep(1);
    setParsed(null);
    setParseError(null);
    setFilePath(null);
    setSelectedConns(new Set());
    setConnFilter("");
    setCollapsedGroups(new Set());
    setConnVaultMap(new Map());
    setBulkSelection("");
    setVaultPage(0);
    setImportResult(null);
  }, [tab]);

  useEffect(() => { setVaultPage(0); }, [step]);

  useEffect(() => {
    if (tab !== "import" || step !== 1) return;
    const unlisten = getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type === "enter") { setDragOver(true); }
      else if (event.payload.type === "leave") { setDragOver(false); }
      else if (event.payload.type === "drop") {
        setDragOver(false);
        if (event.payload.paths.length > 0) loadFile(event.payload.paths[0]);
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [tab, step]);

  const groupedConns = useMemo((): ConnMap => {
    if (!parsed) return {};
    const groups: ConnMap = {};
    for (const c of parsed.connections) {
      const key = c.db_type || "other";
      if (!groups[key]) groups[key] = [];
      groups[key].push(c);
    }
    return groups;
  }, [parsed]);

  const filteredGroupedConns = useMemo((): ConnMap => {
    if (!parsed || !connFilter.trim()) return groupedConns;
    const lower = connFilter.toLowerCase();
    const filtered: ConnMap = {};
    for (const [key, conns] of Object.entries(groupedConns)) {
      const matching = conns.filter(
        (c) => c.name.toLowerCase().includes(lower) || (c.host || "").toLowerCase().includes(lower) || (c.database || "").toLowerCase().includes(lower),
      );
      if (matching.length > 0) filtered[key] = matching;
    }
    return filtered;
  }, [groupedConns, connFilter]);

  const groupKeys = Object.keys(filteredGroupedConns).sort();

  const selectedList = useMemo(() => {
    if (!parsed) return [];
    return parsed.connections.filter((c) => selectedConns.has(c.id));
  }, [parsed, selectedConns]);

  const selectedCount = selectedList.length;

  useEffect(() => {
    if (selectedCount > 0) {
      const maxPage = Math.ceil(selectedCount / VAULT_PAGE_SIZE) - 1;
      if (vaultPage > maxPage) setVaultPage(Math.max(0, maxPage));
    }
  }, [selectedCount, vaultPage]);

  const toggleGroupCollapse = (key: string) => setCollapsedGroups((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const selectGroup = (key: string) => { const g = filteredGroupedConns[key]; if (g) setSelectedConns((p) => { const n = new Set(p); g.forEach((c) => n.add(c.id)); return n; }); };
  const deselectGroup = (key: string) => { const g = filteredGroupedConns[key]; if (g) setSelectedConns((p) => { const n = new Set(p); g.forEach((c) => n.delete(c.id)); return n; }); };
  const toggleConn = (id: string) => setSelectedConns((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const selectAll = () => { if (parsed) setSelectedConns(new Set(parsed.connections.map((c) => c.id))); };
  const deselectAll = () => setSelectedConns(new Set());

  const setVaultForConn = useCallback((connId: string, vaultId: string) => {
    setConnVaultMap((prev) => {
      const next = new Map(prev);
      next.set(connId, vaultId);
      return next;
    });
  }, []);

  const bulkAssignVault = useCallback((vaultId: string) => {
    setConnVaultMap((prev) => {
      const next = new Map(prev);
      for (const c of selectedList) {
        next.set(c.id, vaultId);
      }
      return next;
    });
  }, [selectedList]);

  // ── Export ──────────────────────────────────────────────────────────────

  const handleExport = async () => {
    try {
      const path = await save({ filters: [{ name: "JSON", extensions: ["json"] }], defaultPath: getConnectionsFileName() });
      if (!path) return;
      setExporting(true);
      await exportConnections(path, false);
      confirmDialog.dialog({ title: "Export Successful", message: `Connections exported to ${path}`, confirmLabel: "OK", type: "success" });
      onClose();
    } catch (e: any) {
      confirmDialog.dialog({ title: "Export Failed", message: errMsg(e), confirmLabel: "OK", type: "danger" });
    } finally { setExporting(false); }
  };

  // ── Import wizard ───────────────────────────────────────────────────────

  const handlePickFile = async () => {
    try {
      const path = await open({ multiple: false, filters: [{ name: "Connection Files", extensions: ["json", "xml"] }, { name: "All Files", extensions: ["*"] }] });
      if (!path) return;
      await loadFile(path);
    } catch (e: any) { setParseError("Failed to open file: " + errMsg(e)); }
  };

  const loadFile = async (path: string) => {
    if (typeof path !== "string") return;
    setParsing(true); setParseError(null); setParsed(null); setFilePath(path); setSelectedConns(new Set()); setConnFilter(""); setCollapsedGroups(new Set()); setConnVaultMap(new Map()); setBulkSelection(""); setVaultPage(0);
    try {
      const content = await readTextFile(path);
      const result = parseImport(content);
      setParsed(result);
      setSelectedConns(new Set(result.connections.map((c) => c.id)));
      setStep(2);
    } catch (e: any) { setParseError(errMsg(e)); }
    finally { setParsing(false); }
  };

  const nextStep = () => {
    if (step === 2 && !hasVaultCreds) setStep(4);
    else setStep((s) => Math.min(s + 1, maxSteps) as ImportStep);
  };
  const prevStep = () => {
    if (step === 4 && !hasVaultCreds) setStep(2);
    else setStep((s) => Math.max(s - 1, 1) as ImportStep);
  };

  const handleImport = async () => {
    if (!parsed) return;
    setImporting(true); setImportResult(null);
    try {
      const { invokeCmd } = await import("../../lib/ipc");
      const connections = selectedList.map((c) => ({ ...c }));
      const vaultCredentials = [...parsed.vaultCredentials];

      for (const conn of connections) {
        const vcId = connVaultMap.get(conn.id);
        if (vcId === "") {
          conn.is_vault = null;
          conn.vault_credential_id = null;
        } else if (vcId) {
          conn.is_vault = true;
          conn.vault_credential_id = vcId;
          conn.password = null;
          conn.username = null;
        }
      }

      const result = await invokeCmd("import_connections_advanced", {
        connections, vaultCredentials: vaultCredentials.length > 0 ? vaultCredentials : null,
        mode: importMode, vaultPassword: null,
      });

      const parts: string[] = [];
      if (result.imported > 0) parts.push(`${result.imported} imported`);
      if (result.updated > 0) parts.push(`${result.updated} updated`);
      if (result.skipped > 0) parts.push(`${result.skipped} skipped`);
      setImportResult(parts.length > 0 ? parts.join(", ") : "No changes made.");
      await reloadConnections();
    } catch (e: any) {
      setImportResult("error:" + errMsg(e));
    } finally { setImporting(false); }
  };

  const canGoNext = (): boolean => {
    switch (step) { case 1: return parsed !== null; case 2: return selectedCount > 0; default: return true; }
  };

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative w-[640px] max-h-[85vh] bg-[var(--surface)] border border-[var(--border)] rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-[var(--border)] shrink-0">
          <div className="flex items-center gap-3">
            <div className="flex bg-[var(--background)] rounded-lg p-0.5">
              <button onClick={() => setTab("import")} className={`px-3 py-1.5 rounded text-xs font-medium transition-all ${tab === "import" ? "bg-[var(--color-accent)] text-white shadow-sm" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}>
                <Upload className="w-3 h-3 inline mr-1.5" />Import
              </button>
              <button onClick={() => setTab("export")} className={`px-3 py-1.5 rounded text-xs font-medium transition-all ${tab === "export" ? "bg-[var(--color-accent)] text-white shadow-sm" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"}`}>
                <Download className="w-3 h-3 inline mr-1.5" />Export
              </button>
            </div>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-[var(--border)] transition-colors"><X className="w-5 h-5" /></button>
        </div>

        {/* Step indicator */}
        {tab === "import" && !importing && importResult === null && (
          <div className="flex items-center justify-center gap-1 px-5 py-2.5 border-b border-[var(--border)] bg-[var(--background)] shrink-0">
            {stepLabels.map((label, i) => {
              const s = (i + 1) as ImportStep;
              const isActive = s === step;
              const isDone = s < step;
              return (
                <div key={s} className="flex items-center">
                  <div className="flex items-center gap-1.5">
                    <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold border ${isDone ? "bg-emerald-500 border-emerald-500 text-white" : isActive ? "bg-[var(--color-accent)] border-[var(--color-accent)] text-white" : "border-[var(--border)] text-[var(--text-secondary)]"}`}>
                      {isDone ? <CheckCircle className="w-3 h-3" /> : s}
                    </span>
                    <span className={`text-[11px] font-medium ${isActive ? "text-[var(--text-primary)]" : isDone ? "text-emerald-400" : "text-[var(--text-secondary)]"}`}>{label}</span>
                  </div>
                  {s < maxSteps && <span className={`w-6 h-px mx-2 ${s < step ? "bg-emerald-500" : "bg-[var(--border)]"}`} />}
                </div>
              );
            })}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4 flex flex-col min-h-0">
          {/* ═══ EXPORT TAB ═══ */}
          {tab === "export" && (
            <div className="p-4 bg-[var(--background)] border border-[var(--border)] rounded-xl">
              <div className="flex items-center gap-2 mb-3"><Database className="w-4 h-4 text-cyan-400" /><span className="text-sm font-semibold">Export Connections</span></div>
              <p className="text-xs text-[var(--text-secondary)] mb-4">Export all {connections.length} connection{connections.length !== 1 ? "s" : ""} to a JSON file. Passwords are never included in exports.</p>
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {connections.map((c) => (<div key={c.id} className="flex items-center gap-2 text-xs p-1.5 rounded bg-[var(--surface)]"><Database className="w-3 h-3 shrink-0 text-cyan-400" /><span className="truncate flex-1">{c.name}</span><span className="text-[var(--text-secondary)] shrink-0">{c.type}</span><span className="text-[var(--text-secondary)] shrink-0">{c.type === "sqlite" ? (c.filepath || c.database) : `${c.host ?? ""}:${c.port ?? ""}`}</span></div>))}
                {connections.length === 0 && <p className="text-xs text-[var(--text-secondary)] italic text-center py-4">No connections to export.</p>}
              </div>
            </div>
          )}

          {/* ═══ IMPORT WIZARD ═══ */}
          {tab === "import" && !importing && importResult === null && (
            <>
              {/* Step 1: Select File */}
              {step === 1 && (
                <div className="flex-1 flex flex-col justify-center">
                  <div className="p-6 bg-[var(--background)] border border-[var(--border)] rounded-xl text-center">
                    <FileJson className="w-10 h-10 text-purple-400 mx-auto mb-4 opacity-40" />
                    <h3 className="text-sm font-semibold mb-2">Import Connections</h3>
                    <p className="text-xs text-[var(--text-secondary)] mb-6 max-w-md mx-auto">Import connections from QueryDen exports, DBeaver, DataGrip, pgAdmin, or TablePlus.</p>
                    <div
                      className={`px-6 py-3 rounded-lg border-2 border-dashed flex items-center justify-center gap-2 text-sm transition-all mx-auto ${
                        dragOver ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 scale-[1.02]" : "border-[var(--border)] hover:border-[var(--color-accent)] hover:bg-[var(--color-accent)]/5"
                      }`}
                    >
                      <button onClick={handlePickFile} disabled={parsing} className="flex items-center gap-2 disabled:opacity-50">
                        {parsing ? (<><Loader2 className="w-4 h-4 animate-spin" />Parsing…</>) : (<><Upload className="w-4 h-4" />Select or drop a file</>)}
                      </button>
                    </div>
                    {filePath && !parsed && <p className="mt-3 text-[10px] text-[var(--text-secondary)] truncate">{filePath}</p>}
                    {parseError && (
                      <div className="mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-left">
                        <div className="flex items-start gap-2"><AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" /><div><p className="text-xs font-medium text-red-400">Could not parse file</p><pre className="text-xs text-red-300 mt-1 whitespace-pre-wrap">{parseError}</pre></div></div>
                      </div>
                    )}

                    {/* Format examples */}
                    <div className="mt-4 pt-4 border-t border-[var(--border)]">
                      <button onClick={() => setShowFormats(!showFormats)} className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] flex items-center gap-1 mx-auto">
                        {showFormats ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                        What format should my file be?
                      </button>
                      {showFormats && (
                        <div className="mt-3 text-left space-y-3 text-[11px]">
                          <div className="p-2 bg-[var(--surface)] border border-[var(--border)] rounded">
                            <span className="font-semibold text-purple-400">QueryDen</span>
                            <pre className="text-[10px] text-[var(--text-secondary)] mt-1 whitespace-pre-wrap overflow-x-auto">{`{
  "connections": [
    {
      "id": "abc-123",
      "name": "My DB",
      "db_type": "postgres",
      "host": "localhost", "port": 5432,
      "database": "mydb", "username": "user"
    }
  ],
  "version": 2
}`}</pre>
                          </div>
                          <div className="p-2 bg-[var(--surface)] border border-[var(--border)] rounded">
                            <span className="font-semibold text-cyan-400">DBeaver</span>
                            <p className="text-[10px] text-[var(--text-secondary)] mt-0.5">Export <code>data-sources.json</code> from <code>~/.local/share/DBeaverData/workspace6/General/.dbeaver/</code></p>
                          </div>
                          <div className="p-2 bg-[var(--surface)] border border-[var(--border)] rounded">
                            <span className="font-semibold text-orange-400">JetBrains DataGrip</span>
                            <p className="text-[10px] text-[var(--text-secondary)] mt-0.5">Export <code>dataSources.xml</code> from your project's <code>.idea/</code> folder</p>
                          </div>
                          <div className="p-2 bg-[var(--surface)] border border-[var(--border)] rounded">
                            <span className="font-semibold text-emerald-400">pgAdmin / TablePlus</span>
                            <p className="text-[10px] text-[var(--text-secondary)] mt-0.5">Export servers as JSON, or use TablePlus connection export</p>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* Step 2: Choose Connections */}
              {step === 2 && parsed && (
                <>
                  <div className="flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 rounded text-[10px] font-medium bg-purple-500/20 text-purple-400">{parsed.source}</span>
                      <span className="text-[11px] text-[var(--text-secondary)]">{parsed.connections.length} connection{parsed.connections.length !== 1 ? "s" : ""} found</span>
                    </div>
                    <div className="flex gap-1">
                      <button onClick={selectAll} className="text-[10px] px-2 py-0.5 rounded hover:bg-[var(--border)] text-[var(--text-secondary)]">Select All</button>
                      <button onClick={deselectAll} className="text-[10px] px-2 py-0.5 rounded hover:bg-[var(--border)] text-[var(--text-secondary)]">None</button>
                    </div>
                  </div>
                  {parsed.connections.length > 8 && (
                    <div className="relative shrink-0"><Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--text-secondary)]" /><input type="text" placeholder="Filter by name, host, or database..." value={connFilter} onChange={(e) => setConnFilter(e.target.value)} className="w-full pl-7 pr-3 py-1.5 text-xs rounded bg-[var(--background)] border border-[var(--border)] outline-none focus:border-[var(--color-accent)]" /></div>
                  )}
                  <div className="flex-1 min-h-0 border border-[var(--border)] rounded-lg overflow-hidden flex flex-col">
                    <div className="px-3 py-1.5 border-b border-[var(--border)] bg-[var(--background)] flex items-center gap-2 shrink-0"><span className="text-[11px] font-semibold text-[var(--text-secondary)]">{selectedCount} of {parsed.connections.length} selected</span></div>
                    <div className="flex-1 overflow-y-auto">
                      {groupKeys.length === 0 && <p className="text-xs text-[var(--text-secondary)] italic text-center py-6">No connections match the filter.</p>}
                      {groupKeys.map((key) => {
                        const group = filteredGroupedConns[key];
                        const collapsed = collapsedGroups.has(key);
                        const gs = group.filter((c) => selectedConns.has(c.id)).length;
                        const allIn = group.every((c) => selectedConns.has(c.id));
                        const someIn = group.some((c) => selectedConns.has(c.id));
                        return (
                          <div key={key}>
                            <button onClick={() => toggleGroupCollapse(key)} className="w-full flex items-center gap-1.5 px-2 py-1.5 hover:bg-[var(--background)] border-b border-[var(--border)]/50 text-left">
                              {collapsed ? <ChevronRight className="w-3 h-3 text-[var(--text-secondary)] shrink-0" /> : <ChevronDown className="w-3 h-3 text-[var(--text-secondary)] shrink-0" />}
                              <Server className="w-3 h-3 text-cyan-400 shrink-0" />
                              <span className="text-[11px] font-medium flex-1">{DB_LABELS[key] || key}</span>
                              <span className="text-[10px] text-[var(--text-secondary)] mr-2">{gs}/{group.length}</span>
                              <span onClick={(e) => { e.stopPropagation(); allIn ? deselectGroup(key) : selectGroup(key); }} className="cursor-pointer shrink-0">
                                {allIn ? <CheckSquare className="w-3.5 h-3.5 text-[var(--color-accent)]" /> : someIn ? <MinusSquare className="w-3.5 h-3.5 text-[var(--color-accent)]/60" /> : <Square className="w-3.5 h-3.5 text-[var(--text-secondary)]" />}
                              </span>
                            </button>
                            {!collapsed && (
                              <div>
                                {group.map((conn) => (
                                  <label key={conn.id} className="flex items-center gap-2 px-2 py-1 hover:bg-[var(--background)] cursor-pointer border-b border-[var(--border)]/20 last:border-b-0" style={{ paddingLeft: "28px" }}>
                                    <input type="checkbox" checked={selectedConns.has(conn.id)} onChange={() => toggleConn(conn.id)} className="rounded shrink-0" />
                                    <Database className="w-3 h-3 text-cyan-400 shrink-0" />
                                    <div className="flex-1 min-w-0"><span className="text-xs truncate block">{conn.name}</span>{conn.host && <span className="text-[10px] text-[var(--text-secondary)]">{conn.host}:{conn.port ?? 5432} / {conn.database}</span>}</div>
                                    {conn.vault_credential_id && <Shield className="w-3 h-3 text-yellow-500 shrink-0" />}
                                  </label>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}

              {/* Step 3: Vault Credentials (per-connection) — only when vault creds exist */}
              {step === 3 && hasVaultCreds && (
                <>
                  <div className="p-4 bg-[var(--background)] border border-[var(--border)] rounded-lg shrink-0">
                    <div className="flex items-center gap-2 mb-3"><Shield className="w-4 h-4 text-yellow-500" /><span className="text-sm font-semibold">Assign Vault Credentials (optional)</span></div>
                    <p className="text-xs text-[var(--text-secondary)] mb-3">Link imported connections to vault profiles. Strips embedded credentials and uses vault-managed auth instead.</p>

                    {/* Bulk assign */}
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-[11px] font-medium text-[var(--text-secondary)] shrink-0">Apply to all:</span>
                      <select
                        value={bulkSelection}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === "__clear__") { bulkAssignVault(""); setBulkSelection("__clear__"); }
                          else if (v) { bulkAssignVault(v); setBulkSelection(v); }
                        }}
                        className="flex-1 bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-xs outline-none focus:border-[var(--color-accent)]"
                      >
                        <option value="">Bulk assign…</option>
                        <option value="__clear__">-- None (clear all) --</option>
                        {existingVaultCreds.map((vc) => (<option key={vc.id} value={vc.id}>{vc.name} ({vc.username})</option>))}
                      </select>
                    </div>
                  </div>

                  {/* Per-connection list */}
                  {selectedCount > 0 && (() => {
                    const totalPages = Math.ceil(selectedCount / VAULT_PAGE_SIZE);
                    const pageConns = selectedList.slice(vaultPage * VAULT_PAGE_SIZE, (vaultPage + 1) * VAULT_PAGE_SIZE);
                    return (
                  <div className="flex-1 min-h-0 border border-[var(--border)] rounded-lg overflow-hidden flex flex-col">
                    <div className="px-3 py-1.5 border-b border-[var(--border)] bg-[var(--background)] flex items-center gap-2 shrink-0">
                      <span className="text-[11px] font-semibold text-[var(--text-secondary)]">{selectedCount} connection{selectedCount !== 1 ? "s" : ""} selected</span>
                      <span className="text-[10px] text-[var(--text-secondary)] ml-auto">{Array.from(connVaultMap.values()).filter(Boolean).length} with vault assigned</span>
                    </div>
                    <div className="flex-1 overflow-y-auto">
                      {pageConns.map((conn) => (
                        <div key={conn.id} className="flex items-center gap-2 px-2 py-1.5 border-b border-[var(--border)]/20 last:border-b-0">
                          <div className="flex-1 min-w-0">
                            <span className="text-xs truncate block">{conn.name}</span>
                            {conn.host && <span className="text-[10px] text-[var(--text-secondary)]">{conn.host}:{conn.port ?? 5432} / {conn.database}</span>}
                          </div>
                          <select
                            value={connVaultMap.get(conn.id) || ""}
                            onChange={(e) => setVaultForConn(conn.id, e.target.value)}
                            className="bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-[11px] outline-none focus:border-[var(--color-accent)] max-w-[180px]"
                          >
                            <option value="">No vault</option>
                            {existingVaultCreds.map((vc) => (<option key={vc.id} value={vc.id}>{vc.name}</option>))}
                          </select>
                        </div>
                      ))}
                    </div>
                    {totalPages > 1 && (
                      <div className="px-2 py-1.5 border-t border-[var(--border)] bg-[var(--background)] flex items-center justify-between text-[10px] shrink-0">
                        <button onClick={() => setVaultPage((p) => Math.max(0, p - 1))} disabled={vaultPage === 0} className="px-2 py-0.5 rounded hover:bg-[var(--border)] disabled:opacity-30 text-[var(--text-secondary)]"><ChevronLeft className="w-3 h-3 inline" /> Prev</button>
                        <span className="text-[var(--text-secondary)]">Page {vaultPage + 1} of {totalPages}</span>
                        <button onClick={() => setVaultPage((p) => Math.min(totalPages - 1, p + 1))} disabled={vaultPage >= totalPages - 1} className="px-2 py-0.5 rounded hover:bg-[var(--border)] disabled:opacity-30 text-[var(--text-secondary)]">Next <ChevronRight className="w-3 h-3 inline" /></button>
                      </div>
                    )}
                  </div>
                    );
                  })()}
                </>
              )}

              {/* Step 4: Configure & Import (or step 3 when no vault creds) */}
              {(step === 4 || (step === 3 && !hasVaultCreds)) && (
                <>
                  <div className="p-3 bg-[var(--background)] border border-[var(--border)] rounded-lg shrink-0">
                    <div className="flex items-center gap-2"><Database className="w-4 h-4 text-cyan-400" /><span className="text-xs font-semibold">{selectedCount} connection{selectedCount !== 1 ? "s" : ""} ready to import</span></div>
                    {filePath && <p className="text-[10px] text-[var(--text-secondary)] mt-1 ml-6 truncate">from {parsed?.source} — {filePath}</p>}
                    {(() => { const vcCount = Array.from(connVaultMap.values()).filter(Boolean).length; return vcCount > 0 ? <p className="text-[10px] text-yellow-400 mt-1 ml-6">{vcCount} with vault credential assigned</p> : null; })()}
                  </div>
                  <div className="shrink-0">
                    <label className="text-[11px] font-semibold text-[var(--text-secondary)] block mb-2">Import Mode</label>
                    <div className="grid grid-cols-3 gap-2">
                      {([{ id: "upsert" as const, label: "Upsert", desc: "Match on host:port:db" }, { id: "override" as const, label: "Override", desc: "Replace all connections" }, { id: "skip" as const, label: "Skip Duplicates", desc: "Skip by ID" }]).map((opt) => (
                        <button key={opt.id} onClick={() => setImportMode(opt.id)} className={`p-2.5 rounded-lg border text-left transition-all ${importMode === opt.id ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 ring-1 ring-[var(--color-accent)]" : "border-[var(--border)] hover:bg-[var(--border)]/30"}`}>
                          <div className="text-xs font-medium">{opt.label}</div><div className="text-[10px] text-[var(--text-secondary)] mt-0.5">{opt.desc}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </>
          )}

          {/* Import progress — outside wizard block so it renders when !importing is false */}
          {tab === "import" && importing && (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
              <Loader2 className="w-8 h-8 animate-spin text-[var(--color-accent)] mb-4" />
              <p className="text-sm font-semibold text-[var(--text-primary)] mb-1">Importing Connections</p>
              <p className="text-xs text-[var(--text-secondary)]">Please wait while your connections are being imported...</p>
            </div>
          )}

          {/* Import result — outside wizard block */}
          {tab === "import" && !importing && importResult !== null && (() => {
            const result = importResult;
            const isError = result.startsWith("error:");
            return (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-6">
              {isError ? (
                <>
                  <AlertTriangle className="w-10 h-10 text-red-400 mx-auto mb-3" />
                  <p className="text-sm font-semibold text-red-400 mb-1">Import Failed</p>
                  <p className="text-xs text-red-300 mb-4 whitespace-pre-wrap">{result.slice(6)}</p>
                </>
              ) : (
                <>
                  <CheckCircle className="w-10 h-10 text-emerald-400 mx-auto mb-3" />
                  <p className="text-sm font-semibold text-emerald-400 mb-1">Import Complete</p>
                  <p className="text-xs text-emerald-300 mb-4">{result}</p>
                  <p className="text-[10px] text-[var(--text-secondary)] mb-4">Your connections have been saved. Close this dialog to continue.</p>
                </>
              )}
              <button onClick={onClose} className="px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white hover:opacity-90 text-sm font-medium transition-all">Close</button>
            </div>
            );
          })()}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-[var(--border)] flex justify-between gap-2 shrink-0">
          {tab === "export" && (
            <>
              <div />
              <div className="flex gap-2">
                <button onClick={onClose} className="px-4 py-2 rounded-lg hover:bg-[var(--border)] text-sm text-[var(--text-secondary)] transition-colors">Close</button>
                <button onClick={handleExport} disabled={exporting || connections.length === 0} className="px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white hover:opacity-90 flex items-center gap-2 text-sm disabled:opacity-40 transition-all">
                  {exporting ? (<><Loader2 className="w-3 h-3 animate-spin" />Exporting…</>) : (<><Download className="w-3 h-3" />Export {connections.length}</>)}
                </button>
              </div>
            </>
          )}
          {tab === "import" && !importing && importResult === null && (
            <>
              <div>{step > 1 && <button onClick={prevStep} className="px-4 py-2 rounded-lg hover:bg-[var(--border)] text-sm text-[var(--text-secondary)] flex items-center gap-1.5 transition-colors"><ChevronLeft className="w-4 h-4" />Back</button>}</div>
              <div className="flex gap-2">
                <button onClick={onClose} className="px-4 py-2 rounded-lg hover:bg-[var(--border)] text-sm text-[var(--text-secondary)] transition-colors">Cancel</button>
                {(step < maxSteps) ? (
                  <button onClick={nextStep} disabled={!canGoNext()} className="px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white hover:opacity-90 flex items-center gap-1.5 text-sm disabled:opacity-40 transition-all">Next<ChevronRight className="w-4 h-4" /></button>
                ) : (
                  <button onClick={handleImport} disabled={importing} className="px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white hover:opacity-90 flex items-center gap-2 text-sm font-medium disabled:opacity-40 transition-all">
                    {importing ? (<><Loader2 className="w-3 h-3 animate-spin" />Importing…</>) : (<><Upload className="w-3 h-3" />Import {selectedCount}</>)}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
