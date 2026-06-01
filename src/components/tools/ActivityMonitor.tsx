import { useState, useEffect, useCallback, useRef } from "react";
import { X, RefreshCw, Activity, Trash2, Search, ShieldAlert, Cpu, Zap, Clock, Filter } from "lucide-react";
import { useConnections } from "../../contexts/useConnections";
import { useConfirmDialog } from "../ui/ConfirmDialog";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";

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

const thClass = "px-2 py-2 text-[9px] font-bold uppercase text-[var(--neutral-11)] cursor-pointer hover:text-[var(--neutral-12)] select-none";

export const ActivityMonitor: React.FC<ActivityMonitorProps> = ({ isOpen, onClose }) => {
  const { currentDb, activeConnection, databases } = useConnections();
  const confirmDialog = useConfirmDialog();
  const [stats, setStats] = useState<ConnectionStats[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [targetDb, setTargetDb] = useState<string>("");
  const latestTargetDbRef = useRef(targetDb);
  // Filters
  const [stateFilter, setStateFilter] = useState<string>("all");
  const [longRunningOnly, setLongRunningOnly] = useState(false);
  const [backendTypeFilter, setBackendTypeFilter] = useState<string>("all");
  // Sorting
  const [sortKey, setSortKey] = useState<SortKey>("pid");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  useEffect(() => { latestTargetDbRef.current = targetDb; }, [targetDb]);

  const fetchStats = useCallback(async (overrideTargetDb?: string) => {
    if (!activeConnection) return;
    if (activeConnection.type !== 'postgres') { setError("PostgreSQL only"); return; }
    if (!currentDb) { setError("Not connected"); return; }

    const dbTarget = overrideTargetDb ?? latestTargetDbRef.current;

    setIsLoading(true);
    setError(null);

    try {
      const dbFilter = dbTarget ? `AND datname = $1` : "";
      const query = `SELECT pid, COALESCE(datname::text, '') as datname, COALESCE(usename::text, '') as usename, COALESCE(application_name::text, '') as application_name, COALESCE(client_addr::text, 'local') as client_addr, COALESCE(client_port::text, '') as client_port, COALESCE(backend_start::text, '') as backend_start, COALESCE(xact_start::text, '') as xact_start, COALESCE(query_start::text, '') as query_start, COALESCE(state_change::text, '') as state_change, COALESCE(wait_event_type::text, '') as wait_event_type, COALESCE(wait_event::text, '') as wait_event, COALESCE(state::text, 'unknown') as state, COALESCE(backend_type::text, '') as backend_type, COALESCE(query::text, '') as query FROM pg_stat_activity WHERE pid <> pg_backend_pid() ${dbFilter} ORDER BY backend_start DESC`;
      const result = await (currentDb as any).select(query, dbTarget ? [dbTarget] : []) as ConnectionStats[];
      setStats(result);
      setError(null);
    } catch (err: any) {
      setError(err.message || "Failed to fetch");
    } finally { setIsLoading(false); }
  }, [currentDb, activeConnection]);

  const terminateBackend = async (pid: number | string) => {
    if (!currentDb) return;
    const confirmed = await confirmDialog.confirm({ title: "Terminate Session", message: `Kill PID ${pid}?`, confirmLabel: "Kill", type: "danger" });
    if (!confirmed) return;
    try {
      await (currentDb as any).select(`SELECT pg_terminate_backend($1::int)`, [pid]);
      fetchStats();
    } catch (err: any) { setError(err.message); }
  };

  useEffect(() => { if (isOpen) { setAutoRefresh(true); setTargetDb(""); setSearchTerm(""); setStateFilter("all"); setLongRunningOnly(false); setBackendTypeFilter("all"); fetchStats(""); } }, [isOpen]);
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
    <Dialog
      open={isOpen}
      onClose={onClose}
      className="relative w-[95vw] h-[90vh] max-w-none rounded-2xl overflow-hidden"
      backdropClassName="bg-black/70 backdrop-blur-md"
    >
      <div className="flex items-center justify-between px-4 py-3 bg-[var(--surface-elevated)] border-b border-[var(--neutral-6)] shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-[var(--success-3)] text-[var(--success-11)] border border-[var(--success-6)]"><Activity className="w-5 h-5" /></div>
          <div>
            <h2 className="font-bold text-lg text-[var(--neutral-12)]">Session Audit</h2>
            <div className="flex items-center gap-3 text-[10px]">
              <span className="text-[var(--neutral-11)]">{activeConnection?.name}</span>
              <span className="text-[var(--success-11)] font-bold">{activeCount} active</span>
              <span className="text-[var(--warning-11)]">{idleCount} idle</span>
              {longRunningCount > 0 && <span className="text-[var(--danger-11)] font-bold animate-pulse">{longRunningCount} long-running</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={autoRefresh ? "primary" : "secondary"}
            leftIcon={<RefreshCw className={`w-3.5 h-3.5 ${autoRefresh ? "animate-spin" : ""}`} />}
            onClick={() => setAutoRefresh(!autoRefresh)}
          >
            {autoRefresh ? "Live" : "Auto"}
          </Button>
          <IconButton icon={<X />} label="Close" variant="ghost" size="sm" onClick={onClose} />
        </div>
      </div>

      <div className="flex items-center gap-3 px-4 py-2.5 bg-[var(--surface-base)] border-b border-[var(--neutral-6)] flex-wrap">
        <div className="flex-1 max-w-xs">
          <Input
            inputSize="sm"
            leftIcon={<Search />}
            placeholder="Search sessions..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <div className="w-36">
          <Input
            inputSize="sm"
            list="db-list"
            placeholder="Filter database..."
            value={targetDb}
            onChange={(e) => setTargetDb(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && fetchStats()}
          />
          <datalist id="db-list">
            {databases.map(db => <option key={db} value={db} />)}
          </datalist>
        </div>

        {/* State Filter */}
        <Select
          selectSize="sm"
          className="w-32"
          value={stateFilter}
          onValueChange={setStateFilter}
          options={[{ label: "All States", value: "all" }, ...uniqueStates.map(s => ({ label: s, value: s }))]}
        />

        {/* Backend Type Filter */}
        <Select
          selectSize="sm"
          className="w-36"
          value={backendTypeFilter}
          onValueChange={setBackendTypeFilter}
          options={[{ label: "All Backends", value: "all" }, ...uniqueBackendTypes.map(bt => ({ label: bt, value: bt }))]}
        />

        {/* Long Running Toggle */}
        <Button
          size="sm"
          variant={longRunningOnly ? "primary" : "secondary"}
          leftIcon={<Clock className="w-3 h-3" />}
          onClick={() => setLongRunningOnly(!longRunningOnly)}
        >
          Long Running
        </Button>

        <IconButton icon={<RefreshCw />} label="Refresh" variant="ghost" size="sm" onClick={() => fetchStats()} />
        <div className="flex-1" />
        <span className="text-[10px] text-[var(--neutral-11)]"><Filter className="w-3 h-3 inline mr-1 opacity-40" />{filteredStats.length} / {stats.length} sessions</span>
      </div>

      <div className="flex-1 overflow-auto">
        {isLoading && stats.length === 0 ? (
          <div className="h-full flex items-center justify-center"><Cpu className="w-8 h-8 text-[var(--accent-11)] animate-spin" /></div>
        ) : filteredStats.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-[var(--neutral-11)]"><Zap className="w-12 h-12 opacity-20 mb-2" /><p className="text-xs font-medium opacity-40">No sessions found</p></div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead className="sticky top-0 z-10 bg-[var(--surface-elevated)] shadow-sm">
              <tr className="border-b border-[var(--neutral-6)]">
                <th className="w-10 px-2 py-2 text-[9px] font-bold uppercase text-[var(--neutral-11)] bg-[var(--surface-elevated)]"></th>
                <th onClick={() => handleSort("pid")} className={`${thClass} w-16`}>PID{sortIndicator("pid")}</th>
                <th onClick={() => handleSort("state")} className={`${thClass} w-20`}>State{sortIndicator("state")}</th>
                <th onClick={() => handleSort("usename")} className={`${thClass} w-24`}>User{sortIndicator("usename")}</th>
                <th onClick={() => handleSort("datname")} className={`${thClass} w-24`}>Database{sortIndicator("datname")}</th>
                <th onClick={() => handleSort("application_name")} className={`${thClass} w-28`}>Application{sortIndicator("application_name")}</th>
                <th onClick={() => handleSort("client_addr")} className={`${thClass} w-20`}>Client{sortIndicator("client_addr")}</th>
                <th onClick={() => handleSort("duration")} className={`${thClass} w-20`}>Duration{sortIndicator("duration")}</th>
                <th onClick={() => handleSort("wait_event_type")} className={`${thClass} w-16`}>Wait{sortIndicator("wait_event_type")}</th>
                <th onClick={() => handleSort("query")} className={`${thClass} min-w-[200px]`}>Query{sortIndicator("query")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--neutral-6)]">
              {filteredStats.map((stat) => {
                const durationSec = getDurationSeconds(stat.query_start);
                const isLongRunning = durationSec > 5 && stat.state === "active";
                return (
                <tr key={stat.pid} className={`group hover:bg-[var(--neutral-3)]/50 transition-colors ${isLongRunning ? "bg-[var(--danger-3)]/40" : ""}`}>
                  <td className="px-2 py-1.5">
                    <button onClick={() => terminateBackend(stat.pid)} className="p-1 rounded text-[var(--danger-9)]/50 hover:text-[var(--danger-9)] hover:bg-[var(--danger-3)] transition-all" title="Kill"><Trash2 className="w-3.5 h-3.5" /></button>
                  </td>
                  <td className="px-2 py-1.5"><span className="font-mono text-xs font-medium text-[var(--accent-11)]">{stat.pid}</span></td>
                  <td className="px-2 py-1.5"><span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${stat.state === 'active' ? "bg-[var(--success-3)] text-[var(--success-11)]" : stat.state === 'idle in transaction' ? "bg-[var(--danger-3)] text-[var(--danger-11)]" : "bg-[var(--warning-3)] text-[var(--warning-11)]"}`}>{stat.state}</span></td>
                  <td className="px-2 py-1.5"><span className="text-xs font-medium text-[var(--neutral-12)]">{stat.usename}</span></td>
                  <td className="px-2 py-1.5"><span className="text-xs text-[var(--neutral-12)]">{stat.datname}</span></td>
                  <td className="px-2 py-1.5"><span className="text-[10px] text-[var(--neutral-11)] truncate block max-w-[100px]">{stat.application_name || '-'}</span></td>
                  <td className="px-2 py-1.5"><span className="text-[10px] text-[var(--neutral-11)] font-mono">{stat.client_addr}</span></td>
                  <td className="px-2 py-1.5"><span className={`text-[10px] font-mono ${isLongRunning ? "text-[var(--danger-11)] font-bold" : "text-[var(--neutral-11)]"}`}>{formatDuration(stat.query_start)}</span></td>
                  <td className="px-2 py-1.5"><span className={`text-[9px] font-medium ${stat.wait_event_type ? "text-[var(--warning-11)]" : "text-[var(--neutral-9)]"}`}>{stat.wait_event_type || '-'}</span></td>
                  <td className="px-2 py-1.5">
                    <code className="text-[10px] font-mono text-[var(--neutral-11)] whitespace-nowrap overflow-hidden text-ellipsis block max-w-[250px]">{stat.query || '<idle>'}</code>
                  </td>
                </tr>
              );})}
            </tbody>
          </table>
        )}
      </div>

      <div className="px-4 py-2 bg-[var(--surface-elevated)] border-t border-[var(--neutral-6)] flex items-center justify-between text-[10px] text-[var(--neutral-11)]">
        <span>PostgreSQL pg_stat_activity</span>
        <span>Click column headers to sort</span>
      </div>

      {error && <div className="absolute top-16 right-6 max-w-sm bg-[var(--danger-9)] text-white px-4 py-3 rounded-xl text-sm font-medium flex items-center gap-2 z-10"><ShieldAlert className="w-5 h-5" /><span className="flex-1">{error}</span><button onClick={() => setError(null)}><X className="w-4 h-4" /></button></div>}
    </Dialog>
  );
};
