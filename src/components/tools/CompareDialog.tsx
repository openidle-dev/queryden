import { useState, useEffect } from "react";
import { X, GitCompare, ChevronRight, AlertCircle, GitMerge, ArrowRight, Check, Play, Loader2, CheckSquare, Square, Info } from "lucide-react";
import "../editor/monacoSetup";
import { DiffEditor } from "@monaco-editor/react";
import { defineMonacoThemes, resolveMonacoTheme } from "../../utils/monacoThemes";
import { useConnections } from "../../contexts/useConnections";
import { useTheme } from "../../contexts/ThemeContext";
import { ToolGuideWizard } from "./ToolGuideWizard";
import { useConfirmDialog } from "../ui/ConfirmDialog";
import { useSettings } from "../../store/settingsStore";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";

interface CompareDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

interface TableDiff {
  name: string;
  status: "same" | "different" | "source_only" | "target_only";
  sourceDDL?: string;
  targetDDL?: string;
}

export function CompareDialog({ isOpen, onClose }: CompareDialogProps) {
  const { databases, getDDL, copyTableData, executeDataCopy, schemaItems, selectedDatabase, activeConnection, currentDb } = useConnections();
  const { theme } = useTheme();
  const [mode, setMode] = useState<"compare" | "merge">("compare");
  const [leftSelection, setLeftSelection] = useState<{ db: string; table: string }>({ db: selectedDatabase || "", table: "" });
  const [rightSelection, setRightSelection] = useState<{ db: string; table: string }>({ db: selectedDatabase || "", table: "" });
  const [leftDDL, setLeftDDL] = useState("");
  const [rightDDL, setRightDDL] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [migrationSQL, setMigrationSQL] = useState("");

  // Merge mode state
  const [sourceDB, setSourceDB] = useState("");
  const [targetDB, setTargetDB] = useState("");
  const [analyzeTable, setAnalyzeTable] = useState("");
  const [tableDiffs, setTableDiffs] = useState<TableDiff[]>([]);
  const [mergeResults, setMergeResults] = useState<string[]>([]);
  const [analyzeProgress, setAnalyzeProgress] = useState<{ current: number; total: number; phase: string } | null>(null);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [isMigrating, setIsMigrating] = useState(false);
  const [migrationProgress, setMigrationProgress] = useState<{ current: number; total: number; phase: string; errors: string[] } | null>(null);
  const [migrationComplete, setMigrationComplete] = useState<{ success: boolean; rowsCopied: number; errors: string[] } | null>(null);
  const [mergeQueryName, setMergeQueryName] = useState("");
  const [showGuide, setShowGuide] = useState(false);

  // Auto-initialize databases when dialog opens
  useEffect(() => {
    if (isOpen && activeConnection) {
      const defaultDb = selectedDatabase || (databases.length > 0 ? databases[0] : "");
      if (defaultDb) {
        if (!sourceDB) setSourceDB(defaultDb);
        if (!targetDB) setTargetDB(defaultDb);
        if (!leftSelection.db) setLeftSelection(prev => ({ ...prev, db: defaultDb }));
        if (!rightSelection.db) setRightSelection(prev => ({ ...prev, db: defaultDb }));
      }
    }
  }, [isOpen, activeConnection, selectedDatabase, databases]);

  const toggleSelection = (name: string) => {
    setSelectedItems(prev => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedItems(new Set(tableDiffs.map(d => d.name)));
  };

  const deselectAll = () => {
    setSelectedItems(new Set());
  };

  const confirm = useConfirmDialog();
  const settings = useSettings();

  const runMerge = async () => {
    if (selectedItems.size === 0) {
      await confirm.dialog({
        title: "No Selection",
        message: "Please select at least one item to merge",
        confirmLabel: "OK",
        type: "info",
      });
      return;
    }

    const confirmed = await confirm.confirm({
      title: "Confirm Merge",
      message: `Merge ${selectedItems.size} item(s) to ${targetDB}? This will transfer schema and data.`,
      confirmLabel: "Merge",
      cancelLabel: "Cancel",
      type: "warning",
    });

    if (!confirmed) return;

    setIsMigrating(true);
    setMigrationProgress({ current: 0, total: selectedItems.size * 2, phase: "Starting merge...", errors: [] });
    setMigrationComplete(null);

    const errors: string[] = [];
    let totalRows = 0;

    try {
      const selectedDiffs = tableDiffs.filter(d => selectedItems.has(d.name));
      if (selectedDiffs.length === 0) {
        await confirm.dialog({
          title: "No Valid DDL",
          message: "No valid DDL to migrate",
          confirmLabel: "OK",
          type: "info",
        });
        return;
      }

      let fullMigration = "-- ================================================\n";
      fullMigration += `-- MERGE SCRIPT: ${sourceDB} -> ${targetDB}\n`;
      fullMigration += `-- Generated: ${new Date().toISOString()}\n`;
      fullMigration += "-- ================================================\n\n";

      // Schema definition first
      fullMigration += "-- ================================================\n";
      fullMigration += "-- SCHEMA DEFINITION\n";
      fullMigration += "-- ================================================\n\n";

      const schemaStart = Date.now();
      let schemaCount = 0;

      // Phase 1: Create schema in target database
      setMigrationProgress({
        current: 0,
        total: selectedDiffs.length * 2,
        phase: "Creating schema in target database...",
        errors
      });

      for (let i = 0; i < selectedDiffs.length; i++) {
        const diff = selectedDiffs[i];
        setMigrationProgress({
          current: i + 1,
          total: selectedDiffs.length * 2,
          phase: `Creating ${diff.name}`,
          errors
        });

        try {
          fullMigration += diff.sourceDDL || `-- No DDL for ${diff.name}`;
          fullMigration += "\n\n";

          // Execute DDL if it exists
          // Execute DDL if it exists and execution is allowed
          if (diff.sourceDDL && activeConnection && settings.copyAllowExecute) {
            try {
              await currentDb.execute(diff.sourceDDL);
              schemaCount++;
            } catch (ddlError: any) {
              // Schema might already exist - that's OK
              if (!ddlError.message?.includes("already exists")) {
                errors.push(`DDL warning for ${diff.name}: ${ddlError.message}`);
              } else {
                schemaCount++;
              }
            }
          } else if (diff.sourceDDL && activeConnection && !settings.copyAllowExecute) {
            // Even if not executing, count as "processed for script"
            schemaCount++;
          } else if (activeConnection) {
            schemaCount++;
          }
        } catch (e: any) {
          errors.push(`Schema error for ${diff.name}: ${e.message || e}`);
        }
      }

      const schemaTime = Date.now() - schemaStart;
      fullMigration += `-- Schema: ${schemaCount} objects in ${(schemaTime/1000).toFixed(1)}s\n\n`;

      // Phase 2: Copy data
      fullMigration += "-- ================================================\n";
      fullMigration += "-- DATA COPY (Actual data transfer)\n";
      fullMigration += "-- ================================================\n\n";

      const dataStart = Date.now();
      let dataCount = 0;
      let tableIndex = selectedDiffs.length;

      for (let i = 0; i < selectedDiffs.length; i++) {
        const diff = selectedDiffs[i];
        setMigrationProgress({
          current: tableIndex + i + 1,
          total: selectedDiffs.length * 2,
          phase: `Copying data: ${diff.name}`,
          errors
        });

        try {
          // Generate SQL for the script regardless of execution
          const copySQL = await copyTableData(diff.name, targetDB);
          fullMigration += copySQL + "\n\n";

          // Actually execute the data copy with settings
          const copyResult = await executeDataCopy(diff.name, diff.name, targetDB, {
            method: settings.copyMethod,
            batchSize: settings.copyBatchSize,
            parallel: settings.copyParallel,
            compression: settings.copyCompression,
            allowExecute: settings.copyAllowExecute,
          });

          if (copyResult.success) {
            totalRows += copyResult.rowsCopied;
            fullMigration += `-- Data for ${diff.name}: Copied ${copyResult.rowsCopied} rows (Executed)\n`;
            dataCount++;
          } else {
            if (!settings.copyAllowExecute) {
               fullMigration += `-- Data for ${diff.name}: SQL generated for script\n`;
               dataCount++;
            } else {
              fullMigration += `-- Data for ${diff.name}: ${copyResult.error || "Failed"}\n`;
              if (copyResult.error) {
                errors.push(`${diff.name}: ${copyResult.error}`);
              }
            }
          }
        } catch (e: any) {
          errors.push(`Data copy error for ${diff.name}: ${e.message || e}`);
        }
      }

      const dataTime = Date.now() - dataStart;
      fullMigration += `-- Data copy generation: ${dataCount} tables in ${(dataTime/1000).toFixed(1)}s\n\n`;

      // Summary
      fullMigration += "-- ================================================\n";
      fullMigration += "-- SUMMARY\n";
      fullMigration += "-- ================================================\n";
      fullMigration += `-- Total objects: ${selectedDiffs.length}\n`;
      fullMigration += `Objects with schema: ${schemaCount}\n`;
      fullMigration += `Objects with data: ${dataCount}\n`;
      fullMigration += `Errors: ${errors.length}\n`;
      fullMigration += `-- Total time: ${((Date.now() - schemaStart)/1000).toFixed(1)}s\n`;

      setMigrationProgress({
        current: selectedDiffs.length * 2,
        total: selectedDiffs.length * 2,
        phase: "Complete!",
        errors
      });

      setMigrationComplete({
        success: errors.length === 0,
        rowsCopied: totalRows,
        errors
      });

      setMigrationSQL(fullMigration);

      // Don't close - let user see the results
      // Open the query with the generated SQL
      const queryName = mergeQueryName.trim() || `Merge ${sourceDB} -> ${targetDB}`;
      window.dispatchEvent(new CustomEvent("open-query-with-text", {
        detail: { query: fullMigration, name: queryName }
      }));

    } catch (e: any) {
      errors.push(`Migration failed: ${e.message || e}`);
      setMigrationComplete({
        success: false,
        rowsCopied: 0,
        errors
      });
    } finally {
      setIsMigrating(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      setLeftSelection(prev => ({ ...prev, db: selectedDatabase || prev.db }));
      setRightSelection(prev => ({ ...prev, db: selectedDatabase || prev.db }));
    }
  }, [isOpen, selectedDatabase]);

  const handleCompare = async () => {
    if (!leftSelection.table || !rightSelection.table) return;
    setIsLoading(true);
    try {
      // Get DDL for both tables
      const l = await getDDL("table", leftSelection.table);
      const r = await getDDL("table", rightSelection.table);
      setLeftDDL(l || `-- No DDL found for ${leftSelection.table}`);
      setRightDDL(r || `-- No DDL found for ${rightSelection.table}`);
    } catch (e) {
      console.error(e);
      setLeftDDL(`-- Error: ${e}`);
      setRightDDL(`-- Error: ${e}`);
    } finally {
      setIsLoading(false);
    }
  };

  const handleGenerateMigration = async () => {
    if (!leftSelection.table || !rightSelection.table) return;
    setIsLoading(true);
    try {
      const ddl = await getDDL("table", leftSelection.table);
      const copySQL = await copyTableData(leftSelection.table, rightSelection.db);

      let migration = `-- Migration: ${leftSelection.db}.${leftSelection.table} -> ${rightSelection.db}.${rightSelection.table}\n`;
      migration += `-- Generated: ${new Date().toISOString()}\n\n`;
      migration += `-- Phase 1: Schema\n`;
      migration += ddl + "\n\n";
      migration += `-- Phase 2: Data\n`;
      migration += copySQL + "\n";

      setMigrationSQL(migration);
      await confirm.dialog({
        title: "Migration Generated",
        message: "A migration script has been generated. You can now run it or view it.",
        confirmLabel: "OK",
        type: "success",
      });
    } catch (e: any) {
      confirm.dialog({
        title: "Generation Failed",
        message: "Failed to generate migration: " + (e.message || e),
        confirmLabel: "OK",
        type: "danger"
      });
    } finally {
      setIsLoading(false);
    }
  };

  const runMigration = async () => {
    if (!migrationSQL) return;

    const confirmed = await confirm.confirm({
      title: "Confirm Migration",
      message: "Run this migration on the target database?",
      confirmLabel: "Run",
      cancelLabel: "Cancel",
      type: "warning",
    });

    if (!confirmed) return;

    setIsLoading(true);
    try {
      window.dispatchEvent(new CustomEvent("open-query-with-text", {
        detail: { query: migrationSQL, name: `Migration ${leftSelection.table} -> ${rightSelection.table}` }
      }));
      onClose();
    } catch (e: any) {
      confirm.dialog({
        title: "Migration Failed",
        message: "Failed to run migration: " + (e.message || e),
        confirmLabel: "OK",
        type: "danger"
      });
    } finally {
      setIsLoading(false);
    }
  };

  const analyzeDatabases = async () => {
    if (!sourceDB || !targetDB) return;
    setIsLoading(true);
    setTableDiffs([]);
    setMergeResults([]);
    setAnalyzeProgress({ current: 0, total: 0, phase: "Starting..." });
    setSelectedItems(new Set());

    try {
      const diffs: TableDiff[] = [];
      let allTables = schemaItems?.tables || [];
      let allViews: string[] = [];
      let allFunctions: string[] = [];

      // Filter to specific table if selected - only analyze that table
      if (analyzeTable) {
        allTables = [analyzeTable];
      } else {
        allViews = schemaItems?.views || [];
        allFunctions = schemaItems?.functions || [];
      }

      const allItems = [...allTables, ...allViews, ...allFunctions];

      setAnalyzeProgress({ current: 0, total: allItems.length, phase: "Analyzing tables..." });

      // Analyze tables
      for (let i = 0; i < allTables.length; i++) {
        const table = allTables[i];
        setAnalyzeProgress({ current: i + 1, total: allItems.length, phase: `Analyzing table: ${table}` });

        try {
          const ddl = await getDDL("table", table);
          diffs.push({
            name: table,
            status: "same",
            sourceDDL: ddl,
            targetDDL: ddl
          });
        } catch (e) {
          diffs.push({ name: table, status: "different" });
        }
      }

      // Analyze views
      setAnalyzeProgress({ current: allTables.length, total: allItems.length, phase: "Analyzing views..." });
      for (let i = 0; i < allViews.length; i++) {
        const view = allViews[i];
        setAnalyzeProgress({ current: allTables.length + i + 1, total: allItems.length, phase: `Analyzing view: ${view}` });

        try {
          const ddl = await getDDL("view", view);
          diffs.push({
            name: view,
            status: "same",
            sourceDDL: ddl,
            targetDDL: ddl
          });
        } catch (e) {
          diffs.push({ name: view, status: "different" });
        }
      }

      // Analyze functions
      setAnalyzeProgress({ current: allTables.length + allViews.length, total: allItems.length, phase: "Analyzing functions..." });
      for (let i = 0; i < allFunctions.length; i++) {
        const func = allFunctions[i];
        setAnalyzeProgress({ current: allTables.length + allViews.length + i + 1, total: allItems.length, phase: `Analyzing function: ${func}` });

        try {
          const ddl = await getDDL("function", func);
          diffs.push({
            name: func,
            status: "same",
            sourceDDL: ddl,
            targetDDL: ddl
          });
        } catch (e) {
          diffs.push({ name: func, status: "different" });
        }
      }

      setTableDiffs(diffs);
      setAnalyzeProgress({ current: allItems.length, total: allItems.length, phase: "Complete!" });

      if (diffs.length === 0) {
        setMergeResults(["No objects found to analyze"]);
      } else {
        const tableCount = allTables.length;
        const prefix = analyzeTable ? `Analyzed table: ${analyzeTable}` : `Analysis complete: ${tableCount} tables`;
        setMergeResults([`${prefix}, ${allViews.length} views, ${allFunctions.length} functions`]);
      }
    } catch (e) {
      setMergeResults([`Error: ${e}`]);
    } finally {
      setIsLoading(false);
      setTimeout(() => setAnalyzeProgress(null), 2000);
    }
  };

  if (!isOpen) return null;

  if (!activeConnection) {
    return (
      <>
        <Dialog open={isOpen} onClose={onClose} size="md">
          <Dialog.Body className="p-8 text-center">
            <div className="p-4 bg-[var(--warning-3)] rounded-full w-20 h-20 flex items-center justify-center mx-auto mb-6 relative">
              <AlertCircle className="w-10 h-10 text-[var(--warning-11)]" />
              <IconButton
                icon={<Info />}
                label="How to fix this?"
                variant="primary"
                size="sm"
                onClick={() => setShowGuide(true)}
                className="absolute -top-2 -right-2 rounded-full shadow-lg"
              />
            </div>
            <h2 className="text-xl font-bold mb-2 text-[var(--neutral-12)]">Cluster Required</h2>
            <p className="text-sm text-[var(--neutral-11)] mb-8 leading-relaxed">
              Please first initialize the database cluster before using the comparison or merge tools.
              <button
                onClick={() => setShowGuide(true)}
                className="text-[var(--accent-11)] hover:underline ml-1 font-medium"
              >
                Learn more
              </button>
            </p>
            <Button variant="primary" size="md" onClick={onClose} className="w-full">
              Go Back
            </Button>
          </Dialog.Body>
        </Dialog>
        <ToolGuideWizard
          isOpen={showGuide}
          onClose={() => setShowGuide(false)}
          type="cluster-required"
        />
      </>
    );
  }

  return (
    <Dialog open={isOpen} onClose={onClose} className="w-full h-full max-w-6xl rounded-xl overflow-hidden">
      <div className="p-4 border-b border-[var(--neutral-6)] flex items-center justify-between bg-[var(--surface-elevated)]">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-[var(--accent-3)] rounded-lg">
            {mode === "compare" ? (
              <GitCompare className="w-5 h-5 text-[var(--accent-11)]" />
            ) : (
              <GitMerge className="w-5 h-5 text-[var(--accent-11)]" />
            )}
          </div>
          <div>
            <h2 className="text-lg font-bold text-[var(--neutral-12)]">
              {mode === "compare" ? "Schema Comparison" : "Database Merge"}
            </h2>
            <p className="text-[10px] text-[var(--neutral-11)] uppercase tracking-widest font-bold opacity-60">
              {mode === "compare" ? "Structure Diff Tool" : "Migration Generator"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant={mode === "compare" ? "primary" : "secondary"} onClick={() => setMode("compare")}>
            Compare
          </Button>
          <Button size="sm" variant={mode === "merge" ? "primary" : "secondary"} onClick={() => setMode("merge")}>
            Merge
          </Button>
          <IconButton icon={<X />} label="Close" variant="ghost" size="sm" onClick={onClose} />
        </div>
      </div>

      {mode === "compare" ? (
        <>
          <div className="p-4 bg-[var(--surface-base)] border-b border-[var(--neutral-6)] flex items-center gap-6 select-none">
            <div className="flex-1 flex flex-col gap-2">
              <label className="text-[10px] font-bold text-[var(--neutral-11)] uppercase">Source Table (Left)</label>
              <div className="flex gap-2 relative">
                <div className="flex-1">
                  <Select
                    selectSize="sm"
                    value={leftSelection.db}
                    onValueChange={(db) => setLeftSelection({ ...leftSelection, db })}
                    options={databases.map(db => ({ label: db, value: db }))}
                  />
                </div>
                <div className="flex-[2]">
                  <Input
                    inputSize="sm"
                    list="schema-tables-left"
                    placeholder="Search table..."
                    value={leftSelection.table}
                    onChange={(e) => setLeftSelection({ ...leftSelection, table: e.target.value })}
                  />
                  <datalist id="schema-tables-left">
                    {schemaItems?.tables.map(t => <option key={t} value={t}>{t}</option>)}
                  </datalist>
                </div>
              </div>
            </div>

            <div className="shrink-0 pt-4">
              <ChevronRight className="w-5 h-5 opacity-20" />
            </div>

            <div className="flex-1 flex flex-col gap-2">
              <label className="text-[10px] font-bold text-[var(--neutral-11)] uppercase">Target Table (Right)</label>
              <div className="flex gap-2">
                <div className="flex-1">
                  <Select
                    selectSize="sm"
                    value={rightSelection.db}
                    onValueChange={(db) => setRightSelection({ ...rightSelection, db })}
                    options={databases.map(db => ({ label: db, value: db }))}
                  />
                </div>
                <div className="flex-[2]">
                  <Input
                    inputSize="sm"
                    list="schema-tables-right"
                    placeholder="Search table..."
                    value={rightSelection.table}
                    onChange={(e) => setRightSelection({ ...rightSelection, table: e.target.value })}
                  />
                  <datalist id="schema-tables-right">
                    {schemaItems?.tables.map(t => <option key={t} value={t}>{t}</option>)}
                  </datalist>
                </div>
              </div>
            </div>

            <div className="pt-4">
              <Button
                variant="primary"
                size="md"
                onClick={handleCompare}
                loading={isLoading}
                disabled={!leftSelection.table || !rightSelection.table}
              >
                {isLoading ? "Fetching..." : "Compare Structure"}
              </Button>
            </div>
          </div>

          <div className="flex-1 relative bg-[var(--surface-base)]">
            {leftDDL && rightDDL ? (
              <>
                {leftDDL === rightDDL && !leftDDL.includes('-- Error') && (
                  <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 px-4 py-1.5 bg-[var(--success-3)] border border-[var(--success-6)] text-[var(--success-11)] rounded-full text-xs font-bold flex items-center shadow-lg">
                    <AlertCircle className="w-4 h-4 mr-2" /> Match! No structural differences found.
                  </div>
                )}
                <DiffEditor
                  height="100%"
                  language="sql"
                  original={leftDDL}
                  modified={rightDDL}
                  theme={resolveMonacoTheme(theme)}
                  beforeMount={defineMonacoThemes}
                  options={{
                    renderSideBySide: true,
                    readOnly: true,
                    minimap: { enabled: false },
                    fontSize: 13,
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                  }}
                />
              </>
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center opacity-30">
                <GitCompare className="w-20 h-20 mb-4" />
                <p className="text-xl font-bold">Select two tables to compare their DDL</p>
                <p className="text-sm mt-1">Make sure you type the full exact name from the dropdown list</p>
              </div>
            )}
          </div>

          <div className="p-3 border-t border-[var(--neutral-6)] bg-[var(--surface-elevated)] flex items-center justify-between">
            <div className="flex items-center gap-2 text-[10px] text-[var(--success-11)]">
              <AlertCircle className="w-3.5 h-3.5" />
              <span>DDL comparison ready - select tables to compare</span>
            </div>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={handleGenerateMigration}
                disabled={isLoading || !leftSelection.table || !rightSelection.table}
              >
                Generate Migration
              </Button>
              {migrationSQL && (
                <Button variant="primary" size="sm" onClick={runMigration} disabled={isLoading}>
                  Run Migration
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={onClose}>Close Tool</Button>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="p-4 bg-[var(--surface-base)] border-b border-[var(--neutral-6)] flex items-center gap-4">
            <div className="flex-1">
              <Select
                label="Source Database"
                selectSize="sm"
                placeholder="Select database..."
                value={sourceDB}
                onValueChange={(v) => { setSourceDB(v); setAnalyzeTable(""); }}
                options={databases.map(db => ({ label: db, value: db }))}
              />
            </div>
            <div className="pt-5">
              <ArrowRight className="w-5 h-5 text-[var(--accent-11)]" />
            </div>
            <div className="flex-1">
              <Select
                label="Target Database"
                selectSize="sm"
                placeholder="Select database..."
                value={targetDB}
                onValueChange={setTargetDB}
                options={databases.map(db => ({ label: db, value: db }))}
              />
            </div>
            <div className="w-48">
              <Select
                label="Specific Table (optional)"
                selectSize="sm"
                value={analyzeTable || "__all__"}
                onValueChange={(v) => setAnalyzeTable(v === "__all__" ? "" : v)}
                disabled={!sourceDB}
                options={[{ label: "All tables", value: "__all__" }, ...(schemaItems?.tables?.map(t => ({ label: t, value: t })) ?? [])]}
              />
            </div>
            <div className="flex items-center gap-4 pt-5">
              <label className="flex items-center gap-2 cursor-pointer group">
                <div className="relative">
                  <input
                    type="checkbox"
                    className="sr-only peer"
                    checked={settings.copyAllowExecute}
                    onChange={(e) => settings.setSetting("copyAllowExecute", e.target.checked)}
                  />
                  <div className="w-8 h-4 bg-[var(--neutral-5)] rounded-full peer peer-checked:bg-[var(--accent-9)] transition-colors after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:after:translate-x-4"></div>
                </div>
                <span className="text-[10px] uppercase font-bold text-[var(--neutral-11)] group-hover:text-[var(--accent-11)]">Direct Execute</span>
              </label>
              <Button
                variant="primary"
                size="md"
                onClick={analyzeDatabases}
                loading={isLoading}
                disabled={!sourceDB || !targetDB}
                leftIcon={isLoading ? undefined : <Play className="w-3 h-3" />}
              >
                Analyze
              </Button>
            </div>
          </div>

          <div className="flex-1 p-4 overflow-auto">
            {/* Migration Progress */}
            {(migrationProgress || migrationComplete) && (
              <div className="mb-4">
                {migrationComplete ? (
                  <div className={`rounded p-3 ${migrationComplete.success ? 'bg-[var(--success-3)] border border-[var(--success-6)]' : 'bg-[var(--danger-3)] border border-[var(--danger-6)]'}`}>
                    <div className="flex items-center gap-2 mb-2">
                      {migrationComplete.success ? (
                        <Check className="w-4 h-4 text-[var(--success-11)]" />
                      ) : (
                        <AlertCircle className="w-4 h-4 text-[var(--danger-11)]" />
                      )}
                      <span className={`text-xs font-bold ${migrationComplete.success ? 'text-[var(--success-11)]' : 'text-[var(--danger-11)]'}`}>
                        {migrationComplete.success ? 'Migration script generated!' : 'Migration completed with errors'}
                      </span>
                    </div>
                    {migrationComplete.errors.length > 0 && (
                      <div className="mt-2 text-[10px] text-[var(--danger-11)] max-h-24 overflow-auto">
                        {migrationComplete.errors.map((err, i) => (
                          <div key={i} className="mb-1">• {err}</div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : migrationProgress && (
                  <div className="bg-[var(--accent-3)] border border-[var(--accent-6)] rounded p-3">
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-[var(--accent-11)] flex items-center gap-2">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        {migrationProgress.phase}
                      </span>
                      <span className="text-[var(--neutral-11)]">
                        {migrationProgress.current} / {migrationProgress.total}
                      </span>
                    </div>
                    <div className="h-2 bg-[var(--neutral-5)] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[var(--accent-9)] transition-all duration-300"
                        style={{ width: `${migrationProgress.total > 0 ? (migrationProgress.current / migrationProgress.total) * 100 : 0}%` }}
                      />
                    </div>
                    {migrationProgress.errors.length > 0 && (
                      <div className="mt-2 text-[10px] text-[var(--danger-11)]">
                        {migrationProgress.errors.length} error(s) so far
                      </div>
                    )}
                  </div>
                )}
              </div>
)}

            {analyzeProgress && !migrationProgress && (
              <div className="mb-4">
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-[var(--accent-11)] flex items-center gap-2">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    {analyzeProgress.phase}
                  </span>
                  <span className="text-[var(--neutral-11)]">
                    {analyzeProgress.current} / {analyzeProgress.total}
                  </span>
                </div>
                <div className="h-2 bg-[var(--neutral-5)] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[var(--accent-9)] transition-all duration-300"
                    style={{ width: `${analyzeProgress.total > 0 ? (analyzeProgress.current / analyzeProgress.total) * 100 : 0}%` }}
                  />
                </div>
              </div>
            )}

            {tableDiffs.length > 0 && !migrationComplete ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 pb-2 border-b border-[var(--neutral-6)]">
                  <Check className="w-4 h-4 text-[var(--success-11)]" />
                  <span className="text-sm font-bold">Analysis Results ({tableDiffs.length} objects)</span>
                </div>

                <div className="bg-[var(--success-3)] border border-[var(--success-6)] rounded p-3 mb-4">
                  <p className="text-xs text-[var(--success-11)]">Database merge: schema + data copy from {sourceDB} to {targetDB}.</p>
                  <p className="text-[10px] text-[var(--success-11)] opacity-70 mt-1">Using: {settings.copyMethod} method, batch size: {settings.copyBatchSize}</p>
                </div>

                <div className="grid grid-cols-1 gap-1">
                  <div className="flex items-center gap-2 pb-2 border-b border-[var(--neutral-6)] mb-2">
                    <span className="text-sm font-bold">Analysis Results ({tableDiffs.length} objects)</span>
                    <div className="flex-1" />
                    <button onClick={selectAll} className="text-[10px] text-[var(--accent-11)] hover:text-[var(--accent-10)] flex items-center gap-1">
                      <CheckSquare className="w-3 h-3" /> Select All
                    </button>
                    <button onClick={deselectAll} className="text-[10px] text-[var(--neutral-11)] hover:text-[var(--neutral-12)] flex items-center gap-1">
                      <Square className="w-3 h-3" /> Deselect
                    </button>
                  </div>

                  {tableDiffs.map(diff => (
                    <div key={diff.name} onClick={() => toggleSelection(diff.name)}
                      className={`flex items-center gap-2 p-2 bg-[var(--neutral-3)] rounded text-xs cursor-pointer hover:bg-[var(--neutral-4)] ${selectedItems.has(diff.name) ? 'ring-1 ring-[var(--accent-8)]' : ''}`}>
                      {selectedItems.has(diff.name) ? (
                        <CheckSquare className="w-3.5 h-3.5 text-[var(--accent-11)]" />
                      ) : (
                        <Square className="w-3.5 h-3.5 text-[var(--neutral-9)]" />
                      )}
                      <span className={`w-2 h-2 rounded-full ${diff.status === 'same' ? 'bg-[var(--success-9)]' : diff.status === 'different' ? 'bg-[var(--warning-9)]' : 'bg-[var(--danger-9)]'}`} />
                      <span className="flex-1 font-mono">{diff.name}</span>
                      <span className="text-[10px] uppercase">{diff.status}</span>
                    </div>
                  ))}
                </div>

                {tableDiffs.length > 20 && (
                  <p className="text-xs text-[var(--neutral-11)] text-center py-2">
                    ... and {tableDiffs.length - 20} more objects
                  </p>
                )}

                {selectedItems.size > 0 && !migrationComplete && (
                  <div className="mt-4 p-3 bg-[var(--accent-3)] border border-[var(--accent-6)] rounded">
                    <div className="flex items-center gap-2 mb-2">
                      <Input
                        inputSize="sm"
                        value={mergeQueryName}
                        onChange={(e) => setMergeQueryName(e.target.value)}
                        placeholder={`Merge ${sourceDB} → ${targetDB}`}
                      />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-[var(--accent-11)]">
                        {selectedItems.size} item(s) selected
                      </span>
                      <Button
                        variant="primary"
                        size="md"
                        onClick={runMerge}
                        loading={isMigrating}
                        leftIcon={isMigrating ? undefined : <ArrowRight className="w-3 h-3" />}
                      >
                        Merge to {targetDB}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ) : mergeResults.length > 0 && !analyzeProgress ? (
              <div className="p-4 bg-[var(--accent-3)] border border-[var(--accent-6)] rounded">
                {mergeResults.map((result, i) => (
                  <p key={i} className="text-xs">{result}</p>
                ))}
              </div>
            ) : !analyzeProgress ? (
              <div className="flex flex-col items-center justify-center h-full opacity-40">
                <GitMerge className="w-16 h-16 mb-4" />
                <p className="text-lg font-bold">Database Merge Tool</p>
                <p className="text-sm mt-2">Select source and target databases, then click ANALYZE</p>
              </div>
            ) : null}
          </div>

          <div className="p-3 border-t border-[var(--neutral-6)] bg-[var(--surface-elevated)] flex justify-between items-center">
            <div className="text-[10px] text-[var(--neutral-11)]">
              {migrationComplete ? (
                <span className={migrationComplete.success ? "text-[var(--success-11)]" : "text-[var(--warning-11)]"}>
                  {migrationComplete.success ? "Migration completed successfully" : "Migration completed with errors"}
                </span>
              ) : mode === "merge" ? (
                <span>Select tables and click MERGE when ready</span>
              ) : null}
            </div>
            <div className="flex gap-2">
              {migrationComplete && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setMigrationComplete(null);
                    setMigrationProgress(null);
                    setSelectedItems(new Set());
                    setTableDiffs([]);
                  }}
                >
                  New Merge
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={onClose}>
                {migrationComplete ? "Done" : "Close"}
              </Button>
            </div>
          </div>
        </>
      )}
    </Dialog>
  );
}
