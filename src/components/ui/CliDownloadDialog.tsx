import { useState } from "react";
import { Download, X, Terminal, AlertCircle } from "lucide-react";
import { useCliStore } from "../../store/cliStore";

interface CliDownloadDialogProps {
  isOpen: boolean;
  toolKind: string;
  toolName: string;
  onSuccess: (path: string) => void;
  onClose: () => void;
}

export function CliDownloadDialog({
  isOpen,
  toolKind,
  toolName,
  onSuccess,
  onClose,
}: CliDownloadDialogProps) {
  const { ensureTool, getVersion } = useCliStore();
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleDownload = async () => {
    setIsDownloading(true);
    setError(null);
    try {
      const path = await ensureTool(toolKind);
      const ver = await getVersion(toolKind).catch(() => null);
      setVersion(ver);
      onSuccess(path);
    } catch (e: any) {
      setError(e.toString());
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] bg-black/60 flex items-center justify-center p-4 backdrop-blur-sm">
      <div className="bg-[var(--surface)] rounded-lg shadow-2xl w-full max-w-md border border-[var(--color-accent)]">
        {/* Header */}
        <div className="p-4 border-b border-[var(--border)] flex items-center gap-3">
          <Download className="w-5 h-5 text-[var(--color-accent)]" />
          <h2 className="text-sm font-semibold flex-1 text-[var(--text-primary)]">
            Download CLI Tool
          </h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-[var(--border)] rounded transition-colors text-[var(--text-secondary)]"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded bg-[var(--color-accent)]/20 flex items-center justify-center">
              <Terminal className="w-5 h-5 text-[var(--color-accent)]" />
            </div>
            <div>
              <p className="text-sm font-medium text-[var(--text-primary)]">
                {toolName} CLI not found
              </p>
              <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                This connection type requires the <code className="font-mono text-[var(--color-accent)]">{toolKind}</code> command-line tool.
              </p>
            </div>
          </div>

          <div className="bg-[var(--background)] rounded p-3 text-xs space-y-1">
            <div className="font-medium text-[var(--text-primary)] flex items-center gap-1.5">
              <AlertCircle className="w-3.5 h-3.5 text-[var(--color-warning)]" />
              What happens next:
            </div>
            <div className="text-[var(--text-secondary)] space-y-1 mt-1.5">
              <p>1. The CLI binary will be downloaded from the official source</p>
              <p>2. It will be cached locally in your app data folder</p>
              <p>3. Future connections to this type will use the cached version</p>
            </div>
          </div>

          {error && (
            <div className="text-xs text-[var(--color-error)] bg-[var(--color-error)]/10 border border-[var(--color-error)]/20 rounded p-2 whitespace-pre-wrap">
              {error}
            </div>
          )}

          {version && (
            <div className="text-xs text-[var(--color-success)] bg-[var(--color-success)]/10 border border-[var(--color-success)]/20 rounded p-2">
              Downloaded! Version: {version}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-[var(--border)] flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs rounded hover:bg-[var(--surface-hover)] text-[var(--text-secondary)]"
          >
            Cancel
          </button>
          <button
            onClick={handleDownload}
            disabled={isDownloading}
            className="px-4 py-2 text-xs rounded bg-[var(--color-accent)] hover:opacity-80 disabled:opacity-50 text-white flex items-center gap-2"
          >
            {isDownloading ? (
              <>
                <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Downloading...
              </>
            ) : (
              <>
                <Download className="w-3.5 h-3.5" />
                Download & Install
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
