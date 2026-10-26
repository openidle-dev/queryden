import { create } from "zustand";
import { invokeCmd } from "../lib/ipc";
import { logger } from "../utils/logger";

export interface DBSettings {
  // Explorer View Options
  showForeignTables: boolean;
  showTriggers: boolean;
  showFunctions: boolean;
  showViews: boolean;
  showTables: boolean;
  showIndexes: boolean;
  showConstraints: boolean;
  showSequences: boolean;
  showTypes: boolean;
  showProcedures: boolean;
  showOperators: boolean;
  showAllNamespaces: boolean;
  showEmptyGroups: boolean;
  
  // SQL Code Completion
  suggestObjectsFrom: "currentScope" | "allSchemas";
  qualifyObjects: "onCollisions" | "always" | "never";
  joinCompletion: boolean;
  suggestAliases: boolean;
  
  // Query Execution
  executeOnEnter: boolean;
  executeInSeparateThread: boolean;
  maxRowsToDisplay: number;
  resultSetPrefetchSize: number;
  enableQueryVariables: boolean;
  
  // Appearance
  theme: "dark" | "light" | "blue" | "system";
  showTreeIndentGuides: boolean;
  compactMode: boolean;
  widescreenLayout: boolean;
  editorFontSize: number;
  editorFontFamily: string;
  editorTabSize: number;
  editorWordWrap: boolean;
  editorLineNumbers: boolean;
  editorMinimap: boolean;
  
  // Copy/Transfer
  copyMethod: "insert" | "copy" | "pgdump";
  copyBatchSize: number;
  copyParallel: number;
  copyCompression: boolean;
  copyVerifyAfter: boolean;
  copyAllowExecute: boolean;
  copyLoggingLevel: "minimal" | "normal" | "verbose";
  
  // Permissions & Rules
  allowSqlExecute: boolean;
  safetyWarnOnTruncate: boolean;
  safetyWarnOnDeleteNoWhere: boolean;
  bypassSafetyRules: boolean;
  
  // Vault
  hasVaultEnabled: boolean;

  // Startup — reconnect the previously-active connection (best effort).
  autoReconnect: boolean;

  // Updates
  updateChannel: "stable" | "beta";

  // Auto Save
  autoSaveEnabled: boolean;
  autoSaveInterval: number;  // seconds
  autoSavePath: string;       // empty = default (appDataDir/auto-save)

  // AI Assistant
  aiProvider: "openai" | "anthropic" | "google" | "local";
  aiApiKey: string;
  aiModel: string;
  aiEndpoint: string;
  aiEnabled: boolean;

  // Export Formats
  enabledExportFormats: string[];
  /** Excel export was enabled once for users who saved settings before it existed. */
  excelExportOffered: boolean;
  
  // Actions
  setSetting: <K extends keyof DBSettings>(key: K, value: DBSettings[K]) => void;
  resetSettings: () => void;
}

const defaultSettings: Omit<DBSettings, "setSetting" | "resetSettings"> = {
  // Explorer View Options
  showForeignTables: false,
  showTriggers: true,
  showFunctions: true,
  showViews: true,
  showTables: true,
  showIndexes: true,
  showConstraints: true,
  showSequences: true,
  showTypes: true,
  showProcedures: true,
  showOperators: true,
  showAllNamespaces: false,
  showEmptyGroups: false,
  
  // SQL Code Completion
  suggestObjectsFrom: "allSchemas",
  qualifyObjects: "onCollisions",
  joinCompletion: true,
  suggestAliases: true,
  
  // Query Execution
  executeOnEnter: false,
  executeInSeparateThread: true,
  maxRowsToDisplay: 1000,
  resultSetPrefetchSize: 100,
  enableQueryVariables: true,
  
  // Appearance
  theme: "dark",
  showTreeIndentGuides: true,
  compactMode: false,
  widescreenLayout: false,
  editorFontSize: 13,
  editorFontFamily: "JetBrains Mono",
  editorTabSize: 2,
  editorWordWrap: false,
  editorLineNumbers: true,
  editorMinimap: false,
  
  // Copy/Transfer
  copyMethod: "insert",
  copyBatchSize: 1000,
  copyParallel: 4,
  copyCompression: true,
  copyVerifyAfter: true,
  copyAllowExecute: true,
  copyLoggingLevel: "normal",
  
  // Permissions & Rules
  allowSqlExecute: true,
  safetyWarnOnTruncate: true,
  safetyWarnOnDeleteNoWhere: true,
  bypassSafetyRules: false,
  
  // Vault
  hasVaultEnabled: true,

  // Startup — reconnect the previously-active connection (best effort).
  autoReconnect: true,

  // Updates
  updateChannel: "stable",

  // Export Formats
  enabledExportFormats: ["csv", "excel", "json", "xml", "html", "sql"],
  excelExportOffered: true,

  // AI Assistant
  aiProvider: "openai",
  aiApiKey: "",
  aiModel: "gpt-5.5",
  aiEndpoint: "",
  aiEnabled: false,

  // Auto Save
  autoSaveEnabled: true,
  autoSaveInterval: 30,
  autoSavePath: "",
};

function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as Window & { __TAURI_INTERNALS__?: unknown; __TAURI__?: unknown };
  return !!w.__TAURI_INTERNALS__ || !!w.__TAURI__;
}

/**
 * Resolves once the persisted settings file has been read (or the read was
 * skipped/failed). Startup flows that depend on a user-toggled setting
 * (e.g. auto-reconnect) must await this first — otherwise the default would
 * win the race against the user's saved preference.
 */
let resolveSettingsReady: () => void = () => undefined;
export const settingsReady: Promise<void> = new Promise<void>((res) => {
  resolveSettingsReady = res;
});

// Set when settings.json exists but couldn't be read: saving the in-memory
// defaults afterwards would overwrite every setting the user has.
let settingsReadFailed = false;

const loadFromFile = async (): Promise<Partial<DBSettings>> => {
  if (!isTauri()) return {};
  try {
    const settings = await invokeCmd("load_settings");
    // Settings are user-mutable JSON; treat as unknown and narrow via the
    // defaultSettings spread below rather than trusting the shape blindly.
    return (settings as Partial<DBSettings>) ?? {};
  } catch (e) {
    settingsReadFailed = true;
    logger.error("Failed to load settings — changes will not be saved this session:", e);
    return {};
  }
};

const saveToFile = async (settings: Partial<DBSettings>) => {
  if (!isTauri() || settingsReadFailed) return;
  try {
    await invokeCmd("save_settings", { settings });
  } catch (e) {
    logger.error("Failed to save settings:", e);
  }
};

export const useSettings = create<DBSettings>()((set, get) => ({
  ...defaultSettings,
  
  setSetting: async (key, value) => {
    set((state) => ({ ...state, [key]: value }));
    saveToFile(get());
  },
  
  resetSettings: async () => {
    set(() => defaultSettings);
    saveToFile(defaultSettings);
  },
}));

// Initialize settings from file
if (typeof window !== "undefined") {
  (async () => {
    try {
      // Load from encrypted Rust storage
      const fileSettings = await loadFromFile();
      if (fileSettings && Object.keys(fileSettings).length > 0) {
        const merged = { ...defaultSettings, ...fileSettings };
        // One-time: Excel (.xlsx) export arrived after users saved their
        // format list; switch it on once rather than leaving it hidden.
        if (!merged.excelExportOffered) {
          merged.excelExportOffered = true;
          if (!merged.enabledExportFormats.includes("excel")) {
            merged.enabledExportFormats = [...merged.enabledExportFormats, "excel"];
          }
          saveToFile(merged);
        }
        useSettings.setState(merged);
      }

      // Initialize vault state from loaded settings
      const { useVault } = await import('./vaultStore');
      useVault.getState().initFromSettings();

      // Sync persisted AI settings to aiStore
      const s = useSettings.getState();
      const { useAI } = await import('./aiStore');
      useAI.setState({
        provider: s.aiProvider,
        apiKey: s.aiApiKey,
        model: s.aiModel,
        endpoint: s.aiEndpoint,
        enabled: s.aiEnabled,
      });
    } finally {
      resolveSettingsReady();
    }
  })();
}