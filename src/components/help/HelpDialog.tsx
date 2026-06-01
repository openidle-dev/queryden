import React, { useState, useEffect, useMemo } from "react";
import { X, Info, BookOpen, Terminal, Cpu, HardDrive, Github, Bug, Send, CheckCircle, Paperclip, FileText, Shield } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useConnections } from "../../contexts/useConnections";
import { invokeCmd, SystemInfoDto } from "../../lib/ipc";
import { logger } from "../../utils/logger";
import { useAppInfo } from "../../hooks/useAppInfo";
import { useUpdateStore } from "../../store/updateStore";
import { useSettings } from "../../store/settingsStore";
import { parseChangelog } from "../../utils/parseChangelog";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Input } from "../ui/Input";
// Bundled CHANGELOG.md from the repo root via Vite's `?raw` loader. Locked to
// the build's installed version — newer versions land via auto-update.
import changelogRaw from "../../../CHANGELOG.md?raw";

interface HelpDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

type HelpTab = "about" | "changelog" | "report";

type SystemInfo = SystemInfoDto;


export function HelpDialog({ isOpen, onClose }: HelpDialogProps) {
  const [activeTab, setActiveTab] = useState<HelpTab>("about");
  const { activeConnection } = useConnections();
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null);
  const [keyringStatus, setKeyringStatus] = useState<string>("Detecting...");
  const { name: appName, version: appVersion } = useAppInfo();
  const { buildDate, fetchBuildDate } = useUpdateStore();
  const updateChannel = useSettings((s) => s.updateChannel ?? "stable");

  useEffect(() => {
    if (isOpen) {
      fetchSystemInfo();
      fetchBuildDate();
      fetchKeyringStatus();
    }
  }, [isOpen]);

  const fetchSystemInfo = async () => {
    try {
      const info = await invokeCmd("get_system_info");
      setSysInfo(info);
    } catch (err) {
      logger.error("Failed to fetch system info:", err);
    }
  };

  const fetchKeyringStatus = async () => {
    try {
      const result = await invokeCmd("get_master_key_storage_status");
      switch (result.status) {
        case "keyring":
          setKeyringStatus("OS Keyring");
          break;
        case "file_fallback":
          setKeyringStatus("Local file (fallback)");
          break;
        case "unavailable":
          setKeyringStatus("Unavailable");
          break;
      }
    } catch (err) {
      logger.error("Failed to fetch keyring status:", err);
      setKeyringStatus("Unknown");
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[150] bg-black/60 flex items-center justify-center p-8 backdrop-blur-sm animate-in fade-in duration-300">
      <div className="bg-[var(--surface-elevated)] w-full max-w-4xl h-[660px] rounded-lg shadow-2xl flex overflow-hidden border border-[var(--neutral-6)] animate-in zoom-in-95 duration-200">

        {/* Sidebar */}
        <div className="w-64 border-r border-[var(--neutral-6)] bg-[var(--surface-panel)] flex flex-col font-sans">
          <div className="h-12 px-4 border-b border-[var(--neutral-6)] flex items-center gap-2 shrink-0">
            <img src="/img/icon.png" alt={appName} className="w-5 h-5 rounded-md" />
            <h2 className="font-semibold text-sm tracking-tight">{appName}</h2>
          </div>

          <nav className="p-3 space-y-1">
            <TabButton
              active={activeTab === "about"}
              onClick={() => setActiveTab("about")}
              icon={<Info className="w-4 h-4" />}
              label="About"
            />
            <TabButton
              active={activeTab === "changelog"}
              onClick={() => setActiveTab("changelog")}
              icon={<FileText className="w-4 h-4" />}
              label="What's New"
            />
            <TabButton
              active={activeTab === "report"}
              onClick={() => setActiveTab("report")}
              icon={<Bug className="w-4 h-4" />}
              label="Log New Issue"
            />
          </nav>

          <div className="mt-auto p-4 border-t border-[var(--neutral-6)]">
            <div className="flex items-center justify-between text-[10px] uppercase font-bold text-[var(--neutral-11)] opacity-70 tracking-widest mb-3">
              <span>Community</span>
            </div>
            <div className="space-y-3">
              <a href="https://github.com/openidle-dev/queryden" target="_blank" className="flex items-center gap-2 text-xs font-medium text-[var(--neutral-11)] hover:text-[var(--neutral-12)] transition-colors">
                <Github className="w-4 h-4" /> GitHub Repository
              </a>
            </div>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 flex flex-col min-w-0 bg-[var(--surface-base)] font-sans">
          <div className="h-12 px-4 border-b border-[var(--neutral-6)] flex items-center justify-between bg-[var(--surface-elevated)]">
            <h3 className="font-semibold text-sm">
              {activeTab === "about" && "Application Info"}
              {activeTab === "changelog" && "What's New"}
              {activeTab === "report" && "Report an Issue"}
            </h3>
            <IconButton icon={<X />} label="Close" size="sm" variant="ghost" onClick={onClose} />
          </div>

          <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
            {activeTab === "about" && (
              <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="flex items-start gap-6 p-6 bg-[var(--surface-panel)] rounded-lg border border-[var(--neutral-6)] shadow-sm">
                  <img src="/img/icon.png" alt={appName} className="w-20 h-20 rounded-2xl" />
                   <div className="flex-1">
                      <h1 className="text-2xl font-black mb-1">{appName} <span className="text-[var(--accent-11)] text-sm">v{appVersion}</span></h1>
                      <p className="text-sm text-[var(--neutral-11)] leading-relaxed mb-4">
                        A premium database management environment built for the modern SQL expert. 
                        Engineered for speed, performance, and accessibility.
                      </p>
                      <div className="flex gap-4 text-xs font-bold">
                        <Button
                          variant="primary"
                          size="sm"
                          leftIcon={<BookOpen className="w-3 h-3" />}
                          onClick={async () => {
                            const url = "https://queryden.openidle.com/docs";
                            try {
                              const { openUrl } = await import("@tauri-apps/plugin-opener");
                              await openUrl(url);
                            } catch (err) {
                              console.error("openUrl failed, trying WebviewWindow:", err);
                              try {
                                const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
                                new WebviewWindow("docs", {
                                  url,
                                  title: `${appName} Documentation Guide`,
                                  width: 1100,
                                  height: 800,
                                  resizable: true,
                                  center: true
                                });
                              } catch (winErr) {
                                console.error("WebviewWindow also failed:", winErr);
                                window.open(url, "_blank", "noopener,noreferrer");
                              }
                            }
                          }}
                        >
                          View Documentation Guide
                        </Button>
                      </div>
                   </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <InfoCard title="Version" value={`v${appVersion}`} icon={<Terminal className="w-4 h-4" />} />
                  <InfoCard title="Build" value={buildDate || 'Loading…'} icon={<Terminal className="w-4 h-4" />} />
                  <InfoCard title="Channel" value={updateChannel === "beta" ? "Beta" : "Stable"} icon={<Terminal className="w-4 h-4" />} />
                  <InfoCard title="Platform" value={sysInfo?.os_name?.toString() || "Detecting..."} icon={<HardDrive className="w-4 h-4" />} />
                  <InfoCard title="CPU" value={sysInfo?.cpu_model?.toString() || "Detecting..."} icon={<Cpu className="w-4 h-4" />} />
                  <InfoCard title="Master Key" value={keyringStatus} icon={<Shield className="w-4 h-4" />} />
                </div>

                {keyringStatus === "Unavailable" && (
                  <div className="mt-4 p-3 bg-[var(--danger-3)] border border-[var(--danger-7)] rounded-lg text-xs leading-relaxed text-[var(--danger-11)]">
                    <strong>Master key unavailable.</strong> The encryption key could not be found in the OS keyring or on disk. Encrypted data may be unrecoverable. Try restarting the application or checking your app data directory.
                  </div>
                )}
              </div>
            )}

            {activeTab === "changelog" && (
              <ChangelogPanel installedVersion={appVersion} />
            )}

            {activeTab === "report" && (
              <IssueReporter
                appVersion={appVersion}
                buildDate={buildDate}
                updateChannel={updateChannel}
                sysInfo={sysInfo}
                activeConnection={activeConnection}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Changelog Panel ────────────────────────────────────────────────
//
// Renders the bundled CHANGELOG.md (Keep-a-Changelog format) as a list of
// version blocks, newest first. Version sections are parsed once and memoized.
// "Current" badge marks the version the user is running, so they can spot
// what they're on at a glance. See #144.

function ChangelogPanel({ installedVersion }: { installedVersion: string }) {
  const entries = useMemo(() => parseChangelog(changelogRaw), []);
  const prose =
    "max-w-none text-sm text-[var(--neutral-11)] leading-relaxed " +
    "[&_h2]:hidden " + // version heading rendered separately above
    "[&_h3]:text-xs [&_h3]:font-bold [&_h3]:uppercase [&_h3]:tracking-widest [&_h3]:opacity-60 [&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:text-[var(--neutral-12)] " +
    "[&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-2 [&_li]:text-[13px] " +
    "[&_p]:mb-3 " +
    "[&_strong]:text-[var(--neutral-12)] " +
    "[&_code]:bg-[var(--neutral-4)] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[12px] [&_code]:text-[var(--accent-11)] " +
    "[&_a]:text-[var(--accent-11)] [&_a]:underline hover:[&_a]:text-[var(--accent-10)]";

  if (entries.length === 0) {
    return (
      <div className="text-sm text-[var(--neutral-11)] italic">
        No changelog content is available.
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <p className="text-xs text-[var(--neutral-11)] opacity-70">
        Release notes for QueryDen. Newer versions arrive via auto-update — open this dialog after updating to see what changed.
      </p>
      {entries.map((entry) => {
        const isCurrent = entry.version === installedVersion;
        const isUnreleased = entry.version.toLowerCase() === "unreleased";
        return (
          <section
            key={entry.version}
            className="p-5 bg-[var(--surface-panel)] rounded-lg border border-[var(--neutral-6)]"
          >
            <header className="flex items-baseline gap-3 mb-3">
              <h2 className="text-lg font-black tracking-tight">
                {isUnreleased ? "Unreleased" : `v${entry.version}`}
              </h2>
              {entry.date && (
                <span className="text-[10px] uppercase font-bold tracking-widest text-[var(--neutral-11)] opacity-60">
                  {entry.date}
                </span>
              )}
              {isCurrent && (
                <span className="text-[10px] uppercase font-bold tracking-widest text-[var(--accent-11)] bg-[var(--accent-3)] px-2 py-0.5 rounded-full">
                  Current
                </span>
              )}
            </header>
            <div className={prose}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.body}</ReactMarkdown>
            </div>
          </section>
        );
      })}
    </div>
  );
}

// ── Issue Reporter ─────────────────────────────────────────────────

interface IssueReporterProps {
  appVersion: string;
  buildDate: string | null;
  updateChannel: "stable" | "beta";
  sysInfo: SystemInfo | null;
  activeConnection: any;
}

function IssueReporter({ appVersion, buildDate, updateChannel, sysInfo, activeConnection }: IssueReporterProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<"bug" | "enhancement" | "question">("bug");
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [useEmail, setUseEmail] = useState(false);

  const buildIssueBody = (isPlaintext = false) => {
    let body = "";
    if (description) body += isPlaintext ? `Description:\n${description}\n\n` : `## Description\n${description}\n\n`;
    body += "---\n\n";
    body += isPlaintext ? `Environment:\n` : `## Environment\n`;
    const channelLabel = updateChannel === "beta" ? "Beta" : "Stable";
    if (isPlaintext) {
      body += `App: v${appVersion} (${buildDate || "dev"})\nChannel: ${channelLabel}\nOS: ${sysInfo?.os_name || "unknown"}\nCPU: ${sysInfo?.cpu_model || "unknown"}\n`;
    } else {
      body += `| Key | Value |\n|---|---|\n| **App** | v${appVersion} (${buildDate || "dev"}) |\n| **Channel** | ${channelLabel} |\n| **OS** | ${sysInfo?.os_name || "unknown"} |\n| **CPU** | ${sysInfo?.cpu_model || "unknown"} |\n`;
    }
    if (activeConnection) body += isPlaintext ? `DB: ${activeConnection.type?.toUpperCase()}\n` : `| **DB** | ${activeConnection.type?.toUpperCase()} |\n`;
    return body;
  };

  const submitIssue = async () => {
    if (!title.trim()) return;
    if (useEmail) {
      const mailtoUrl = `mailto:hello@openidle.com?subject=[${severity.toUpperCase()}] ${title}&body=${encodeURIComponent(buildIssueBody(true))}`;
      try { (await import("@tauri-apps/plugin-opener")).openUrl(mailtoUrl); } catch { window.open(mailtoUrl, "_blank"); }
    } else {
      const p = new URLSearchParams({ title, body: buildIssueBody(), labels: severity });
      const url = `https://github.com/openidle-dev/queryden/issues/new?${p.toString()}`;
      try { (await import("@tauri-apps/plugin-opener")).openUrl(url); } catch { window.open(url, "_blank"); }
    }
    setIsSubmitted(true);
    setTimeout(() => { setIsSubmitted(false); setTitle(""); setDescription(""); }, 4000);
  };

  if (isSubmitted) {
    return (
      <div className="flex flex-col items-center justify-center py-10 animate-in fade-in duration-300">
        <CheckCircle className="w-12 h-12 text-[var(--success-11)] mb-4" />
        <h3 className="text-lg font-bold mb-1">{useEmail ? "Email Opened" : "GitHub Opened"}</h3>
        <p className="text-xs text-[var(--neutral-11)] text-center opacity-70 max-w-xs leading-relaxed">
          {useEmail
            ? "To attach a screenshot, drag-and-drop it into your email client."
            : "To attach a screenshot, drag-and-drop or paste it into the GitHub issue page that just opened."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-in fade-in duration-300">
      <div className="p-3 border rounded-lg flex items-start gap-3 bg-[var(--accent-3)] border-[var(--accent-6)]">
        {useEmail ? <Send className="w-4 h-4 text-[var(--accent-11)] shrink-0 mt-0.5" /> : <Bug className="w-4 h-4 text-[var(--accent-11)] shrink-0 mt-0.5" />}
        <p className="text-[11px] text-[var(--neutral-11)] leading-tight">
          {useEmail ? "Report via email to hello@openidle.com." : "Open an issue on our GitHub repository."}
        </p>
      </div>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-[10px] font-bold uppercase tracking-widest text-[var(--neutral-11)] opacity-50">Report Type</label>
          <div className="flex gap-1.5">
            {(["bug", "enhancement", "question"] as const).map(t => (
              <button
                key={t} onClick={() => setSeverity(t)}
                className={`flex-1 px-3 py-2 rounded-lg text-[10px] font-bold transition-all cursor-pointer border ${severity === t ? "bg-[var(--accent-9)] text-white border-[var(--accent-9)] shadow-sm" : "bg-[var(--surface-panel)] border-[var(--neutral-6)] text-[var(--neutral-11)] hover:text-[var(--neutral-12)] hover:border-[var(--neutral-7)]"}`}
              >
                {t === "bug" ? "🐛 Bug" : t === "enhancement" ? "✨ Feature" : "❓ Question"}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-[10px] font-bold uppercase tracking-widest text-[var(--neutral-11)] opacity-50">Issue Title</label>
          <Input
            inputSize="sm"
            value={title} onChange={e => setTitle(e.target.value)}
            placeholder="Short summary of the issue..."
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-[10px] font-bold uppercase tracking-widest text-[var(--neutral-11)] opacity-50">Description</label>
          <textarea
            value={description} onChange={e => setDescription(e.target.value)}
            placeholder="Tell us what happened..."
            rows={3}
            className="w-full px-3 py-2 bg-[var(--surface-base)] border border-[var(--neutral-7)] rounded-md text-xs text-[var(--neutral-12)] placeholder:text-[var(--neutral-9)] outline-none focus:border-[var(--accent-8)] focus:ring-1 focus:ring-[var(--accent-8)]/30 resize-none transition-all"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <div className="text-[10px] font-bold uppercase tracking-widest text-[var(--neutral-11)] opacity-50">Attach an image?</div>
            <div className="h-[90px] p-3 bg-[var(--surface-panel)] border border-dashed border-[var(--neutral-6)] rounded-lg flex items-start gap-2.5">
              <Paperclip className="w-3.5 h-3.5 text-[var(--neutral-11)] shrink-0 mt-0.5 opacity-80" />
              <p className="text-[10px] text-[var(--neutral-11)] leading-snug">
                {useEmail
                  ? "After we open your email client, drag-and-drop the image into the message."
                  : "After we open the GitHub page, drag-and-drop or paste the image into the issue body."}
              </p>
            </div>
          </div>

          <div className="flex flex-col justify-end gap-3">
            <div className="p-2 bg-[var(--surface-panel)] border border-[var(--neutral-6)] rounded-lg text-[9px] text-[var(--neutral-11)] space-y-0.5">
              <div><span className="opacity-50">App:</span> v{appVersion} ({buildDate?.slice(0, 7) || "dev"})</div>
              <div><span className="opacity-50">OS:</span> {sysInfo?.os_name?.toString().split(' ')[0] || "?"}</div>
            </div>
            <Button
              variant={useEmail ? "secondary" : "primary"}
              onClick={submitIssue} disabled={!title.trim()}
              className="w-full"
            >
              {useEmail ? "Send via Email" : "Create Issue"}
            </Button>
          </div>
        </div>
      </div>

      <div className="flex justify-center pt-1">
        <button onClick={() => setUseEmail(!useEmail)} className="text-[10px] font-bold text-[var(--accent-11)] hover:underline opacity-60 cursor-pointer">
          {useEmail ? "Need GitHub Account?" : "Don't have a GitHub account?"}
        </button>
      </div>
    </div>
  );
}

// ── Shared Components ──────────────────────────────────────────────

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-bold transition-all cursor-pointer ${
        active
          ? "bg-[var(--accent-9)] text-white shadow-lg"
          : "text-[var(--neutral-11)] hover:bg-[var(--neutral-4)] hover:text-[var(--neutral-12)]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function InfoCard({ title, value, icon }: { title: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="p-4 bg-[var(--surface-panel)] border border-[var(--neutral-6)] rounded-lg flex flex-col gap-1 shadow-sm hover:border-[var(--accent-8)]/40 transition-colors">
      <div className="flex items-center gap-2 text-[10px] font-bold text-[var(--neutral-11)] uppercase tracking-widest opacity-60">
        {icon} {title}
      </div>
      <div className="text-sm font-bold truncate">{value}</div>
    </div>
  );
}
