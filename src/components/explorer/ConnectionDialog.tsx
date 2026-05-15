import { useState, useEffect } from "react";
import { DatabaseConnection } from "../../contexts/ConnectionContext";
import { useConnections } from "../../contexts/useConnections";
import { X, CheckCircle, Database, ServerCrash, Search, Settings, Shield } from "lucide-react";
import { useConfirmDialog } from "../ui/ConfirmDialog";

import { PROVIDERS } from "../../config/providers";
import { getDefaultDatabaseName } from "../../config/app";
import { filterProviders, getComingSoonCount } from "./filterProviders";

export function ConnectionDialog({ connection, onClose }: { connection?: DatabaseConnection; onClose: () => void }) {
  const { addConnection, updateConnection, removeConnection, vaultCredentials } = useConnections();
  const [step, setStep] = useState<"driver" | "details">(connection ? "details" : "driver");
  const [searchFilter, setSearchFilter] = useState("");
  const [driverCategory, setDriverCategory] = useState("All");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [showAll, setShowAll] = useState(false);
  const [activeTab, setActiveTab] = useState<"general" | "ssh">("general");

  const [formData, setFormData] = useState({
    name: connection?.name || "",
    type: (connection?.type as string) || "postgres",
    host: connection?.host || "localhost",
    port: connection?.port?.toString() || "5432",
    database: connection?.database || "",
    username: connection?.username || "",
    password: connection?.password || "",
    filepath: connection?.filepath || "",
    isVault: true,
    vaultCredentialId: connection?.vaultCredentialId || "",
    color: connection?.color || "#06b6d4",
    // SSH fields
    sshEnabled: connection?.sshEnabled || false,
    sshHost: connection?.sshHost || "",
    sshPort: connection?.sshPort?.toString() || "22",
    sshUsername: connection?.sshUsername || "",
    sshPassword: connection?.sshPassword || "",
    sshKeyPath: connection?.sshKeyPath || "",
    sshKeyPassphrase: connection?.sshKeyPassphrase || "",
    sshAuthMethod: connection?.sshKeyPath ? "key" : "password",
  });
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const confirmDialog = useConfirmDialog();

  // Focus effect when switching steps
  useEffect(() => {
    if (step === "details" && !formData.name && formData.type) {
      setFormData(prev => ({ ...prev, name: `Local ${prev.type.charAt(0).toUpperCase() + prev.type.slice(1)}` }));
    }
  }, [step]);

  // ESC to close
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [onClose]);

  const testConnection = async (): Promise<{ success: boolean; message: string }> => {
    setIsConnecting(true);
    setError(null);
    setTestResult(null);

    let connectionString = "";

    const supportedDrivers = ["sqlite", "postgres", "supabase", "cockroach", "mysql", "mariadb"];
    if (!supportedDrivers.includes(formData.type)) {
      setIsConnecting(false);
      return { 
        success: false, 
        message: `The '${PROVIDERS.find(p => p.id === formData.type)?.name || formData.type}' provider is either coming soon or not supported by the underlying Tauri driver.` 
      };
    }

    if (formData.type === "sqlite") {
      connectionString = `sqlite:${formData.filepath || getDefaultDatabaseName()}`;
    } else if (["postgres", "supabase", "cockroach"].includes(formData.type)) {
      const host = formData.host || "localhost";
      const port = formData.port || (formData.type === "cockroach" ? "26257" : "5432");
      const database = formData.database || (formData.type === "cockroach" ? "defaultdb" : "postgres");
      
      let user = formData.username || "postgres";
      let pass = formData.password || "";

      if (formData.vaultCredentialId) {
        const cred = vaultCredentials.find(c => c.id === formData.vaultCredentialId);
        if (cred) {
          user = cred.username || user;
          pass = cred.password || pass;
        }
      }

      // URL encode credentials to handle special characters
      const encodedUser = encodeURIComponent(user);
      const encodedPass = encodeURIComponent(pass);

      connectionString = `postgres://${encodedUser}:${encodedPass}@${host}:${port}/${database}`;
    } else if (["mysql", "mariadb"].includes(formData.type)) {
      const host = formData.host || "localhost";
      const port = formData.port || "3306";
      const database = formData.database || "mysql";
      
      let user = formData.username || "root";
      let pass = formData.password || "";

      if (formData.vaultCredentialId) {
        const cred = vaultCredentials.find(c => c.id === formData.vaultCredentialId);
        if (cred) {
          user = cred.username || user;
          pass = cred.password || pass;
        }
      }

      // URL encode credentials to handle special characters
      const encodedUser = encodeURIComponent(user);
      const encodedPass = encodeURIComponent(pass);

      connectionString = `mysql://${encodedUser}:${encodedPass}@${host}:${port}/${database}`;
    }

    const isTauri = typeof window !== 'undefined' && (
      !!(window as any).__TAURI_INTERNALS__ || 
      !!(window as any).__TAURI__
    );
    if (!isTauri) {
      setIsConnecting(false);
      return { 
        success: false, 
        message: "Not running in Tauri framework. Connection testing only works in the desktop app." 
      };
    }

    try {
      const Database = await import("@tauri-apps/plugin-sql");
      if (!Database.default) {
        setIsConnecting(false);
        return { success: false, message: "SQL plugin not available. Please run the app in Tauri." };
      }

      const db = await Database.default.load(connectionString);
      await db.select("SELECT 1");
      await db.close();
      
      setIsConnecting(false);
      return { success: true, message: "Connection successful!" };
    } catch (err: any) {
      console.error("Connection test error:", err);
      const errorMsg = err.message || err.toString() || "Unknown error occurred";
      setIsConnecting(false);
      return { success: false, message: errorMsg };
    }
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    
    // Test on save
    const result = await testConnection();
    setTestResult(result);
    if (!result.success) {
      const confirmed = await confirmDialog.confirm({
        title: "Connection Test Failed",
        message: `The connection test failed: ${result.message}. Do you want to save these settings anyway?`,
        confirmLabel: "Save Anyway",
        cancelLabel: "Cancel",
        type: "warning"
      });
      if (!confirmed) {
        setError(result.message);
        return;
      }
    }

    const conn: DatabaseConnection = {
      id: connection?.id || crypto.randomUUID(),
      name: formData.name,
      type: formData.type,
      host: formData.host,
      port: parseInt(formData.port) || (formData.type === "postgres" ? 5432 : 3306),
      database: formData.database,
      username: formData.username,
      password: formData.password,
      filepath: formData.filepath,
      isVault: formData.isVault,
      vaultCredentialId: formData.vaultCredentialId,
      color: formData.color,
      sshEnabled: formData.sshEnabled || undefined,
      sshHost: formData.sshEnabled ? formData.sshHost : undefined,
      sshPort: formData.sshEnabled ? (parseInt(formData.sshPort) || 22) : undefined,
      sshUsername: formData.sshEnabled ? formData.sshUsername : undefined,
      sshPassword: formData.sshEnabled && formData.sshAuthMethod === "password" ? formData.sshPassword : undefined,
      sshKeyPath: formData.sshEnabled && formData.sshAuthMethod === "key" ? formData.sshKeyPath : undefined,
      sshKeyPassphrase: formData.sshEnabled && formData.sshAuthMethod === "key" ? formData.sshKeyPassphrase : undefined,
    };

    if (connection) {
      updateConnection(conn.id, conn);
    } else {
      addConnection(conn);
    }
    
    onClose();
  };

  const handleTestOnly = async (e: React.FormEvent) => {
    e.preventDefault();
    const result = await testConnection();
    setTestResult(result);
    if (!result.success) {
      setError(result.message);
    }
  };

  const categories = ["All", "Popular", "RDBMS", "NoSQL", "Cloud", "Embedded"];
  const filteredProviders = filterProviders(PROVIDERS, {
    showAll,
    search: searchFilter,
    category: driverCategory,
  });
  const comingSoonCount = getComingSoonCount(PROVIDERS);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[200] backdrop-blur-[1px]">
      <div className="bg-[var(--surface)] rounded-xl shadow-2xl w-[900px] h-[650px] flex flex-col overflow-hidden border border-[var(--border)] animate-in fade-in zoom-in duration-100">
        
        {/* Header */}
        <div className="p-4 border-b border-[var(--border)] flex items-center justify-between bg-gradient-to-r from-[var(--surface-raised)] to-[var(--surface)]">
          <div className="flex items-center gap-2">
            <div className="p-1.5 bg-[var(--color-accent)]/20 rounded">
              <Database className="w-5 h-5 text-[var(--color-accent)]" />
            </div>
            <div>
              <h3 className="text-sm font-bold tracking-wide">
                {step === "driver" ? "Select your database" : (connection ? "Edit Connection" : "Connection Details")}
              </h3>
              {step === "driver" && <p className="text-[10px] text-[var(--text-secondary)]">Create new database connection. Find your database driver in the list below.</p>}
              {step === "details" && <p className="text-[10px] text-[var(--text-secondary)]">Configure connection settings for {PROVIDERS.find(p => p.id === formData.type)?.name}.</p>}
            </div>
          </div>
          <button onClick={onClose} className="p-2 text-[var(--text-secondary)] hover:text-white hover:bg-[var(--border)] rounded-full transition-all">
            <X className="w-4 h-4" />
          </button>
        </div>
        
        {/* Step 1: Provider Selection */}
        {step === "driver" && (
          <div className="flex-1 flex flex-col min-h-0 bg-[#1e1e1e]">
            {/* Search Bar */}
            <div className="p-3 border-b border-[var(--border)] bg-[var(--surface)] flex gap-2 items-center">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-secondary)]" />
                <input
                  type="text"
                  placeholder="Type part of database/driver name to filter"
                  value={searchFilter}
                  onChange={e => setSearchFilter(e.target.value)}
                  className="w-full pl-9 pr-3 py-1.5 text-xs rounded bg-[#111111] border border-[var(--border)] outline-none focus:border-[var(--color-accent)] text-white"
                />
              </div>
              <label className="text-[10px] text-[var(--text-secondary)] flex items-center gap-1.5 mr-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showAll}
                  onChange={(e) => setShowAll(e.target.checked)}
                  className="w-3 h-3 accent-[var(--color-accent)] cursor-pointer"
                />
                <span>Show all ({comingSoonCount})</span>
              </label>
              <div className="text-[10px] text-[var(--text-secondary)] flex items-center gap-1.5 mr-2">
                <span>View:</span>
                <button 
                  onClick={() => setViewMode("grid")}
                  className={`${viewMode === "grid" ? "bg-[var(--color-accent)] text-white" : "bg-[#111111] text-[var(--text-secondary)]"} px-2 py-0.5 rounded border ${viewMode === "grid" ? "border-[var(--color-accent)]" : "border-[var(--border)]"} hover:bg-[var(--color-accent)]/80 transition-all`}
                >
                  Tiles
                </button>
                <button 
                  onClick={() => setViewMode("list")}
                  className={`${viewMode === "list" ? "bg-[var(--color-accent)] text-white" : "bg-[#111111] text-[var(--text-secondary)]"} px-2 py-0.5 rounded border ${viewMode === "list" ? "border-[var(--color-accent)]" : "border-[var(--border)]"} hover:bg-[var(--color-accent)]/80 transition-all`}
                >
                  List
                </button>
              </div>
            </div>

            <div className="flex flex-1 min-h-0">
              {/* Left Category Sidebar */}
              <div className="w-48 bg-[var(--surface)] border-r border-[var(--border)] py-2 overflow-y-auto">
                {categories.map(c => (
                  <button
                    key={c}
                    onClick={() => setDriverCategory(c)}
                    className={`w-full text-left px-4 py-1.5 text-[11px] font-bold ${driverCategory === c ? "bg-[var(--color-accent)]/20 text-[var(--color-accent)] border-r-2 border-[var(--color-accent)]" : "text-[var(--text-primary)] hover:bg-[var(--border)]"}`}
                  >
                    {c}
                  </button>
                ))}
              </div>

              {/* Content Area */}
              <div className="flex-1 p-6 overflow-y-auto bg-[#1a1a1a]">
                {viewMode === "grid" ? (
                  <div className="grid grid-cols-4 gap-4">
                    {filteredProviders.map(p => {
                      const Icon = p.icon;
                      return (
                        <button
                          key={p.id}
                          disabled={p.comingSoon}
                          onClick={() => {
                            setError(null);
                            setTestResult(null);
                            setFormData(prev => ({ 
                              ...prev, 
                              type: p.id as any,
                              port: p.defaultPort || ""
                            }));
                            setStep("details");
                          }}
                          className={`flex flex-col items-center justify-center p-4 rounded-xl border transition-all ${
                            p.comingSoon 
                              ? "bg-[#222] border-[#333] opacity-60 cursor-not-allowed grayscale" 
                              : "bg-[#252526] border-[#3c3c3c] hover:border-[var(--color-accent)] hover:shadow-lg hover:shadow-[var(--color-accent)]/10 hover:-translate-y-1"
                          }`}
                        >
                          <div className={`p-4 rounded-lg ${p.bg} ${p.color} border border-white/5 mb-3`}>
                            <Icon className="w-10 h-10 drop-shadow-md" />
                          </div>
                          <span className="text-xs font-bold text-gray-200">{p.name}</span>
                          {p.comingSoon && <span className="text-[9px] text-[var(--text-secondary)] mt-1 font-mono tracking-tighter">SOON</span>}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {filteredProviders.map(p => {
                      const Icon = p.icon;
                      return (
                        <button
                          key={p.id}
                          disabled={p.comingSoon}
                          onClick={() => {
                            setError(null);
                            setTestResult(null);
                            setFormData(prev => ({ 
                              ...prev, 
                              type: p.id as any,
                              port: p.defaultPort || ""
                            }));
                            setStep("details");
                          }}
                          className={`w-full flex items-center gap-4 p-3 rounded-lg border transition-all ${
                            p.comingSoon 
                              ? "bg-[#222]/50 border-[#333] opacity-60 cursor-not-allowed grayscale" 
                              : "bg-[#252526] border-[#3c3c3c] hover:border-[var(--color-accent)] group"
                          }`}
                        >
                          <div className={`p-2 rounded ${p.bg} ${p.color} border border-white/5`}>
                            <Icon className="w-5 h-5" />
                          </div>
                          <div className="flex-1 text-left">
                            <div className="text-sm font-bold text-gray-200">{p.name}</div>
                            <div className="text-[10px] text-[var(--text-secondary)]">{p.type} • {p.defaultPort ? `Default Port: ${p.defaultPort}` : "Local File"}</div>
                          </div>
                          {p.comingSoon ? (
                            <span className="text-[9px] font-mono text-[var(--text-secondary)] px-2 py-0.5 bg-[#333] rounded">COMING SOON</span>
                          ) : (
                            <div className="opacity-0 group-hover:opacity-100 transition-opacity text-[10px] font-bold text-[var(--color-accent)] uppercase">
                              Select &gt;
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            
            <div className="p-3 border-t border-[var(--border)] bg-[var(--surface)] flex justify-end">
              <button disabled className="px-4 py-1.5 bg-[#2d2d2d] text-[var(--text-secondary)] text-xs rounded border border-[#3c3c3c] cursor-not-allowed">
                Next &gt;
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Connection Details */}
        {step === "details" && (
          <div className="flex-1 flex flex-col min-h-0">
            <div className="flex flex-1 min-h-0">
              {/* Left Sidebar - Summary */}
              <div className="w-64 bg-[#1e1e1e] border-r border-[var(--border)] p-6 flex flex-col items-center border-t border-[var(--surface-raised)]">
                {(() => {
                  const p = PROVIDERS.find(p => p.id === formData.type);
                  const Icon = p?.icon || Database;
                  return (
                    <>
                      <div className={`p-6 rounded-2xl ${p?.bg || 'bg-gray-800'} ${p?.color || 'text-white'} border border-white/10 mb-4 shadow-xl`}>
                        <Icon className="w-16 h-16 drop-shadow-lg" />
                      </div>
                      <h2 className="text-lg font-bold text-white mb-1">{p?.name}</h2>
                      <p className="text-[10px] uppercase tracking-widest text-[var(--text-secondary)] font-bold">Standard Connection</p>
                      <div className="mt-8 w-full space-y-2">
                        <div className="p-3 bg-[#2d2d2d] rounded-lg border border-[#3c3c3c] text-xs">
                          <span className="text-[var(--text-secondary)]">Driver: </span> <span className="font-mono text-[var(--color-accent)]">Native (Tauri)</span>
                        </div>
                        <div className="p-3 bg-[#2d2d2d] rounded-lg border border-[#3c3c3c] text-xs">
                          <span className="text-[var(--text-secondary)]">Status: </span> 
                          <span className={`font-bold ${testResult ? (testResult.success ? 'text-green-400' : 'text-red-400') : (connection ? 'text-sky-400' : 'text-amber-400')}`}>
                            {testResult ? (testResult.success ? 'Verified' : 'Error') : (connection ? 'Saved / Ready' : 'Pending')}
                          </span>
                        </div>
                      </div>
                    </>
                  );
                })()}
              </div>

              {/* Form Content */}
              <form id="connection-form" onSubmit={handleSubmit} className="flex-1 flex flex-col min-h-0">
                {/* Tabs */}
                {formData.type !== "sqlite" && (
                  <div className="flex border-b border-[var(--border)] bg-[#1e1e1e]">
                    <button
                      type="button"
                      onClick={() => setActiveTab("general")}
                      className={`flex items-center gap-2 px-4 py-2.5 text-xs font-bold transition-all border-b-2 ${
                        activeTab === "general"
                          ? "border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--surface)]"
                          : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      <Settings className="w-3.5 h-3.5" />
                      General
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab("ssh")}
                      className={`flex items-center gap-2 px-4 py-2.5 text-xs font-bold transition-all border-b-2 ${
                        activeTab === "ssh"
                          ? "border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--surface)]"
                          : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      <Shield className="w-3.5 h-3.5" />
                      SSH / Tunneling
                      {formData.sshEnabled && <span className="w-1.5 h-1.5 bg-[var(--color-success)] rounded-full" />}
                    </button>
                  </div>
                )}

                {/* Tab Content */}
                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                  {activeTab === "general" && (
                    <>
                      {/* General Settings */}
                      <div className="space-y-4">
                        <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] pb-2 border-b border-[var(--border)]">General Settings</h4>
                        
                        <div>
                          <label className="block text-xs font-bold mb-1.5 text-[var(--text-primary)]">Connection Name</label>
                          <input
                            type="text"
                            value={formData.name}
                            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                            className="w-full px-4 py-2.5 text-sm rounded bg-[#2d2d2d] border border-[#444] focus:border-[var(--color-accent)] focus:bg-[#333] transition-colors outline-none font-medium shadow-inner"
                            placeholder="Production Database"
                            required
                          />
                        </div>

                        {/* Connection Color */}
                        <div className="flex items-center gap-3">
                          <label className="text-xs font-bold text-[var(--text-primary)] shrink-0">Color</label>
                          <input
                            type="color"
                            value={formData.color}
                            onChange={(e) => setFormData({ ...formData, color: e.target.value })}
                            className="w-7 h-7 rounded cursor-pointer border border-[#444] bg-transparent"
                            title="Pick a color"
                          />
                          {[
                            "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899",
                            "#ef4444", "#f97316", "#eab308", "#22c55e",
                            "#14b8a6", "#64748b", "#1e293b", "#ffffff",
                          ].map((color) => (
                            <button
                              key={color}
                              type="button"
                              onClick={() => setFormData({ ...formData, color })}
                              className={`w-5 h-5 rounded-full border transition-all ${
                                formData.color === color ? "border-white scale-110" : "border-transparent hover:scale-105"
                              }`}
                              style={{ backgroundColor: color }}
                            />
                          ))}
                        </div>
                        
                        {formData.type === "sqlite" ? (
                          <div>
                            <label className="block text-xs font-bold mb-1.5 text-[var(--text-primary)]">File Path (Absolute)</label>
                            <input
                              type="text"
                              value={formData.filepath}
                              onChange={(e) => setFormData({ ...formData, filepath: e.target.value })}
                              className="w-full px-4 py-2.5 text-sm rounded bg-[#2d2d2d] border border-[#444] focus:border-[var(--color-accent)] focus:bg-[#333] transition-colors outline-none font-mono text-cyan-300"
                              placeholder="/absolute/path/to/database.db"
                            />
                          </div>
                        ) : (
                          <>
                            <div className="grid grid-cols-3 gap-4">
                              <div className="col-span-2">
                                <label className="block text-xs font-bold mb-1.5 text-[var(--text-primary)]">Host / Server</label>
                                <input
                                  type="text"
                                  value={formData.host}
                                  onChange={(e) => setFormData({ ...formData, host: e.target.value })}
                                  className="w-full px-4 py-2.5 text-sm rounded bg-[#2d2d2d] border border-[#444] focus:border-[var(--color-accent)] focus:bg-[#333] transition-colors outline-none font-mono"
                                  placeholder="localhost"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-bold mb-1.5 text-[var(--text-primary)]">Port</label>
                                <input
                                  type="text"
                                  value={formData.port}
                                  onChange={(e) => setFormData({ ...formData, port: e.target.value })}
                                  className="w-full px-4 py-2.5 text-sm rounded bg-[#2d2d2d] border border-[#444] focus:border-[var(--color-accent)] focus:bg-[#333] transition-colors outline-none font-mono text-amber-300"
                                  placeholder={formData.type === "postgres" ? "5432" : "3306"}
                                />
                              </div>
                            </div>
                            
                            <div>
                              <label className="block text-xs font-bold mb-1.5 text-[var(--text-primary)]">Target Database</label>
                              <input
                                type="text"
                                value={formData.database}
                                onChange={(e) => setFormData({ ...formData, database: e.target.value })}
                                className="w-full px-4 py-2.5 text-sm rounded bg-[#2d2d2d] border border-[#444] focus:border-[var(--color-accent)] focus:bg-[#333] transition-colors outline-none font-mono text-purple-300"
                                placeholder="database_name"
                                required
                              />
                            </div>
                          </>
                        )}
                      </div>

                      {/* Authentication - ONLY IF NOT SQLITE */}
                      {formData.type !== "sqlite" && (
                        <div className="space-y-4 pt-2">
                          <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] pb-2 border-b border-[var(--border)]">Authentication</h4>
                          
                          {vaultCredentials.length > 0 && (
                            <div className="mb-2">
                              <label className="block text-[10px] font-bold mb-1 text-[var(--text-primary)]">Vault Profile</label>
                              <select
                                value={formData.vaultCredentialId}
                                onChange={(e) => setFormData({ ...formData, vaultCredentialId: e.target.value })}
                                className="w-full px-3 py-1.5 text-xs rounded bg-[#2d2d2d] border border-[#444] focus:border-[var(--color-accent)] focus:bg-[#333] transition-colors outline-none text-white"
                              >
                                <option value="">Manual</option>
                                {vaultCredentials.map(c => (
                                  <option key={c.id} value={c.id}>{c.name} ({c.username})</option>
                                ))}
                              </select>
                            </div>
                          )}

                          {!formData.vaultCredentialId && (
                            <div className="grid grid-cols-2 gap-4 animate-in fade-in slide-in-from-top-1 duration-200">
                              <div>
                                <label className="block text-xs font-bold mb-1.5 text-[var(--text-primary)]">Username</label>
                                <input
                                  type="text"
                                  value={formData.username}
                                  onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                                  className="w-full px-4 py-2.5 text-sm rounded bg-[#2d2d2d] border border-[#444] focus:border-[var(--color-accent)] focus:bg-[#333] transition-colors outline-none font-mono text-green-300 shadow-inner"
                                  placeholder={formData.type === "postgres" ? "postgres" : "root"}
                                />
                              </div>
                              
                              <div>
                                <label className="block text-xs font-bold mb-1.5 text-[var(--text-primary)]">Password</label>
                                <input
                                  type="password"
                                  value={formData.password}
                                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                                  className="w-full px-4 py-2.5 text-sm rounded bg-[#2d2d2d] border border-[#444] focus:border-[var(--color-accent)] focus:bg-[#333] transition-colors outline-none font-mono shadow-inner"
                                  placeholder="••••••••••"
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}

                  {activeTab === "ssh" && formData.type !== "sqlite" && (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between pb-2 border-b border-[var(--border)]">
                        <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)]">SSH Tunnel</h4>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={formData.sshEnabled}
                            onChange={(e) => setFormData({ ...formData, sshEnabled: e.target.checked })}
                            className="w-4 h-4 rounded accent-[var(--color-accent)]"
                          />
                          <span className="text-xs font-bold text-[var(--text-primary)]">Enable SSH</span>
                        </label>
                      </div>

                      {formData.sshEnabled ? (
                        <div className="space-y-4 animate-in fade-in slide-in-from-top-1 duration-200">
                          <div className="grid grid-cols-3 gap-4">
                            <div className="col-span-2">
                              <label className="block text-xs font-bold mb-1.5 text-[var(--text-primary)]">SSH Host</label>
                              <input
                                type="text"
                                value={formData.sshHost}
                                onChange={(e) => setFormData({ ...formData, sshHost: e.target.value })}
                                className="w-full px-4 py-2.5 text-sm rounded bg-[#2d2d2d] border border-[#444] focus:border-[var(--color-accent)] focus:bg-[#333] transition-colors outline-none font-mono"
                                placeholder="bastion.example.com"
                              />
                            </div>
                            <div>
                              <label className="block text-xs font-bold mb-1.5 text-[var(--text-primary)]">SSH Port</label>
                              <input
                                type="text"
                                value={formData.sshPort}
                                onChange={(e) => setFormData({ ...formData, sshPort: e.target.value })}
                                className="w-full px-4 py-2.5 text-sm rounded bg-[#2d2d2d] border border-[#444] focus:border-[var(--color-accent)] focus:bg-[#333] transition-colors outline-none font-mono text-amber-300"
                                placeholder="22"
                              />
                            </div>
                          </div>

                          <div>
                            <label className="block text-xs font-bold mb-1.5 text-[var(--text-primary)]">SSH Username</label>
                            <input
                              type="text"
                              value={formData.sshUsername}
                              onChange={(e) => setFormData({ ...formData, sshUsername: e.target.value })}
                              className="w-full px-4 py-2.5 text-sm rounded bg-[#2d2d2d] border border-[#444] focus:border-[var(--color-accent)] focus:bg-[#333] transition-colors outline-none font-mono text-green-300"
                              placeholder="deploy"
                            />
                          </div>

                          <div>
                            <label className="block text-xs font-bold mb-1.5 text-[var(--text-primary)]">Authentication Method</label>
                            <div className="flex gap-4">
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="radio"
                                  name="sshAuth"
                                  checked={formData.sshAuthMethod === "password"}
                                  onChange={() => setFormData({ ...formData, sshAuthMethod: "password" })}
                                  className="w-4 h-4 accent-[var(--color-accent)]"
                                />
                                <span className="text-xs text-[var(--text-primary)]">Password</span>
                              </label>
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="radio"
                                  name="sshAuth"
                                  checked={formData.sshAuthMethod === "key"}
                                  onChange={() => setFormData({ ...formData, sshAuthMethod: "key" })}
                                  className="w-4 h-4 accent-[var(--color-accent)]"
                                />
                                <span className="text-xs text-[var(--text-primary)]">Private Key</span>
                              </label>
                            </div>
                          </div>

                          {formData.sshAuthMethod === "password" && (
                            <div>
                              <label className="block text-xs font-bold mb-1.5 text-[var(--text-primary)]">SSH Password</label>
                              <input
                                type="password"
                                value={formData.sshPassword}
                                onChange={(e) => setFormData({ ...formData, sshPassword: e.target.value })}
                                className="w-full px-4 py-2.5 text-sm rounded bg-[#2d2d2d] border border-[#444] focus:border-[var(--color-accent)] focus:bg-[#333] transition-colors outline-none font-mono shadow-inner"
                                placeholder="••••••••••"
                              />
                            </div>
                          )}

                          {formData.sshAuthMethod === "key" && (
                            <>
                              <div>
                                <label className="block text-xs font-bold mb-1.5 text-[var(--text-primary)]">Private Key Path</label>
                                <input
                                  type="text"
                                  value={formData.sshKeyPath}
                                  onChange={(e) => setFormData({ ...formData, sshKeyPath: e.target.value })}
                                  className="w-full px-4 py-2.5 text-sm rounded bg-[#2d2d2d] border border-[#444] focus:border-[var(--color-accent)] focus:bg-[#333] transition-colors outline-none font-mono text-cyan-300"
                                  placeholder="/home/user/.ssh/id_ed25519"
                                />
                              </div>
                              <div>
                                <label className="block text-xs font-bold mb-1.5 text-[var(--text-primary)]">Key Passphrase (Optional)</label>
                                <input
                                  type="password"
                                  value={formData.sshKeyPassphrase}
                                  onChange={(e) => setFormData({ ...formData, sshKeyPassphrase: e.target.value })}
                                  className="w-full px-4 py-2.5 text-sm rounded bg-[#2d2d2d] border border-[#444] focus:border-[var(--color-accent)] focus:bg-[#333] transition-colors outline-none font-mono shadow-inner"
                                  placeholder="••••••••••"
                                />
                              </div>
                            </>
                          )}

                          <div className="p-3 bg-[#2d2d2d] rounded-lg border border-[#444]">
                            <p className="text-[10px] text-[var(--text-secondary)]">
                              <span className="font-bold text-[var(--text-primary)]">How it works:</span> An SSH tunnel will be created on a free local port. 
                              Your database connection will route through the SSH server to reach the target host securely.
                            </p>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center py-12 text-center">
                          <Shield className="w-12 h-12 text-[var(--text-secondary)] opacity-30 mb-4" />
                          <p className="text-sm text-[var(--text-secondary)] mb-2">SSH tunneling is disabled</p>
                          <p className="text-[10px] text-[var(--text-secondary)]">Enable SSH above to connect through a bastion host or SSH tunnel</p>
                        </div>
                      )}
                    </div>
                  )}

                  {formData.type === "sqlite" && (
                    <div className="flex flex-col items-center justify-center py-12 text-center">
                      <Database className="w-12 h-12 text-[var(--text-secondary)] opacity-30 mb-4" />
                      <p className="text-sm text-[var(--text-secondary)]">SQLite connections use local files</p>
                      <p className="text-[10px] text-[var(--text-secondary)]">SSH tunneling is not available for SQLite databases</p>
                    </div>
                  )}

                  {/* Error & Test Feedback */}
                  {error && (
                    <div className="p-3 rounded-lg border text-xs flex items-start gap-3 bg-red-500/10 border-red-500/30 text-red-400">
                      <ServerCrash className="w-5 h-5 flex-shrink-0 mt-0.5" />
                      <div className="font-mono">{error}</div>
                    </div>
                  )}
                  
                  {testResult?.success && (
                    <div className="p-3 flex items-start gap-3 bg-green-500/10 border border-green-500/30 text-green-400 rounded-lg text-xs font-bold">
                      <CheckCircle className="w-5 h-5 flex-shrink-0" />
                      <div>{testResult.message}</div>
                    </div>
                  )}
                </div>
              </form>
            </div>
            
            {/* Footer Actions */}
            <div className="p-4 border-t border-[var(--border)] bg-[#1e1e1e] flex items-center justify-between shadow-[0_-4px_10px_rgba(0,0,0,0.1)] z-10">
              <div className="flex gap-2">
                {!connection && (
                  <button onClick={() => setStep("driver")} className="px-5 py-2 text-xs font-bold rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[#333] transition-colors text-white">
                    &lt; Back to Providers
                  </button>
                )}
                {connection && (
                  <button onClick={() => { removeConnection(connection.id); onClose(); }} className="px-5 py-2 text-xs font-bold rounded-lg border border-red-500/30 bg-red-500/10 text-red-500 hover:bg-red-500/20 transition-colors">
                    Delete Target
                  </button>
                )}
              </div>
              
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={handleTestOnly}
                  disabled={isConnecting || !formData.name}
                  className="px-6 py-2 text-xs font-bold rounded-lg border border-[var(--border)] bg-[var(--surface)] hover:bg-[#333] transition-colors text-white disabled:opacity-50 flex items-center gap-2"
                >
                  {isConnecting && <span className="animate-pulse w-2 h-2 rounded-full bg-amber-400" />}
                  {isConnecting ? "Negotiating..." : "Test Connection"}
                </button>
                
                <button
                  type="submit"
                  form="connection-form"
                  disabled={isConnecting || !formData.name}
                  className="px-8 py-2 text-xs font-bold rounded-lg bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-all shadow-lg shadow-[var(--color-accent)]/20 disabled:opacity-50"
                >
                  Finish
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}