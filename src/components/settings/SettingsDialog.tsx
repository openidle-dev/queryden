import { useState, useEffect } from "react";
import { X, Settings, Database, Play, Monitor, Keyboard, Zap, Trash2, Search, Import, Edit2, Copy, HardDrive, Shield, AlertTriangle, CheckCircle, AlertCircle } from "lucide-react";
import { useSettings } from "../../store/settingsStore";
import { useKeymap, defaultKeymaps, useLiveTemplates } from "../../store/keymapStore";
import { useAI, AIProvider } from "../../store/aiStore";
import { Sparkles, Bot } from "lucide-react";
import { VaultCredential } from "../../contexts/ConnectionContext";
import { useConnections } from "../../contexts/useConnections";
import { useVault } from "../../store/vaultStore";

type SettingsCategory = "appearance" | "sqlCompletion" | "queryExecution" | "explorer" | "keymap" | "templates" | "importExport" | "ai" | "copyTransfer" | "permissions" | "vault";

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

const categories: { id: SettingsCategory; label: string; icon: any; keywords: string[] }[] = [
  { id: "appearance", label: "Appearance", icon: Monitor, keywords: ["theme", "dark", "light", "compact", "font", "size", "indent", "appearance", "widescreen", "guides", "editor font", "table font"] },
  { id: "keymap", label: "Keymap", icon: Keyboard, keywords: ["shortcut", "keyboard", "hotkey", "binding", "preset", "keymap", "shortcuts", "actions"] },
  { id: "sqlCompletion", label: "SQL Code Completion", icon: Zap, keywords: ["completion", "suggest", "alias", "case", "join", "sql", "qualify", "objects", "keyword case", "foreign keys"] },
  { id: "queryExecution", label: "Query Execution", icon: Play, keywords: ["enter", "max rows", "commit", "prefetch", "execute", "run", "auto-commit", "inline", "results"] },
  { id: "explorer", label: "Database Explorer", icon: Database, keywords: ["view", "function", "trigger", "index", "constraint", "schema", "namespace", "tree", "explorer", "foreign tables", "empty groups"] },
  { id: "copyTransfer", label: "Copy/Transfer", icon: Copy, keywords: ["copy", "transfer", "merge", "schema", "data", "method", "batch size", "parallel", "threads", "compression", "logging", "pg_dump"] },
  { id: "permissions", label: "Permissions & Rules", icon: Shield, keywords: ["drop", "truncate", "delete", "warn", "bypass", "rules", "safety", "guru", "dangerous"] },
  { id: "ai", label: "AI Assistant", icon: Sparkles, keywords: ["ai", "assistant", "openai", "gemini", "anthropic", "llm", "api", "key", "model", "ollama", "gpt-4", "claude"] },
  { id: "importExport", label: "Import/Export", icon: Import, keywords: ["import", "export", "csv", "json", "sql", "tsv", "xml", "html", "delimiter", "headers", "null", "quote"] },
  { id: "vault", label: "Credential Vault", icon: Shield, keywords: ["vault", "security", "credentials", "password", "username", "encryption", "master", "profiles"] },
];

export function SettingsDialog({ isOpen, onClose }: SettingsDialogProps) {
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>("appearance");
  const [searchTerm, setSearchTerm] = useState("");
  const settings = useSettings();
  const keymap = useKeymap();

  const filteredCategories = categories.filter(cat => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return cat.label.toLowerCase().includes(term) || cat.keywords.some(k => k.toLowerCase().includes(term));
  });

  // Auto-switch to first result if current category is no longer visible
  useEffect(() => {
    if (searchTerm && filteredCategories.length > 0 && !filteredCategories.find(c => c.id === activeCategory)) {
      setActiveCategory(filteredCategories[0].id);
    }
  }, [searchTerm, filteredCategories, activeCategory]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEsc);
    return () => window.removeEventListener("keydown", handleEsc);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-[var(--surface)] rounded-lg shadow-xl w-[880px] h-[640px] flex" style={{ overflow: 'visible' }}>
        {/* Left Sidebar */}
        <div className="w-52 border-r border-[var(--border)] flex flex-col shrink-0">
          <div className="p-3 border-b border-[var(--border)]">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <Settings className="w-4 h-4" />
              Settings
            </h2>
          </div>
          
          {/* Search */}
          <div className="p-2 border-b border-[var(--border)]">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--text-secondary)]" />
              <input
                type="text"
                placeholder="Search..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-7 pr-2 py-1.5 text-xs rounded bg-[var(--background)] border border-[var(--border)] outline-none focus:border-[var(--color-accent)]"
              />
            </div>
          </div>

          {/* Categories */}
          <div className="flex-1 overflow-y-auto py-0.5">
            {filteredCategories.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors ${
                  activeCategory === cat.id 
                    ? "bg-[var(--color-accent)]/15 text-[var(--color-accent)]" 
                    : "hover:bg-[var(--border)] text-[var(--text-secondary)]"
                }`}
              >
                <cat.icon className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{cat.label}</span>
              </button>
            ))}
            {filteredCategories.length === 0 && (
              <div className="p-4 text-center">
                <p className="text-xs text-[var(--text-secondary)] italic">No settings found for "{searchTerm}"</p>
              </div>
            )}
          </div>
        </div>

        {/* Right Content */}
        <div className="flex-1 flex flex-col">
          {/* Header */}
          <div className="h-12 px-4 flex items-center justify-between border-b border-[var(--border)]">
            <h3 className="text-sm font-semibold">
              {categories.find((c) => c.id === activeCategory)?.label}
            </h3>
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-[var(--border)]"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Settings Content */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {activeCategory === "appearance" && <AppearanceSettings />}
            {activeCategory === "keymap" && <KeymapSettings />}
            {activeCategory === "sqlCompletion" && <SQLCompletionSettings />}
            {activeCategory === "queryExecution" && <QueryExecutionSettings />}
            {activeCategory === "explorer" && <ExplorerSettings />}
            {activeCategory === "templates" && <LiveTemplatesSettings />}
            {activeCategory === "importExport" && <ImportExportSettings />}
            {activeCategory === "ai" && <AISettings />}
            {activeCategory === "copyTransfer" && <CopyTransferSettings />}
            {activeCategory === "permissions" && <PermissionsSettings />}
            {activeCategory === "vault" && <VaultCredentialsSettings />}
          </div>

          {/* Footer */}
          <div className="px-4 py-2 border-t border-[var(--border)] flex justify-between shrink-0">
            <button
              onClick={() => {
                settings.resetSettings();
                keymap.setPreset("default");
              }}
              className="px-3 py-1.5 text-xs rounded hover:bg-[var(--border)] text-[var(--color-error)]"
            >
              Reset All to Defaults
            </button>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-xs rounded hover:bg-[var(--border)]"
              >
                Cancel
              </button>
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-xs rounded bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)]"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AppearanceSettings() {
  const settings = useSettings();

  return (
    <div className="space-y-5">
      <div>
        <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] mb-3">Theme & Layout</h4>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium mb-1.5">Theme</label>
            <select
              value={settings.theme}
              onChange={(e) => settings.setSetting("theme", e.target.value as any)}
              className="w-full px-3 py-1.5 text-sm rounded bg-[var(--background)] border border-[var(--border)] outline-none focus:border-[var(--color-accent)] text-[var(--text-primary)]"
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="system">System</option>
            </select>
          </div>

          <ToggleOption
            label="Compact mode"
            description="Reduced heights for toolbars and headers"
            checked={settings.compactMode}
            onChange={(checked) => settings.setSetting("compactMode", checked)}
          />

          <ToggleOption
            label="Show indent guides"
            description="Display vertical lines in tree views"
            checked={settings.showTreeIndentGuides}
            onChange={(checked) => settings.setSetting("showTreeIndentGuides", checked)}
          />

          <ToggleOption
            label="Widescreen layout"
            description="Optimize for wide-screen monitors"
            checked={settings.widescreenLayout}
            onChange={(checked) => settings.setSetting("widescreenLayout", checked)}
          />
        </div>
      </div>

      <div className="border-t border-[var(--border)] pt-4">
        <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] mb-3">Editor Font</h4>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium mb-1.5">Editor & Table Font Size</label>
            <div className="flex items-center gap-3">
              <input
                type="number"
                value={settings.editorFontSize}
                onChange={(e) => settings.setSetting("editorFontSize", parseInt(e.target.value) || 12)}
                className="w-20 px-2 py-1.5 text-sm rounded bg-[var(--background)] border border-[var(--border)] outline-none focus:border-[var(--color-accent)]"
                min={8}
                max={32}
              />
              <span className="text-xs text-[var(--text-secondary)]">px</span>
            </div>
            <p className="text-[10px] text-[var(--text-secondary)] mt-1 opacity-60">Affects both the SQL editor and the results data table.</p>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1.5">Editor Font Family</label>
            <select
              value={settings.editorFontFamily || "JetBrains Mono"}
              onChange={(e) => settings.setSetting("editorFontFamily", e.target.value)}
              className="w-full px-3 py-1.5 text-sm rounded bg-[var(--background)] border border-[var(--border)] outline-none focus:border-[var(--color-accent)] text-[var(--text-primary)]"
            >
              <option value="JetBrains Mono">JetBrains Mono</option>
              <option value="Fira Code">Fira Code</option>
              <option value="Cascadia Code">Cascadia Code</option>
              <option value="Source Code Pro">Source Code Pro</option>
              <option value="monospace">System Monospace</option>
            </select>
            <p className="text-[10px] text-[var(--text-secondary)] mt-1 opacity-60">Applies to the SQL editor only.</p>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1.5">Tab Size</label>
            <div className="flex items-center gap-3">
              <input
                type="number"
                value={settings.editorTabSize || 2}
                onChange={(e) => settings.setSetting("editorTabSize", Math.max(1, Math.min(8, parseInt(e.target.value) || 2)))}
                className="w-20 px-2 py-1.5 text-sm rounded bg-[var(--background)] border border-[var(--border)] outline-none focus:border-[var(--color-accent)]"
                min={1}
                max={8}
              />
              <span className="text-xs text-[var(--text-secondary)]">spaces</span>
            </div>
          </div>

          <ToggleOption
            label="Show line numbers"
            description="Display line numbers in the SQL editor gutter"
            checked={settings.editorLineNumbers ?? true}
            onChange={(checked) => settings.setSetting("editorLineNumbers", checked)}
          />

          <ToggleOption
            label="Word wrap"
            description="Wrap long lines instead of horizontal scrolling"
            checked={settings.editorWordWrap ?? false}
            onChange={(checked) => settings.setSetting("editorWordWrap", checked)}
          />

          <ToggleOption
            label="Minimap"
            description="Show code overview minimap in the editor"
            checked={settings.editorMinimap ?? false}
            onChange={(checked) => settings.setSetting("editorMinimap", checked)}
          />
        </div>
      </div>
    </div>
  );
}

function KeymapSettings() {
  const keymap = useKeymap();
  const [selectedPreset, setSelectedPreset] = useState(keymap.activePreset);

  const handlePresetChange = (presetId: string) => {
    setSelectedPreset(presetId);
    keymap.setPreset(presetId);
  };

  return (
    <div className="space-y-5">
      {/* Keymap Preset */}
      <div>
        <label className="block text-xs font-medium mb-2">Keymap Preset</label>
        <select
          value={selectedPreset}
          onChange={(e) => handlePresetChange(e.target.value)}
          className="w-full px-3 py-2 text-sm rounded bg-[var(--background)] border border-[var(--border)] outline-none focus:border-[var(--color-accent)] text-[var(--text-primary)]"
        >
          {defaultKeymaps.map((preset) => (
            <option key={preset.id} value={preset.id}>{preset.name}</option>
          ))}
        </select>
      </div>

      {/* Common Shortcuts */}
      <div>
        <label className="block text-xs font-medium mb-2">Key Bindings</label>
        <div className="space-y-2 bg-[var(--background)] rounded border border-[var(--border)] p-3 max-h-60 overflow-y-auto">
          {Object.entries(defaultKeymaps.find(p => p.id === selectedPreset)?.actions || {}).map(([action, shortcut]) => (
            <div key={action} className="flex items-center justify-between text-sm">
              <span className="capitalize">{action.replace(/([A-Z])/g, ' $1').trim()}</span>
              <kbd className="px-2 py-0.5 bg-[var(--surface)] border border-[var(--border)] rounded text-xs font-mono">
                {shortcut || "—"}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function SQLCompletionSettings() {
  const settings = useSettings();

  return (
    <div className="space-y-5">
      {/* Suggest Objects From */}
      <div>
        <label className="block text-xs font-medium mb-2">Suggest objects from</label>
        <select
          value={settings.suggestObjectsFrom}
          onChange={(e) => settings.setSetting("suggestObjectsFrom", e.target.value as any)}
          className="w-full px-3 py-2 text-sm rounded bg-[var(--background)] border border-[var(--border)] outline-none focus:border-[var(--color-accent)] text-[var(--text-primary)]"
        >
          <option value="currentScope">Current schema only</option>
          <option value="allSchemas">All available schemas</option>
        </select>
        <p className="text-xs text-[var(--text-secondary)] mt-1">Which schemas to suggest objects from</p>
      </div>

      {/* Qualify Objects */}
      <div>
        <label className="block text-xs font-medium mb-2">Qualify objects</label>
        <select
          value={settings.qualifyObjects}
          onChange={(e) => settings.setSetting("qualifyObjects", e.target.value as any)}
          className="w-full px-3 py-2 text-sm rounded bg-[var(--background)] border border-[var(--border)] outline-none focus:border-[var(--color-accent)] text-[var(--text-primary)]"
        >
          <option value="onCollisions">On collisions</option>
          <option value="always">Always</option>
          <option value="never">Never</option>
        </select>
      </div>

      {/* JOIN Completion */}
      <ToggleOption
        label="JOIN completion"
        description="Auto-complete JOIN statements with foreign keys"
        checked={settings.joinCompletion}
        onChange={(checked) => settings.setSetting("joinCompletion", checked)}
      />

      {/* Suggest Aliases */}
      <ToggleOption
        label="Suggest alias names"
        description="Create aliases after table names"
        checked={settings.suggestAliases}
        onChange={(checked) => settings.setSetting("suggestAliases", checked)}
      />
    </div>
  );
}

function QueryExecutionSettings() {
  const settings = useSettings();

  return (
    <div className="space-y-5">
      <div>
        <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] mb-3">Execution Behavior</h4>
        <div className="space-y-4">
          <ToggleOption
            label="Execute on Enter"
            description="Run query when pressing Enter in editor"
            checked={settings.executeOnEnter}
            onChange={(checked) => settings.setSetting("executeOnEnter", checked)}
          />

          <div>
            <label className="block text-xs font-medium mb-1.5">Max rows to display</label>
            <input
              type="number"
              value={settings.maxRowsToDisplay}
              onChange={(e) => settings.setSetting("maxRowsToDisplay", parseInt(e.target.value))}
              className="w-24 px-2 py-1.5 text-sm rounded bg-[var(--background)] border border-[var(--border)] outline-none focus:border-[var(--color-accent)] text-[var(--text-primary)]"
            />
            <p className="text-[10px] text-[var(--text-secondary)] mt-1">Limit result set size for performance</p>
          </div>

          <div>
            <label className="block text-xs font-medium mb-1.5">Result set prefetch size</label>
            <input
              type="number"
              value={settings.resultSetPrefetchSize}
              onChange={(e) => settings.setSetting("resultSetPrefetchSize", parseInt(e.target.value))}
              className="w-24 px-2 py-1.5 text-sm rounded bg-[var(--background)] border border-[var(--border)] outline-none focus:border-[var(--color-accent)] text-[var(--text-primary)]"
            />
          </div>
        </div>
      </div>

      <div className="border-t border-[var(--border)] pt-4">
        <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--text-secondary)] mb-3">Variable Substitution</h4>
        <ToggleOption
          label="Variable substitution (:var)"
          description='Replace :varname patterns with values before execution. Use :name, :name:default, or :name? for optional.'
          checked={settings.enableQueryVariables ?? true}
          onChange={(checked) => settings.setSetting("enableQueryVariables", checked)}
        />
      </div>
    </div>
  );
}

function ExplorerSettings() {
  const settings = useSettings();

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs font-semibold mb-3 text-[var(--text-secondary)] uppercase tracking-wider">Object Visibility</label>
        <div className="grid grid-cols-2 gap-x-8 gap-y-1 bg-[var(--background)]/30 border border-[var(--border)] rounded-lg p-3">
          <ToggleOption
            label="Tables"
            checked={settings.showTables}
            onChange={(checked) => settings.setSetting("showTables", checked)}
          />
          <ToggleOption
            label="Views"
            checked={settings.showViews}
            onChange={(checked) => settings.setSetting("showViews", checked)}
          />
          <ToggleOption
            label="Functions"
            checked={settings.showFunctions}
            onChange={(checked) => settings.setSetting("showFunctions", checked)}
          />
          <ToggleOption
            label="Triggers"
            checked={settings.showTriggers}
            onChange={(checked) => settings.setSetting("showTriggers", checked)}
          />
          <ToggleOption
            label="Indexes"
            checked={settings.showIndexes}
            onChange={(checked) => settings.setSetting("showIndexes", checked)}
          />
          <ToggleOption
            label="Constraints"
            checked={settings.showConstraints}
            onChange={(checked) => settings.setSetting("showConstraints", checked)}
          />
          <ToggleOption
            label="Sequences"
            checked={settings.showSequences}
            onChange={(checked) => settings.setSetting("showSequences", checked)}
          />
          <ToggleOption
            label="Types"
            checked={settings.showTypes}
            onChange={(checked) => settings.setSetting("showTypes", checked)}
          />
        </div>
      </div>

      <div className="space-y-1">
        <label className="block text-xs font-semibold mb-2 text-[var(--text-secondary)] uppercase tracking-wider">Advanced</label>
        <ToggleOption
          label="Show Foreign Tables"
          description="Show foreign tables from fdw"
          checked={settings.showForeignTables}
          onChange={(checked) => settings.setSetting("showForeignTables", checked)}
        />

        <ToggleOption
          label="All Namespaces"
          description="Show all schemas without full introspection"
          checked={settings.showAllNamespaces}
          onChange={(checked) => settings.setSetting("showAllNamespaces", checked)}
        />

        <ToggleOption
          label="Show Empty Groups"
          description="Show empty folder groups"
          checked={settings.showEmptyGroups}
          onChange={(checked) => settings.setSetting("showEmptyGroups", checked)}
        />
      </div>
    </div>
  );
}

function LiveTemplatesSettings() {
  const templates = useLiveTemplates();
  const [editingTemplate, setEditingTemplate] = useState<{
    id?: string;
    name: string;
    abbreviation: string;
    template: string;
    description?: string;
  } | null>(null);

  const handleSave = () => {
    if (!editingTemplate || !editingTemplate.abbreviation || !editingTemplate.template) return;
    
    if (editingTemplate.id) {
      templates.updateTemplate(editingTemplate.id, {
        id: editingTemplate.id,
        name: editingTemplate.name || editingTemplate.abbreviation,
        abbreviation: editingTemplate.abbreviation,
        template: editingTemplate.template,
        description: editingTemplate.description
      });
    } else {
      templates.addTemplate({
        id: crypto.randomUUID(),
        name: editingTemplate.name || editingTemplate.abbreviation,
        abbreviation: editingTemplate.abbreviation,
        template: editingTemplate.template,
        description: editingTemplate.description
      });
    }
    setEditingTemplate(null);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-[var(--text-secondary)] flex-1">
          Use live templates to quickly insert common SQL patterns. Type abbreviation and press Tab.
        </p>
        <button 
          onClick={() => setEditingTemplate({ name: "", abbreviation: "", template: "", description: "" })}
          className="px-2 py-1 text-xs rounded bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors"
        >
          + Add
        </button>
      </div>

      {editingTemplate && (
        <div className="p-2 bg-[var(--surface-raised)] border border-[var(--color-accent)]/50 rounded-lg space-y-2 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-[9px] uppercase font-bold text-[var(--text-secondary)] mb-1">Abbreviation</label>
              <input 
                type="text" 
                value={editingTemplate.abbreviation}
                onChange={e => setEditingTemplate({...editingTemplate, abbreviation: e.target.value})}
                placeholder="e.g. ss"
                className="w-full px-2 py-1 text-xs rounded bg-[var(--background)] border border-[var(--border)] outline-none focus:border-[var(--color-accent)] font-mono"
              />
            </div>
            <div>
              <label className="block text-[9px] uppercase font-bold text-[var(--text-secondary)] mb-1">Name</label>
              <input 
                type="text" 
                value={editingTemplate.name}
                onChange={e => setEditingTemplate({...editingTemplate, name: e.target.value})}
                placeholder="Select Star"
                className="w-full px-2 py-1 text-xs rounded bg-[var(--background)] border border-[var(--border)] outline-none focus:border-[var(--color-accent)]"
              />
            </div>
          </div>
          <div>
            <label className="block text-[9px] uppercase font-bold text-[var(--text-secondary)] mb-1">Template Content</label>
            <textarea 
              value={editingTemplate.template}
              onChange={e => setEditingTemplate({...editingTemplate, template: e.target.value})}
              placeholder="SELECT * FROM ${1:table};"
              rows={2}
              className="w-full px-2 py-1 text-xs rounded bg-[var(--background)] border border-[var(--border)] outline-none focus:border-[var(--color-accent)] font-mono resize-none"
            />
            <p className="text-[8px] text-[var(--text-secondary)] mt-0.5">Use $1, $2, etc. for cursor stops.</p>
          </div>
          <div className="flex justify-end gap-2">
            <button 
              onClick={() => setEditingTemplate(null)}
              className="px-2 py-1 text-xs rounded hover:bg-[var(--border)] transition-colors"
            >
              Cancel
            </button>
            <button 
              onClick={handleSave}
              disabled={!editingTemplate.abbreviation || !editingTemplate.template}
              className="px-2 py-1 text-xs rounded bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      )}

      <div className="space-y-1.5 max-h-[250px] overflow-y-auto pr-1 custom-scrollbar">
        {templates.templates.map((template) => (
          <div 
            key={template.id} 
            className="flex items-center justify-between p-1.5 bg-[var(--background)] rounded border border-[var(--border)] shadow-sm hover:border-[var(--text-secondary)] transition-colors group"
          >
            <div className="flex-1 min-w-0 pr-2">
              <div className="flex items-center gap-1.5">
                <kbd className="px-1 py-0.5 bg-[var(--surface-raised)] border border-[var(--border)] rounded text-[9px] font-bold font-mono text-[var(--color-accent)]">
                  {template.abbreviation}
                </kbd>
                <span className="text-xs font-medium">{template.name}</span>
              </div>
              <pre className="text-[9px] text-[var(--text-secondary)] mt-0.5 font-mono truncate">
                {template.template}
              </pre>
            </div>
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <button 
                onClick={() => setEditingTemplate(template)}
                className="p-1 rounded hover:bg-[var(--border)] transition-colors" 
                title="Edit template"
              >
                <Edit2 className="w-3 h-3 text-[var(--text-primary)]" />
              </button>
              <button 
                onClick={() => templates.removeTemplate(template.id)}
                className="p-1 rounded hover:bg-red-500/20 text-[var(--color-error)] transition-colors" 
                title="Delete template"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </div>
        ))}
        {templates.templates.length === 0 && (
          <div className="text-center py-4 text-xs text-[var(--text-secondary)] italic border border-dashed border-[var(--border)] rounded">
            No live templates. Add one above.
          </div>
        )}
      </div>
    </div>
  );
}

function ImportExportSettings() {
  const settings = useSettings();
  
  const toggleFormat = (id: string) => {
    const current = settings.enabledExportFormats;
    if (current.includes(id)) {
      settings.setSetting("enabledExportFormats", current.filter(f => f !== id));
    } else {
      settings.setSetting("enabledExportFormats", [...current, id]);
    }
  };

  return (
    <div className="space-y-5">
      {/* Export Formats */}
      <div>
        <label className="block text-xs font-semibold mb-3 text-[var(--text-secondary)] uppercase tracking-wider">Toolbar Export Formats</label>
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 bg-[var(--background)]/30 border border-[var(--border)] rounded-lg p-3">
          {[
            { id: "csv", label: "CSV (Comma-Separated Values)", ext: ".csv" },
            { id: "json", label: "JSON", ext: ".json" },
            { id: "xml", label: "XML Document", ext: ".xml" },
            { id: "html", label: "HTML Table", ext: ".html" },
            { id: "sql", label: "SQL INSERT Statement", ext: ".sql" },
          ].map((format) => (
            <label key={format.id} className="flex items-center gap-2 text-[13px] group cursor-pointer py-0.5">
              <input 
                type="checkbox" 
                checked={settings.enabledExportFormats.includes(format.id)} 
                onChange={() => toggleFormat(format.id)}
                className="rounded border-[var(--border)] text-[var(--color-accent)] focus:ring-0 cursor-pointer" 
              />
              <span className="group-hover:text-[var(--text-primary)] transition-colors">{format.label}</span>
              <span className="text-[10px] text-[var(--text-secondary)] ml-auto opacity-40">({format.ext})</span>
            </label>
          ))}
        </div>
      </div>

      {/* CSV Delimiter */}
      <div>
        <label className="block text-xs font-medium mb-2">CSV Delimiter</label>
        <select className="w-full px-3 py-2 text-sm rounded bg-[var(--background)] border border-[var(--border)] outline-none focus:border-[var(--color-accent)] text-[var(--text-primary)]">
          <option value=",">Comma (,)</option>
          <option value=";">Semicolon (;)</option>
          <option value="\t">Tab</option>
          <option value="|">Pipe (|)</option>
        </select>
      </div>

      {/* Include Headers */}
      <ToggleOption
        label="Include column headers"
        description="First row contains column names"
        checked={true}
        onChange={() => {}}
      />

      {/* Null Value */}
      <div>
        <label className="block text-xs font-medium mb-2">NULL represented as</label>
        <input
          type="text"
          defaultValue="NULL"
          className="w-full px-3 py-2 text-sm rounded bg-[var(--background)] border border-[var(--border)] outline-none focus:border-[var(--color-accent)] text-[var(--text-primary)]"
        />
      </div>

      {/* Quote Character */}
      <div>
        <label className="block text-xs font-medium mb-2">Quote character</label>
        <select className="w-full px-3 py-2 text-sm rounded bg-[var(--background)] border border-[var(--border)] outline-none focus:border-[var(--color-accent)] text-[var(--text-primary)]">
          <option value="&quot;">Double quotes (&quot;)</option>
          <option value="'">Single quotes (')</option>
        </select>
      </div>
    </div>
  );
}

function ToggleOption({ label, description, checked, onChange }: { 
  label: string; 
  description?: string; 
  checked: boolean; 
  onChange: (checked: boolean) => void 
}) {
  return (
    <div className={`flex items-center ${label ? 'justify-between py-1' : 'justify-end'}`}>
      {label && (
        <div className="min-w-0 flex-1 mr-3">
          <div className="text-sm">{label}</div>
          {description && (
            <div className="text-xs text-[var(--text-secondary)] mt-0.5">{description}</div>
          )}
        </div>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`w-9 h-5 rounded-full transition-colors shrink-0 ${
          checked ? "bg-[var(--color-accent)]" : "bg-[var(--border)]"
        }`}
      >
        <div
          className={`w-3.5 h-3.5 rounded-full bg-white transition-transform ${
            checked ? "translate-x-[18px]" : "translate-x-[3px]"
          }`}
        />
      </button>
    </div>
  );
}

function AISettings() {
  const ai = useAI();

  return (
    <div className="space-y-6">
      <div className="bg-purple-500/10 border border-purple-500/20 rounded-lg p-3 flex gap-3">
        <Sparkles className="w-5 h-5 text-purple-400 shrink-0 mt-0.5" />
        <div className="text-xs">
          <p className="font-bold text-purple-400 mb-1">Empower your workflow with AI</p>
          <p className="text-[var(--text-secondary)]">Connect your own API provider to generate complex SQL, explain query plans, and fix errors directly in the editor.</p>
        </div>
      </div>

      <ToggleOption
        label="Enable AI Assistant"
        description="Enable AI-powered features in the SQL editor"
        checked={ai.enabled}
        onChange={(checked) => ai.setEnabled(checked)}
      />

      <div className={`space-y-5 transition-all duration-300 ${!ai.enabled ? "opacity-30 pointer-events-none grayscale" : ""}`}>
        <div>
          <label className="block text-xs font-medium mb-2">AI Provider</label>
          <div className="grid grid-cols-2 gap-2">
            {[
              { id: "openai", label: "OpenAI", icon: "🤖" },
              { id: "google", label: "Google Gemini", icon: "✨" },
              { id: "anthropic", label: "Anthropic", icon: "🏛️" },
              { id: "local", label: "Local (Ollama)", icon: "🏠" },
            ].map((p) => (
              <button
                key={p.id}
                onClick={() => ai.setProvider(p.id as AIProvider)}
                className={`flex items-center gap-2 p-2 rounded border text-xs transition-all ${
                  ai.provider === p.id 
                    ? "bg-[var(--color-accent)]/10 border-[var(--color-accent)] text-[var(--color-accent)] font-bold shadow-sm" 
                    : "bg-[var(--background)] border-[var(--border)] hover:border-[var(--text-secondary)]"
                }`}
              >
                <span>{p.icon}</span>
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium mb-2">API Key</label>
          <div className="relative">
            <Bot className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-secondary)] opacity-50" />
            <input
              type="password"
              placeholder={`Enter your ${ai.provider} API key...`}
              value={ai.apiKey}
              onChange={(e) => ai.setApiKey(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-sm rounded bg-[var(--background)] border border-[var(--border)] outline-none focus:border-[var(--color-accent)] font-mono"
            />
          </div>
          <p className="text-[10px] text-[var(--text-secondary)] mt-1.5 opacity-60">Keys are stored locally in your filesystem and never sent to our servers.</p>
        </div>

        <div>
          <label className="block text-xs font-medium mb-2">Model Selection</label>
          <select
            value={ai.model}
            onChange={(e) => ai.setModel(e.target.value)}
            className="w-full px-3 py-2 text-sm rounded bg-[var(--background)] border border-[var(--border)] outline-none focus:border-[var(--color-accent)] text-[var(--text-primary)]"
          >
            {ai.provider === "openai" && (
              <>
                <option value="gpt-4o">GPT-4o (Recommended)</option>
                <option value="gpt-4-turbo">GPT-4 Turbo</option>
                <option value="gpt-3.5-turbo">GPT-3.5 Turbo</option>
              </>
            )}
            {ai.provider === "google" && (
              <>
                <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
                <option value="gemini-1.5-flash">Gemini 1.5 Flash</option>
              </>
            )}
            {ai.provider === "anthropic" && (
              <>
                <option value="claude-3-5-sonnet">Claude 3.5 Sonnet</option>
                <option value="claude-3-opus">Claude 3 Opus</option>
              </>
            )}
            {ai.provider === "local" && (
              <option value="llama3">Llama 3 (via Ollama)</option>
            )}
          </select>
        </div>
      </div>
    </div>
  );
}

function CopyTransferSettings() {
  const settings = useSettings();
  
  const setSetting = settings.setSetting as any;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <Copy className="w-4 h-4" />
          Copy/Transfer Settings
        </h3>
        <p className="text-xs text-[var(--text-secondary)] mb-4">
          Configure how data is copied between databases during merge/transfer operations.
        </p>
      </div>

      <div className="space-y-4">
        <div>
          <label className="text-xs font-medium block mb-1">Copy Method</label>
          <select
            value={settings.copyMethod}
            onChange={(e) => setSetting("copyMethod", e.target.value)}
            className="w-full bg-[var(--background)] border border-[var(--border)] rounded px-3 py-2 text-xs outline-none"
          >
            <option value="insert">INSERT...SELECT (Same server)</option>
            <option value="copy">COPY TO/FROM (Fastest - Same server)</option>
            <option value="pgdump">pg_dump/pg_restore (Cross-server)</option>
          </select>
          <p className="text-[10px] text-[var(--text-secondary)] mt-1">
            {settings.copyMethod === "insert" && "Uses INSERT INTO...SELECT - works across databases on same server"}
            {settings.copyMethod === "copy" && "Native PostgreSQL COPY - fastest for bulk data, requires same server"}
            {settings.copyMethod === "pgdump" && "Uses pg_dump pipeline - best for cross-server migrations"}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-medium block mb-1">Batch Size</label>
            <input
              type="number"
              value={settings.copyBatchSize}
              onChange={(e) => setSetting("copyBatchSize", parseInt(e.target.value) || 1000)}
              className="w-full bg-[var(--background)] border border-[var(--border)] rounded px-3 py-2 text-xs outline-none"
              min={100}
              max={100000}
            />
            <p className="text-[10px] text-[var(--text-secondary)] mt-1">
              Rows per batch (INSERT method)
            </p>
          </div>
          
          <div>
            <label className="text-xs font-medium block mb-1">Parallel Threads</label>
            <input
              type="number"
              value={settings.copyParallel}
              onChange={(e) => setSetting("copyParallel", parseInt(e.target.value) || 4)}
              className="w-full bg-[var(--background)] border border-[var(--border)] rounded px-3 py-2 text-xs outline-none"
              min={1}
              max={16}
            />
            <p className="text-[10px] text-[var(--text-secondary)] mt-1">
              Parallel workers (pg_restore)
            </p>
          </div>
        </div>

        <div className="space-y-3 pt-2">
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={settings.copyCompression}
              onChange={(e) => setSetting("copyCompression", e.target.checked)}
              className="rounded"
            />
            Enable compression (pg_restore)
          </label>
          
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={settings.copyVerifyAfter}
              onChange={(e) => setSetting("copyVerifyAfter", e.target.checked)}
              className="rounded"
            />
            Verify row counts after transfer
          </label>
        </div>

        <div>
          <label className="text-xs font-medium block mb-1">Logging Level</label>
          <select
            value={settings.copyLoggingLevel}
            onChange={(e) => setSetting("copyLoggingLevel", e.target.value)}
            className="w-full bg-[var(--background)] border border-[var(--border)] rounded px-3 py-2 text-xs outline-none"
          >
            <option value="minimal">Minimal</option>
            <option value="normal">Normal</option>
            <option value="verbose">Verbose</option>
          </select>
        </div>
      </div>

      <div className="pt-4 border-t border-[var(--border)]">
        <h4 className="text-xs font-semibold mb-2 flex items-center gap-2">
          <HardDrive className="w-3 h-3" />
          Hardware Utilization
        </h4>
        <div className="bg-[var(--surface-raised)] rounded p-3">
          <div className="flex items-center justify-between text-xs mb-2">
            <span>Memory buffer</span>
            <span className="text-[var(--text-secondary)]">256 MB</span>
          </div>
          <div className="flex items-center justify-between text-xs mb-2">
            <span>Work mem</span>
            <span className="text-[var(--text-secondary)]">128 MB per connection</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span>Max worker processes</span>
            <span className="text-[var(--text-secondary)]">{settings.copyParallel} (parallel)</span>
          </div>
        </div>
      </div>

      <div className="pt-4 border-t border-[var(--border)]">
        <h4 className="text-xs font-semibold mb-2">Transfer Presets</h4>
        <div className="grid grid-cols-3 gap-2">
          <button
            onClick={() => { 
              setSetting("copyMethod", "insert");
              setSetting("copyBatchSize", 500);
              setSetting("copyParallel", 2);
            }}
            className="p-2 bg-[var(--surface-raised)] rounded text-xs hover:bg-[var(--surface-hover)] text-center"
          >
            <div className="font-medium">Small Table</div>
            <div className="text-[10px] text-[var(--text-secondary)]">&lt;10K rows</div>
          </button>
          <button
            onClick={() => { 
              setSetting("copyMethod", "insert");
              setSetting("copyBatchSize", 2000);
              setSetting("copyParallel", 4);
            }}
            className="p-2 bg-[var(--surface-raised)] rounded text-xs hover:bg-[var(--surface-hover)] text-center"
          >
            <div className="font-medium">Medium</div>
            <div className="text-[10px] text-[var(--text-secondary)]">10K-1M rows</div>
          </button>
          <button
            onClick={() => { 
              setSetting("copyMethod", "pgdump");
              setSetting("copyParallel", 8);
              setSetting("copyCompression", true);
            }}
            className="p-2 bg-[var(--surface-raised)] rounded text-xs hover:bg-[var(--surface-hover)] text-center"
          >
            <div className="font-medium">Large</div>
            <div className="text-[10px] text-[var(--text-secondary)]">&gt;1M rows</div>
          </button>
        </div>
      </div>
    </div>
  );
}

function PermissionsSettings() {
  const settings = useSettings();

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-yellow-500" />
          Safety Rules
        </h3>
        <p className="text-xs text-[var(--text-secondary)] mb-4">
          Enable warnings for potentially dangerous queries in the SQL editor.
        </p>

        <div className="space-y-4">
          <ToggleOption
            label="Warn on TRUNCATE"
            description="Show confirmation dialog before executing TRUNCATE statements"
            checked={settings.safetyWarnOnTruncate}
            onChange={(checked) => settings.setSetting("safetyWarnOnTruncate", checked)}
          />

          <ToggleOption
            label="Warn on DELETE without WHERE"
            description="Prevent accidental full table deletions"
            checked={settings.safetyWarnOnDeleteNoWhere}
            onChange={(checked) => settings.setSetting("safetyWarnOnDeleteNoWhere", checked)}
          />

          <div className="mt-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
            <ToggleOption
              label="Allow / Bypass Rules"
              description="Disable all safety warnings and execute immediately"
              checked={settings.bypassSafetyRules}
              onChange={(checked) => settings.setSetting("bypassSafetyRules", checked)}
            />
            <p className="text-[10px] text-[var(--color-error)] mt-2 font-medium">
              WARNING: Bypassing rules allows critical operations to run without any confirmation.
            </p>
          </div>
        </div>
      </div>

      <div className="pt-4 border-t border-[var(--border)]">
        <h3 className="text-sm font-semibold mb-2">Rule Patterns</h3>
        <div className="bg-[var(--surface-raised)] rounded p-2 overflow-x-auto">
          <table className="w-full text-left text-[10px] text-[var(--text-secondary)]">
            <thead>
              <tr className="border-b border-[var(--border)]">
                <th className="pb-1 font-bold">Pattern</th>
                <th className="pb-1 font-bold">Rule Action</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="pt-1 font-mono">TRUNCATE TABLE ...</td>
                <td className="pt-1">Show Warning</td>
              </tr>
              <tr>
                <td className="pt-1 font-mono">DELETE FROM ... (No WHERE)</td>
                <td className="pt-1">Show Warning</td>
              </tr>
              <tr>
                <td className="pt-1 font-mono">DROP DATABASE ...</td>
                <td className="pt-1">Force Confirmation</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function VaultCredentialsSettings() {
  const vault = useVault();
  const connections = useConnections();
  const [editingCred, setEditingCred] = useState<VaultCredential | null>(null);
  const [newCredName, setNewCredName] = useState("");
  const [newCredUser, setNewCredUser] = useState("");
  const [newCredPass, setNewCredPass] = useState("");
  const [statusMsg, setStatusMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const showStatus = (type: "success" | "error", text: string) => {
    setStatusMsg({ type, text });
    setTimeout(() => setStatusMsg(null), 3000);
  };

  const handleAddCredential = () => {
    if (!newCredName) return;
    try {
      const newCred: VaultCredential = {
        id: crypto.randomUUID(),
        name: newCredName,
        username: newCredUser,
        password: newCredPass
      };
      connections.addVaultCredential(newCred);
      setNewCredName("");
      setNewCredUser("");
      setNewCredPass("");
      showStatus("success", `Profile "${newCred.name}" added successfully`);
    } catch (e: any) {
      showStatus("error", `Failed to add profile: ${e.message || String(e)}`);
    }
  };

  const handleUpdateCredential = () => {
    if (!editingCred) return;
    try {
      connections.updateVaultCredential(editingCred.id, {
        name: newCredName,
        username: newCredUser,
        password: newCredPass
      });
      setEditingCred(null);
      setNewCredName("");
      setNewCredUser("");
      setNewCredPass("");
      showStatus("success", `Profile "${newCredName}" updated successfully`);
    } catch (e: any) {
      showStatus("error", `Failed to update profile: ${e.message || String(e)}`);
    }
  };

  const handleDeleteCredential = (cred: VaultCredential) => {
    try {
      connections.removeVaultCredential(cred.id);
      showStatus("success", `Profile "${cred.name}" removed`);
    } catch (e: any) {
      showStatus("error", `Failed to remove profile: ${e.message || String(e)}`);
    }
  };

  const startEdit = (cred: VaultCredential) => {
    setEditingCred(cred);
    setNewCredName(cred.name);
    setNewCredUser(cred.username || "");
    setNewCredPass(cred.password || "");
  };

  const cancelEdit = () => {
    setEditingCred(null);
    setNewCredName("");
    setNewCredUser("");
    setNewCredPass("");
  };

return (
    <div className="space-y-3">
      {/* Status Message */}
      {statusMsg && (
        <div className={`p-2 rounded-lg text-xs font-medium flex items-center gap-2 animate-in fade-in slide-in-from-top-1 duration-200 ${
          statusMsg.type === "success" 
            ? "bg-green-500/10 border border-green-500/30 text-green-400" 
            : "bg-red-500/10 border border-red-500/30 text-red-400"
        }`}>
          {statusMsg.type === "success" ? <CheckCircle className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
          {statusMsg.text}
        </div>
      )}

      {/* Vault Status/Enable - Compact Header */}
      <div className="flex items-center justify-between p-2 bg-[var(--surface-raised)] border border-[var(--border)] rounded">
        <div className="flex items-center gap-2">
          <Shield className="w-4 h-4 text-[var(--color-accent)]" />
          <span className="text-xs font-semibold">Credential Vault</span>
        </div>
        <ToggleOption
          label=""
          checked={vault.hasVaultEnabled}
          onChange={(checked) => vault.setHasVaultEnabled(checked)}
        />
      </div>

      {vault.hasVaultEnabled && (
        <div className="space-y-2 animate-in fade-in duration-300">
          {/* Compact Credential Form */}
          <div className="p-2 bg-[var(--background)] border border-[var(--color-accent)]/30 rounded-lg space-y-2">
             <div className="text-[10px] font-bold text-[var(--color-accent)] uppercase tracking-wide">
                {editingCred ? "Edit Profile" : "Add Secure Profile"}
             </div>
             <div className="grid grid-cols-1 gap-1.5">
                <input
                  type="text"
                  placeholder="Profile Name"
                  value={newCredName}
                  onChange={(e) => setNewCredName(e.target.value)}
                  className="w-full px-2 py-1 text-sm rounded bg-[var(--surface)] border border-[var(--border)] outline-none focus:border-[var(--color-accent)]"
                />
                <div className="grid grid-cols-2 gap-1.5">
                  <input
                    type="text"
                    placeholder="Username"
                    value={newCredUser}
                    onChange={(e) => setNewCredUser(e.target.value)}
                    className="w-full px-2 py-1 text-sm rounded bg-[var(--surface)] border border-[var(--border)] outline-none focus:border-[var(--color-accent)]"
                  />
                  <input
                    type="password"
                    placeholder="Password"
                    value={newCredPass}
                    onChange={(e) => setNewCredPass(e.target.value)}
                    className="w-full px-2 py-1 text-sm rounded bg-[var(--surface)] border border-[var(--border)] outline-none focus:border-[var(--color-accent)]"
                  />
                </div>
             </div>
             <div className="flex justify-end gap-1.5">
                {editingCred && (
                  <button
                    onClick={cancelEdit}
                    className="px-2 py-0.5 text-xs rounded hover:bg-[var(--border)]"
                  >
                    Cancel
                  </button>
                )}
                <button
                  onClick={editingCred ? handleUpdateCredential : handleAddCredential}
                  disabled={!newCredName}
                  className="px-2 py-0.5 text-xs rounded bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
                >
                  {editingCred ? "Update" : "Save"}
                </button>
             </div>
          </div>

          {/* Compact Credential List */}
          <div className="space-y-1 max-h-[200px] overflow-y-auto custom-scrollbar">
            {connections.vaultCredentials.map((cred) => (
              <div 
                key={cred.id}
                className="flex items-center justify-between px-2 py-1.5 bg-[var(--surface-raised)] border border-[var(--border)] rounded hover:border-[var(--color-accent)] transition-colors group"
              >
                <div className="flex items-center gap-2">
                  <div className="text-xs font-semibold">{cred.name}</div>
                  <div className="text-xs text-[var(--text-secondary)]">({cred.username || "—"})</div>
                </div>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button 
                    onClick={() => startEdit(cred)}
                    className="p-1 rounded hover:bg-[var(--border)]"
                  >
                    <Edit2 className="w-3 h-3" />
                  </button>
                  <button 
                    onClick={() => handleDeleteCredential(cred)}
                    className="p-1 rounded hover:bg-red-500/20 text-red-500"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
            {connections.vaultCredentials.length === 0 && (
              <div className="text-center py-3 text-xs text-[var(--text-secondary)] italic border border-dashed border-[var(--border)] rounded">
                No secure profiles stored.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
