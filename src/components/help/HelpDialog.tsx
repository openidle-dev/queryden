import React, { useState, useEffect } from "react";
import { X, Info, BookOpen, Activity, ChevronRight, ExternalLink, Github, Terminal, Cpu, HardDrive, RefreshCw } from "lucide-react";
import { useConnections } from "../../contexts/useConnections";
import { invoke } from "@tauri-apps/api/core";
import { useAppInfo } from "../../hooks/useAppInfo";

interface HelpDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

type HelpTab = "about" | "docs" | "status";

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
  const { activeConnection, selectedDatabase } = useConnections();
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState<string | null>(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const { name: appName, version: appVersion } = useAppInfo();

  useEffect(() => {
    if (isOpen) {
      fetchSystemInfo();
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

  const handleCheckUpdate = async () => {
    setIsCheckingUpdate(true);
    setUpdateStatus(null);
    try {
      const res = await invoke<string>("check_for_updates");
      setUpdateStatus(res);
    } catch (err) {
      setUpdateStatus("Failed to check for updates. Please try again later.");
    } finally {
      setIsCheckingUpdate(false);
    }
  };

  const openReleaseNotes = () => {
    window.open("https://github.com/openidle-dev/queryden/releases", "_blank");
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
                active={activeTab === "status"} 
                onClick={() => setActiveTab("status")}
                icon={<Activity className="w-4 h-4" />}
                label="Server Status"
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
              <a href="#" className="flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)] hover:text-white transition-colors">
                <ExternalLink className="w-4 h-4" /> Official Docs
              </a>
            </div>
          </div>
        </div>

        {/* Content Area */}
        <div className="flex-1 flex flex-col min-w-0 bg-[var(--background)] font-sans">
          <div className="h-14 px-6 border-b border-[var(--border)] flex items-center justify-between bg-[var(--surface)]">
            <h3 className="font-bold text-sm uppercase tracking-widest opacity-80">
              {activeTab === "about" && "Application Info"}
              {activeTab === "status" && "Runtime Status"}
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
                          onClick={handleCheckUpdate}
                          disabled={isCheckingUpdate}
                          className="text-blue-400 hover:underline flex items-center gap-1 disabled:opacity-50"
                        >
                          {isCheckingUpdate && <RefreshCw className="w-3 h-3 animate-spin" />}
                          Check for Updates <ChevronRight className="w-3 h-3" />
                        </button>
                        <button onClick={openReleaseNotes} className="text-blue-400 hover:underline">Release Notes</button>
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
                          className="bg-blue-500 text-white px-3 py-1 rounded-lg hover:bg-blue-600 transition-colors flex items-center gap-2 ml-auto"
                        >
                          <BookOpen className="w-3 h-3" /> View Documentation Guide
                        </button>
                      </div>
                      
                      {updateStatus && (
                        <div className="mt-4 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg text-xs font-medium text-blue-400 animate-in fade-in slide-in-from-top-1">
                          {updateStatus}
                        </div>
                      )}
                   </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <InfoCard title="Build" value="2026.05.01-stable" icon={<Terminal className="w-4 h-4" />} />
                  <InfoCard title="Tauri Service" value="RUNNING" icon={<Activity className="w-4 h-4 text-green-500" />} />
                  <InfoCard title="Platform" value={sysInfo?.os_name?.toString() || "Detecting..."} icon={<HardDrive className="w-4 h-4" />} />
                  <InfoCard title="CPU" value={sysInfo?.cpu_model?.toString() || "Detecting..."} icon={<Cpu className="w-4 h-4" />} />
                </div>
              </div>
            )}

            {activeTab === "status" && (
              <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
                <div className="space-y-4">
                   <h4 className="text-xs font-bold uppercase tracking-widest text-[var(--text-secondary)] opacity-60">System Resources</h4>
                   <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {sysInfo ? (
                        <>
                          <ResourceCard 
                            label="Memory Usage" 
                            current={`${(sysInfo.memory_used_kb / 1024).toFixed(1)} MB`}
                            total={`${(sysInfo.memory_total_kb / 1024).toFixed(1)} MB`}
                            percentage={(sysInfo.memory_used_kb / sysInfo.memory_total_kb) * 100}
                          />
                          <ResourceCard 
                            label="CPU Load" 
                            current={`${sysInfo.cpu_count} Cores`}
                            total="100%"
                            percentage={5} // Simulated for now
                          />
                        </>
                      ) : (
                        <div className="col-span-2 py-8 text-center text-xs opacity-50">Loading metrics...</div>
                      )}
                   </div>
                </div>

                <div className="space-y-4">
                  <h4 className="text-xs font-bold uppercase tracking-widest text-[var(--text-secondary)] opacity-60">Database Connection</h4>
                  {activeConnection ? (
                    <div className="space-y-4">
                      <div className="p-4 bg-green-500/10 border border-green-500/20 rounded-xl flex items-center gap-4 shadow-sm">
                        <div className="w-10 h-10 bg-green-500/20 rounded-full flex items-center justify-center text-green-500">
                           <Activity className="w-5 h-5 animate-pulse" />
                        </div>
                        <div className="flex-1">
                          <div className="text-[10px] font-bold text-green-500 uppercase tracking-widest">Active Connection</div>
                          <div className="text-lg font-bold">{activeConnection.name}</div>
                        </div>
                        <div className="text-xs font-mono opacity-50 px-2 py-1 bg-white/5 rounded">
                          {activeConnection.type.toUpperCase()}
                        </div>
                      </div>
                      
                      <div className="grid grid-cols-2 gap-4">
                        <StatusItem label="Endpoint" value={activeConnection.host || "N/A"} />
                        <StatusItem label="Port" value={String(activeConnection.port)} />
                        <StatusItem label="Active Database" value={selectedDatabase || "N/A"} />
                        <StatusItem label="App Uptime" value={sysInfo ? formatUptime(sysInfo.uptime_seconds) : "..."} />
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center py-10 text-center opacity-40 border border-dashed border-[var(--border)] rounded-2xl">
                      <Activity className="w-12 h-12 mb-4" />
                      <h3 className="text-sm font-bold">No Active Connection</h3>
                      <p className="text-xs max-w-[200px]">Connect to a database to see live server status and performance metrics.</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

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

function StatusItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-3 bg-[var(--surface-raised)] border border-[var(--border)] rounded-lg">
      <div className="text-[10px] font-bold text-[var(--text-secondary)] uppercase mb-1">{label}</div>
      <div className="text-xs font-mono truncate">{value}</div>
    </div>
  );
}

function ResourceCard({ label, current, total, percentage }: { label: string; current: string; total: string; percentage: number }) {
  return (
    <div className="p-4 bg-[var(--surface-raised)] border border-[var(--border)] rounded-xl shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-bold uppercase tracking-widest opacity-60">{label}</span>
        <span className="text-xs font-bold text-blue-400">{Math.round(percentage)}%</span>
      </div>
      <div className="h-2 bg-[var(--background)] rounded-full overflow-hidden mb-3">
        <div 
          className="h-full bg-blue-500 rounded-full transition-all duration-1000" 
          style={{ width: `${Math.max(5, percentage)}%` }} 
        />
      </div>
      <div className="flex justify-between text-[10px] items-baseline font-medium">
        <span className="text-[var(--text-secondary)]">Used: <span className="text-white">{current}</span></span>
        <span className="text-[var(--text-secondary)]">Total: {total}</span>
      </div>
    </div>
  );
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
