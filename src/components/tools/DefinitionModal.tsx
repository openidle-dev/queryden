import { useState, useEffect } from "react";
import { Code2, Copy, CheckCircle, XCircle } from "lucide-react";
import "../editor/monacoSetup";
import Editor from "@monaco-editor/react";
import { useConnections } from "../../contexts/useConnections";
import { useTheme } from "../../contexts/ThemeContext";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";

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

  return (
    <Dialog open={isOpen} onClose={onClose} className="max-w-4xl h-[70vh]">
      <Dialog.Title onClose={onClose}>
        <span className="flex items-center gap-3 flex-1">
          <span className="p-1.5 bg-[var(--accent-3)] rounded">
            <Code2 className="w-4 h-4 text-[var(--accent-11)]" />
          </span>
          <span className="flex flex-col leading-tight">
            <span>{tableName}</span>
            <span className="text-[10px] font-normal text-[var(--neutral-11)] uppercase">Schema definition</span>
          </span>
        </span>
        {!loading && ddl && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopy}
            leftIcon={<Copy className="w-3.5 h-3.5" />}
            className="mr-1"
          >
            Copy DDL
          </Button>
        )}
      </Dialog.Title>

      <div className="flex-1 min-h-0 relative">
        {loading ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center opacity-50">
            <div className="w-8 h-8 rounded-full border-2 border-[var(--accent-9)] border-t-transparent animate-spin mb-4" />
            <p className="text-sm font-mono tracking-widest text-[var(--accent-11)]">DECODING SCHEMA…</p>
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

      {copyStatus === "copied" && (
        <div className="fixed bottom-10 right-10 bg-[var(--success-9)] text-white px-4 py-2 rounded-md shadow-xl text-xs font-bold flex items-center gap-2 z-[300]">
          <CheckCircle className="w-4 h-4" /> Copied successfully
        </div>
      )}
      {copyStatus === "failed" && (
        <div className="fixed bottom-10 right-10 bg-[var(--danger-9)] text-white px-4 py-2 rounded-md shadow-xl text-xs font-bold flex items-center gap-2 z-[300]">
          <XCircle className="w-4 h-4" /> Failed to copy
        </div>
      )}
    </Dialog>
  );
}
