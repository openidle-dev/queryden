import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import { Terminal, RefreshCw, Copy, Trash2, CheckCircle, XCircle, Clock, ChevronUp, HelpCircle } from "lucide-react";
import { PsqlHelpDialog } from "./PsqlHelpDialog";
import { useSettings } from "../../store/settingsStore";

interface PsqlConsoleEntry {
  id: string;
  command: string;
  outputLines: string[];
  hasErrors: boolean;
  executionTime: number;
}

interface PsqlWindowProps {
  entries: PsqlConsoleEntry[];      // completed command+output pairs
  liveOutput: string[];              // output lines being generated now
  runningCommand: string | null;    // command currently executing
  isExecuting: boolean;
  executionTime: number;
  onRun: (query: string) => void;
  onClear: () => void;
  onRemoveLast?: () => void;
  connectionName?: string;
  databaseName?: string;
}

function isTabularOutput(lines: string[]): TabularInfo | null {
  if (lines.length < 1) return null;

  const pipePattern = /[|│]/;
  if (!pipePattern.test(lines[0])) return null;

  const header = lines[0];
  const headerParts = header.split(pipePattern).map(s => s.trimEnd());
  const headerPipeCount = headerParts.length - 1;
  if (headerPipeCount <= 0) return null;

  const footerStartIdx = lines.findIndex((l, i) => i > 0 && /^\(\d+ rows?\)/.test(l.trim()));
  const contentLines = footerStartIdx >= 1 ? lines.slice(0, footerStartIdx) : lines;
  const footerLines = footerStartIdx >= 0 ? lines.slice(footerStartIdx) : [];

  if (contentLines.length >= 2) {
    const sepIdx = contentLines.findIndex(l => /^[-+\s─┼│┬┴├┤╪]+$/.test(l.trim()) && l.trim().length > 3);
    if (sepIdx >= 1) {
      const sep = contentLines[sepIdx];
      const sepSegments = sep.split(pipePattern).slice(1, -1);
      if (sepSegments.length > 0 && sepSegments.length === headerPipeCount) {
        const colWidths: number[] = sepSegments.map(s => s.replace(/[-+─┼│┬┴├┤╪]/g, '').trim().length || s.trim().length);
        const dataLines = contentLines.slice(0, sepIdx).map(l => l.split(pipePattern).map(s => s.trimEnd()));
        for (const row of dataLines) {
          for (let i = 0; i < row.length && i < colWidths.length; i++) {
            colWidths[i] = Math.max(colWidths[i], row[i].length);
          }
        }
        return { colWidths, lines: dataLines, footerLines };
      }
    }
  }

  const dataLines: string[][] = [];
  for (let i = 1; i < contentLines.length; i++) {
    const parts = contentLines[i].split(pipePattern);
    if (parts.length - 1 === headerPipeCount) {
      dataLines.push(parts.map(s => s.trimEnd()));
    }
  }

  if (dataLines.length === 0) return null;

  const colWidths = headerParts.map(p => p.length);
  for (const row of dataLines) {
    for (let i = 0; i < row.length; i++) {
      colWidths[i] = Math.max(colWidths[i], row[i].length);
    }
  }

  const allLines = [headerParts, ...dataLines];
  return { colWidths, lines: allLines, footerLines };
}

interface TabularInfo {
  colWidths: number[];
  lines: string[][];
  footerLines: string[];
}

function renderTabularLines(info: TabularInfo, hasErrors: boolean): React.ReactNode[] {
  const { colWidths, lines, footerLines } = info;
  const rows: React.ReactNode[] = [];
  for (let r = 0; r < lines.length; r++) {
    const cells = lines[r].map((cell, i) => {
      const w = colWidths[i] ?? cell.length;
      return cell + " ".repeat(w - cell.length);
    });
    const cls = r === 0 ? (hasErrors ? "text-red-400" : "text-cyan-300 font-bold") : (hasErrors ? "text-red-400" : "text-gray-100");
    rows.push(<div key={`r-${r}`} className={cls}>{" " + cells.join(" │ ")}</div>);
  }

  rows.splice(1, 0, <div key="sep" className={hasErrors ? "text-red-400" : "text-gray-600"}>{" " + colWidths.map(w => "─".repeat(w ?? 0)).join("─┼─")}</div>);

  for (let f = 0; f < footerLines.length; f++) {
    rows.push(<div key={`f-${f}`} className={hasErrors ? "text-red-400" : "text-gray-500 italic"}>{footerLines[f]}</div>);
  }

  return rows;
}

function classifyLine(line: string): string {
  if (line.startsWith("ERROR:") || line.startsWith("FATAL:") || line.startsWith("psql: error:")) return "text-red-400";
  if (line.startsWith("WARNING:")) return "text-yellow-400";
  if (/^psql\s*\(/i.test(line)) return "text-gray-500 italic";
  if (/^Password for user/i.test(line)) return "text-amber-400";
  if (/^\(\d+ rows?\)/.test(line.trim())) return "text-gray-500 italic";
  return "text-gray-300";
}

export const PsqlWindow = memo(function PsqlWindow({
  entries,
  liveOutput,
  runningCommand,
  isExecuting,
  executionTime,
  onRun,
  onClear,
  onRemoveLast,
  connectionName,
  databaseName,
}: PsqlWindowProps) {
  const settings = useSettings();
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [copied, setCopied] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const isAtBottomRef = useRef(true);

  const fontFamily = settings.editorFontFamily || "'JetBrains Mono', 'Fira Code', 'Consolas', 'Cascadia Code', monospace";

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Track if user is scrolled to bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
      isAtBottomRef.current = gap < 40;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Auto-scroll to bottom when entries or liveOutput change
  useEffect(() => {
    if (isAtBottomRef.current && scrollRef.current) {
      requestAnimationFrame(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
      });
    }
  }, [entries, liveOutput, isExecuting]);

  const handleSubmit = useCallback(() => {
    const cmd = draft.trim();
    if (!cmd || isExecuting) return;
    setDraft("");
    setHistoryIndex(-1);
    onRun(cmd);
  }, [draft, isExecuting, onRun]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (entries.length === 0) return;
      const newIndex = historyIndex < entries.length - 1 ? historyIndex + 1 : historyIndex;
      setHistoryIndex(newIndex);
      setDraft(entries[entries.length - 1 - newIndex]?.command || "");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIndex <= 0) { setHistoryIndex(-1); setDraft(""); }
      else {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setDraft(entries[entries.length - 1 - newIndex]?.command || "");
      }
    } else if (e.key === "PageUp") {
      if (scrollRef.current) {
        scrollRef.current.scrollTop -= 400;
        e.preventDefault();
      }
    } else if (e.key === "PageDown") {
      if (scrollRef.current) {
        scrollRef.current.scrollTop += 400;
        e.preventDefault();
      }
    } else if (e.key === "Home" && (e.ctrlKey || e.metaKey)) {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = 0;
        e.preventDefault();
      }
    } else if (e.key === "End" && (e.ctrlKey || e.metaKey)) {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        e.preventDefault();
      }
    }
  }, [handleSubmit, entries, historyIndex]);

  const copyOutput = useCallback(() => {
    const text = entries.map(e => `❯ ${e.command}\n${e.outputLines.join("\n")}`).join("\n\n");
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [entries]);

  const removeLast = useCallback(() => {
    if (onRemoveLast) {
      onRemoveLast();
    }
  }, [onRemoveLast]);

  const clearAll = useCallback(() => {
    setDraft("");
    setHistoryIndex(-1);
    onClear();
    textareaRef.current?.focus();
  }, [onClear]);

  // Auto-resize textarea based on content
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
    }
  }, [draft]);

  const hasErrors = entries.some(e => e.hasErrors);
  const totalRows = useMemo(() => {
    let total = 0;
    for (const entry of entries) {
      const footer = entry.outputLines.find(l => /^\(\d+ rows?\)/.test(l.trim()));
      if (footer) {
        const m = footer.match(/(\d+)/);
        total += m ? parseInt(m[1]) : 0;
      }
    }
    const liveFooter = liveOutput.find(l => /^\(\d+ rows?\)/.test(l.trim()));
    if (liveFooter) {
      const m = liveFooter.match(/(\d+)/);
      total += m ? parseInt(m[1]) : 0;
    }
    return total;
  }, [entries, liveOutput]);

  return (
    <div className="h-full flex flex-col bg-[var(--background)]">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 bg-[var(--surface)] border-b border-[var(--border)] shrink-0">
        <Terminal className="w-3.5 h-3.5 text-blue-400" />
        <span className="text-xs font-semibold text-[var(--text-primary)]">psql Console</span>
        {connectionName && (
          <span className="text-[10px] text-[var(--color-accent)] opacity-70">[{connectionName}]</span>
        )}
        {databaseName && (
          <span className="text-[10px] text-[var(--text-secondary)]">/ {databaseName}</span>
        )}
        <div className="flex-1" />
        {isExecuting && (
          <span className="flex items-center gap-1 text-[10px] text-amber-400">
            <RefreshCw className="w-3 h-3 animate-spin" /> Running...
          </span>
        )}
        {!isExecuting && executionTime > 0 && (
          <span className="flex items-center gap-1 text-[10px] text-gray-500">
            <Clock className="w-3 h-3" /> {executionTime}ms
          </span>
        )}
        {!isExecuting && entries.length > 0 && totalRows > 0 && !hasErrors && (
          <span className="flex items-center gap-1 text-[10px] text-green-400">
            <CheckCircle className="w-3 h-3" /> {totalRows} rows
          </span>
        )}
        {!isExecuting && hasErrors && (
          <span className="flex items-center gap-1 text-[10px] text-red-400">
            <XCircle className="w-3 h-3" /> Error
          </span>
        )}
        <div className="w-px h-4 bg-[var(--border)] mx-1" />
        <button onClick={copyOutput} className="p-1 text-gray-500 hover:text-gray-300 transition-colors" title="Copy all output">
          {copied ? <CheckCircle className="w-3.5 h-3.5 text-green-400" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
        <button onClick={() => setShowHelp(true)} className="p-1 text-gray-500 hover:text-blue-400 transition-colors" title="psql Help (\?)">
          <HelpCircle className="w-3.5 h-3.5" />
        </button>
        <button onClick={removeLast} className="p-1 text-gray-500 hover:text-gray-300 transition-colors" title="Remove last entry" disabled={entries.length === 0}>
          <ChevronUp className="w-3.5 h-3.5" />
        </button>
        <button onClick={clearAll} className="p-1 text-gray-500 hover:text-red-400 transition-colors" title="Clear console" disabled={entries.length === 0}>
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {showHelp && (
        <PsqlHelpDialog 
          onClose={() => setShowHelp(false)} 
          onSelectCommand={(cmd) => {
            setDraft(cmd);
            textareaRef.current?.focus();
          }}
        />
      )}

      {/* Terminal Output Area */}
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-auto bg-[#0d1117] px-4 py-3" style={{ fontFamily }}>
        {entries.length === 0 && liveOutput.length === 0 && !isExecuting && (
          <div className="flex flex-col items-center justify-center h-full opacity-30 select-none">
            <Terminal className="w-10 h-10 mb-2 text-blue-500/40" />
            <p className="text-sm text-gray-400 font-medium">psql Console</p>
            <p className="text-[11px] text-gray-600 mt-1">Type SQL commands and press <kbd className="px-1.5 py-0.5 bg-[#1a1a1a] border border-[#333] rounded text-[10px] font-mono">Enter</kbd> to execute</p>
            <p className="text-[10px] text-gray-700 mt-0.5">Try <span className="text-gray-500 font-mono">\d</span> · <span className="text-gray-500 font-mono">\dt</span> · <span className="text-gray-500 font-mono">SELECT version();</span></p>
          </div>
        )}

        {entries.map((entry, idx) => (
          <div key={entry.id} className="mb-1">
            {/* Separator between entries */}
            {idx > 0 && <div className="border-t border-[#21262d] my-3" />}
            {/* Command */}
            <div className="flex items-start gap-2 mt-1">
              <span className="text-emerald-400 font-bold shrink-0 select-none text-sm">❯</span>
              <span className="text-gray-100 whitespace-pre-wrap break-all flex-1 text-[13px]">{entry.command}</span>
            </div>
            {/* Output */}
            {entry.outputLines.length > 0 ? (() => {
              const tabular = isTabularOutput(entry.outputLines);
              if (tabular) {
                return (
                  <pre className={`mt-1 ml-5 text-[13px] leading-[18px] ${entry.hasErrors ? "text-red-400" : ""}`}>
                    {renderTabularLines(tabular, entry.hasErrors)}
                  </pre>
                );
              }
              return (
                <pre className={`mt-1 ml-5 text-[13px] leading-[18px] whitespace-pre-wrap break-all ${entry.hasErrors ? "text-red-400" : "text-gray-300"}`}>
                  {entry.outputLines.map((line, i) => (
                    <div key={i} className={classifyLine(line)}>{line}</div>
                  ))}
                </pre>
              );
            })() : (
              <div className="ml-5 mt-1 text-[11px] text-gray-600 italic">({entry.executionTime}ms)</div>
            )}
          </div>
        ))}

        {/* Live output (during execution) */}
        {(liveOutput.length > 0 || isExecuting) && (
          <div className="mb-1">
            {entries.length > 0 && <div className="border-t border-[#21262d] my-3" />}
            <div className="flex items-start gap-2 mt-1">
              <span className="text-emerald-400 font-bold shrink-0 select-none text-sm">❯</span>
              <span className="text-gray-100 text-[13px]">{runningCommand || draft}</span>
            </div>
            {liveOutput.length > 0 ? (() => {
                const tabular = isTabularOutput(liveOutput);
                if (tabular) {
                  return (
                    <pre className="mt-1 ml-5 text-[13px] leading-[18px]">
                      {renderTabularLines(tabular, false)}
                      {isExecuting && <div className="text-amber-400 animate-pulse mt-0.5">▌</div>}
                    </pre>
                  );
                }
                return (
                  <pre className="mt-1 ml-5 text-[13px] leading-[18px] whitespace-pre-wrap break-all text-gray-300">
                    {liveOutput.map((line, i) => (
                      <div key={i} className={classifyLine(line)}>{line}</div>
                    ))}
                    {isExecuting && <div className="text-amber-400 animate-pulse mt-0.5">▌</div>}
                  </pre>
                );
              })() : (
              <div className="ml-5 mt-1">
                <span className="text-amber-400 animate-pulse text-[13px]">▌</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Input Area */}
      <div className="shrink-0 border-t border-[#30363d] bg-[#161b22]">
        <div className="flex items-start px-3 py-2 gap-2">
          <span className="text-emerald-400 font-bold text-[14px] leading-5 shrink-0 mt-0.5 select-none">❯</span>
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={e => {
              setDraft(e.target.value);
              setHistoryIndex(-1);
            }}
            onKeyDown={handleKeyDown}
            disabled={isExecuting}
            className="flex-1 bg-transparent text-[13px] text-gray-100 font-mono leading-5 outline-none placeholder-gray-600 caret-blue-400 disabled:opacity-50 min-h-[24px] max-h-[120px]"
            style={{ fontFamily }}
            placeholder={isExecuting ? "Running..." : "Type SQL or meta-command (e.g. \\d, \\dt, \\l) and press Enter..."}
            rows={1}
            spellCheck={false}
            autoFocus
          />
        </div>
        <div className="flex items-center gap-3 px-3 pb-1.5 text-[9px] text-gray-600">
          <span><kbd className="px-1 py-0.5 bg-[#0d1117] border border-[#30363d] rounded font-mono">Enter</kbd> execute</span>
          <span><kbd className="px-1 py-0.5 bg-[#0d1117] border border-[#30363d] rounded font-mono">↑↓</kbd> history</span>
          <span><kbd className="px-1 py-0.5 bg-[#0d1117] border border-[#30363d] rounded font-mono">Shift+Enter</kbd> newline</span>
          <span className="text-gray-700 ml-auto">psql</span>
        </div>
      </div>
    </div>
  );
});