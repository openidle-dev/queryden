import { useState, useEffect, useRef } from "react";
import {
  Bell,
  Download,
  CheckCircle,
  ArrowUpCircle,
  X,
  Loader2,
  AlertTriangle,
  ExternalLink,
  RefreshCw,
  Rocket,
  FileText,
} from "lucide-react";
import { releaseUrl, useUpdateStore } from "../../store/updateStore";
import ReactMarkdown from "react-markdown";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";

export function UpdateNotification() {
  const {
    phase,
    update,
    currentVersion,
    downloadProgress,
    totalBytes,
    error,
    dismissed,
    checkForUpdates,
    downloadUpdate,
    installUpdate,
    dismiss,
    reset,
    fetchBuildDate,
  } = useUpdateStore();

  const [showPanel, setShowPanel] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Auto-check on mount (silent background check)
  useEffect(() => {
    fetchBuildDate();
    // Check after a short delay so the app loads first
    const timer = setTimeout(() => {
      checkForUpdates();
    }, 5000);
    return () => clearTimeout(timer);
  }, []);

  // Close panel on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setShowPanel(false);
      }
    }
    if (showPanel) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showPanel]);

  // A single, stable "you have unread" dot — same pattern as VS Code /
  // Slack / GitHub. We don't swap the icon shape based on state (was a
  // BellDot swap previously) because the icon flip reads as a glitch
  // rather than a status change. See #115.
  const showDot =
    (phase === "available" && !dismissed) ||
    phase === "downloading" ||
    phase === "ready";

  const handleBellClick = () => {
    setShowPanel(!showPanel);
  };

  return (
    <div className="relative" ref={panelRef}>
      {/* Bell Icon Button */}
      <button
        onClick={handleBellClick}
        className={`relative flex items-center gap-2 px-3 py-1.5 rounded text-sm transition-all group ${
          showPanel
            ? "bg-[var(--accent-9)]/20 text-[var(--accent-9)]"
            : "hover:bg-[var(--neutral-6)]"
        }`}
        title={
          phase === "available"
            ? "Update available!"
            : phase === "ready"
            ? "Update ready to install"
            : "Check for updates"
        }
      >
        <Bell className="w-4 h-4 group-hover:text-[var(--accent-9)]" />

        {/* Static unread-style dot. No animation, no icon swap; the dot is
            the only visual change between states. Sized + positioned to
            sit inside the icon's top-right rather than floating outside
            the button's padding. */}
        {showDot && (
          <span className="absolute top-1 right-2 block w-1.5 h-1.5 rounded-full bg-[var(--accent-9)] ring-2 ring-[var(--surface-elevated)]" />
        )}
      </button>

      {/* Dropdown Panel */}
      {showPanel && (
        <div className="absolute right-0 top-full mt-2 w-[420px] bg-[var(--surface-elevated)] border border-[var(--neutral-6)] rounded-xl shadow-2xl z-[200] animate-in fade-in slide-in-from-top-2 duration-200 overflow-hidden">
          {/* Header */}
          <div className="p-4 border-b border-[var(--neutral-6)] bg-[var(--surface-elevated)] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ArrowUpCircle className="w-4 h-4 text-[var(--accent-9)]" />
              <h3 className="text-sm font-bold">Software Updates</h3>
            </div>
            <IconButton icon={<X />} label="Close" size="sm" variant="ghost" onClick={() => setShowPanel(false)} />
          </div>

          {/* Content */}
          <div className="max-h-[500px] overflow-y-auto custom-scrollbar">
            {/* Checking state */}
            {phase === "checking" && (
              <div className="p-8 text-center">
                <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3 text-[var(--accent-11)]" />
                <p className="text-sm font-medium">Checking for updates…</p>
                <p className="text-xs text-[var(--neutral-11)] mt-1">Contacting GitHub</p>
              </div>
            )}

            {/* Up to date */}
            {phase === "up-to-date" && currentVersion && (
              <div className="p-8 text-center">
                <div className="w-14 h-14 bg-[var(--success-3)] rounded-full flex items-center justify-center mx-auto mb-4">
                  <CheckCircle className="w-7 h-7 text-[var(--success-11)]" />
                </div>
                <h4 className="text-base font-bold mb-1">You're up to date!</h4>
                <p className="text-xs text-[var(--neutral-11)]">
                  QueryDen v{currentVersion} is the latest version.
                </p>
                <Button variant="secondary" size="sm" onClick={checkForUpdates} className="mt-4 mx-auto" leftIcon={<RefreshCw className="w-3 h-3" />}>
                  Check again
                </Button>
              </div>
            )}

            {/* Update available */}
            {phase === "available" && update && (
              <div className="p-5 space-y-4">
                {/* Version badge */}
                <div className="flex items-center gap-3 p-4 bg-[var(--warning-3)] border border-[var(--warning-6)] rounded-xl">
                  <div className="w-10 h-10 bg-[var(--warning-3)] rounded-full flex items-center justify-center shrink-0">
                    <Rocket className="w-5 h-5 text-[var(--warning-11)]" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--warning-11)] mb-0.5">
                      New Version Available
                    </div>
                    <div className="text-sm font-bold">
                      v{update.version}
                    </div>
                    <div className="text-[10px] text-[var(--neutral-11)] mt-0.5">
                      v{update.currentVersion} → v{update.version}
                      {update.date && (
                        <> · {new Date(update.date).toLocaleDateString()}</>
                      )}
                    </div>
                  </div>
                </div>

                {/* Changelog */}
                {update.body && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-[var(--neutral-11)] opacity-60">
                      <FileText className="w-3 h-3" /> What's New
                    </div>
                    <div className="p-4 bg-[var(--surface-base)] rounded-xl border border-[var(--neutral-6)] max-h-[200px] overflow-y-auto custom-scrollbar">
                      <div className="prose-sm text-xs text-[var(--neutral-11)] leading-relaxed [&_h1]:text-base [&_h1]:font-bold [&_h1]:text-[var(--neutral-12)] [&_h1]:mb-2 [&_h2]:text-sm [&_h2]:font-bold [&_h2]:text-[var(--neutral-12)] [&_h2]:mb-2 [&_h3]:text-xs [&_h3]:font-bold [&_h3]:text-[var(--neutral-12)] [&_h3]:mb-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ul]:space-y-1 [&_li]:text-xs [&_p]:mb-2 [&_code]:bg-[var(--neutral-4)] [&_code]:px-1 [&_code]:rounded [&_code]:text-[var(--accent-11)] [&_a]:text-[var(--accent-11)] [&_a]:underline">
                        <ReactMarkdown>{update.body}</ReactMarkdown>
                      </div>
                    </div>
                  </div>
                )}

                {/* Download button + release-page escape hatch */}
                <div className="flex items-center gap-2">
                  <Button variant="primary" onClick={downloadUpdate} className="flex-1 font-bold shadow-lg" leftIcon={<Download className="w-4 h-4" />}>
                    Download Update
                  </Button>
                  <a
                    href={releaseUrl(update.version)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-2.5 bg-[var(--neutral-4)] hover:bg-[var(--neutral-5)] rounded-md transition-colors"
                    title="View release on GitHub"
                  >
                    <ExternalLink className="w-4 h-4 opacity-70" />
                  </a>
                  <Button variant="secondary" onClick={() => { dismiss(); setShowPanel(false); }} title="Dismiss">
                    Later
                  </Button>
                </div>
              </div>
            )}

            {/* Downloading */}
            {phase === "downloading" && (
              <div className="p-8 text-center">
                <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3 text-[var(--accent-11)]" />
                <h4 className="text-sm font-bold mb-1">Downloading update…</h4>
                <p className="text-xs text-[var(--neutral-11)]">
                  {totalBytes
                    ? `${Math.round(downloadProgress)}% of ${formatSize(totalBytes)}`
                    : "Connecting…"}
                </p>
                <div className="mt-4 h-1.5 bg-[var(--neutral-6)] rounded-full overflow-hidden w-48 mx-auto">
                  <div
                    className="h-full bg-[var(--accent-9)] rounded-full transition-all duration-150"
                    style={{ width: `${downloadProgress}%` }}
                  />
                </div>
              </div>
            )}

            {/* Ready to install */}
            {phase === "ready" && update && (
              <div className="p-5 space-y-4">
                <div className="flex items-center gap-3 p-4 bg-[var(--success-3)] border border-[var(--success-6)] rounded-xl">
                  <div className="w-10 h-10 bg-[var(--success-3)] rounded-full flex items-center justify-center shrink-0">
                    <CheckCircle className="w-5 h-5 text-[var(--success-11)]" />
                  </div>
                  <div className="flex-1">
                    <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--success-11)] mb-0.5">
                      Download Complete
                    </div>
                    <div className="text-sm font-bold">Ready to Install</div>
                    <div className="text-[10px] text-[var(--neutral-11)] mt-0.5">
                      QueryDen v{update.version}
                    </div>
                  </div>
                </div>

                <Button
                  variant="primary"
                  onClick={installUpdate}
                  leftIcon={<Rocket className="w-4 h-4" />}
                  className="w-full py-3 h-auto font-bold shadow-lg bg-[var(--success-9)] hover:bg-[var(--success-10)]"
                >
                  Install & Restart
                </Button>
                <p className="text-[10px] text-center text-[var(--neutral-11)] opacity-60">
                  QueryDen will close and relaunch after the update.
                </p>
              </div>
            )}

            {/* Installing */}
            {phase === "installing" && (
              <div className="p-8 text-center">
                <Loader2 className="w-8 h-8 animate-spin mx-auto mb-3 text-[var(--success-11)]" />
                <h4 className="text-sm font-bold mb-1">Installing update…</h4>
                <p className="text-xs text-[var(--neutral-11)]">
                  The app will restart momentarily.
                </p>
              </div>
            )}

            {/* Error */}
            {phase === "error" && (
              <div className="p-5 space-y-3">
                <div className="flex items-start gap-3 p-4 bg-[var(--danger-3)] border border-[var(--danger-6)] rounded-xl">
                  <AlertTriangle className="w-5 h-5 text-[var(--danger-11)] shrink-0 mt-0.5" />
                  <div>
                    <div className="text-sm font-bold text-[var(--danger-11)] mb-1">Update Error</div>
                    <div className="text-xs text-[var(--neutral-11)] break-words">
                      {error || "An unknown error occurred"}
                    </div>
                  </div>
                </div>
                <Button variant="secondary" onClick={() => { reset(); checkForUpdates(); }} className="w-full" leftIcon={<RefreshCw className="w-3.5 h-3.5" />}>
                  Try Again
                </Button>
              </div>
            )}

            {/* Idle / not checked yet */}
            {phase === "idle" && (
              <div className="p-8 text-center">
                <Bell className="w-8 h-8 mx-auto mb-3 opacity-30" />
                <p className="text-sm font-medium opacity-50">No update information</p>
                <Button variant="primary" size="sm" onClick={checkForUpdates} className="mt-4 mx-auto font-bold" leftIcon={<RefreshCw className="w-3 h-3" />}>
                  Check for Updates
                </Button>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="p-3 border-t border-[var(--neutral-6)] bg-[var(--surface-elevated)] flex items-center justify-between text-[10px] text-[var(--neutral-11)]">
            <span>
              {currentVersion && (
                <>Current: v{currentVersion}</>
              )}
            </span>
            <a
              href="https://github.com/openidle-dev/queryden/releases"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 hover:text-white transition-colors"
            >
              All Releases <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
