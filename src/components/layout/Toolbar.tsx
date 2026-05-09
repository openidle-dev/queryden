import { 
  Play, Settings, Sun, Moon, Search, Zap, HelpCircle, AlignLeft, Download,
  ArrowRightLeft, CheckCircle, XCircle
} from "lucide-react";
import { useTheme } from "../../contexts/ThemeContext";
import { useConnections } from "../../contexts/useConnections";
import { useKeymap } from "../../store/keymapStore";
import { useState, useEffect } from "react";

const ISOLATION_LEVELS = [
  { label: "READ COMMITTED", value: "READ COMMITTED" },
  { label: "READ UNCOMMITTED", value: "READ UNCOMMITTED" },
  { label: "REPEATABLE READ", value: "REPEATABLE READ" },
  { label: "SERIALIZABLE", value: "SERIALIZABLE" },
  { label: "DEFAULT", value: "" },
];

export function Toolbar() {
  const { theme, toggleTheme } = useTheme();
  const { activeConnection, selectedDatabase } = useConnections();
  const keymap = useKeymap();
  const [txActive, setTxActive] = useState(false);
  const [txIsolation, setTxIsolation] = useState("READ COMMITTED");
  const [txStatements, setTxStatements] = useState(0);

  // Listen for transaction state changes from MainContent
  useEffect(() => {
    const handleTxState = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setTxActive(detail.active);
      setTxStatements(detail.statementCount || 0);
    };
    window.addEventListener("tx-state-changed", handleTxState);
    return () => window.removeEventListener("tx-state-changed", handleTxState);
  }, []);

  const dispatchTx = (action: string, isolation?: string) => {
    window.dispatchEvent(new CustomEvent("tx-control", {
      detail: { action, isolation: isolation || txIsolation }
    }));
  };

  const getShortcut = (action: string) => {
    const sc = keymap.getShortcut(action);
    return sc || "";
  };

  return (
    <div className="h-10 flex items-center justify-between px-3 bg-[var(--surface)] border-b border-[var(--border)]">
      {/* Left: Connection Info */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--text-secondary)]">Connection:</span>
          <div 
            className="w-2 h-2 rounded-full" 
            style={{ backgroundColor: activeConnection?.color || "#06b6d4" }} 
          />
          <span className="text-sm font-medium">{activeConnection?.name || "Not connected"}</span>
        </div>
        
        {selectedDatabase && (
          <>
            <span className="text-[var(--border)]">/</span>
            <select
              className="bg-transparent border-none text-sm outline-none cursor-pointer"
              value={selectedDatabase}
              onChange={() => {}}
            >
              <option value={selectedDatabase}>{selectedDatabase}</option>
            </select>
          </>
        )}
        
        {activeConnection ? (
          <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: 'var(--color-success-bg)', color: 'var(--color-success)' }}>
            Connected
          </span>
        ) : (
          <span className="text-xs px-2 py-0.5 rounded" style={{ backgroundColor: 'var(--color-error-bg)', color: 'var(--color-error)' }}>
            Disconnected
          </span>
        )}
      </div>

      {/* Center: Execute/Run Button (Primary) */}
      <div className="flex items-center gap-1">
        <button
          className="flex items-center gap-1.5 px-3 py-1 text-sm rounded bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          title={`Execute Query ${getShortcut("execute") ? `(${getShortcut("execute")})` : ""}`}
        >
          <Play className="w-3.5 h-3.5" />
          <span>Run</span>
        </button>
        
        <button
          className="p-1.5 rounded hover:bg-[var(--border)]"
          title={`Execute All ${getShortcut("executeAll") ? `(${getShortcut("executeAll")})` : ""}`}
        >
          <Play className="w-4 h-4" />
        </button>

        {/* Transaction Controls */}
        <div className="flex items-center gap-1 ml-2 pl-2 border-l border-[var(--border)]">
          {/* Isolation Level Selector */}
          {!txActive && (
            <select
              value={txIsolation}
              onChange={(e) => setTxIsolation(e.target.value)}
              className="bg-transparent border border-[var(--border)] rounded px-1.5 py-1 text-[10px] text-[var(--text-secondary)] outline-none cursor-pointer hover:border-[var(--color-accent)] disabled:opacity-40"
              title="Transaction Isolation Level"
              disabled={!activeConnection}
            >
              {ISOLATION_LEVELS.map((lvl) => (
                <option key={lvl.value} value={lvl.value}>
                  {lvl.label || "Isolation"}
                </option>
              ))}
            </select>
          )}

          {/* BEGIN Transaction */}
          <button
            onClick={() => dispatchTx("begin")}
            disabled={!activeConnection || txActive}
            className="flex items-center gap-1 px-2 py-1 text-[10px] rounded border border-[var(--color-accent)] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            title="BEGIN — Start a transaction"
          >
            <ArrowRightLeft className="w-3 h-3" />
            <span>Begin</span>
          </button>

          {/* COMMIT */}
          <button
            onClick={() => dispatchTx("commit")}
            disabled={!activeConnection || !txActive}
            className="flex items-center gap-1 px-2 py-1 text-[10px] rounded border border-[var(--color-success)] text-[var(--color-success)] hover:bg-[var(--color-success)]/10 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            title="COMMIT — Save all changes"
          >
            <CheckCircle className="w-3 h-3" />
            <span>Commit</span>
          </button>

          {/* ROLLBACK */}
          <button
            onClick={() => dispatchTx("rollback")}
            disabled={!activeConnection || !txActive}
            className="flex items-center gap-1 px-2 py-1 text-[10px] rounded border border-[var(--color-error)] text-[var(--color-error)] hover:bg-[var(--color-error)]/10 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            title="ROLLBACK — Undo all changes"
          >
            <XCircle className="w-3 h-3" />
            <span>Rollback</span>
          </button>

          {/* Transaction Status Indicator */}
          {txActive && (
            <div className="flex items-center gap-1 px-2 py-1 rounded bg-[var(--color-warning)]/10 border border-[var(--color-warning)]/30">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-warning)] animate-pulse" />
              <span className="text-[10px] text-[var(--color-warning)] font-medium">
                Tx{txStatements > 0 ? ` · ${txStatements}` : ""}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-1">
        <button
          className="p-1.5 rounded hover:bg-[var(--border)]"
          title={`Format Code ${getShortcut("format") ? `(${getShortcut("format")})` : ""}`}
        >
          <AlignLeft className="w-4 h-4" />
        </button>
        
        <button
          className="p-1.5 rounded hover:bg-[var(--border)]"
          title="Live Templates"
        >
          <Zap className="w-4 h-4" />
        </button>
        
        <button
          className="p-1.5 rounded hover:bg-[var(--border)]"
          title={`Export ${getShortcut("export") ? `(${getShortcut("export")})` : ""}`}
        >
          <Download className="w-4 h-4" />
        </button>
        
        <div className="w-px h-5 bg-[var(--border)] mx-1" />
        
        <button
          className="p-1.5 rounded hover:bg-[var(--border)]"
          title={`Find ${getShortcut("find") ? `(${getShortcut("find")})` : ""}`}
        >
          <Search className="w-4 h-4" />
        </button>
        
        <button
          onClick={toggleTheme}
          className="p-1.5 rounded hover:bg-[var(--border)]"
          title={`Toggle Theme ${theme === "dark" ? "(Light)" : "(Dark)"}`}
        >
          {theme === "dark" ? (
            <Sun className="w-4 h-4" />
          ) : (
            <Moon className="w-4 h-4" />
          )}
        </button>
        
        <button
          className="p-1.5 rounded hover:bg-[var(--border)] transition-colors group relative"
          title="Help & Documentation"
          onClick={() => window.dispatchEvent(new CustomEvent("open-help-dialog"))}
        >
          <HelpCircle className="w-4 h-4 group-hover:text-[var(--color-accent)]" />
          <span className="absolute top-0 right-0 w-1.5 h-1.5 bg-blue-500 rounded-full animate-pulse opacity-0 group-hover:opacity-100 transition-opacity" />
        </button>

        <button
          className="p-1.5 rounded hover:bg-[var(--border)]"
          title={`Settings ${getShortcut("settings") ? `(${getShortcut("settings")})` : ""}`}
          onClick={() => window.dispatchEvent(new CustomEvent("open-settings-dialog"))}
        >
          <Settings className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}