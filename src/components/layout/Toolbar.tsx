import {
  Play, Settings, Sun, Moon, Search, Zap, HelpCircle, AlignLeft, Download,
  ArrowRightLeft, CheckCircle, XCircle
} from "lucide-react";
import { useTheme } from "../../contexts/ThemeContext";
import { useConnections } from "../../contexts/useConnections";
import { useKeymap } from "../../store/keymapStore";
import { useState, useEffect } from "react";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { cn } from "../../lib/cn";

const ISOLATION_LEVELS = [
  { label: "READ COMMITTED", value: "READ COMMITTED" },
  { label: "READ UNCOMMITTED", value: "READ UNCOMMITTED" },
  { label: "REPEATABLE READ", value: "REPEATABLE READ" },
  { label: "SERIALIZABLE", value: "SERIALIZABLE" },
  { label: "DEFAULT", value: "" },
];

// Shared outline-button class for BEGIN / COMMIT / ROLLBACK. These deliberately
// use a bordered, color-tinted treatment that doesn't map to any of the four
// Button variants (primary/secondary/ghost/destructive). The Button primitive
// supplies cursor, focus ring, sizing, and disabled handling; className
// overrides the background, border, and text color per transaction action.
const txButtonClass = (colorVar: string) =>
  cn(
    "bg-transparent border text-[length:10px] gap-1",
    `border-[var(${colorVar})] text-[var(${colorVar})]`,
    `hover:bg-[var(${colorVar})]/10`,
    "disabled:opacity-30 disabled:bg-transparent"
  );

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
    <div className="h-10 flex items-center justify-between px-3 bg-[var(--surface-panel)] border-b border-[var(--neutral-6)]">
      {/* Left: Connection Info */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--neutral-11)]">Connection:</span>
          <div
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: activeConnection?.color || "var(--accent-9)" }}
          />
          <span className="text-sm font-medium">{activeConnection?.name || "Not connected"}</span>
        </div>

        {selectedDatabase && (
          <>
            <span className="text-[var(--neutral-7)]">/</span>
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
          <span className="text-xs px-2 py-0.5 rounded bg-[var(--success-3)] text-[var(--success-11)]">
            Connected
          </span>
        ) : (
          <span className="text-xs px-2 py-0.5 rounded bg-[var(--danger-3)] text-[var(--danger-11)]">
            Disconnected
          </span>
        )}
      </div>

      {/* Center: Execute/Run + Transaction Controls */}
      <div className="flex items-center gap-1">
        <Button
          variant="primary"
          size="sm"
          leftIcon={<Play className="w-3.5 h-3.5" />}
          title={`Execute Query${getShortcut("execute") ? ` (${getShortcut("execute")})` : ""}`}
        >
          Run
        </Button>

        <IconButton
          icon={<Play />}
          label={`Execute All${getShortcut("executeAll") ? ` (${getShortcut("executeAll")})` : ""}`}
          variant="ghost"
          size="sm"
        />

        {/* Transaction Controls */}
        <div className="flex items-center gap-1 ml-2 pl-2 border-l border-[var(--neutral-6)]">
          {/* Isolation Level Selector — kept native because Radix Select rejects
              empty-string values (DEFAULT uses "" by design). Migrating requires
              a non-empty sentinel + bidirectional mapping; tracked under #152. */}
          {!txActive && (
            <select
              value={txIsolation}
              onChange={(e) => setTxIsolation(e.target.value)}
              className="bg-transparent border border-[var(--neutral-6)] rounded-sm px-1.5 py-1 text-[10px] text-[var(--neutral-11)] outline-none cursor-pointer hover:border-[var(--accent-8)] disabled:opacity-40"
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

          <Button
            onClick={() => dispatchTx("begin")}
            disabled={!activeConnection || txActive}
            size="xs"
            leftIcon={<ArrowRightLeft className="w-3 h-3" />}
            className={txButtonClass("--accent-9")}
            title="BEGIN — Start a transaction"
          >
            Begin
          </Button>

          <Button
            onClick={() => dispatchTx("commit")}
            disabled={!activeConnection || !txActive}
            size="xs"
            leftIcon={<CheckCircle className="w-3 h-3" />}
            className={txButtonClass("--success-9")}
            title="COMMIT — Save all changes"
          >
            Commit
          </Button>

          <Button
            onClick={() => dispatchTx("rollback")}
            disabled={!activeConnection || !txActive}
            size="xs"
            leftIcon={<XCircle className="w-3 h-3" />}
            className={txButtonClass("--danger-9")}
            title="ROLLBACK — Undo all changes"
          >
            Rollback
          </Button>

          {/* Transaction Status Indicator */}
          {txActive && (
            <div className="flex items-center gap-1 px-2 py-1 rounded-sm bg-[var(--warning-3)] border border-[var(--warning-6)]">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--warning-9)] animate-pulse" />
              <span className="text-[10px] text-[var(--warning-11)] font-medium">
                Tx{txStatements > 0 ? ` · ${txStatements}` : ""}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Right: Actions */}
      <div className="flex items-center gap-1">
        <IconButton
          icon={<AlignLeft />}
          label={`Format Code${getShortcut("format") ? ` (${getShortcut("format")})` : ""}`}
          variant="ghost"
          size="sm"
        />
        <IconButton icon={<Zap />} label="Live Templates" variant="ghost" size="sm" />
        <IconButton
          icon={<Download />}
          label={`Export${getShortcut("export") ? ` (${getShortcut("export")})` : ""}`}
          variant="ghost"
          size="sm"
        />

        <div className="w-px h-5 bg-[var(--neutral-6)] mx-1" />

        <IconButton
          icon={<Search />}
          label={`Find${getShortcut("find") ? ` (${getShortcut("find")})` : ""}`}
          variant="ghost"
          size="sm"
        />
        <IconButton
          icon={theme === "dark" ? <Sun /> : <Moon />}
          label={`Toggle Theme (${theme === "dark" ? "Light" : "Dark"})`}
          variant="ghost"
          size="sm"
          onClick={toggleTheme}
        />
        <IconButton
          icon={<HelpCircle />}
          label="Help & Documentation"
          variant="ghost"
          size="sm"
          onClick={() => window.dispatchEvent(new CustomEvent("open-help-dialog"))}
        />
        <IconButton
          icon={<Settings />}
          label={`Settings${getShortcut("settings") ? ` (${getShortcut("settings")})` : ""}`}
          variant="ghost"
          size="sm"
          onClick={() => window.dispatchEvent(new CustomEvent("open-settings-dialog"))}
        />
      </div>
    </div>
  );
}
