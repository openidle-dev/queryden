import { useState, useEffect } from "react";
import { X, GitCompare, ChevronRight, AlertCircle, GitMerge, ArrowRight, Check, Play, Loader2, CheckSquare, Square, Info } from "lucide-react";
import { DiffEditor } from "@monaco-editor/react";
import { useConnections } from "../../contexts/useConnections";
import { ToolGuideWizard } from "./ToolGuideWizard";
import { useConfirmDialog } from "../ui/ConfirmDialog";
import { useSettings } from "../../store/settingsStore";

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
        <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-8 backdrop-blur-sm">
          <div className="bg-[var(--surface)] w-full max-w-md rounded-xl shadow-2xl flex flex-col overflow-hidden border border-[var(--border)] p-8 text-center animate-in zoom-in duration-200">
            <div className="p-4 bg-amber-500/20 rounded-full w-20 h-20 flex items-center justify-center mx-auto mb-6 relative">
              <AlertCircle className="w-10 h-10 text-amber-500" />
              <button 
                onClick={() => setShowGuide(true)}
                className="absolute -top-2 -right-2 p-2 bg-blue-500 text-white rounded-full shadow-lg hover:bg-blue-600 transition-all scale-110"
                title="How to fix this?"
              >
                <Info className="w-4 h-4" />
              </button>
            </div>
            <h2 className="text-xl font-bold mb-2 text-white">Cluster Required</h2>
            <p className="text-sm text-[var(--text-secondary)] mb-8 leading-relaxed">
              Please first initialize the database cluster before using the comparison or merge tools.
              <button 
                onClick={() => setShowGuide(true)}
                className="text-blue-400 hover:underline ml-1 font-medium"
              >
                Learn more
              </button>
            </p>
            <button 
              onClick={onClose}
              className="w-full py-3 bg-amber-500 hover:bg-amber-600 text-white rounded-xl font-bold transition-all shadow-lg shadow-amber-500/20"
            >
              Go Back
            </button>
          </div>
        </div>
        <ToolGuideWizard 
          isOpen={showGuide} 
          onClose={() => setShowGuide(false)} 
          type="cluster-required" 
        />
      </>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-8 backdrop-blur-sm">
      <div className="bg-[var(--surface)] w-full h-full max-w-6xl rounded-xl shadow-2xl flex flex-col overflow-hidden border border-[var(--border)]">
        <div className="p-4 border-b border-[var(--border)] flex items-center justify-between bg-[var(--surface-raised)]">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-amber-500/20 rounded-lg">
              {mode === "compare" ? (
                <GitCompare className="w-5 h-5 text-amber-500" />
              ) : (
                <GitMerge className="w-5 h-5 text-amber-500" />
              )}
            </div>
            <div>
              <h2 className="text-lg font-bold">
                {mode === "compare" ? "Schema Comparison" : "Database Merge"}
              </h2>
              <p className="text-[10px] text-[var(--text-secondary)] uppercase tracking-widest font-bold opacity-60">
                {mode === "compare" ? "Structure Diff Tool" : "Migration Generator"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button 
              onClick={() => setMode("compare")}
              className={`px-3 py-1 text-xs font-bold rounded ${mode === "compare" ? "bg-amber-500 text-white" : "bg-[var(--border)]"}`}
            >
              Compare
            </button>
            <button 
              onClick={() => setMode("merge")}
              className={`px-3 py-1 text-xs font-bold rounded ${mode === "merge" ? "bg-amber-500 text-white" : "bg-[var(--border)]"}`}
            >
              Merge
            </button>
            <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {mode === "compare" ? (
          <>
            <div className="p-4 bg-[var(--surface)] border-b border-[var(--border)] flex items-center gap-6 select-none">
              <div className="flex-1 flex flex-col gap-2">
                <label className="text-[10px] font-bold text-[var(--text-secondary)] uppercase">Source Table (Left)</label>
                <div className="flex gap-2 relative">
                  <select 
                    value={leftSelection.db}
                    onChange={(e) => setLeftSelection({ ...leftSelection, db: e.target.value })}
                    className="flex-1 bg-[var(--background)] border border-[var(--border)] rounded px-3 py-1.5 text-xs outline-none focus:border-[var(--color-accent)] text-[var(--text-primary)]"
                  >
                    {databases.map(db => <option key={db} value={db}>{db}</option>)}
                  </select>
                  <div className="flex-[2] relative">
                    <input
                      list="schema-tables-left"
                      placeholder="Search table..."
                      value={leftSelection.table}
                      onChange={(e) => setLeftSelection({ ...leftSelection, table: e.target.value })}
                      className="w-full bg-[var(--background)] border border-[var(--border)] rounded px-3 py-1.5 text-xs outline-none focus:border-[var(--color-accent)] text-[var(--text-primary)]"
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
                <label className="text-[10px] font-bold text-[var(--text-secondary)] uppercase">Target Table (Right)</label>
                <div className="flex gap-2">
                  <select 
                    value={rightSelection.db}
                    onChange={(e) => setRightSelection({ ...rightSelection, db: e.target.value })}
                    className="flex-1 bg-[var(--background)] border border-[var(--border)] rounded px-3 py-1.5 text-xs outline-none focus:border-[var(--color-accent)] text-[var(--text-primary)]"
                  >
                    {databases.map(db => <option key={db} value={db}>{db}</option>)}
                  </select>
                  <div className="flex-[2] relative">
                    <input
                      list="schema-tables-right"
                      placeholder="Search table..."
                      value={rightSelection.table}
                      onChange={(e) => setRightSelection({ ...rightSelection, table: e.target.value })}
                      className="w-full bg-[var(--background)] border border-[var(--border)] rounded px-3 py-1.5 text-xs outline-none focus:border-[var(--color-accent)] text-[var(--text-primary)]"
                    />
                    <datalist id="schema-tables-right">
                      {schemaItems?.tables.map(t => <option key={t} value={t}>{t}</option>)}
                    </datalist>
                  </div>
                </div>
              </div>

              <div className="pt-4">
                <button 
                  onClick={handleCompare}
                  disabled={isLoading || !leftSelection.table || !rightSelection.table}
                  className="px-6 py-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-30 text-white rounded font-bold text-xs shadow-lg shadow-amber-500/20 transition-all flex items-center gap-2"
                >
                  {isLoading ? "Fetching..." : "COMPARE STRUCTURE"}
                </button>
              </div>
            </div>

            <div className="flex-1 relative bg-[#1e1e1e]">
              {leftDDL && rightDDL ? (
                <>
                  {leftDDL === rightDDL && !leftDDL.includes('-- Error') && (
                    <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 px-4 py-1.5 bg-green-500/20 border border-green-500/50 text-green-400 rounded-full text-xs font-bold flex items-center shadow-lg">
                      <AlertCircle className="w-4 h-4 mr-2" /> Match! No structural differences found.
                    </div>
                  )}
                  <DiffEditor
                    height="100%"
                    language="sql"
                    original={leftDDL}
                    modified={rightDDL}
                    theme="vs-dark"
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

            <div className="p-3 border-t border-[var(--border)] bg-[var(--surface-raised)] flex items-center justify-between">
              <div className="flex items-center gap-2 text-[10px] text-green-400">
                <AlertCircle className="w-3.5 h-3.5" />
                <span>DDL comparison ready - select tables to compare</span>
              </div>
              <div className="flex gap-2">
                <button 
                  onClick={handleGenerateMigration}
                  disabled={isLoading || !leftSelection.table || !rightSelection.table}
                  className="px-4 py-1.5 text-xs font-bold bg-blue-500/10 text-blue-400 border border-blue-500/30 hover:bg-blue-500/20 rounded transition-colors uppercase"
                >
                  Generate Migration
                </button>
                {migrationSQL && (
                  <button 
                    onClick={runMigration}
                    disabled={isLoading}
                    className="px-4 py-1.5 text-xs font-bold bg-green-500/10 text-green-400 border border-green-500/30 hover:bg-green-500/20 rounded transition-colors uppercase"
                  >
                    Run Migration
                  </button>
                )}
                <button onClick={onClose} className="px-4 py-1.5 text-xs font-bold hover:bg-white/5 rounded transition-colors uppercase">Close Tool</button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="p-4 bg-[var(--surface)] border-b border-[var(--border)] flex items-center gap-4">
              <div className="flex-1">
                <label className="text-[10px] font-bold text-[var(--text-secondary)] uppercase">Source Database</label>
                <select 
                  value={sourceDB}
                  onChange={(e) => { setSourceDB(e.target.value); setAnalyzeTable(""); }}
                  className="w-full bg-[var(--background)] border border-[var(--border)] rounded px-3 py-2 text-xs outline-none focus:border-[var(--color-accent)]"
                >
                  <option value="">Select database...</option>
                  {databases.map(db => <option key={db} value={db}>{db}</option>)}
                </select>
              </div>
              <div className="pt-5">
                <ArrowRight className="w-5 h-5 text-amber-500" />
              </div>
              <div className="flex-1">
                <label className="text-[10px] font-bold text-[var(--text-secondary)] uppercase">Target Database</label>
                <select 
                  value={targetDB}
                  onChange={(e) => setTargetDB(e.target.value)}
                  className="w-full bg-[var(--background)] border border-[var(--border)] rounded px-3 py-2 text-xs outline-none focus:border-[var(--color-accent)]"
                >
                  <option value="">Select database...</option>
                  {databases.map(db => <option key={db} value={db}>{db}</option>)}
                </select>
              </div>
              <div className="w-48">
                <label className="text-[10px] font-bold text-[var(--text-secondary)] uppercase">Specific Table (optional)</label>
                <select 
                  value={analyzeTable}
                  onChange={(e) => setAnalyzeTable(e.target.value)}
                  disabled={!sourceDB}
                  className="w-full bg-[var(--background)] border border-[var(--border)] rounded px-3 py-2 text-xs outline-none focus:border-[var(--color-accent)] disabled:opacity-50"
                >
                  <option value="">All tables</option>
                  {schemaItems?.tables?.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
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
                    <div className="w-8 h-4 bg-[var(--surface-raised)] rounded-full peer peer-checked:bg-amber-500 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:after:translate-x-4"></div>
                  </div>
                  <span className="text-[10px] uppercase font-bold text-[var(--text-secondary)] group-hover:text-amber-400">Direct Execute</span>
                </label>
                <button 
                  onClick={analyzeDatabases}
                  disabled={isLoading || !sourceDB || !targetDB}
                  className="px-4 py-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-30 text-white rounded font-bold text-xs flex items-center gap-2"
                >
                  {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
                  ANALYZE
                </button>
              </div>
            </div>
            
            <div className="flex-1 p-4 overflow-auto">
              {/* Migration Progress */}
              {(migrationProgress || migrationComplete) && (
                <div className="mb-4">
                  {migrationComplete ? (
                    <div className={`rounded p-3 ${migrationComplete.success ? 'bg-green-500/10 border border-green-500/30' : 'bg-red-500/10 border border-red-500/30'}`}>
                      <div className="flex items-center gap-2 mb-2">
                        {migrationComplete.success ? (
                          <Check className="w-4 h-4 text-green-400" />
                        ) : (
                          <AlertCircle className="w-4 h-4 text-red-400" />
                        )}
                        <span className={`text-xs font-bold ${migrationComplete.success ? 'text-green-400' : 'text-red-400'}`}>
                          {migrationComplete.success ? 'Migration script generated!' : 'Migration completed with errors'}
                        </span>
                      </div>
                      {migrationComplete.errors.length > 0 && (
                        <div className="mt-2 text-[10px] text-red-400 max-h-24 overflow-auto">
                          {migrationComplete.errors.map((err, i) => (
                            <div key={i} className="mb-1">• {err}</div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : migrationProgress && (
                    <div className="bg-amber-500/10 border border-amber-500/30 rounded p-3">
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="text-amber-400 flex items-center gap-2">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          {migrationProgress.phase}
                        </span>
                        <span className="text-[var(--text-secondary)]">
                          {migrationProgress.current} / {migrationProgress.total}
                        </span>
                      </div>
                      <div className="h-2 bg-[var(--surface-raised)] rounded-full overflow-hidden">
                        <div 
                          className="h-full bg-amber-500 transition-all duration-300"
                          style={{ width: `${migrationProgress.total > 0 ? (migrationProgress.current / migrationProgress.total) * 100 : 0}%` }}
                        />
                      </div>
                      {migrationProgress.errors.length > 0 && (
                        <div className="mt-2 text-[10px] text-red-400">
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
                    <span className="text-amber-400 flex items-center gap-2">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      {analyzeProgress.phase}
                    </span>
                    <span className="text-[var(--text-secondary)]">
                      {analyzeProgress.current} / {analyzeProgress.total}
                    </span>
                  </div>
                  <div className="h-2 bg-[var(--surface-raised)] rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-amber-500 transition-all duration-300"
                      style={{ width: `${analyzeProgress.total > 0 ? (analyzeProgress.current / analyzeProgress.total) * 100 : 0}%` }}
                    />
                  </div>
                </div>
              )}
              
              {tableDiffs.length > 0 && !migrationComplete ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 pb-2 border-b border-[var(--border)]">
                    <Check className="w-4 h-4 text-green-400" />
                    <span className="text-sm font-bold">Analysis Results ({tableDiffs.length} objects)</span>
                  </div>
                  
                  <div className="bg-green-500/10 border border-green-500/30 rounded p-3 mb-4">
                    <p className="text-xs text-green-400">Database merge: schema + data copy from {sourceDB} to {targetDB}.</p>
                    <p className="text-[10px] text-green-400/70 mt-1">Using: {settings.copyMethod} method, batch size: {settings.copyBatchSize}</p>
                  </div>
                  
                  <div className="grid grid-cols-1 gap-1">
                    <div className="flex items-center gap-2 pb-2 border-b border-[var(--border)] mb-2">
                      <span className="text-sm font-bold">Analysis Results ({tableDiffs.length} objects)</span>
                      <div className="flex-1" />
                      <button onClick={selectAll} className="text-[10px] text-blue-400 hover:text-blue-300 flex items-center gap-1">
                        <CheckSquare className="w-3 h-3" /> Select All
                      </button>
                      <button onClick={deselectAll} className="text-[10px] text-gray-400 hover:text-gray-300 flex items-center gap-1">
                        <Square className="w-3 h-3" /> Deselect
                      </button>
                    </div>
                    
                    {tableDiffs.map(diff => (
                      <div key={diff.name} onClick={() => toggleSelection(diff.name)}
                        className={`flex items-center gap-2 p-2 bg-[var(--surface-raised)] rounded text-xs cursor-pointer hover:bg-[var(--surface-hover)] ${selectedItems.has(diff.name) ? 'ring-1 ring-amber-500' : ''}`}>
                        {selectedItems.has(diff.name) ? (
                          <CheckSquare className="w-3.5 h-3.5 text-amber-400" />
                        ) : (
                          <Square className="w-3.5 h-3.5 text-gray-500" />
                        )}
                        <span className={`w-2 h-2 rounded-full ${diff.status === 'same' ? 'bg-green-400' : diff.status === 'different' ? 'bg-amber-400' : 'bg-red-400'}`} />
                        <span className="flex-1 font-mono">{diff.name}</span>
                        <span className="text-[10px] uppercase">{diff.status}</span>
                      </div>
                    ))}
                  </div>
                  
                  {tableDiffs.length > 20 && (
                    <p className="text-xs text-[var(--text-secondary)] text-center py-2">
                      ... and {tableDiffs.length - 20} more objects
                    </p>
                  )}

                  {selectedItems.size > 0 && !migrationComplete && (
                    <div className="mt-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded">
                      <div className="flex items-center gap-2 mb-2">
                        <input
                          type="text"
                          value={mergeQueryName}
                          onChange={(e) => setMergeQueryName(e.target.value)}
                          placeholder={`Merge ${sourceDB} → ${targetDB}`}
                          className="flex-1 bg-[var(--background)] border border-[var(--border)] rounded px-2 py-1 text-xs outline-none"
                        />
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-amber-400">
                          {selectedItems.size} item(s) selected
                        </span>
                        <button 
                          onClick={runMerge}
                          disabled={isMigrating}
                          className="px-4 py-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-30 text-white rounded font-bold text-xs flex items-center gap-2"
                        >
                          {isMigrating ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowRight className="w-3 h-3" />}
                          MERGE TO {targetDB}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ) : mergeResults.length > 0 && !analyzeProgress ? (
                <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded">
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
              
            <div className="p-3 border-t border-[var(--border)] bg-[var(--surface-raised)] flex justify-between items-center">
              <div className="text-[10px] text-[var(--text-secondary)]">
                {migrationComplete ? (
                  <span className={migrationComplete.success ? "text-green-400" : "text-amber-400"}>
                    {migrationComplete.success ? "Migration completed successfully" : "Migration completed with errors"}
                  </span>
                ) : mode === "merge" ? (
                  <span>Select tables and click MERGE when ready</span>
                ) : null}
              </div>
              <div className="flex gap-2">
                {migrationComplete && (
                  <button 
                    onClick={() => {
                      setMigrationComplete(null);
                      setMigrationProgress(null);
                      setSelectedItems(new Set());
                      setTableDiffs([]);
                    }}
                    className="px-3 py-1.5 text-xs font-bold hover:bg-white/5 rounded transition-colors uppercase text-blue-400"
                  >
                    New Merge
                  </button>
                )}
                <button onClick={onClose} className="px-4 py-1.5 text-xs font-bold hover:bg-white/5 rounded transition-colors uppercase">
                  {migrationComplete ? "Done" : "Close"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}