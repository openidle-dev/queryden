import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

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
  theme: "dark" | "light" | "system";
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
  
  // Export Formats
  enabledExportFormats: string[];
  
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

  // Export Formats
  enabledExportFormats: ["csv", "json", "xml", "html", "sql"],
};

function isTauri(): boolean {
  return typeof window !== 'undefined' && (
    !!(window as any).__TAURI_INTERNALS__ || 
    !!(window as any).__TAURI__
  );
}

const loadFromFile = async (): Promise<Partial<DBSettings>> => {
  if (!isTauri()) return {};
  try {
    const settings = await invoke<any>("load_settings");
    return settings || {};
  } catch {
    return { };
  }
};

const saveToFile = async (settings: Partial<DBSettings>) => {
  if (!isTauri()) return;
  try {
    await invoke("save_settings", { settings });
  } catch (e) {
    console.error("Failed to save settings:", e);
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
    // Load from encrypted Rust storage
    const fileSettings = await loadFromFile();
    if (fileSettings && Object.keys(fileSettings).length > 0) {
      useSettings.setState({ ...defaultSettings, ...fileSettings });
    }
    
    // Initialize vault state from loaded settings
    const { useVault } = await import('./vaultStore');
    useVault.getState().initFromSettings();
  })();
}