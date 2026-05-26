import { useState, useEffect, useMemo } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { MainContent } from "./MainContent";
import { DatabaseExplorer } from "../explorer/DatabaseExplorer";
import { FilesExplorer } from "../explorer/FilesExplorer";
import { ConnectionDialog } from "../explorer/ConnectionDialog";
import { useTheme } from "../../contexts/ThemeContext";
import { useConnections } from "../../contexts/useConnections";
import { useSettings } from "../../store/settingsStore";
import { Database, Files, Settings, Search, X, HelpCircle, Table, Eye, Variable, BookOpen, AlertTriangle, CheckCircle, ChevronRight } from "lucide-react";
import { UpdateNotification } from "../help/UpdateNotification";
import { useAppInfo } from "../../hooks/useAppInfo";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { cn } from "../../lib/cn";

// Active state for the header's tool-window toggles (Database Explorer, Files,
// Search). Uses Button's ghost variant as the base and tints it with the
// accent-3/accent-11 pair when the window is open — matches the rest of the
// chrome's restraint while still being unambiguous.
const toolToggleActiveClass = "bg-[var(--accent-3)] text-[var(--accent-11)] hover:bg-[var(--accent-4)]";

export function AppLayout() {
  const { theme } = useTheme();
  const { activeConnection, selectedDatabase, schemaItems } = useConnections();
  const settings = useSettings();
  const [showExplorer, setShowExplorer] = useState(true);
  const { name: appName } = useAppInfo();
  const [showFiles, setShowFiles] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Add Connection dialog is owned here (not in DatabaseExplorer) so the
  // EmptyStateLauncher (#84) can trigger it via `open-new-connection` even
  // when the sidebar is collapsed or showing the Files panel. Lifting also
  // removes the listener-timing race where the event fired before
  // DatabaseExplorer's listener had mounted.
  const [showAddConnectionDialog, setShowAddConnectionDialog] = useState(false);
  const [defaultConnectionFolderId, setDefaultConnectionFolderId] = useState<string | undefined>(undefined);
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

  // EmptyStateLauncher (#84) dispatches these. open-files-panel surfaces
  // the saved-queries browser; open-new-connection opens the Add Connection
  // dialog. Both listeners live here (not in the sidebar) so they survive
  // panel toggles and work even when the sidebar is fully collapsed.
  useEffect(() => {
    const handleOpenFiles = () => {
      setShowFiles(true);
      setShowExplorer(false);
    };
    const handleOpenNewConnection = (e: Event) => {
      setDefaultConnectionFolderId((e as CustomEvent).detail?.folderId);
      setShowAddConnectionDialog(true);
    };
    window.addEventListener("open-files-panel", handleOpenFiles);
    window.addEventListener("open-new-connection", handleOpenNewConnection);
    return () => {
      window.removeEventListener("open-files-panel", handleOpenFiles);
      window.removeEventListener("open-new-connection", handleOpenNewConnection);
    };
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

  // Listen for global shortcut events dispatched from App.tsx
  useEffect(() => {
    const handleToggleExplorer = () => setShowExplorer((prev) => !prev);
    const handleToggleSearch = () => setShowSearch((prev) => !prev);

    window.addEventListener("toggle-explorer", handleToggleExplorer);
    window.addEventListener("toggle-search", handleToggleSearch);
    return () => {
      window.removeEventListener("toggle-explorer", handleToggleExplorer);
      window.removeEventListener("toggle-search", handleToggleSearch);
    };
  }, []);

  return (
    <div className={`theme-${theme} ${settings.compactMode ? 'compact-mode' : ''} h-screen flex flex-col bg-[var(--surface-base)] text-[var(--neutral-12)]`}>
      {/* Top Tool Window Bar - DataGrip Style */}
      <header className="h-11 flex items-center justify-between px-2 bg-[var(--surface-panel)] border-b border-[var(--neutral-6)]">
        {/* Left: Tool Window Buttons */}
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<Database className="w-4 h-4" />}
            onClick={() => {
              setShowExplorer(!showExplorer);
              if (!showExplorer) setShowFiles(false);
            }}
            className={cn(showExplorer && toolToggleActiveClass)}
            title="Database Explorer (Ctrl+\\)"
          >
            Database Explorer
          </Button>

          <Button
            variant="ghost"
            size="sm"
            leftIcon={<Files className="w-4 h-4" />}
            onClick={() => {
              setShowFiles(!showFiles);
              if (!showFiles) setShowExplorer(false);
            }}
            className={cn(showFiles && toolToggleActiveClass)}
            title="Files"
          >
            Files
          </Button>
        </div>

        {/* Center: App Title */}
        <div className="flex items-center gap-2">
          <img src="/tauri.svg" alt="QueryDen" className="w-6 h-6" />
          <span className="text-sm font-semibold">{appName}</span>
          {activeConnection && (
            <span className="text-xs px-2 py-0.5 rounded bg-[var(--accent-3)] text-[var(--accent-11)]">
              {activeConnection.name}
            </span>
          )}
        </div>

        {/* Right: Search & Settings */}
        <div className="flex items-center gap-1">
          <IconButton
            icon={<Search />}
            label="Search (Ctrl+Shift+F)"
            variant="ghost"
            size="sm"
            onClick={() => setShowSearch(!showSearch)}
            className={cn(showSearch && toolToggleActiveClass)}
          />

          <UpdateNotification />

          <IconButton
            icon={<HelpCircle />}
            label="Help & Documentation (Ctrl+H)"
            variant="ghost"
            size="sm"
            onClick={openHelp}
          />

          <IconButton
            icon={<Settings />}
            label="Settings (Ctrl+Alt+S)"
            variant="ghost"
            size="sm"
            onClick={openSettings}
          />
        </div>
      </header>

      {/* Search Bar */}
      {showSearch && (
        <div className="relative">
          <div className="h-10 flex items-center gap-2 px-3 bg-[var(--surface-elevated)] border-b border-[var(--neutral-6)]">
            <Search className="w-4 h-4 text-[var(--neutral-11)]" />
            <input
              type="text"
              placeholder="Search tables, views, functions... (Ctrl+Shift+F)"
              className="w-full bg-transparent border-none outline-none text-sm placeholder:text-[var(--neutral-11)] py-2"
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
              <IconButton
                icon={<X />}
                label="Clear search"
                variant="ghost"
                size="xs"
                onClick={() => setSearchQuery("")}
              />
            )}
            <div className="w-px h-4 bg-[var(--neutral-6)] mx-1" />
            <Button variant="ghost" size="xs" onClick={() => setShowSearch(false)}>
              Close
            </Button>
          </div>
          
          {searchQuery && (
            <div className="absolute top-full left-0 right-0 z-50 bg-[var(--surface-elevated)] border-b border-x border-[var(--neutral-6)] shadow-2xl animate-in fade-in slide-in-from-top-1 duration-200 flex flex-col max-h-[400px]">
              {searchResults.length > 0 ? (
                <div className="p-2 space-y-1 overflow-y-auto">
                  <div className="px-3 py-1 text-[10px] uppercase font-bold text-[var(--neutral-11)] opacity-50 tracking-widest">
                    Database Objects
                  </div>
                  {searchResults.map((result, index) => (
                    <button
                      key={result.id}
                      onClick={() => handleSearchResultClick(result.id)}
                      onMouseEnter={() => setSelectedIndex(index)}
                      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-all text-left text-sm group ${
                        index === selectedIndex 
                          ? 'bg-[var(--accent-9)] text-white' 
                          : 'hover:bg-[var(--surface-elevated)] text-[var(--neutral-12)]'
                      }`}
                    >
                      <result.icon className={`w-4 h-4 ${index === selectedIndex ? 'text-white' : 'text-[var(--accent-9)]'}`} />
                      <span className="flex-1 font-medium">{result.name}</span>
                      <span className={`text-[10px] font-bold uppercase ${index === selectedIndex ? 'opacity-100' : 'opacity-50'}`}>{result.type}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="p-8 flex flex-col items-center justify-center text-center">
                  {!isDatabaseReady ? (
                    <div className="w-full max-w-sm animate-in fade-in slide-in-from-bottom-2 duration-300">
                      <div className="w-12 h-12 bg-[var(--warning-3)] text-[var(--warning-11)] rounded-full flex items-center justify-center mb-4 mx-auto">
                        <AlertTriangle className="w-6 h-6" />
                      </div>
                      <h3 className="text-base font-bold mb-2">Database Not Initialized</h3>
                      <p className="text-xs text-[var(--neutral-11)] mb-6">
                        The global search searches through your tables, views, and functions. You must connect and select a database first.
                      </p>
                      
                      <div className="bg-[var(--surface-elevated)] border border-[var(--neutral-6)] rounded-xl p-4 text-left space-y-4 shadow-sm mb-6">
                        <h4 className="text-[10px] uppercase font-black text-[var(--neutral-11)] tracking-widest flex items-center gap-2">
                          <HelpCircle className="w-3 h-3 text-[var(--accent-11)]" /> Setup Guide
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
                        <Button
                          variant="primary"
                          size="sm"
                          leftIcon={<BookOpen className="w-3.5 h-3.5" />}
                          onClick={() => {
                            openHelp();
                            setShowSearch(false);
                          }}
                        >
                          View Detailed Help
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="w-16 h-16 bg-[var(--neutral-6)] rounded-full flex items-center justify-center mb-4 opacity-50">
                        <Search className="w-8 h-8" />
                      </div>
                      <h3 className="text-lg font-bold mb-1">No results for "{searchQuery}"</h3>
                      <p className="text-sm text-[var(--neutral-11)] max-w-md">
                        We couldn't find anything matching your search in the current database.
                      </p>
                      <div className="mt-6 flex gap-2">
                        <Button
                          variant="primary"
                          size="sm"
                          leftIcon={<BookOpen className="w-3.5 h-3.5" />}
                          onClick={() => {
                            openHelp();
                            setShowSearch(false);
                            setSearchQuery("");
                          }}
                        >
                          Search Documentation
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setSearchQuery("")}
                        >
                          Clear Search
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              )}
              
              <div className="mt-auto p-2 bg-[var(--surface-elevated)] border-t border-[var(--neutral-6)] flex items-center justify-between text-[10px] font-medium text-[var(--neutral-11)]">
                <div className="flex gap-4">
                  <span><kbd className="bg-[var(--surface-base)] px-1 rounded">↑↓</kbd> Navigate</span>
                  <span><kbd className="bg-[var(--surface-base)] px-1 rounded">Enter</kbd> Select</span>
                  <span><kbd className="bg-[var(--surface-base)] px-1 rounded">Esc</kbd> Close</span>
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
                <div className="h-full bg-[var(--surface-elevated)] border-r border-[var(--neutral-6)]">
                  {/* DatabaseExplorer stays mounted while the sidebar is visible
                      (even when Files is the active panel) — keeps its tree state
                      (expanded nodes, selection) intact across sidebar switches. */}
                  <div className={showExplorer ? "h-full" : "hidden"}>
                    <DatabaseExplorer isAddConnectionDialogOpen={showAddConnectionDialog} />
                  </div>
                  {showFiles && <FilesExplorer />}
                </div>
              </Panel>

              <PanelResizeHandle className="w-1 bg-[var(--neutral-6)] hover:bg-[var(--accent-9)] transition-colors cursor-col-resize" />
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
      <div className="h-6 flex items-center justify-between px-3 bg-[var(--surface-elevated)] border-t border-[var(--neutral-6)] text-[10px] text-[var(--neutral-11)] shrink-0">
        {/* Left: Connection info */}
        <div className="flex items-center gap-3">
          {activeConnection ? (
            <>
              <div className="flex items-center gap-1.5">
                <span
                  className="w-2 h-2 rounded-full border border-black/20"
                  style={{ backgroundColor: activeConnection.color || "#06b6d4" }}
                />
                <span className="font-medium text-[var(--neutral-12)]">{activeConnection.name}</span>
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
            <div className="flex items-center gap-1 text-[var(--warning-9)]">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--warning-9)] animate-pulse" />
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

      {/* Add Connection dialog — owned here, not in DatabaseExplorer (#84). */}
      {showAddConnectionDialog && (
        <ConnectionDialog onClose={() => { setShowAddConnectionDialog(false); setDefaultConnectionFolderId(undefined); }} defaultFolderId={defaultConnectionFolderId} />
      )}
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
      className={`flex items-center gap-3 p-2 rounded-lg transition-colors ${onClick ? 'cursor-pointer hover:bg-white/5' : ''} ${active ? 'bg-[var(--accent-3)] border border-[var(--accent-6)]' : ''}`}
      onClick={onClick}
    >
      <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
        done ? 'bg-[var(--success-9)] text-white' : (active ? 'bg-[var(--accent-9)] text-white' : 'bg-[var(--neutral-6)] text-[var(--neutral-11)]')
      }`}>
        {done ? <CheckCircle className="w-3 h-3" /> : num}
      </div>
      <div className="flex-1">
        <div className={`text-xs font-medium ${done ? 'text-[var(--neutral-11)] line-through' : (active ? 'text-[var(--accent-11)]' : 'text-[var(--neutral-12)]')}`}>
          {text}
        </div>
      </div>
      {onClick && !done && (
        <ChevronRight className="w-3 h-3 text-[var(--neutral-11)]" />
      )}
    </div>
  );
}