import { X, Search } from "lucide-react";
import { useState } from "react";

interface PsqlCommand {
  command: string;
  description: string;
  category: string;
}

const PSQL_COMMANDS: PsqlCommand[] = [
  { command: "\\d", description: "List tables, views, and sequences", category: "General" },
  { command: "\\dt", description: "List tables", category: "General" },
  { command: "\\dv", description: "List views", category: "General" },
  { command: "\\di", description: "List indexes", category: "General" },
  { command: "\\df", description: "List functions", category: "General" },
  { command: "\\dn", description: "List schemas", category: "General" },
  { command: "\\du", description: "List roles/users", category: "General" },
  { command: "\\l", description: "List databases", category: "General" },
  { command: "\\c dbname", description: "Connect to a new database", category: "Connection" },
  { command: "\\conninfo", description: "Show info about current connection", category: "Connection" },
  { command: "\\d name", description: "Describe table, view, or index", category: "Detailed" },
  { command: "\\d+ name", description: "Describe table etc. with more detail", category: "Detailed" },
  { command: "\\dp", description: "List table, view, and sequence access privileges", category: "Privileges" },
  { command: "\\z", description: "Same as \\dp", category: "Privileges" },
  { command: "\\watch [sec]", description: "Execute query every [sec] seconds", category: "Utility" },
  { command: "\\timing", description: "Toggle visualization of query execution time", category: "Utility" },
  { command: "\\?", description: "Help on psql meta-commands", category: "Helper" },
  { command: "\\h", description: "Help on SQL commands (e.g. \\h SELECT)", category: "Helper" },
];

interface PsqlHelpDialogProps {
  onClose: () => void;
  onSelectCommand: (cmd: string) => void;
}

export function PsqlHelpDialog({ onClose, onSelectCommand }: PsqlHelpDialogProps) {
  const [search, setSearch] = useState("");

  const filteredCommands = PSQL_COMMANDS.filter(c => 
    c.command.toLowerCase().includes(search.toLowerCase()) || 
    c.description.toLowerCase().includes(search.toLowerCase()) ||
    c.category.toLowerCase().includes(search.toLowerCase())
  );

  const categories = Array.from(new Set(PSQL_COMMANDS.map(c => c.category)));

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-[2px] p-4 animate-in fade-in duration-200">
      <div className="bg-[#1c2128] border border-[#30363d] rounded-xl shadow-2xl w-full max-w-md max-h-[70vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#30363d] bg-[#22272e]">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 bg-blue-500/10 rounded-md">
              <code className="text-blue-400 font-bold text-base">\?</code>
            </div>
            <div>
              <h3 className="text-sm font-bold text-gray-100 uppercase tracking-tight">psql Meta-commands</h3>
              <p className="text-[10px] text-gray-500">PostgreSQL CLI shortcuts</p>
            </div>
          </div>
          <button 
            onClick={onClose}
            className="p-1.5 hover:bg-[#2d333b] rounded-full text-gray-500 hover:text-gray-300 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-2.5 border-b border-[#30363d] bg-[#1c2128]">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500" />
            <input 
              type="text"
              placeholder="Filter commands..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-[#0d1117] border border-[#30363d] rounded-md py-1.5 pl-9 pr-3 text-[13px] text-gray-200 focus:outline-none focus:border-blue-500/50 transition-all placeholder-gray-600"
              autoFocus
            />
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-1.5 custom-scrollbar" style={{ 
          scrollbarWidth: 'thin',
          scrollbarColor: '#444c56 transparent'
        }}>
          <style>{`
            .custom-scrollbar::-webkit-scrollbar {
              width: 6px;
            }
            .custom-scrollbar::-webkit-scrollbar-track {
              background: transparent;
            }
            .custom-scrollbar::-webkit-scrollbar-thumb {
              background-color: #444c56;
              border-radius: 20px;
              border: 1px solid transparent;
            }
            .custom-scrollbar::-webkit-scrollbar-thumb:hover {
              background-color: #57606a;
            }
          `}</style>
          {filteredCommands.length > 0 ? (
            categories.map(category => {
              const categoryCmds = filteredCommands.filter(c => c.category === category);
              if (categoryCmds.length === 0) return null;
              
              return (
                <div key={category} className="mb-2 last:mb-0">
                  <h4 className="px-2 py-1 text-[9px] font-bold uppercase tracking-widest text-gray-500/70">{category}</h4>
                  <div className="grid grid-cols-1 gap-0.5">
                    {categoryCmds.map((c) => (
                      <button
                        key={c.command}
                        onClick={() => {
                          onSelectCommand(c.command);
                          onClose();
                        }}
                        className="flex items-center gap-3 px-2 py-1.5 rounded-md hover:bg-[#2d333b] text-left group transition-all border border-transparent hover:border-[#444c56]/30"
                      >
                        <code className="text-emerald-400 font-bold text-[12px] min-w-[70px] bg-[#1a2027] px-1.5 py-0.5 rounded border border-[#30363d] group-hover:border-emerald-500/30 transition-colors">
                          {c.command}
                        </code>
                        <span className="text-[12px] text-gray-400 group-hover:text-gray-200 transition-colors flex-1 truncate">{c.description}</span>
                        <div className="opacity-0 group-hover:opacity-100 transition-opacity">
                          <span className="text-[9px] bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded font-bold uppercase tracking-tighter">Use</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="flex flex-col items-center justify-center py-8 text-gray-500">
              <Search className="w-8 h-8 mb-2 opacity-10" />
              <p className="text-[12px]">No matches</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-[#30363d] bg-[#22272e] flex justify-between items-center">
          <p className="text-[10px] text-gray-600">
            Click to auto-fill
          </p>
          <button 
            onClick={onClose}
            className="px-3 py-1 bg-[#2d333b] hover:bg-[#444c56] text-gray-300 text-[11px] font-medium rounded-md transition-colors border border-[#30363d]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
