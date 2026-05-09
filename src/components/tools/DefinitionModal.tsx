import { useState, useEffect } from "react";
import { X, Code2, Copy, CheckCircle, XCircle } from "lucide-react";
import Editor from "@monaco-editor/react";
import { useConnections } from "../../contexts/useConnections";
import { useTheme } from "../../contexts/ThemeContext";

interface DefinitionModalProps {
  isOpen: boolean;
  tableName: string;
  onClose: () => void;
}

export function DefinitionModal({ isOpen, tableName, onClose }: DefinitionModalProps) {
  const { getDDL, activeConnection } = useConnections();
  const { theme } = useTheme();
  const [ddl, setDdl] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed" | null>(null);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(ddl || "-- No DDL found.");
      setCopyStatus("copied");
    } catch (err) {
      setCopyStatus("failed");
    }
    setTimeout(() => setCopyStatus(null), 2000);
  };

  useEffect(() => {
    if (isOpen && tableName && activeConnection) {
      setLoading(true);
      getDDL("table", tableName).then((res) => {
        setDdl(res);
        setLoading(false);
      });
    }
  }, [isOpen, tableName, activeConnection, getDDL]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-8 bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div 
        className="w-full max-w-4xl h-[70vh] bg-[var(--surface)] rounded-xl shadow-2xl flex flex-col overflow-hidden border border-[var(--border)] animate-in zoom-in-95 duration-200"
        onClick={e => e.stopPropagation()}
      >
        <div className="h-12 border-b border-[var(--border)] flex items-center justify-between px-4 bg-[var(--surface-raised)] shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-1.5 bg-[var(--color-accent)]/20 rounded">
              <Code2 className="w-4 h-4 text-[var(--color-accent)]" />
            </div>
            <div>
              <h3 className="font-bold text-sm tracking-wide">{tableName}</h3>
              <p className="text-[10px] text-[var(--text-secondary)] uppercase">Schema Definition</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!loading && ddl && (
              <button 
                onClick={handleCopy} 
                className="flex items-center gap-1.5 px-3 py-1.5 hover:bg-[var(--border)] rounded text-xs transition-colors opacity-80 hover:opacity-100 font-bold"
              >
                <Copy className="w-3.5 h-3.5" />
                Copy DDL
              </button>
            )}
            <button onClick={onClose} className="p-1.5 hover:bg-[var(--border)] rounded mr-1 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 bg-[#1e1e1e] relative">
          {loading ? (
             <div className="absolute inset-0 flex flex-col items-center justify-center opacity-50">
               <div className="w-8 h-8 rounded-full border-2 border-[var(--color-accent)] border-t-transparent animate-spin mb-4" />
               <p className="text-sm font-mono tracking-widest text-[var(--color-accent)]">DECODING SCHEMA...</p>
             </div>
          ) : (
            <Editor
              height="100%"
              language="sql"
              theme={theme === "dark" ? "vs-dark" : "vs"}
              value={ddl || `-- No DDL found or object does not exist.\n-- Make sure you include the schema name if applicable.`}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                fontSize: 13,
                fontFamily: "'JetBrains Mono', monospace",
                lineNumbers: "on",
                scrollBeyondLastLine: false,
                automaticLayout: true,
                padding: { top: 16 }
              }}
            />
          )}
        </div>
      </div>
      
      {copyStatus === "copied" && (
        <div className="fixed bottom-10 right-10 bg-green-500 text-white px-4 py-2 rounded shadow-xl text-xs font-bold animate-in fade-in slide-in-from-bottom-2 duration-200 flex items-center gap-2 z-[300]">
          <CheckCircle className="w-4 h-4" /> Copied Successfully
        </div>
      )}
      {copyStatus === "failed" && (
        <div className="fixed bottom-10 right-10 bg-rose-500 text-white px-4 py-2 rounded shadow-xl text-xs font-bold animate-in fade-in slide-in-from-bottom-2 duration-200 flex items-center gap-2 z-[300]">
          <XCircle className="w-4 h-4" /> Failed to Copy
        </div>
      )}
    </div>
  );
}
