import { useState, useEffect, useMemo } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { MainContent } from "./MainContent";
import { DatabaseExplorer } from "../explorer/DatabaseExplorer";
import { FilesExplorer } from "../explorer/FilesExplorer";
import { useTheme } from "../../contexts/ThemeContext";
import { useConnections } from "../../contexts/useConnections";
import { useSettings } from "../../store/settingsStore";
import { Database, Files, Settings, Search, X, HelpCircle, Table, Eye, Variable, BookOpen, AlertTriangle, CheckCircle, ChevronRight } from "lucide-react";
import { UpdateNotification } from "../help/UpdateNotification";
import { useAppInfo } from "../../hooks/useAppInfo";

export function AppLayout() {
  const { theme } = useTheme();
  const { activeConnection, selectedDatabase, schemaItems } = useConnections();
  const settings = useSettings();
  const [showExplorer, setShowExplorer] = useState(true);
  const { name: appName } = useAppInfo();
  const [showFiles, setShowFiles] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const openHelp = () => window.dispatchEvent(new CustomEvent("open-help-dialog"));
  const openSettings = () => window.dispatchEvent(new CustomEvent("open-settings-dialog"));
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Status bar state
  const [statusInfo, setStatusInfo] = useState<{ rows?: number; time?: number; txActive?: boolean; txStatements?: number }>({});

  const isDatabaseReady = !!activeConnection && !!selectedDatabase;

  // Listen for status updates from MainContent
  useEffect(() => {
    const handleStatusUpdate = (e: Event) => {
      setStatusInfo((e as CustomEvent).detail);
    };
    window.addEventListener("status-bar-update", handleStatusUpdate);
    return () => window.removeEventListener("status-bar-update", handleStatusUpdate);
  }, []);

  // EmptyStateLauncher (#84) dispatches this to surface the saved-queries
  // browser when there's nothing else for the user to do yet.
  useEffect(() => {
    const handleOpenFiles = () => {
      setShowFiles(true);
      setShowExplorer(false);
    };
    window.addEventListener("open-files-panel", handleOpenFiles);
    return () => window.removeEventListener("open-files-panel", handleOpenFiles);
  }, []);

  const searchResults = useMemo(() => {
    if (!searchQuery || !schemaItems) return [];
    const query = searchQuery.toLowerCase();
    const results: { id: string; name: string; type: "table" | "view" | "function"; icon: any }[] = [];

    schemaItems.tables.forEach(t => {
      if (t.toLowerCase().includes(query)) {
        results.push({ id: `table-${t}`, name: t, type: "table", icon: Table });
      }
    });

    schemaItems.views.forEach(v => {
      if (v.toLowerCase().includes(query)) {
        results.push({ id: `view-${v}`, name: v, type: "view", icon: Eye });
      }
    });

    schemaItems.functions.forEach(f => {
      if (f.toLowerCase().includes(query)) {
        results.push({ id: `func-${f}`, name: f, type: "function", icon: Variable });
      }
    });

    return results.slice(0, 10);
  }, [searchQuery, schemaItems]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [searchResults]);

  const handleSearchResultClick = (id: string) => {
    window.dispatchEvent(new CustomEvent("jump-to-explorer-node", { detail: { id } }));
    setShowSearch(false);
    setSearchQuery("");
  };

  // Handle keyboard shortcuts (Ctrl+Alt+S is owned by App.tsx)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+\ - Database Explorer toggle.
      // Issue #13: previously Ctrl+D, which collided with Monaco's built-in
      // "add selection to next occurrence" (multi-cursor) when focus was in
      // the editor. Ctrl+\ matches the VS Code / DataGrip sidebar-toggle
      // convention and doesn't shadow any Monaco default binding.
      if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key === "\\") {
        e.preventDefault();
        setShowExplorer((prev) => !prev);
      }

      // Ctrl+Shift+F - Search
      if (e.ctrlKey && e.shiftKey && e.key === "F") {
        e.preventDefault();
        setShowSearch((prev) => !prev);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  return (
    <div className={`theme-${theme} ${settings.compactMode ? 'compact-mode' : ''} h-screen flex flex-col bg-[var(--background)] text-[var(--text-primary)]`}>
      {/* Top Tool Window Bar - DataGrip Style */}
      <header className="h-11 flex items-center justify-between px-2 bg-[var(--surface)] border-b border-[var(--border)]">
        {/* Left: Tool Window Buttons */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              setShowExplorer(!showExplorer);
              if (!showExplorer) setShowFiles(false);
            }}
            className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm transition-colors ${
              showExplorer 
                ? "bg-[var(--color-accent)]/20 text-[var(--color-accent)]" 
                : "hover:bg-[var(--border)]"
            }`}
            title="Database Explorer (Ctrl+\)"
          >
            <Database className="w-4 h-4" />
            Database Explorer
          </button>
          
          <button 
            onClick={() => {
              setShowFiles(!showFiles);
              if (!showFiles) setShowExplorer(false);
            }}
            className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm transition-colors ${
              showFiles 
                ? "bg-[var(--color-accent)]/20 text-[var(--color-accent)]" 
                : "hover:bg-[var(--border)]"
            }`}
            title="Files"
          >
            <Files className="w-4 h-4" />
            Files
          </button>
        </div>
        
        {/* Center: App Title */}
        <div className="flex items-center gap-2">
          <img src="/tauri.svg" alt="QueryDen" className="w-6 h-6" />
          <span className="text-sm font-semibold">{appName}</span>
          {activeConnection && (
            <span className="text-xs px-2 py-0.5 rounded bg-[var(--color-accent)]/20 text-[var(--color-accent)]">
              {activeConnection.name}
            </span>
          )}
        </div>

        {/* Right: Search & Settings */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowSearch(!showSearch)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded text-sm transition-colors ${
              showSearch 
                ? "bg-[var(--color-accent)]/20 text-[var(--color-accent)]" 
                : "hover:bg-[var(--border)]"
            }`}
            title="Search (Ctrl+Shift+F)"
          >
            <Search className="w-4 h-4" />
          </button>

          <UpdateNotification />
          
          <button
            onClick={openHelp}
            className="flex items-center gap-2 px-3 py-1.5 rounded text-sm hover:bg-[var(--border)] transition-colors group"
            title="Help & Documentation (Ctrl+H)"
          >
            <HelpCircle className="w-4 h-4 group-hover:text-[var(--color-accent)]" />
          </button>

          <button
            onClick={openSettings}
            className="flex items-center gap-2 px-3 py-1.5 rounded text-sm hover:bg-[var(--border)]"
            title="Settings (Ctrl+Alt+S)"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Search Bar */}
      {showSearch && (
        <div className="relative">
          <div className="h-10 flex items-center gap-2 px-3 bg-[var(--surface)] border-b border-[var(--border)]">
            <Search className="w-4 h-4 text-[var(--text-secondary)]" />
            <input
              type="text"
              placeholder="Search tables, views, functions... (Ctrl+Shift+F)"
              className="w-full bg-transparent border-none outline-none text-sm placeholder:text-[var(--text-secondary)] py-2"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setSelectedIndex(prev => (prev + 1) % (searchResults.length || 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setSelectedIndex(prev => (prev - 1 + (searchResults.length || 1)) % (searchResults.length || 1));
                } else if (e.key === 'Enter' && searchResults.length > 0) {
                  e.preventDefault();
                  handleSearchResultClick(searchResults[selectedIndex].id);
                } else if (e.key === 'Escape') {
                  setSearchQuery("");
                  setShowSearch(false);
                }
              }}
              autoFocus
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery("")} className="p-1 hover:bg-white/5 rounded">
                <X className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
              </button>
            )}
            <div className="w-px h-4 bg-[var(--border)] mx-1" />
            <button onClick={() => setShowSearch(false)} className="text-xs font-medium text-[var(--text-secondary)] hover:text-white px-2">
              Close
            </button>
          </div>
          
          {searchQuery && (
            <div className="absolute top-full left-0 right-0 z-50 bg-[var(--surface)] border-b border-x border-[var(--border)] shadow-2xl animate-in fade-in slide-in-from-top-1 duration-200 flex flex-col max-h-[400px]">
              {searchResults.length > 0 ? (
                <div className="p-2 space-y-1 overflow-y-auto">
                  <div className="px-3 py-1 text-[10px] uppercase font-bold text-[var(--text-secondary)] opacity-50 tracking-widest">
                    Database Objects
                  </div>
                  {searchResults.map((result, index) => (
                    <button
                      key={result.id}
                      onClick={() => handleSearchResultClick(result.id)}
                      onMouseEnter={() => setSelectedIndex(index)}
                      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all text-left text-sm group ${
                        index === selectedIndex 
                          ? 'bg-blue-500 text-white' 
                          : 'hover:bg-[var(--surface-raised)] text-[var(--text-primary)]'
                      }`}
                    >
                      <result.icon className={`w-4 h-4 ${index === selectedIndex ? 'text-white' : 'text-[var(--color-accent)]'}`} />
                      <span className="flex-1 font-medium">{result.name}</span>
                      <span className={`text-[10px] font-bold uppercase ${index === selectedIndex ? 'opacity-100' : 'opacity-50'}`}>{result.type}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="p-8 flex flex-col items-center justify-center text-center">
                  {!isDatabaseReady ? (
                    <div className="w-full max-w-sm animate-in fade-in slide-in-from-bottom-2 duration-300">
                      <div className="w-12 h-12 bg-amber-500/20 text-amber-500 rounded-full flex items-center justify-center mb-4 mx-auto">
                        <AlertTriangle className="w-6 h-6" />
                      </div>
                      <h3 className="text-base font-bold mb-2">Database Not Initialized</h3>
                      <p className="text-xs text-[var(--text-secondary)] mb-6">
                        The global search searches through your tables, views, and functions. You must connect and select a database first.
                      </p>
                      
                      <div className="bg-[var(--surface-raised)] border border-[var(--border)] rounded-xl p-4 text-left space-y-4 shadow-sm mb-6">
                        <h4 className="text-[10px] uppercase font-black text-[var(--text-secondary)] tracking-widest flex items-center gap-2">
                          <HelpCircle className="w-3 h-3 text-blue-500" /> Setup Guide
                        </h4>
                        
                        <div className="space-y-3">
                          <StepItem 
                            num={1} 
                            text="Create/Select a Connection" 
                            done={!!activeConnection} 
                            onClick={() => {
                              setShowExplorer(true);
                              setShowSearch(false);
                            }}
                          />
                          <StepItem 
                            num={2} 
                            text="Select a Target Database" 
                            done={!!selectedDatabase} 
                            active={!!activeConnection && !selectedDatabase}
                            onClick={() => {
                              setShowExplorer(true);
                              setShowSearch(false);
                            }}
                          />
                          <StepItem 
                            num={3} 
                            text="Search Objects" 
                            active={isDatabaseReady}
                          />
                        </div>
                      </div>

                      <div className="flex gap-2 justify-center">
                        <button
                          onClick={() => {
                            openHelp();
                            setShowSearch(false);
                          }}
                          className="px-4 py-2 bg-[var(--color-accent)] text-white text-xs font-bold rounded-lg hover:bg-[var(--color-accent-hover)] transition-colors flex items-center gap-2 shadow-lg shadow-[var(--color-accent)]/20"
                        >
                          <BookOpen className="w-3.5 h-3.5" />
                          View Detailed Help
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="w-16 h-16 bg-[var(--border)] rounded-full flex items-center justify-center mb-4 opacity-50">
                        <Search className="w-8 h-8" />
                      </div>
                      <h3 className="text-lg font-bold mb-1">No results for "{searchQuery}"</h3>
                      <p className="text-sm text-[var(--text-secondary)] max-w-md">
                        We couldn't find anything matching your search in the current database.
                      </p>
                      <div className="mt-6 flex gap-2">
                        <button
                          onClick={() => {
                            openHelp();
                            setShowSearch(false);
                            setSearchQuery("");
                          }}
                          className="px-4 py-2 bg-[var(--color-accent)] text-white text-xs font-bold rounded-lg hover:bg-[var(--color-accent-hover)] transition-colors flex items-center gap-2"
                        >
                          <BookOpen className="w-3.5 h-3.5" />
                          Search Documentation
                        </button>
                        <button 
                          onClick={() => setSearchQuery("")}
                          className="px-4 py-2 bg-[var(--surface-raised)] text-xs font-bold rounded-lg hover:bg-[var(--border)] transition-colors"
                        >
                          Clear Search
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
              
              <div className="mt-auto p-2 bg-[var(--surface-raised)] border-t border-[var(--border)] flex items-center justify-between text-[10px] font-medium text-[var(--text-secondary)]">
                <div className="flex gap-4">
                  <span><kbd className="bg-[var(--background)] px-1 rounded">↑↓</kbd> Navigate</span>
                  <span><kbd className="bg-[var(--background)] px-1 rounded">Enter</kbd> Select</span>
                  <span><kbd className="bg-[var(--background)] px-1 rounded">Esc</kbd> Close</span>
                </div>
                <div>{searchResults.length} results found</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Main Content Area — always mounted, explorer visibility controlled via CSS + panel size */}
      <div className="flex-1 flex overflow-hidden">
        <PanelGroup direction="horizontal">
          {/* Database Explorer Sidebar — always in DOM, collapsed when hidden */}
          {(showExplorer || showFiles) && (
            <>
              <Panel
                id="sidebar"
                defaultSize={20}
                minSize={15}
                maxSize={40}
                order={1}
              >
                <div className="h-full bg-[var(--surface)] border-r border-[var(--border)]">
                  {showExplorer && <DatabaseExplorer />}
                  {showFiles && <FilesExplorer />}
                </div>
              </Panel>

              <PanelResizeHandle className="w-1 bg-[var(--border)] hover:bg-[var(--color-accent)] transition-colors cursor-col-resize" />
            </>
          )}

          {/* Main Editor Area — always mounted, never destroyed */}
          <Panel
            id="main"
            defaultSize={showExplorer ? 80 : 100}
            order={2}
          >
            <MainContent />
          </Panel>
        </PanelGroup>
      </div>

      {/* Status Bar */}
      <div className="h-6 flex items-center justify-between px-3 bg-[var(--surface)] border-t border-[var(--border)] text-[10px] text-[var(--text-secondary)] shrink-0">
        {/* Left: Connection info */}
        <div className="flex items-center gap-3">
          {activeConnection ? (
            <>
              <div className="flex items-center gap-1.5">
                <span
                  className="w-2 h-2 rounded-full border border-black/20"
                  style={{ backgroundColor: activeConnection.color || "#06b6d4" }}
                />
                <span className="font-medium text-[var(--text-primary)]">{activeConnection.name}</span>
              </div>
              {selectedDatabase && (
                <>
                  <span className="opacity-40">/</span>
                  <span>{selectedDatabase}</span>
                </>
              )}
              {activeConnection.host && (
                <>
                  <span className="opacity-40">·</span>
                  <span className="font-mono">{activeConnection.host}:{activeConnection.port || (activeConnection.type === "mysql" ? 3306 : 5432)}</span>
                </>
              )}
            </>
          ) : (
            <span className="opacity-50">No connection</span>
          )}
        </div>

        {/* Right: Metrics */}
        <div className="flex items-center gap-3">
          {/* Transaction indicator */}
          {statusInfo.txActive && (
            <div className="flex items-center gap-1 text-[var(--color-warning)]">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-warning)] animate-pulse" />
              <span>Tx{statusInfo.txStatements !== undefined && statusInfo.txStatements > 0 ? ` (${statusInfo.txStatements})` : ""}</span>
            </div>
          )}
          {/* Row count */}
          {statusInfo.rows !== undefined && (
            <span>{statusInfo.rows} row{statusInfo.rows !== 1 ? "s" : ""}</span>
          )}
          {/* Execution time */}
          {statusInfo.time !== undefined && statusInfo.time > 0 && (
            <span>{statusInfo.time}ms</span>
          )}
          {/* DB type */}
          {activeConnection && (
            <span className="uppercase font-mono text-[9px] opacity-50">{activeConnection.type}</span>
          )}
        </div>
      </div>
    </div>
  );
}

function StepItem({ num, text, done, active, onClick }: { 
  num: number; 
  text: string; 
  done?: boolean; 
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <div 
      className={`flex items-center gap-3 p-2 rounded-lg transition-colors ${onClick ? 'cursor-pointer hover:bg-white/5' : ''} ${active ? 'bg-blue-500/10 border border-blue-500/20' : ''}`}
      onClick={onClick}
    >
      <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
        done ? 'bg-green-500 text-white' : (active ? 'bg-blue-500 text-white' : 'bg-[var(--border)] text-[var(--text-secondary)]')
      }`}>
        {done ? <CheckCircle className="w-3 h-3" /> : num}
      </div>
      <div className="flex-1">
        <div className={`text-xs font-medium ${done ? 'text-[var(--text-secondary)] line-through' : (active ? 'text-blue-400' : 'text-[var(--text-primary)]')}`}>
          {text}
        </div>
      </div>
      {onClick && !done && (
        <ChevronRight className="w-3 h-3 text-[var(--text-secondary)]" />
      )}
    </div>
  );
}