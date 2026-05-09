import { useState, useEffect, useCallback } from "react";
import { X, RefreshCw, Activity, Trash2, Search, ShieldAlert, Cpu, Zap, Clock, Filter } from "lucide-react";
import { useConnections } from "../../contexts/useConnections";
import { useConfirmDialog } from "../ui/ConfirmDialog";
import { quoteIdentifier } from "../../utils/sqlSecurity";

interface ActivityMonitorProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ConnectionStats {
  pid: number;
  datname: string;
  usename: string;
  application_name: string;
  client_addr: string;
  client_port: string;
  backend_start: string;
  xact_start: string;
  query_start: string;
  state_change: string;
  wait_event_type: string;
  wait_event: string;
  state: string;
  backend_type: string;
  query: string;
}


function formatDuration(isoString: string): string {
  if (!isoString) return "-";
  try {
    const start = new Date(isoString);
    const now = new Date();
    const diff = Math.floor((now.getTime() - start.getTime()) / 1000);
    if (diff < 60) return `${diff}s`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ${diff % 60}s`;
    return `${Math.floor(diff / 3600)}h ${Math.floor((diff % 3600) / 60)}m`;
  } catch { return "-"; }
}

function getDurationSeconds(isoString: string): number {
  if (!isoString) return 0;
  try {
    const start = new Date(isoString);
    const now = new Date();
    return Math.floor((now.getTime() - start.getTime()) / 1000);
  } catch { return 0; }
}

type SortKey = "pid" | "state" | "usename" | "datname" | "application_name" | "client_addr" | "duration" | "wait_event_type" | "query";

export const ActivityMonitor: React.FC<ActivityMonitorProps> = ({ isOpen, onClose }) => {
  const { currentDb, activeConnection, databases } = useConnections();
  const confirmDialog = useConfirmDialog();
  const [stats, setStats] = useState<ConnectionStats[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [targetDb, setTargetDb] = useState<string>("");
  // Filters
  const [stateFilter, setStateFilter] = useState<string>("all");
  const [longRunningOnly, setLongRunningOnly] = useState(false);
  const [backendTypeFilter, setBackendTypeFilter] = useState<string>("all");
  // Sorting
  const [sortKey, setSortKey] = useState<SortKey>("pid");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const fetchStats = useCallback(async () => {
    if (!activeConnection) return;
    if (activeConnection.type !== 'postgres') { setError("PostgreSQL only"); return; }
    if (!currentDb) { setError("Not connected"); return; }
    
    setIsLoading(true);
    setError(null);
    
    try {
      const dbFilter = targetDb ? `AND datname = ${quoteIdentifier(targetDb, 'postgres')}` : "";
      const query = `SELECT pid, COALESCE(datname::text, '') as datname, COALESCE(usename::text, '') as usename, COALESCE(application_name::text, '') as application_name, COALESCE(client_addr::text, 'local') as client_addr, COALESCE(client_port::text, '') as client_port, COALESCE(backend_start::text, '') as backend_start, COALESCE(xact_start::text, '') as xact_start, COALESCE(query_start::text, '') as query_start, COALESCE(state_change::text, '') as state_change, COALESCE(wait_event_type::text, '') as wait_event_type, COALESCE(wait_event::text, '') as wait_event, COALESCE(state::text, 'unknown') as state, COALESCE(backend_type::text, '') as backend_type, COALESCE(query::text, '') as query FROM pg_stat_activity WHERE pid <> pg_backend_pid() ${dbFilter} ORDER BY backend_start DESC`;
      const result = await (currentDb as any).select(query) as ConnectionStats[];
      setStats(result);
      setError(null);
    } catch (err: any) {
      setError(err.message || "Failed to fetch");
    } finally { setIsLoading(false); }
  }, [currentDb, activeConnection, targetDb]);

  const terminateBackend = async (pid: number | string) => {
    if (!currentDb) return;
    const confirmed = await confirmDialog.confirm({ title: "Terminate Session", message: `Kill PID ${pid}?`, confirmLabel: "Kill", type: "danger" });
    if (!confirmed) return;
    try {
      await (currentDb as any).select(`SELECT pg_terminate_backend($1::int)`, [pid]);
      fetchStats();
    } catch (err: any) { setError(err.message); }
  };

  useEffect(() => { if (isOpen) { setTargetDb(""); setSearchTerm(""); setStateFilter("all"); setLongRunningOnly(false); setBackendTypeFilter("all"); fetchStats(); } }, [isOpen]);
  useEffect(() => { if (autoRefresh && isOpen) { let i: ReturnType<typeof setInterval> | undefined; i = setInterval(fetchStats, 3000); return () => { if (i) clearInterval(i); }; } }, [autoRefresh, isOpen, fetchStats]);

  if (!isOpen) return null;

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return "";
    return sortDir === "asc" ? " ▲" : " ▼";
  };

  // Get unique states and backend types for filter dropdowns
  const uniqueStates = Array.from(new Set(stats.map(s => s.state).filter(Boolean)));
  const uniqueBackendTypes = Array.from(new Set(stats.map(s => s.backend_type).filter(Boolean)));

  const filteredStats = stats
    .filter(s => {
      // Text search
      const t = searchTerm.toLowerCase();
      const matchesSearch = !t || s.usename?.toLowerCase().includes(t) || s.datname?.toLowerCase().includes(t) || s.query?.toLowerCase().includes(t) || s.application_name?.toLowerCase().includes(t) || String(s.pid).includes(t);
      
      // State filter
      const matchesState = stateFilter === "all" || s.state === stateFilter;
      
      // Backend type filter
      const matchesBackend = backendTypeFilter === "all" || s.backend_type === backendTypeFilter;
      
      // Long running filter (> 5 seconds)
      const matchesLongRunning = !longRunningOnly || getDurationSeconds(s.query_start) > 5;

      return matchesSearch && matchesState && matchesBackend && matchesLongRunning;
    })
    .sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "pid": cmp = a.pid - b.pid; break;
        case "state": cmp = (a.state || "").localeCompare(b.state || ""); break;
        case "usename": cmp = (a.usename || "").localeCompare(b.usename || ""); break;
        case "datname": cmp = (a.datname || "").localeCompare(b.datname || ""); break;
        case "application_name": cmp = (a.application_name || "").localeCompare(b.application_name || ""); break;
        case "client_addr": cmp = (a.client_addr || "").localeCompare(b.client_addr || ""); break;
        case "duration": cmp = getDurationSeconds(a.query_start) - getDurationSeconds(b.query_start); break;
        case "wait_event_type": cmp = (a.wait_event_type || "").localeCompare(b.wait_event_type || ""); break;
        case "query": cmp = (a.query || "").localeCompare(b.query || ""); break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });

  // Compute summary stats
  const activeCount = stats.filter(s => s.state === "active").length;
  const idleCount = stats.filter(s => s.state === "idle").length;
  const longRunningCount = stats.filter(s => getDurationSeconds(s.query_start) > 5 && s.state === "active").length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-md" onClick={onClose} />
      <div className="relative w-[95vw] h-[90vh] bg-[var(--surface)] border border-[var(--border)] rounded-2xl shadow-2xl flex flex-col overflow-hidden">
        
        <div className="flex items-center justify-between px-4 py-3 bg-[var(--surface)] border-b border-[var(--border)] shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"><Activity className="w-5 h-5" /></div>
            <div>
              <h2 className="font-bold text-lg text-[var(--text-primary)]">Session Audit</h2>
              <div className="flex items-center gap-3 text-[10px]">
                <span className="text-[var(--text-secondary)]">{activeConnection?.name}</span>
                <span className="text-emerald-400 font-bold">{activeCount} active</span>
                <span className="text-amber-400">{idleCount} idle</span>
                {longRunningCount > 0 && <span className="text-red-400 font-bold animate-pulse">{longRunningCount} long-running</span>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => setAutoRefresh(!autoRefresh)} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${autoRefresh ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" : "bg-[var(--background)] border border-[var(--border)]"}`}><RefreshCw className={`w-3.5 h-3.5 ${autoRefresh ? "animate-spin" : ""}`} />{autoRefresh ? "Live" : "Auto"}</button>
            <button onClick={onClose} className="p-2 hover:bg-red-500/10 hover:text-red-500 rounded-full"><X className="w-5 h-5" /></button>
          </div>
        </div>

        <div className="flex items-center gap-3 px-4 py-2.5 bg-[var(--background)]/40 border-b border-[var(--border)] flex-wrap">
          <div className="relative flex-1 max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-secondary)]" />
            <input type="text" placeholder="Search sessions..." value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} className="w-full pl-8 pr-3 py-1.5 bg-[var(--surface)] border border-[var(--border)] rounded-lg text-xs outline-none focus:border-emerald-500/40" />
          </div>
          <div className="relative">
            <input type="text" list="db-list" placeholder="Filter database..." value={targetDb} onChange={(e) => setTargetDb(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && fetchStats()} className="bg-[var(--surface)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-xs outline-none w-36" />
            <datalist id="db-list">
              {databases.map(db => <option key={db} value={db} />)}
            </datalist>
          </div>
          
          {/* State Filter */}
          <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} className="bg-[var(--surface)] border border-[var(--border)] rounded-lg px-2 py-1.5 text-xs outline-none cursor-pointer">
            <option value="all">All States</option>
            {uniqueStates.map(s => <option key={s} value={s}>{s}</option>)}
          </select>

          {/* Backend Type Filter */}
          <select value={backendTypeFilter} onChange={(e) => setBackendTypeFilter(e.target.value)} className="bg-[var(--surface)] border border-[var(--border)] rounded-lg px-2 py-1.5 text-xs outline-none cursor-pointer">
            <option value="all">All Backends</option>
            {uniqueBackendTypes.map(bt => <option key={bt} value={bt}>{bt}</option>)}
          </select>

          {/* Long Running Toggle */}
          <button onClick={() => setLongRunningOnly(!longRunningOnly)} className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all border ${longRunningOnly ? "bg-red-500/15 text-red-400 border-red-500/30" : "bg-[var(--surface)] border-[var(--border)] text-[var(--text-secondary)]"}`}>
            <Clock className="w-3 h-3" />Long Running
          </button>

          <button onClick={fetchStats} className="p-1.5 hover:bg-[var(--border)] rounded-lg" title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </button>
          <div className="flex-1" />
          <span className="text-[10px] text-[var(--text-secondary)]"><Filter className="w-3 h-3 inline mr-1 opacity-40" />{filteredStats.length} / {stats.length} sessions</span>
        </div>

        <div className="flex-1 overflow-auto">
          {isLoading && stats.length === 0 ? (
            <div className="h-full flex items-center justify-center"><Cpu className="w-8 h-8 text-emerald-400 animate-spin" /></div>
          ) : filteredStats.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-[var(--text-secondary)]"><Zap className="w-12 h-12 opacity-20 mb-2" /><p className="text-xs font-medium opacity-40">No sessions found</p></div>
          ) : (
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 z-10 bg-[var(--surface)] shadow-sm">
                <tr className="border-b border-[var(--border)]">
                  <th className="w-10 px-2 py-2 text-[9px] font-bold uppercase text-[var(--text-secondary)] bg-[var(--surface)]"></th>
                  <th onClick={() => handleSort("pid")} className="px-2 py-2 text-[9px] font-bold uppercase text-[var(--text-secondary)] w-16 cursor-pointer hover:text-[var(--text-primary)] select-none">PID{sortIndicator("pid")}</th>
                  <th onClick={() => handleSort("state")} className="px-2 py-2 text-[9px] font-bold uppercase text-[var(--text-secondary)] w-20 cursor-pointer hover:text-[var(--text-primary)] select-none">State{sortIndicator("state")}</th>
                  <th onClick={() => handleSort("usename")} className="px-2 py-2 text-[9px] font-bold uppercase text-[var(--text-secondary)] w-24 cursor-pointer hover:text-[var(--text-primary)] select-none">User{sortIndicator("usename")}</th>
                  <th onClick={() => handleSort("datname")} className="px-2 py-2 text-[9px] font-bold uppercase text-[var(--text-secondary)] w-24 cursor-pointer hover:text-[var(--text-primary)] select-none">Database{sortIndicator("datname")}</th>
                  <th onClick={() => handleSort("application_name")} className="px-2 py-2 text-[9px] font-bold uppercase text-[var(--text-secondary)] w-28 cursor-pointer hover:text-[var(--text-primary)] select-none">Application{sortIndicator("application_name")}</th>
                  <th onClick={() => handleSort("client_addr")} className="px-2 py-2 text-[9px] font-bold uppercase text-[var(--text-secondary)] w-20 cursor-pointer hover:text-[var(--text-primary)] select-none">Client{sortIndicator("client_addr")}</th>
                  <th onClick={() => handleSort("duration")} className="px-2 py-2 text-[9px] font-bold uppercase text-[var(--text-secondary)] w-20 cursor-pointer hover:text-[var(--text-primary)] select-none">Duration{sortIndicator("duration")}</th>
                  <th onClick={() => handleSort("wait_event_type")} className="px-2 py-2 text-[9px] font-bold uppercase text-[var(--text-secondary)] w-16 cursor-pointer hover:text-[var(--text-primary)] select-none">Wait{sortIndicator("wait_event_type")}</th>
                  <th onClick={() => handleSort("query")} className="px-2 py-2 text-[9px] font-bold uppercase text-[var(--text-secondary)] min-w-[200px] cursor-pointer hover:text-[var(--text-primary)] select-none">Query{sortIndicator("query")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {filteredStats.map((stat) => {
                  const durationSec = getDurationSeconds(stat.query_start);
                  const isLongRunning = durationSec > 5 && stat.state === "active";
                  return (
                  <tr key={stat.pid} className={`group hover:bg-[var(--surface-raised)]/50 transition-colors ${isLongRunning ? "bg-red-500/5" : ""}`}>
                    <td className="px-2 py-1.5">
                      <button onClick={() => terminateBackend(stat.pid)} className="p-1 rounded text-red-500/40 hover:text-red-500 hover:bg-red-500/10 transition-all" title="Kill"><Trash2 className="w-3.5 h-3.5" /></button>
                    </td>
                    <td className="px-2 py-1.5"><span className="font-mono text-xs font-medium text-emerald-400">{stat.pid}</span></td>
                    <td className="px-2 py-1.5"><span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${stat.state === 'active' ? "bg-green-500/20 text-green-400" : stat.state === 'idle in transaction' ? "bg-red-500/20 text-red-400" : "bg-amber-500/20 text-amber-400"}`}>{stat.state}</span></td>
                    <td className="px-2 py-1.5"><span className="text-xs font-medium">{stat.usename}</span></td>
                    <td className="px-2 py-1.5"><span className="text-xs text-blue-400">{stat.datname}</span></td>
                    <td className="px-2 py-1.5"><span className="text-[10px] text-purple-400 truncate block max-w-[100px]">{stat.application_name || '-'}</span></td>
                    <td className="px-2 py-1.5"><span className="text-[10px] text-[var(--text-secondary)] font-mono">{stat.client_addr}</span></td>
                    <td className="px-2 py-1.5"><span className={`text-[10px] font-mono ${isLongRunning ? "text-red-400 font-bold" : "text-[var(--text-secondary)]"}`}>{formatDuration(stat.query_start)}</span></td>
                    <td className="px-2 py-1.5"><span className={`text-[9px] font-medium ${stat.wait_event_type ? "text-amber-400" : "text-[var(--text-secondary)]/50"}`}>{stat.wait_event_type || '-'}</span></td>
                    <td className="px-2 py-1.5">
                      <code className="text-[10px] font-mono text-[var(--text-secondary)] whitespace-nowrap overflow-hidden text-ellipsis block max-w-[250px]">{stat.query || '<idle>'}</code>
                    </td>
                  </tr>
                );})}
              </tbody>
            </table>
          )}
        </div>

        <div className="px-4 py-2 bg-[var(--surface)] border-t border-[var(--border)] flex items-center justify-between text-[10px] text-[var(--text-secondary)]">
          <span>PostgreSQL pg_stat_activity</span>
          <span>Click column headers to sort</span>
        </div>

        {error && <div className="absolute top-16 right-6 max-w-sm bg-red-600 text-white px-4 py-3 rounded-xl text-sm font-medium flex items-center gap-2"><ShieldAlert className="w-5 h-5" /><span className="flex-1">{error}</span><button onClick={() => setError(null)}><X className="w-4 h-4" /></button></div>}
      </div>
    </div>
  );
};