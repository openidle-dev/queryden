import { useState, useMemo } from "react";
import { X, Clock, RotateCcw, Search, FileText, Trash2, ChevronRight, ChevronDown, FolderOpen } from "lucide-react";
import { useLocalHistory, LocalHistoryEntry } from "../../store/localHistoryStore";

interface LocalHistoryDialogProps {
  isOpen: boolean;
  onClose: () => void;
  filePath?: string;
  dirPath?: string;
  onRevert?: (content: string) => void;
}

function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  return date.toLocaleDateString() + " " + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatRelative(ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (seconds < 60) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function computeDiff(prev: string, next: string): { added: number[]; removed: number[]; lines: { text: string; type: 'unchanged' | 'added' | 'removed' }[] } {
  const prevLines = prev.split('\n');
  const nextLines = next.split('\n');
  const lines: { text: string; type: 'unchanged' | 'added' | 'removed' }[] = [];
  const added: number[] = [];
  const removed: number[] = [];

  const maxLen = Math.max(prevLines.length, nextLines.length);
  for (let i = 0; i < maxLen; i++) {
    const p = prevLines[i];
    const n = nextLines[i];
    if (p === n) {
      lines.push({ text: n ?? '', type: 'unchanged' });
    } else {
      if (p !== undefined) {
        lines.push({ text: p, type: 'removed' });
        removed.push(lines.length - 1);
      }
      if (n !== undefined) {
        lines.push({ text: n, type: 'added' });
        added.push(lines.length - 1);
      }
    }
  }
  return { added, removed, lines };
}

interface FileGroup {
  filePath: string;
  displayName: string;
  entries: LocalHistoryEntry[];
}

export function LocalHistoryDialog({ isOpen, onClose, filePath, dirPath, onRevert }: LocalHistoryDialogProps) {
  const entries = useLocalHistory((s) => s.entries);
  const { revertToEntry, clearHistory } = useLocalHistory();
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedEntry, setSelectedEntry] = useState<LocalHistoryEntry | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    let filtered: LocalHistoryEntry[];
    if (filePath) {
      filtered = entries.filter(e => e.filePath === filePath);
    } else if (dirPath) {
      const normalizedDir = dirPath.endsWith('/') ? dirPath : dirPath + '/';
      filtered = entries.filter(e => e.filePath.startsWith(normalizedDir) || e.filePath === dirPath);
    } else {
      filtered = [...entries];
    }
    filtered.sort((a, b) => b.timestamp - a.timestamp);

    const groupMap = new Map<string, LocalHistoryEntry[]>();
    for (const entry of filtered) {
      const key = entry.filePath;
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key)!.push(entry);
    }

    const result: FileGroup[] = [];
    for (const [fp, groupEntries] of groupMap) {
      const displayName = fp
        .replace(/^saved-queries\//, '')
        .replace(/^editor\//, '')
        .replace(/^manual\//, '');
      result.push({ filePath: fp, displayName, entries: groupEntries });
    }
    result.sort((a, b) => {
      const aTime = a.entries[0]?.timestamp || 0;
      const bTime = b.entries[0]?.timestamp || 0;
      return bTime - aTime;
    });

    // Auto-expand the first group
    if (expandedGroups.size === 0 && result.length > 0) {
      setExpandedGroups(new Set([result[0].filePath]));
    }

    return result;
  }, [entries, filePath, dirPath]);

  const filteredGroups = useMemo(() => {
    if (!searchTerm) return groups;
    const term = searchTerm.toLowerCase();
    return groups
      .map(g => ({
        ...g,
        entries: g.entries.filter(e =>
          e.content.toLowerCase().includes(term) ||
          e.label?.toLowerCase().includes(term) ||
          e.filePath.toLowerCase().includes(term)
        ),
      }))
      .filter(g => g.entries.length > 0);
  }, [groups, searchTerm]);

  const previousEntry = useMemo(() => {
    if (!selectedEntry) return null;
    const group = filteredGroups.find(g => g.filePath === selectedEntry.filePath);
    if (!group) return null;
    const idx = group.entries.findIndex(e => e.timestamp === selectedEntry.timestamp);
    return idx < group.entries.length - 1 ? group.entries[idx + 1] : null;
  }, [selectedEntry, filteredGroups]);

  const diffResult = useMemo(() => {
    if (!showDiff || !selectedEntry || !previousEntry) return null;
    return computeDiff(previousEntry.content, selectedEntry.content);
  }, [showDiff, selectedEntry, previousEntry]);

  const handleRevert = async (entry: LocalHistoryEntry) => {
    const content = await revertToEntry(entry.filePath, entry.timestamp);
    if (content && onRevert) {
      onRevert(content);
      onClose();
    }
  };

  const toggleGroup = (filePath: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  if (!isOpen) return null;

  const totalRevisions = filteredGroups.reduce((sum, g) => sum + g.entries.length, 0);

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-[var(--surface)] rounded-lg shadow-xl w-[900px] h-[650px] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="h-12 px-4 flex items-center justify-between border-b border-[var(--border)]">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-[var(--color-accent)]" />
            <h3 className="text-sm font-semibold">Local History</h3>
            <span className="text-[10px] text-[var(--text-secondary)] bg-[var(--background)] px-1.5 py-0.5 rounded-full">
              {totalRevisions} revision{totalRevisions !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={async () => { await clearHistory(); setSelectedEntry(null); }}
              className="p-1 rounded hover:bg-rose-500/20 text-rose-400 hover:text-rose-300"
              title="Clear all history"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
            <button onClick={onClose} className="p-1 rounded hover:bg-[var(--border)]">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="px-4 py-2 border-b border-[var(--border)]">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-secondary)]" />
            <input
              type="text"
              placeholder="Search revisions..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-7 pr-2 py-1.5 text-xs rounded bg-[var(--background)] border border-[var(--border)] outline-none focus:border-[var(--color-accent)]"
            />
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left: File groups + revisions */}
          <div className="w-72 border-r border-[var(--border)] flex flex-col">
            <div className="flex-1 overflow-y-auto custom-scrollbar">
              {filteredGroups.length === 0 ? (
                <div className="p-6 text-center text-xs text-[var(--text-secondary)]">
                  <Clock className="w-8 h-8 opacity-20 mx-auto mb-2" />
                  <p className="font-medium mb-1">No history entries found</p>
                  <p className="text-[10px] opacity-60">History is recorded when you run or save queries.</p>
                </div>
              ) : (
                filteredGroups.map(group => {
                  const isExpanded = expandedGroups.has(group.filePath);
                  const latestEntry = group.entries[0];
                  return (
                    <div key={group.filePath}>
                      <button
                        onClick={() => toggleGroup(group.filePath)}
                        className={`w-full text-left px-3 py-2 border-b border-[var(--border)] hover:bg-[var(--surface-raised)] transition-colors flex items-center gap-2 ${
                          selectedEntry?.filePath === group.filePath ? 'bg-[var(--color-accent)]/5' : ''
                        }`}
                      >
                        {isExpanded ? <ChevronDown className="w-3 h-3 text-[var(--text-secondary)] shrink-0" /> : <ChevronRight className="w-3 h-3 text-[var(--text-secondary)] shrink-0" />}
                        <FileText className="w-3.5 h-3.5 text-[var(--color-accent)] shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-medium truncate">{group.displayName}</div>
                          <div className="text-[9px] text-[var(--text-secondary)]">
                            {group.entries.length} revision{group.entries.length !== 1 ? 's' : ''} • {formatRelative(latestEntry.timestamp)}
                          </div>
                        </div>
                      </button>
                      {isExpanded && group.entries.map((entry, index) => (
                        <button
                          key={`${entry.filePath}-${entry.timestamp}`}
                          onClick={() => setSelectedEntry(entry)}
                          className={`w-full text-left px-3 py-1.5 pl-8 border-b border-[var(--border)]/50 hover:bg-[var(--surface-raised)] transition-colors ${
                            selectedEntry?.timestamp === entry.timestamp && selectedEntry?.filePath === entry.filePath ? 'bg-[var(--color-accent)]/10 border-l-2 border-l-[var(--color-accent)]' : ''
                          }`}
                        >
                          <div className="text-[11px] truncate">
                            {entry.label || `Revision ${group.entries.length - index}`}
                          </div>
                          <div className="text-[9px] text-[var(--text-secondary)]">
                            {formatRelative(entry.timestamp)}
                          </div>
                        </button>
                      ))}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Right: Preview */}
          <div className="flex-1 flex flex-col">
            {selectedEntry ? (
              <>
                <div className="px-4 py-2 border-b border-[var(--border)] flex items-center justify-between">
                  <div className="text-xs text-[var(--text-secondary)] flex items-center gap-2 flex-1 min-w-0">
                    <span className="font-medium text-[var(--text-primary)] truncate">{selectedEntry.label || 'Revision'}</span>
                    <span className="shrink-0">• {formatTimestamp(selectedEntry.timestamp)}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {previousEntry && (
                      <button
                        onClick={() => setShowDiff(!showDiff)}
                        className={`text-[10px] px-2 py-1 rounded border transition-colors ${
                          showDiff
                            ? 'bg-[var(--color-accent)] text-white border-[var(--color-accent)]'
                            : 'border-[var(--border)] hover:bg-[var(--border)]'
                        }`}
                      >
                        {showDiff ? "Content" : "Diff"}
                      </button>
                    )}
                    {onRevert && (
                      <button
                        onClick={() => handleRevert(selectedEntry)}
                        className="text-[10px] px-2 py-1 rounded bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] flex items-center gap-1 transition-colors"
                      >
                        <RotateCcw className="w-3 h-3" />
                        Revert
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex-1 overflow-auto">
                  {showDiff && diffResult ? (
                    <div className="p-4">
                      <div className="text-[10px] text-[var(--text-secondary)] mb-2 flex items-center gap-3">
                        <span className="text-red-400">- removed ({diffResult.removed.length} lines)</span>
                        <span className="text-green-400">+ added ({diffResult.added.length} lines)</span>
                      </div>
                      <pre className="text-xs font-mono leading-relaxed">
                        {diffResult.lines.map((line, i) => (
                          <div key={i} className={`${
                            line.type === 'added' ? 'bg-green-500/15 text-green-300' :
                            line.type === 'removed' ? 'bg-red-500/15 text-red-300' :
                            'text-[var(--text-primary)]'
                          }`}>
                            <span className="inline-block w-5 text-right mr-2 opacity-40 select-none text-[10px]">
                              {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                            </span>
                            {line.text}
                          </div>
                        ))}
                      </pre>
                    </div>
                  ) : (
                    <pre className="p-4 text-xs font-mono whitespace-pre-wrap text-[var(--text-primary)] leading-relaxed">
                      {selectedEntry.content}
                    </pre>
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">
                <div className="text-center">
                  <FolderOpen className="w-12 h-12 opacity-20 mx-auto mb-2" />
                  <p className="text-sm">Select a revision to preview</p>
                  <p className="text-xs opacity-50 mt-1">Expand a file group and click a revision</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-[var(--border)] flex items-center justify-between text-[10px] text-[var(--text-secondary)]">
          <span>History is stored locally and persists across sessions</span>
          {selectedEntry && (
            <span>{formatTimestamp(selectedEntry.timestamp)} • {selectedEntry.content.length} chars</span>
          )}
        </div>
      </div>
    </div>
  );
}