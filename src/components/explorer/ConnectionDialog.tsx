import { useState, useEffect, useMemo } from "react";
import { DatabaseConnection } from "../../contexts/ConnectionContext";
import { useConnections } from "../../contexts/useConnections";
import { CheckCircle, Database, ServerCrash, Search, Settings, Shield } from "lucide-react";
import { useConfirmDialog } from "../ui/ConfirmDialog";
import { PasswordInput } from "../ui/PasswordInput";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";

import { PROVIDERS } from "../../config/providers";
import { getDefaultDatabaseName } from "../../config/app";
import { CONNECTION_COLOR_PRESETS, DEFAULT_CONNECTION_COLOR } from "../../config/connectionColors";
import { filterProviders, getComingSoonCount } from "./filterProviders";
import { invokeCmd } from "../../lib/ipc";

// Radix Select reserves the empty string, so root/manual options need sentinels.
const ROOT_FOLDER = "__root__";
const MANUAL_VAULT = "__manual__";

// Password / hex inputs can't use the <Input> primitive (PasswordInput owns its
// own markup; the hex field shares a widget with the swatch), so they reuse this
// to match the primitive's compact, tokenized look.
const fieldInputClass =
  "w-full h-7 px-2.5 text-xs rounded-md bg-[var(--surface-base)] border border-[var(--neutral-7)] " +
  "text-[var(--neutral-12)] placeholder:text-[var(--neutral-9)] outline-none transition-colors " +
  "focus:border-[var(--accent-8)] focus:ring-1 focus:ring-[var(--accent-8)]/30";

const fieldLabelClass = "text-xs font-medium text-[var(--neutral-12)] select-none";

const getValidHexColor = (color: string): string => {
  if (!color) return DEFAULT_CONNECTION_COLOR;
  const trimmed = color.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(trimmed)) return trimmed;
  if (/^#[0-9a-f]{3}$/.test(trimmed)) {
    return '#' + trimmed[1] + trimmed[1] + trimmed[2] + trimmed[2] + trimmed[3] + trimmed[3];
  }
  // Parse rgb(r, g, b)
  const rgbMatch = trimmed.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\)$/);
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1], 10);
    const g = parseInt(rgbMatch[2], 10);
    const b = parseInt(rgbMatch[3], 10);
    const toHex = (c: number) => {
      const hex = Math.max(0, Math.min(255, c)).toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    };
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }
  return DEFAULT_CONNECTION_COLOR; // default fallback for HTML color input
};

export function ConnectionDialog({ connection, onClose, defaultFolderId }: { connection?: DatabaseConnection; onClose: () => void; defaultFolderId?: string }) {
  const { addConnection, updateConnection, removeConnection, vaultCredentials, folders } = useConnections();
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
    color: connection?.color || DEFAULT_CONNECTION_COLOR,
    // SSH fields
    sshEnabled: connection?.sshEnabled || false,
    sshHost: connection?.sshHost || "",
    sshPort: connection?.sshPort?.toString() || "22",
    sshUsername: connection?.sshUsername || "",
    sshPassword: connection?.sshPassword || "",
    sshKeyPath: connection?.sshKeyPath || "",
    sshKeyPassphrase: connection?.sshKeyPassphrase || "",
    sshAuthMethod: connection?.sshKeyPath ? "key" : "password",
    selectedFolderId: connection?.folderId || defaultFolderId || "",
  });
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [isTestingSsh, setIsTestingSsh] = useState(false);
  const [sshTestResult, setSshTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const confirmDialog = useConfirmDialog();

  const flatFolders = useMemo(() => {
    const flat: { folder: typeof folders[0]; depth: number }[] = [];
    const walk = (parentId: string | null, depth: number) => {
      const siblings = folders
        .filter((f) => (f.parentId ?? null) === parentId)
        .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
      for (const f of siblings) {
        flat.push({ folder: f, depth });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    return flat;
  }, [folders]);

  // Focus effect when switching steps
  useEffect(() => {
    if (step === "details" && !formData.name && formData.type) {
      setFormData(prev => ({ ...prev, name: `Local ${prev.type.charAt(0).toUpperCase() + prev.type.slice(1)}` }));
    }
  }, [step]);

  const testConnection = async (): Promise<{ success: boolean; message: string }> => {
    setIsConnecting(true);
    setError(null);
    setTestResult(null);

    const supportedDrivers = ["sqlite", "postgres", "supabase", "cockroach", "mysql", "mariadb"];
    if (!supportedDrivers.includes(formData.type)) {
      setIsConnecting(false);
      return {
        success: false,
        message: `The '${PROVIDERS.find(p => p.id === formData.type)?.name || formData.type}' provider is either coming soon or not supported by the underlying Tauri driver.`
      };
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

    // Resolve credentials (vault override takes precedence over inline fields).
    const defaultUser = ["mysql", "mariadb"].includes(formData.type) ? "root" : "postgres";
    let user = formData.username || defaultUser;
    let pass = formData.password || "";
    if (formData.vaultCredentialId) {
      const cred = vaultCredentials.find(c => c.id === formData.vaultCredentialId);
      if (cred) {
        user = cred.username || user;
        pass = cred.password || pass;
      }
    }
    const encodedUser = encodeURIComponent(user);
    const encodedPass = encodeURIComponent(pass);

    // Default ports must match the per-engine fallbacks the connect path uses.
    const defaultPort = formData.type === "cockroach" ? 26257
      : ["mysql", "mariadb"].includes(formData.type) ? 3306
      : 5432;
    let actualHost = formData.host || "localhost";
    let actualPort = parseInt(formData.port, 10) || defaultPort;
    const database = formData.database
      || (formData.type === "cockroach" ? "defaultdb"
        : ["mysql", "mariadb"].includes(formData.type) ? "mysql"
        : "postgres");

    // #46: If SSH tunneling is enabled, the target DB host is unreachable from
    // this machine — only the SSH gateway is. Mirror the production connect
    // path (ConnectionContext.connectToDatabase) and open a tunnel, then
    // connect to 127.0.0.1:<local_port>. Tear the tunnel down in `finally`
    // so a successful test doesn't leak a long-lived tunnel.
    const useSshTunnel =
      formData.type !== "sqlite" &&
      formData.sshEnabled &&
      !!formData.sshHost &&
      !!formData.sshUsername;
    const testTunnelId = useSshTunnel ? `__test_${crypto.randomUUID()}` : null;

    try {
      if (useSshTunnel && testTunnelId) {
        try {
          const tunnelResult = await invokeCmd("create_ssh_tunnel", {
            connectionId: testTunnelId,
            sshHost: formData.sshHost,
            sshPort: parseInt(formData.sshPort, 10) || 22,
            sshUsername: formData.sshUsername,
            sshPassword: formData.sshAuthMethod === "password" ? (formData.sshPassword || null) : null,
            sshKeyPath: formData.sshAuthMethod === "key" ? (formData.sshKeyPath || null) : null,
            sshKeyPassphrase: formData.sshAuthMethod === "key" ? (formData.sshKeyPassphrase || null) : null,
            remoteHost: actualHost,
            remotePort: actualPort,
          });
          actualHost = "127.0.0.1";
          actualPort = tunnelResult.local_port;
        } catch (err: any) {
          setIsConnecting(false);
          return { success: false, message: `SSH tunnel failed: ${err?.message || err}` };
        }
      }

      let connectionString = "";
      if (formData.type === "sqlite") {
        connectionString = `sqlite:${formData.filepath || getDefaultDatabaseName()}`;
      } else if (["postgres", "supabase", "cockroach"].includes(formData.type)) {
        connectionString = `postgres://${encodedUser}:${encodedPass}@${actualHost}:${actualPort}/${database}`;
      } else if (["mysql", "mariadb"].includes(formData.type)) {
        connectionString = `mysql://${encodedUser}:${encodedPass}@${actualHost}:${actualPort}/${database}`;
      }

      const Database = await import("@tauri-apps/plugin-sql");
      if (!Database.default) {
        return { success: false, message: "SQL plugin not available. Please run the app in Tauri." };
      }

      const db = await Database.default.load(connectionString);
      await db.select("SELECT 1");
      await db.close();
      return { success: true, message: "Connection successful!" };
    } catch (err: any) {
      console.error("Connection test error:", err);
      const errorMsg = err.message || err.toString() || "Unknown error occurred";
      return { success: false, message: errorMsg };
    } finally {
      if (testTunnelId) {
        try {
          await invokeCmd("close_ssh_tunnel", { connectionId: testTunnelId });
        } catch (err) {
          console.warn("Failed to close test SSH tunnel:", err);
        }
      }
      setIsConnecting(false);
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
      folderId: formData.selectedFolderId || null,
    };

    if (connection) {
      updateConnection(conn.id, conn);
    } else {
      addConnection(conn);
    }

    onClose();
  };

  const handleTestSsh = async () => {
    setIsTestingSsh(true);
    setSshTestResult(null);
    try {
      const isTauri = typeof window !== 'undefined' && (
        !!(window as any).__TAURI_INTERNALS__ ||
        !!(window as any).__TAURI__
      );
      if (!isTauri) {
        setSshTestResult({ success: false, message: "SSH tests only work in the desktop app." });
        return;
      }
      if (!formData.sshHost || !formData.sshUsername) {
        setSshTestResult({ success: false, message: "SSH host and username are required." });
        return;
      }
      await invokeCmd("test_ssh_connection", {
        sshHost: formData.sshHost,
        sshPort: parseInt(formData.sshPort, 10) || 22,
        sshUsername: formData.sshUsername,
        sshPassword: formData.sshAuthMethod === "password" ? (formData.sshPassword || null) : null,
        sshKeyPath: formData.sshAuthMethod === "key" ? (formData.sshKeyPath || null) : null,
        sshKeyPassphrase: formData.sshAuthMethod === "key" ? (formData.sshKeyPassphrase || null) : null,
      });
      setSshTestResult({ success: true, message: "SSH authentication succeeded." });
    } catch (err: any) {
      setSshTestResult({ success: false, message: err?.message || err?.toString() || "SSH test failed." });
    } finally {
      setIsTestingSsh(false);
    }
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
  const activeProvider = PROVIDERS.find(p => p.id === formData.type);

  return (
    <Dialog
      open
      onClose={onClose}
      dismissOnBackdrop={false}
      className="w-[900px] max-w-[95vw] h-[640px] max-h-[90vh] overflow-hidden animate-in fade-in zoom-in duration-100"
    >
      <Dialog.Title onClose={onClose}>
        <span className="inline-flex items-center gap-3">
          <span className="p-1.5 bg-[var(--accent-3)] rounded">
            <Database className="w-4 h-4 text-[var(--accent-11)]" />
          </span>
          <span className="flex flex-col leading-tight">
            <span>{step === "driver" ? "Select your database" : (connection ? "Edit Connection" : "Connection Details")}</span>
            <span className="text-[10px] font-normal text-[var(--neutral-11)]">
              {step === "driver"
                ? "Create a new database connection. Find your driver in the list below."
                : `Configure connection settings for ${activeProvider?.name}.`}
            </span>
          </span>
        </span>
      </Dialog.Title>

      {/* Step 1: Provider Selection */}
      {step === "driver" && (
        <div className="flex-1 flex flex-col min-h-0 bg-[var(--surface-panel)]">
          {/* Search Bar */}
          <div className="p-3 border-b border-[var(--neutral-6)] bg-[var(--surface-elevated)] flex gap-2 items-center">
            <div className="flex-1">
              <Input
                inputSize="sm"
                leftIcon={<Search />}
                placeholder="Type part of database/driver name to filter"
                value={searchFilter}
                onChange={e => setSearchFilter(e.target.value)}
              />
            </div>
            <label className="text-[10px] text-[var(--neutral-11)] flex items-center gap-1.5 mr-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
                className="w-3 h-3 accent-[var(--accent-9)] cursor-pointer"
              />
              <span>Show all ({comingSoonCount})</span>
            </label>
            <div className="text-[10px] text-[var(--neutral-11)] flex items-center gap-1.5 mr-2">
              <span>View:</span>
              <Button size="xs" variant={viewMode === "grid" ? "primary" : "ghost"} onClick={() => setViewMode("grid")}>
                Tiles
              </Button>
              <Button size="xs" variant={viewMode === "list" ? "primary" : "ghost"} onClick={() => setViewMode("list")}>
                List
              </Button>
            </div>
          </div>

          <div className="flex flex-1 min-h-0">
            {/* Left Category Sidebar */}
            <div className="w-48 bg-[var(--surface-elevated)] border-r border-[var(--neutral-6)] py-2 overflow-y-auto">
              {categories.map(c => (
                <button
                  key={c}
                  onClick={() => setDriverCategory(c)}
                  className={`w-full text-left px-4 py-1.5 text-[11px] font-bold ${driverCategory === c ? "bg-[var(--accent-3)] text-[var(--accent-11)] border-r-2 border-[var(--accent-9)]" : "text-[var(--neutral-12)] hover:bg-[var(--neutral-4)]"}`}
                >
                  {c}
                </button>
              ))}
            </div>

            {/* Content Area */}
            <div className="flex-1 p-6 overflow-y-auto bg-[var(--surface-base)]">
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
                          // #157: SQLite hides the tab row, so a stranded "ssh"
                          // tab would leave the General form (file path) unreachable.
                          setActiveTab("general");
                          setFormData(prev => ({
                            ...prev,
                            type: p.id as any,
                            port: p.defaultPort || ""
                          }));
                          setStep("details");
                        }}
                        className={`flex flex-col items-center justify-center p-4 rounded-xl border transition-all ${
                          p.comingSoon
                            ? "bg-[var(--neutral-3)] border-[var(--neutral-6)] opacity-60 cursor-not-allowed grayscale"
                            : "bg-[var(--surface-elevated)] border-[var(--neutral-7)] hover:border-[var(--accent-8)] hover:shadow-lg hover:shadow-[var(--accent-9)]/10 hover:-translate-y-1"
                        }`}
                      >
                        <div className={`p-4 rounded-lg ${p.bg} ${p.color} border border-white/5 mb-3`}>
                          <Icon className="w-10 h-10 drop-shadow-md" />
                        </div>
                        <span className="text-xs font-bold text-[var(--neutral-12)]">{p.name}</span>
                        {p.comingSoon && <span className="text-[9px] text-[var(--neutral-11)] mt-1 font-mono tracking-tighter">SOON</span>}
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
                          // #157: SQLite hides the tab row, so a stranded "ssh"
                          // tab would leave the General form (file path) unreachable.
                          setActiveTab("general");
                          setFormData(prev => ({
                            ...prev,
                            type: p.id as any,
                            port: p.defaultPort || ""
                          }));
                          setStep("details");
                        }}
                        className={`w-full flex items-center gap-4 p-3 rounded-lg border transition-all ${
                          p.comingSoon
                            ? "bg-[var(--neutral-3)] border-[var(--neutral-6)] opacity-60 cursor-not-allowed grayscale"
                            : "bg-[var(--surface-elevated)] border-[var(--neutral-7)] hover:border-[var(--accent-8)] group"
                        }`}
                      >
                        <div className={`p-2 rounded ${p.bg} ${p.color} border border-white/5`}>
                          <Icon className="w-5 h-5" />
                        </div>
                        <div className="flex-1 text-left">
                          <div className="text-sm font-bold text-[var(--neutral-12)]">{p.name}</div>
                          <div className="text-[10px] text-[var(--neutral-11)]">{p.type} • {p.defaultPort ? `Default Port: ${p.defaultPort}` : "Local File"}</div>
                        </div>
                        {p.comingSoon ? (
                          <span className="text-[9px] font-mono text-[var(--neutral-11)] px-2 py-0.5 bg-[var(--neutral-5)] rounded">COMING SOON</span>
                        ) : (
                          <div className="opacity-0 group-hover:opacity-100 transition-opacity text-[10px] font-bold text-[var(--accent-11)] uppercase">
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

          <div className="p-3 border-t border-[var(--neutral-6)] bg-[var(--surface-elevated)] flex justify-end">
            <Button size="sm" disabled>
              Next &gt;
            </Button>
          </div>
        </div>
      )}

      {/* Step 2: Connection Details */}
      {step === "details" && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex flex-1 min-h-0">
            {/* Left Sidebar - Summary */}
            <div className="w-56 bg-[var(--surface-panel)] border-r border-[var(--neutral-6)] p-4 flex flex-col items-center">
              {(() => {
                const p = activeProvider;
                const Icon = p?.icon || Database;
                return (
                  <>
                    <div className={`p-4 rounded-2xl ${p?.bg || 'bg-[var(--neutral-5)]'} ${p?.color || 'text-[var(--neutral-12)]'} border border-white/10 mb-3 shadow-xl`}>
                      <Icon className="w-12 h-12 drop-shadow-lg" />
                    </div>
                    <h2 className="text-base font-bold text-[var(--neutral-12)] mb-0.5">{p?.name}</h2>
                    <p className="text-[10px] uppercase tracking-widest text-[var(--neutral-11)] font-bold">Standard Connection</p>
                    <div className="mt-4 w-full space-y-1.5">
                      <div className="p-2 bg-[var(--surface-elevated)] rounded border border-[var(--neutral-6)] text-[11px]">
                        <span className="text-[var(--neutral-11)]">Driver: </span> <span className="font-mono text-[var(--accent-11)]">Native (Tauri)</span>
                      </div>
                      <div className="p-2 bg-[var(--surface-elevated)] rounded border border-[var(--neutral-6)] text-[11px]">
                        <span className="text-[var(--neutral-11)]">Last test: </span>
                        <span className={`font-bold ${testResult ? (testResult.success ? 'text-[var(--success-11)]' : 'text-[var(--danger-11)]') : 'text-[var(--neutral-11)]'}`}>
                          {testResult ? (testResult.success ? 'Passed' : 'Failed') : 'Not run'}
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
                <div className="flex border-b border-[var(--neutral-6)] bg-[var(--surface-panel)]">
                  <button
                    type="button"
                    onClick={() => setActiveTab("general")}
                    className={`flex items-center gap-2 px-4 py-2.5 text-xs font-bold transition-all border-b-2 ${
                      activeTab === "general"
                        ? "border-[var(--accent-9)] text-[var(--accent-11)] bg-[var(--surface-base)]"
                        : "border-transparent text-[var(--neutral-11)] hover:text-[var(--neutral-12)]"
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
                        ? "border-[var(--accent-9)] text-[var(--accent-11)] bg-[var(--surface-base)]"
                        : "border-transparent text-[var(--neutral-11)] hover:text-[var(--neutral-12)]"
                    }`}
                  >
                    <Shield className="w-3.5 h-3.5" />
                    SSH / Tunneling
                    {formData.sshEnabled && <span className="w-1.5 h-1.5 bg-[var(--success-9)] rounded-full" />}
                  </button>
                </div>
              )}

              {/* Tab Content */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {activeTab === "general" && (
                  <>
                    {/* General Settings */}
                    <div className="space-y-2.5">
                      <h4 className="text-[10px] font-bold uppercase tracking-wider text-[var(--neutral-11)] pb-1.5 border-b border-[var(--neutral-6)]">General Settings</h4>

                      <div className={folders.length > 0 ? "grid grid-cols-2 gap-2.5" : ""}>
                        <Input
                          label="Connection Name"
                          inputSize="sm"
                          value={formData.name}
                          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                          placeholder="Production Database"
                          required
                        />

                        {/* Folder */}
                        {folders.length > 0 && (
                          <Select
                            label="Folder"
                            selectSize="sm"
                            value={formData.selectedFolderId || ROOT_FOLDER}
                            onValueChange={(v) => setFormData({ ...formData, selectedFolderId: v === ROOT_FOLDER ? "" : v })}
                            options={[
                              { label: "Root (no folder)", value: ROOT_FOLDER },
                              ...flatFolders.map(({ folder, depth }) => ({
                                label: `${" ".repeat(depth * 2)}${folder.name}`,
                                value: folder.id,
                              })),
                            ]}
                          />
                        )}
                      </div>

                      {/* Connection Color */}
                      <div className="space-y-1.5">
                        <label className={fieldLabelClass}>Connection Color</label>
                        <div className="flex items-center gap-3 flex-wrap">
                          <div className="flex items-center gap-2 bg-[var(--surface-base)] border border-[var(--neutral-7)] rounded-md px-2.5 py-1.5 focus-within:border-[var(--accent-8)] focus-within:ring-1 focus-within:ring-[var(--accent-8)]/30 transition-colors w-44">
                            <div
                              className="relative w-5 h-5 rounded-full border border-[var(--neutral-7)] shadow-sm shrink-0 cursor-pointer overflow-hidden transition-all hover:scale-105"
                              style={{ backgroundColor: getValidHexColor(formData.color) }}
                            >
                              <input
                                type="color"
                                value={getValidHexColor(formData.color)}
                                onChange={(e) => setFormData({ ...formData, color: e.target.value })}
                                className="absolute inset-0 opacity-0 cursor-pointer w-full h-full scale-150"
                                title="Pick custom color"
                              />
                            </div>
                            <input
                              type="text"
                              value={formData.color}
                              onChange={(e) => setFormData({ ...formData, color: e.target.value })}
                              className="w-full bg-transparent text-xs outline-none font-mono text-[var(--neutral-12)]"
                              placeholder={DEFAULT_CONNECTION_COLOR}
                              title="Custom HEX or RGB color"
                            />
                          </div>

                          <div className="flex items-center gap-1.5 flex-wrap">
                            {CONNECTION_COLOR_PRESETS.map((color) => (
                              <button
                                key={color}
                                type="button"
                                onClick={() => setFormData({ ...formData, color })}
                                aria-label={`Set connection color ${color}`}
                                aria-pressed={formData.color === color}
                                className={`w-5 h-5 rounded-full border transition-all ${
                                  formData.color === color ? "border-[var(--neutral-12)] scale-110" : "border-transparent hover:scale-105"
                                }`}
                                style={{ backgroundColor: color }}
                                title={color}
                              />
                            ))}
                          </div>
                        </div>
                      </div>

                      {formData.type === "sqlite" ? (
                        <Input
                          label="File Path (Absolute)"
                          inputSize="sm"
                          className="font-mono"
                          value={formData.filepath}
                          onChange={(e) => setFormData({ ...formData, filepath: e.target.value })}
                          placeholder="/absolute/path/to/database.db"
                        />
                      ) : (
                        <>
                          <div className="grid grid-cols-3 gap-2.5">
                            <div className="col-span-2">
                              <Input
                                label="Host / Server"
                                inputSize="sm"
                                className="font-mono"
                                value={formData.host}
                                onChange={(e) => setFormData({ ...formData, host: e.target.value })}
                                placeholder="localhost"
                              />
                            </div>
                            <Input
                              label="Port"
                              inputSize="sm"
                              className="font-mono"
                              value={formData.port}
                              onChange={(e) => setFormData({ ...formData, port: e.target.value })}
                              placeholder={formData.type === "postgres" ? "5432" : "3306"}
                            />
                          </div>

                          <Input
                            label="Target Database"
                            inputSize="sm"
                            className="font-mono"
                            value={formData.database}
                            onChange={(e) => setFormData({ ...formData, database: e.target.value })}
                            placeholder="database_name"
                            required
                          />
                        </>
                      )}
                    </div>

                    {/* Authentication - ONLY IF NOT SQLITE */}
                    {formData.type !== "sqlite" && (
                      <div className="space-y-2.5 pt-1">
                        <h4 className="text-[10px] font-bold uppercase tracking-wider text-[var(--neutral-11)] pb-1.5 border-b border-[var(--neutral-6)]">Authentication</h4>

                        {vaultCredentials.length > 0 && (
                          <Select
                            label="Vault Profile"
                            selectSize="sm"
                            value={formData.vaultCredentialId || MANUAL_VAULT}
                            onValueChange={(v) => setFormData({ ...formData, vaultCredentialId: v === MANUAL_VAULT ? "" : v })}
                            options={[
                              { label: "Manual", value: MANUAL_VAULT },
                              ...vaultCredentials.map(c => ({ label: `${c.name} (${c.username})`, value: c.id })),
                            ]}
                          />
                        )}

                        {!formData.vaultCredentialId && (
                          <div className="grid grid-cols-2 gap-2.5 animate-in fade-in slide-in-from-top-1 duration-200">
                            <Input
                              label="Username"
                              inputSize="sm"
                              className="font-mono"
                              value={formData.username}
                              onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                              placeholder={formData.type === "postgres" ? "postgres" : "root"}
                            />

                            <div className="flex flex-col gap-1 min-w-0">
                              <label className={fieldLabelClass}>Password</label>
                              <PasswordInput
                                value={formData.password}
                                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                                className={`${fieldInputClass} font-mono`}
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
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between pb-1.5 border-b border-[var(--neutral-6)]">
                      <h4 className="text-[10px] font-bold uppercase tracking-wider text-[var(--neutral-11)]">SSH Tunnel</h4>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={formData.sshEnabled}
                          onChange={(e) => setFormData({ ...formData, sshEnabled: e.target.checked })}
                          className="w-4 h-4 rounded accent-[var(--accent-9)]"
                        />
                        <span className="text-xs font-bold text-[var(--neutral-12)]">Enable SSH</span>
                      </label>
                    </div>

                    {formData.sshEnabled ? (
                      <div className="space-y-2.5 animate-in fade-in slide-in-from-top-1 duration-200">
                        <div className="grid grid-cols-3 gap-2.5">
                          <div className="col-span-2">
                            <Input
                              label="SSH Host"
                              inputSize="sm"
                              className="font-mono"
                              value={formData.sshHost}
                              onChange={(e) => setFormData({ ...formData, sshHost: e.target.value })}
                              placeholder="bastion.example.com"
                            />
                          </div>
                          <Input
                            label="SSH Port"
                            inputSize="sm"
                            className="font-mono"
                            value={formData.sshPort}
                            onChange={(e) => setFormData({ ...formData, sshPort: e.target.value })}
                            placeholder="22"
                          />
                        </div>

                        <div className="grid grid-cols-2 gap-2.5">
                          <Input
                            label="SSH Username"
                            inputSize="sm"
                            className="font-mono"
                            value={formData.sshUsername}
                            onChange={(e) => setFormData({ ...formData, sshUsername: e.target.value })}
                            placeholder="deploy"
                          />
                          <div className="flex flex-col gap-1 min-w-0">
                            <label className={fieldLabelClass}>Authentication Method</label>
                            <div className="flex gap-4 pt-1">
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="radio"
                                  name="sshAuth"
                                  checked={formData.sshAuthMethod === "password"}
                                  onChange={() => setFormData({ ...formData, sshAuthMethod: "password" })}
                                  className="w-4 h-4 accent-[var(--accent-9)]"
                                />
                                <span className="text-xs text-[var(--neutral-12)]">Password</span>
                              </label>
                              <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                  type="radio"
                                  name="sshAuth"
                                  checked={formData.sshAuthMethod === "key"}
                                  onChange={() => setFormData({ ...formData, sshAuthMethod: "key" })}
                                  className="w-4 h-4 accent-[var(--accent-9)]"
                                />
                                <span className="text-xs text-[var(--neutral-12)]">Private Key</span>
                              </label>
                            </div>
                          </div>
                        </div>

                        {formData.sshAuthMethod === "password" && (
                          <div className="flex flex-col gap-1 min-w-0">
                            <label className={fieldLabelClass}>SSH Password</label>
                            <PasswordInput
                              value={formData.sshPassword}
                              onChange={(e) => setFormData({ ...formData, sshPassword: e.target.value })}
                              className={`${fieldInputClass} font-mono`}
                              placeholder="••••••••••"
                            />
                          </div>
                        )}

                        {formData.sshAuthMethod === "key" && (
                          <>
                            <Input
                              label="Private Key Path"
                              inputSize="sm"
                              className="font-mono"
                              value={formData.sshKeyPath}
                              onChange={(e) => setFormData({ ...formData, sshKeyPath: e.target.value })}
                              placeholder="/home/user/.ssh/id_ed25519"
                            />
                            <div className="flex flex-col gap-1 min-w-0">
                              <label className={fieldLabelClass}>Key Passphrase (Optional)</label>
                              <PasswordInput
                                value={formData.sshKeyPassphrase}
                                onChange={(e) => setFormData({ ...formData, sshKeyPassphrase: e.target.value })}
                                className={`${fieldInputClass} font-mono`}
                                placeholder="••••••••••"
                              />
                            </div>
                          </>
                        )}

                        <div className="flex items-center gap-3 pt-1">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={handleTestSsh}
                            loading={isTestingSsh}
                            disabled={!formData.sshHost || !formData.sshUsername}
                            leftIcon={<Shield className="w-3 h-3" />}
                          >
                            {isTestingSsh ? "Testing SSH..." : "Test SSH Tunnel"}
                          </Button>
                          {sshTestResult && (
                            <span className={`text-[11px] font-mono flex items-center gap-1.5 ${sshTestResult.success ? "text-[var(--success-11)]" : "text-[var(--danger-11)]"}`}>
                              {sshTestResult.success ? <CheckCircle className="w-3.5 h-3.5" /> : <ServerCrash className="w-3.5 h-3.5" />}
                              {sshTestResult.message}
                            </span>
                          )}
                        </div>

                        <p className="text-[10px] text-[var(--neutral-11)] leading-relaxed pt-0.5">
                          <span className="font-bold text-[var(--neutral-12)]">How it works:</span> An SSH tunnel is opened on a free local port and the DB connection routes through your SSH server. <span className="font-bold text-[var(--neutral-12)]">Test SSH Tunnel</span> verifies SSH auth alone — DB credentials are not required.
                        </p>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center justify-center py-10 text-center">
                        <Shield className="w-10 h-10 text-[var(--neutral-11)] opacity-30 mb-3" />
                        <p className="text-sm text-[var(--neutral-11)] mb-1">SSH tunneling is disabled</p>
                        <p className="text-[10px] text-[var(--neutral-11)]">Enable SSH above to connect through a bastion host</p>
                      </div>
                    )}
                  </div>
                )}

                {formData.type === "sqlite" && (
                  <div className="flex flex-col items-center justify-center py-10 text-center">
                    <Database className="w-10 h-10 text-[var(--neutral-11)] opacity-30 mb-3" />
                    <p className="text-sm text-[var(--neutral-11)]">SQLite connections use local files</p>
                    <p className="text-[10px] text-[var(--neutral-11)]">SSH tunneling is not available for SQLite databases</p>
                  </div>
                )}
              </div>
            </form>
          </div>

          {/* Sticky feedback strip — always visible above the footer so errors
              never hide below the fold when the form scrolls. #44 */}
          {(error || testResult?.success) && (
            <div className="border-t border-[var(--neutral-6)] bg-[var(--surface-panel)] px-4 py-2">
              {error && (
                <div className="p-2 rounded border text-[11px] flex items-start gap-2 bg-[var(--danger-3)] border-[var(--danger-6)] text-[var(--danger-11)]">
                  <ServerCrash className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <div className="font-mono break-all">{error}</div>
                </div>
              )}
              {!error && testResult?.success && (
                <div className="p-2 flex items-start gap-2 bg-[var(--success-3)] border border-[var(--success-6)] text-[var(--success-11)] rounded text-[11px] font-bold">
                  <CheckCircle className="w-4 h-4 flex-shrink-0" />
                  <div>{testResult.message}</div>
                </div>
              )}
            </div>
          )}

          {/* Footer Actions */}
          <Dialog.Footer className="justify-between">
            <div className="flex gap-2">
              {!connection && (
                <Button variant="secondary" size="md" onClick={() => { setActiveTab("general"); setStep("driver"); }}>
                  &lt; Back to Providers
                </Button>
              )}
              {connection && (
                <Button variant="destructive" size="md" onClick={() => { removeConnection(connection.id); onClose(); }}>
                  Delete Target
                </Button>
              )}
            </div>

            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                size="md"
                onClick={handleTestOnly}
                loading={isConnecting}
                disabled={!formData.name}
              >
                {isConnecting ? "Negotiating..." : "Test Connection"}
              </Button>

              <Button
                type="submit"
                form="connection-form"
                variant="primary"
                size="md"
                loading={isConnecting}
                disabled={!formData.name}
              >
                Finish
              </Button>
            </div>
          </Dialog.Footer>
        </div>
      )}
    </Dialog>
  );
}
