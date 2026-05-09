import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface KeymapAction {
  id: string;
  name: string;
  shortcut: string;
  description?: string;
}

export interface KeymapPreset {
  id: string;
  name: string;
  actions: Record<string, string>;
}

export interface KeymapSettings {
  activePreset: string;
  customActions: Record<string, string>;
  
  setPreset: (presetId: string) => void;
  setShortcut: (actionId: string, shortcut: string) => void;
  getShortcut: (actionId: string) => string | undefined;
}

const defaultKeymaps: KeymapPreset[] = [
  {
    id: "default",
    name: "Default (DataGrip)",
    actions: {
      "execute": "Ctrl+Enter",
      "executeAll": "Ctrl+Shift+Enter",
      "format": "Ctrl+Shift+L",
      "newConsole": "",
      "openConsole": "F4",
      "databaseExplorer": "Ctrl+Alt+S",
      "settings": "Ctrl+Alt+S",
      "find": "Ctrl+F",
      "findInFiles": "Ctrl+Shift+F",
      "globalSearch": "Shift Shift",
      "localHistory": "",
      "clipboardHistory": "Ctrl+Shift+V",
      "formatCode": "Ctrl+Shift+L",
      "toggleComment": "Ctrl+/",
      "duplicateLine": "Ctrl+D",
      "deleteLine": "Ctrl+Y",
      "moveLineUp": "Alt+Shift+Up",
      "moveLineDown": "Alt+Shift+Down",
      "expandSelection": "Ctrl+W",
      "shrinkSelection": "Ctrl+Shift+W",
      "rename": "Shift+F6",
      "quickFix": "Alt+Enter",
      "goToDefinition": "Ctrl+B",
      "structureView": "Ctrl+F12",
      "nextTab": "Alt+Right",
      "previousTab": "Alt+Left",
    }
  }
];

function isTauri(): boolean {
  return typeof window !== 'undefined' && (
    !!(window as any).__TAURI_INTERNALS__ || 
    !!(window as any).__TAURI__
  );
}

const saveKeymapsToFile = async (state: { activePreset: string, customActions: Record<string, string> }) => {
  if (!isTauri()) return;
  try {
    await invoke("save_keymaps", { keymaps: state });
  } catch (e) {
    console.error("Failed to save keymaps:", e);
  }
};

export const useKeymap = create<KeymapSettings>()((set, get) => ({
  activePreset: "default",
  customActions: {},
  
  setPreset: (presetId) => {
    set({ activePreset: presetId });
    saveKeymapsToFile({ activePreset: get().activePreset, customActions: get().customActions });
  },
  
  setShortcut: (actionId, shortcut) => {
    set((state) => {
      const newState = { ...state, customActions: { ...state.customActions, [actionId]: shortcut } };
      saveKeymapsToFile({ activePreset: newState.activePreset, customActions: newState.customActions });
      return newState;
    });
  },
  
  getShortcut: (actionId) => {
    const state = get();
    const preset = defaultKeymaps.find(p => p.id === state.activePreset);
    return state.customActions[actionId] || preset?.actions[actionId];
  }
}));

export interface LiveTemplate {
  id: string;
  abbreviation: string;
  name: string;
  template: string;
  description?: string;
}

export interface LiveTemplatesSettings {
  templates: LiveTemplate[];
  
  addTemplate: (template: LiveTemplate) => void;
  removeTemplate: (id: string) => void;
  updateTemplate: (id: string, updates: Partial<LiveTemplate>) => void;
}

const defaultTemplates: LiveTemplate[] = [
  { id: "sel", abbreviation: "sel", name: "SELECT * FROM", template: "SELECT * FROM $TABLE$", description: "Select all from table" },
  { id: "selw", abbreviation: "selw", name: "SELECT WHERE", template: "SELECT * FROM $TABLE$ WHERE $CONDITION$", description: "Select with WHERE" },
  { id: "ins", abbreviation: "ins", name: "INSERT", template: "INSERT INTO $TABLE$ ($COLS$) VALUES ($VALUES$)", description: "Insert row" },
  { id: "upd", abbreviation: "upd", name: "UPDATE", template: "UPDATE $TABLE$ SET $SET$ WHERE $WHERE$", description: "Update rows" },
  { id: "del", abbreviation: "del", name: "DELETE", template: "DELETE FROM $TABLE$ WHERE $WHERE$", description: "Delete rows" },
  { id: "crt", abbreviation: "crt", name: "CREATE TABLE", template: "CREATE TABLE $TABLE$ (\n  id SERIAL PRIMARY KEY,\n  name VARCHAR(255) NOT NULL\n);", description: "Create table" },
  { id: "selc", abbreviation: "selc", name: "SELECT COUNT", template: "SELECT COUNT(*) FROM $TABLE$", description: "Count rows" },
  { id: "joi", abbreviation: "joi", name: "JOIN", template: "SELECT * FROM $TABLE1$ t1\nJOIN $TABLE2$ t2 ON t1.$COL$ = t2.$COL$", description: "Inner join" },
];

const saveTemplatesToFile = async (templates: LiveTemplate[]) => {
  if (!isTauri()) return;
  try {
    await invoke("save_templates", { templates });
  } catch (e) {
    console.error("Failed to save templates:", e);
  }
};

export const useLiveTemplates = create<LiveTemplatesSettings>()((set, get) => ({
  templates: defaultTemplates,
  
  addTemplate: (template) => {
    set((state) => ({
      templates: [...state.templates, template]
    }));
    saveTemplatesToFile(get().templates);
  },
  
  removeTemplate: (id) => {
    set((state) => ({
      templates: state.templates.filter(t => t.id !== id)
    }));
    saveTemplatesToFile(get().templates);
  },
  
  updateTemplate: (id, updates) => {
    set((state) => ({
      templates: state.templates.map(t => t.id === id ? { ...t, ...updates } : t)
    }));
    saveTemplatesToFile(get().templates);
  },
}));

// Initialize from file
if (typeof window !== "undefined") {
  (async () => {
    try {
      const keymapData = await invoke<any>("load_keymaps");
      if (keymapData && keymapData.activePreset) {
        useKeymap.setState(keymapData);
      }
      
      const templateData = await invoke<any>("load_templates");
      if (templateData && templateData.templates) {
        useLiveTemplates.setState({ templates: templateData.templates });
      }
    } catch (e) {
      console.error("Failed to initialize stores from Rust:", e);
    }
  })();
}

export { defaultKeymaps };
