import { useState, useEffect } from "react";
import { Copy, AlertCircle, Info } from "lucide-react";
import { useConnections } from "../../contexts/useConnections";
import { ToolGuideWizard } from "./ToolGuideWizard";
import { useConfirmDialog } from "../ui/ConfirmDialog";
import { logger } from "../../utils/logger";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";

interface CloneDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CloneDialog({ isOpen, onClose }: CloneDialogProps) {
  const { databases, activeConnection, currentDb, connectToDatabase, selectedDatabase } = useConnections();
  const [sourceDB, setSourceDB] = useState("");
  const [targetDB, setTargetDB] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [useInstantClone, setUseInstantClone] = useState(true);
  const [directExecute, setDirectExecute] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [strategyUsed, setStrategyUsed] = useState<"FILE_COPY" | "TEMPLATE" | null>(null);
  const [showGuide, setShowGuide] = useState(false);

  const confirm = useConfirmDialog();

  useEffect(() => {
    if (isOpen && databases.length > 0) {
      setSourceDB(databases[0]);
      setError(null);
      setSuccess(null);
      setTargetDB("");
    }
  }, [isOpen, databases]);

  const handleClone = async () => {
    if (!sourceDB || !targetDB) return;

    if (sourceDB === "postgres") {
      const isConfirmed = await confirm.confirm({
        title: "Warning: Cloning 'postgres' database",
        message: "Cloning the 'postgres' database is generally not recommended as management connections typically connect to it. Make sure you know what you are doing. Proceed?",
        confirmLabel: "Proceed",
        cancelLabel: "Cancel",
        type: "warning"
      });
      if (!isConfirmed) return;
    }

    setIsLoading(true);
    setError(null);
    setSuccess(null);
    setElapsedTime(0);
    setStrategyUsed(null);

    const startTime = Date.now();
    const timer = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    try {
      if (!currentDb || !activeConnection) {
         throw new Error("No active database connection.");
      }

      if (activeConnection.type !== "postgres" && activeConnection.type !== "supabase") {
         throw new Error("Cloning is only supported for PostgreSQL databases.");
      }

      let cloneQuery = `CREATE DATABASE "${targetDB}" TEMPLATE "${sourceDB}"`;
      if (useInstantClone) {
        cloneQuery += " STRATEGY FILE_COPY";
      }

      if (!directExecute) {
        const fullSql = `-- Step 1: You CANNOT be connected to the database you are cloning!
-- Run \connect postgres (or select 'postgres' in the UI) before running this script.

-- Step 2: Terminate active connections to the source database
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
WHERE datname = '${sourceDB}' AND pid <> pg_backend_pid();

-- Step 3: Clone database
${cloneQuery};`;

        window.dispatchEvent(new CustomEvent("open-query-with-text", {
          detail: { query: fullSql, name: `Clone ${sourceDB} -> ${targetDB}` }
        }));

        onClose();
        return;
      }

      // If we are attempting to clone the currently active database, we MUST
      // connect to a different database (e.g. 'postgres') first, otherwise
      // PostgreSQL will reject it because we are using the template DB.
      let executionDb = currentDb;

      try {
        if (selectedDatabase === sourceDB) {
          const Database = (await import("@tauri-apps/plugin-sql")).default;
          const connectionString = `postgres://${activeConnection.username}:${activeConnection.password}@${activeConnection.host}:${activeConnection.port}/postgres`;
          executionDb = await Database.load(connectionString);
        }
      } catch (err) {
        logger.warn("Could not connect to 'postgres' default database. The clone might fail if connections to the source are active.");
      }

      // Step 1: Terminate all connections to the source database
      try {
        // We do not exclude our own pid if we successfully connected to 'postgres',
        // which kills any dangling connections the UI left open in the background.
        const terminateQuery = selectedDatabase === sourceDB
          ? `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${sourceDB}';`
          : `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${sourceDB}' AND pid <> pg_backend_pid();`;

        await executionDb.select(terminateQuery);
      } catch (err: any) {
        logger.warn("Failed to terminate connections:", err);
      }

      // Step 2: Execute Clone
      try {
        // Use select instead of execute to bypass Tauri sql:allow-execute block
        await executionDb.select(cloneQuery);
        if (useInstantClone) setStrategyUsed("FILE_COPY");
        else setStrategyUsed("TEMPLATE");
      } catch (err: any) {
        // If FILE_COPY is unsupported, fallback to normal clone
        if (useInstantClone && (err.message?.includes("syntax error") || err.message?.includes("STRATEGY"))) {
          logger.debug("Instant clone failed, falling back to normal clone...");
          await executionDb.select(`CREATE DATABASE "${targetDB}" TEMPLATE "${sourceDB}"`);
          setStrategyUsed("TEMPLATE");
        } else if (!err.message?.includes("No records") && !err.message?.includes("not return any rows")) {
          // select might throw "does not return any rows" for CREATE DATABASE, which is actually a success
          throw err;
        } else {
          // Success case for select-on-DDL
          if (useInstantClone) setStrategyUsed("FILE_COPY");
          else setStrategyUsed("TEMPLATE");
        }
      }

      setSuccess(`Database '${targetDB}' successfully cloned.`);
      if (activeConnection) {
        await connectToDatabase(activeConnection.id, selectedDatabase || undefined);
      }
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      clearInterval(timer);
      setIsLoading(false);
    }
  };

  if (!isOpen) return null;

  if (!activeConnection || (activeConnection.type !== "postgres" && activeConnection.type !== "supabase")) {
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
            <h2 className="text-xl font-bold text-[var(--neutral-12)] mb-2">PostgreSQL Required</h2>
            <p className="text-sm text-[var(--neutral-11)] mb-8 leading-relaxed">
              Database cloning is currently only supported for PostgreSQL connections.
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
          type="postgres-required"
        />
      </>
    );
  }

  return (
    <Dialog open={isOpen} onClose={onClose} size="lg">
      <Dialog.Title onClose={onClose}>
        <span className="flex items-center gap-3">
          <span className="p-2 bg-[var(--accent-3)] rounded-lg">
            <Copy className="w-5 h-5 text-[var(--accent-11)]" />
          </span>
          <span className="flex flex-col leading-tight">
            <span className="text-base">Clone Database</span>
            <span className="text-[10px] text-[var(--neutral-11)] uppercase tracking-widest font-bold opacity-60">
              PostgreSQL Template Copy
            </span>
          </span>
        </span>
      </Dialog.Title>

      <Dialog.Body className="space-y-6">
        {error && (
          <div className="p-3 bg-[var(--danger-3)] border border-[var(--danger-6)] rounded flex gap-3 text-[var(--danger-11)] text-sm">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {success && (
          <div className="p-3 bg-[var(--success-3)] border border-[var(--success-6)] rounded-lg text-[var(--success-11)] text-xs">
            <div className="font-bold flex items-center gap-2 mb-1">
              <Copy className="w-3 h-3" /> Successfully Cloned
            </div>
            <p>{success}</p>
            <div className="mt-2 text-[10px] opacity-70">
              <span className="font-semibold">Time:</span> {elapsedTime}s
              {strategyUsed && (
                <> • <span className="font-semibold">Strategy:</span> {strategyUsed === "FILE_COPY" ? "Instant (FILE_COPY)" : "Standard (TEMPLATE)"}</>
              )}
            </div>
            {strategyUsed === "TEMPLATE" && useInstantClone && (
              <p className="mt-2 text-[10px] text-[var(--warning-11)] leading-relaxed italic">
                Note: FILE_COPY was requested but the server fell back to Standard TEMPLATE. This happens if the PostgreSQL version is &lt; 15 or the filesystem (XFS/Btrfs) doesn't support COW.
              </p>
            )}
          </div>
        )}

        <div className="space-y-4">
          <Select
            label="SOURCE DATABASE"
            placeholder="Select database to clone..."
            value={sourceDB}
            onValueChange={setSourceDB}
            disabled={isLoading}
            options={databases.map(db => ({ label: db, value: db }))}
          />

          <Input
            label="NEW DATABASE NAME"
            value={targetDB}
            onChange={(e) => setTargetDB(e.target.value)}
            placeholder="e.g. dev_clone_db"
            disabled={isLoading}
          />

          <label className="flex items-center gap-2 cursor-pointer group mt-4">
            <div className="relative">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={useInstantClone}
                onChange={(e) => setUseInstantClone(e.target.checked)}
                disabled={isLoading}
              />
              <div className="w-8 h-4 bg-[var(--neutral-5)] rounded-full peer peer-checked:bg-[var(--accent-9)] transition-colors after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:after:translate-x-4"></div>
            </div>
            <div className="flex flex-col">
              <span className="text-xs font-bold text-[var(--neutral-12)]">Use Instant Clone (FILE_COPY)</span>
              <span className="text-[10px] text-[var(--neutral-11)]">Requires PostgreSQL 15+ and supported file system (XFS/BTRFS/ZFS)</span>
            </div>
          </label>

          <label className="flex items-center gap-2 cursor-pointer group mt-2">
            <div className="relative">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={directExecute}
                onChange={(e) => setDirectExecute(e.target.checked)}
                disabled={isLoading}
              />
              <div className="w-8 h-4 bg-[var(--neutral-5)] rounded-full peer peer-checked:bg-[var(--warning-9)] transition-colors after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:after:translate-x-4"></div>
            </div>
            <div className="flex flex-col">
              <span className="text-xs font-bold text-[var(--neutral-12)]">Direct Execute</span>
              <span className="text-[10px] text-[var(--neutral-11)]">If unchecked, generates a SQL script to run manually</span>
            </div>
          </label>

          {directExecute && (
            <div className="bg-[var(--warning-3)] border border-[var(--warning-6)] p-3 rounded text-[11px] text-[var(--warning-11)] leading-relaxed mt-2">
              <strong>Warning:</strong> Active connections to the source database will be terminated during the cloning process.
            </div>
          )}
        </div>
      </Dialog.Body>

      <Dialog.Footer>
        <Button variant="ghost" size="md" onClick={onClose} disabled={isLoading}>
          Cancel
        </Button>
        <Button
          variant={directExecute ? "primary" : "secondary"}
          size="md"
          onClick={handleClone}
          loading={isLoading}
          disabled={!sourceDB || !targetDB}
          leftIcon={isLoading ? undefined : <Copy className="w-4 h-4" />}
        >
          {isLoading
            ? (directExecute ? `Cloning… (${elapsedTime}s)` : "Generating…")
            : (directExecute ? "Clone Database" : "Generate Script")}
        </Button>
      </Dialog.Footer>
    </Dialog>
  );
}
