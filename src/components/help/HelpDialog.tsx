import React, { useState, useEffect, useRef } from "react";
import { X, Info, BookOpen, Terminal, Cpu, HardDrive, Github, Bug, Send, Camera, CheckCircle, Loader2, Image, Trash2 } from "lucide-react";
import { useConnections } from "../../contexts/useConnections";
import { invoke } from "@tauri-apps/api/core";
import { useAppInfo } from "../../hooks/useAppInfo";
import { useUpdateStore } from "../../store/updateStore";

interface HelpDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

type HelpTab = "about" | "report";

interface SystemInfo {
  os_name: String;
  os_version: String;
  kernel_version: String;
  hostname: String;
  cpu_model: String;
  cpu_count: number;
  memory_total_kb: number;
  memory_used_kb: number;
  memory_free_kb: number;
  uptime_seconds: number;
  app_version: string;
}


export function HelpDialog({ isOpen, onClose }: HelpDialogProps) {
  const [activeTab, setActiveTab] = useState<HelpTab>("about");
  const { activeConnection } = useConnections();
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null);
  const { name: appName, version: appVersion } = useAppInfo();
  const { buildDate, fetchBuildDate } = useUpdateStore();

  useEffect(() => {
    if (isOpen) {
      fetchSystemInfo();
      fetchBuildDate();
    }
  }, [isOpen]);

  const fetchSystemInfo = async () => {
    try {
      const info = await invoke<SystemInfo>("get_system_info");
      setSysInfo(info);
    } catch (err) {
      console.error("Failed to fetch system info:", err);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[150] bg-black/70 flex items-center justify-center p-8 backdrop-blur-md animate-in fade-in duration-300">
      <div className="bg-[var(--surface)] w-full max-w-4xl h-[660px] rounded-2xl shadow-2xl flex overflow-hidden border border-[var(--border)] animate-in zoom-in-95 duration-200">
        
        {/* Sidebar */}
        <div className="w-64 border-r border-[var(--border)] bg-[var(--surface-raised)] flex flex-col font-sans">
          <div className="p-6">
            <div className="flex items-center gap-3 mb-8">
              <img src="/img/icon.png" alt={appName} className="w-8 h-8 rounded-xl" />
              <h2 className="font-bold text-lg tracking-tight">{appName}</h2>
            </div>
            
            <nav className="space-y-1.5">
              <TabButton 
                active={activeTab === "about"} 
                onClick={() => setActiveTab("about")}
                icon={<Info className="w-4 h-4" />}
                label="About"
              />
              <TabButton 
                active={activeTab === "report"} 
                onClick={() => setActiveTab("report")}
                icon={<Bug className="w-4 h-4" />}
                label="Log New Issue"
              />
            </nav>
          </div>
          
          <div className="mt-auto p-6 border-t border-[var(--border)]">
            <div className="flex items-center justify-between text-[10px] uppercase font-bold text-[var(--text-secondary)] opacity-50 tracking-widest mb-4">
              <span>Community</span>
            </div>
            <div className="space-y-3">
              <a href="https://github.com/openidle-dev/queryden" target="_blank" className="flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)] hover:text-white transition-colors">
                <Github className="w-4 h-4" /> GitHub Repository
              </a>
            </div>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 flex flex-col min-w-0 bg-[var(--background)] font-sans">
          <div className="h-14 px-6 border-b border-[var(--border)] flex items-center justify-between bg-[var(--surface)]">
            <h3 className="font-bold text-sm uppercase tracking-widest opacity-80">
              {activeTab === "about" && "Application Info"}
              {activeTab === "report" && "Report an Issue"}
            </h3>
            <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors group">
              <X className="w-5 h-5 opacity-50 group-hover:opacity-100" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
            {activeTab === "about" && (
              <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="flex items-start gap-6 p-6 bg-[var(--surface-raised)] rounded-2xl border border-[var(--border)] shadow-sm">
                  <img src="/img/icon.png" alt={appName} className="w-20 h-20 rounded-2xl" />
                   <div className="flex-1">
                      <h1 className="text-2xl font-black mb-1">{appName} <span className="text-blue-500 text-sm">v{appVersion}</span></h1>
                      <p className="text-sm text-[var(--text-secondary)] leading-relaxed mb-4">
                        A premium database management environment built for the modern SQL expert. 
                        Engineered for speed, performance, and accessibility.
                      </p>
                      <div className="flex gap-4 text-xs font-bold">
                        <button 
                          onClick={async () => {
                            try {
                              const { openUrl } = await import("@tauri-apps/plugin-opener");
                              const url = window.location.origin + "/docs.html";
                              await openUrl(url);
                            } catch (err) {
                              console.error("openUrl failed, trying WebviewWindow:", err);
                              try {
                                const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
                                new WebviewWindow("docs", {
                                  url: "/docs.html",
                                  title: `${appName} Documentation Guide`,
                                  width: 1100,
                                  height: 800,
                                  resizable: true,
                                  center: true
                                });
                              } catch (winErr) {
                                console.error("WebviewWindow also failed:", winErr);
                                window.open("/docs.html", "_blank");
                              }
                            }
                          }}
                          className="bg-blue-500 text-white px-3 py-1 rounded-lg hover:bg-blue-600 transition-colors flex items-center gap-2"
                        >
                          <BookOpen className="w-3 h-3" /> View Documentation Guide
                        </button>
                      </div>
                   </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <InfoCard title="Version" value={`v${appVersion}`} icon={<Terminal className="w-4 h-4" />} />
                  <InfoCard title="Build" value={buildDate || 'Loading…'} icon={<Terminal className="w-4 h-4" />} />
                  <InfoCard title="Platform" value={sysInfo?.os_name?.toString() || "Detecting..."} icon={<HardDrive className="w-4 h-4" />} />
                  <InfoCard title="CPU" value={sysInfo?.cpu_model?.toString() || "Detecting..."} icon={<Cpu className="w-4 h-4" />} />
                </div>
              </div>
            )}

            {activeTab === "report" && (
              <IssueReporter 
                appVersion={appVersion} 
                buildDate={buildDate} 
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

// ── Issue Reporter ─────────────────────────────────────────────────

interface IssueReporterProps {
  appVersion: string;
  buildDate: string | null;
  sysInfo: SystemInfo | null;
  activeConnection: any;
}

function IssueReporter({ appVersion, buildDate, sysInfo, activeConnection }: IssueReporterProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<"bug" | "enhancement" | "question">("bug");
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [useEmail, setUseEmail] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const captureScreenshot = async () => {
    setIsCapturing(true);
    try {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      const appEl = document.querySelector('[class*="theme-"]') as HTMLElement;
      if (!appEl || !ctx) throw new Error("Could not find app element");

      const rect = appEl.getBoundingClientRect();
      canvas.width = rect.width * (window.devicePixelRatio || 1);
      canvas.height = rect.height * (window.devicePixelRatio || 1);
      ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);

      const svgData = `
        <svg xmlns="http://www.w3.org/2000/svg" width="${rect.width}" height="${rect.height}">
          <foreignObject width="100%" height="100%">
            <div xmlns="http://www.w3.org/1999/xhtml">
              <style>body { margin: 0; }</style>
              ${appEl.outerHTML}
            </div>
          </foreignObject>
        </svg>`;
      
      const svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(svgBlob);
      const img = new window.Image();
      
      await new Promise<void>((resolve, reject) => {
        img.onload = () => {
          ctx.drawImage(img, 0, 0);
          URL.revokeObjectURL(url);
          resolve();
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error("Failed to render screenshot"));
        };
        img.src = url;
      });

      setScreenshot(canvas.toDataURL("image/png"));

      try {
        canvas.toBlob(async (blob) => {
          if (blob) {
            await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          }
        });
      } catch { }
    } catch (err) {
      console.error("Screenshot capture failed:", err);
      fileInputRef.current?.click();
    } finally {
      setIsCapturing(false);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setScreenshot(reader.result as string);
    reader.readAsDataURL(file);
  };

  const buildIssueBody = (isPlaintext = false) => {
    let body = "";
    if (description) body += isPlaintext ? `Description:\n${description}\n\n` : `## Description\n${description}\n\n`;
    if (screenshot) body += isPlaintext ? `Note: A screenshot is copied to the clipboard. Please attach it.\n\n` : `## Screenshot\n> ⚠️ Screenshot captured & copied to clipboard. Paste it here.\n\n`;
    body += "---\n\n";
    body += isPlaintext ? `Environment:\n` : `## Environment\n`;
    if (isPlaintext) {
      body += `App: v${appVersion} (${buildDate || "dev"})\nOS: ${sysInfo?.os_name || "unknown"}\nCPU: ${sysInfo?.cpu_model || "unknown"}\n`;
    } else {
      body += `| Key | Value |\n|---|---|\n| **App** | v${appVersion} (${buildDate || "dev"}) |\n| **OS** | ${sysInfo?.os_name || "unknown"} |\n| **CPU** | ${sysInfo?.cpu_model || "unknown"} |\n`;
    }
    if (activeConnection) body += isPlaintext ? `DB: ${activeConnection.type?.toUpperCase()}\n` : `| **DB** | ${activeConnection.type?.toUpperCase()} |\n`;
    return body;
  };

  const submitIssue = async () => {
    if (!title.trim()) return;
    if (useEmail) {
      const mailtoUrl = `mailto:support@queryden.app?subject=[${severity.toUpperCase()}] ${title}&body=${encodeURIComponent(buildIssueBody(true))}`;
      try { (await import("@tauri-apps/plugin-opener")).openUrl(mailtoUrl); } catch { window.open(mailtoUrl, "_blank"); }
    } else {
      const p = new URLSearchParams({ title, body: buildIssueBody(), labels: severity });
      const url = `https://github.com/openidle-dev/queryden/issues/new?${p.toString()}`;
      try { (await import("@tauri-apps/plugin-opener")).openUrl(url); } catch { window.open(url, "_blank"); }
    }
    setIsSubmitted(true);
    setTimeout(() => { setIsSubmitted(false); setTitle(""); setDescription(""); setScreenshot(null); }, 3000);
  };

  if (isSubmitted) {
    return (
      <div className="flex flex-col items-center justify-center py-10 animate-in fade-in duration-300">
        <CheckCircle className="w-12 h-12 text-green-400 mb-4" />
        <h3 className="text-lg font-bold mb-1">{useEmail ? "Email Opened!" : "GitHub Opened!"}</h3>
        <p className="text-xs text-[var(--text-secondary)] text-center opacity-60">Paste your screenshot if needed.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4 animate-in fade-in duration-300">
      <div className={`p-3 border rounded-lg flex items-start gap-3 ${useEmail ? 'bg-purple-500/5 border-purple-500/15' : 'bg-blue-500/5 border-blue-500/15'}`}>
        {useEmail ? <Send className="w-4 h-4 text-purple-400 shrink-0 mt-0.5" /> : <Bug className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />}
        <p className="text-[11px] text-[var(--text-secondary)] leading-tight">
          {useEmail ? "Report via email to support@queryden.app." : "Open an issue on our GitHub repository."}
        </p>
      </div>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-secondary)] opacity-50">Report Type</label>
          <div className="flex gap-1.5">
            {(["bug", "enhancement", "question"] as const).map(t => (
              <button 
                key={t} onClick={() => setSeverity(t)}
                className={`flex-1 px-3 py-2 rounded-lg text-[10px] font-bold transition-all ${severity === t ? "bg-blue-500 text-white shadow-sm border-blue-400" : "bg-[var(--surface-raised)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-white hover:border-white/20"}`}
              >
                {t === "bug" ? "🐛 Bug" : t === "enhancement" ? "✨ Feature" : "❓ Question"}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-secondary)] opacity-50">Issue Title</label>
          <input 
            value={title} onChange={e => setTitle(e.target.value)}
            placeholder="Short summary of the issue..."
            className="w-full px-3 py-2 bg-[var(--surface-raised)] border border-[var(--border)] rounded-lg text-xs outline-none focus:border-blue-500/50 transition-all"
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-secondary)] opacity-50">Description</label>
          <textarea 
            value={description} onChange={e => setDescription(e.target.value)}
            placeholder="Tell us what happened..."
            rows={3}
            className="w-full px-3 py-2 bg-[var(--surface-raised)] border border-[var(--border)] rounded-lg text-xs outline-none focus:border-blue-500/50 resize-none transition-all"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-secondary)] opacity-50">Screenshot (Optional)</label>
            {screenshot ? (
              <div className="relative group rounded-lg overflow-hidden border border-[var(--border)] h-[90px] bg-black/20">
                <img src={screenshot} alt="Preview" className="w-full h-full object-contain" />
                <button onClick={() => setScreenshot(null)} className="absolute inset-0 bg-red-500/80 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"><Trash2 className="w-5 h-5 text-white" /></button>
              </div>
            ) : (
              <div className="flex gap-2 h-[90px]">
                <button onClick={captureScreenshot} className="flex-1 flex flex-col items-center justify-center gap-1.5 bg-[var(--surface-raised)] border border-[var(--border)] rounded-lg text-[10px] font-bold hover:border-blue-500/30 transition-all">
                  {isCapturing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-4 h-4 opacity-60" />} <span>Capture</span>
                </button>
                <button onClick={() => fileInputRef.current?.click()} className="flex-1 flex flex-col items-center justify-center gap-1.5 bg-[var(--surface-raised)] border border-[var(--border)] rounded-lg text-[10px] font-bold hover:border-blue-500/30 transition-all">
                  <Image className="w-4 h-4 opacity-60" /> <span>Upload</span>
                </button>
                <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileSelect} />
              </div>
            )}
          </div>

          <div className="flex flex-col justify-end gap-3">
            <div className="p-2 bg-[var(--surface-raised)] border border-[var(--border)] rounded-lg text-[9px] text-[var(--text-secondary)] space-y-0.5">
              <div><span className="opacity-50">App:</span> v{appVersion} ({buildDate?.slice(0, 7) || "dev"})</div>
              <div><span className="opacity-50">OS:</span> {sysInfo?.os_name?.toString().split(' ')[0] || "?"}</div>
            </div>
            <button 
              onClick={submitIssue} disabled={!title.trim()}
              className={`w-full py-2.5 rounded-lg text-xs font-bold text-white shadow-lg transition-all ${useEmail ? 'bg-purple-500' : 'bg-green-500'} disabled:opacity-20`}
            >
              {useEmail ? "Send via Email" : "Create Issue"}
            </button>
          </div>
        </div>
      </div>

      <div className="flex justify-center pt-1">
        <button onClick={() => setUseEmail(!useEmail)} className="text-[10px] font-bold text-blue-400 hover:underline opacity-60">
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
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${
        active 
          ? "bg-blue-500 text-white shadow-lg shadow-blue-500/20" 
          : "text-[var(--text-secondary)] hover:bg-white/5 hover:text-white"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function InfoCard({ title, value, icon }: { title: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="p-4 bg-[var(--surface-raised)] border border-[var(--border)] rounded-xl flex flex-col gap-1 shadow-sm hover:border-blue-500/30 transition-colors">
      <div className="flex items-center gap-2 text-[10px] font-bold text-[var(--text-secondary)] uppercase tracking-widest opacity-60">
        {icon} {title}
      </div>
      <div className="text-sm font-bold truncate">{value}</div>
    </div>
  );
}
