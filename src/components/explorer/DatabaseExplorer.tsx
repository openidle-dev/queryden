import { useState, useEffect, useRef } from "react";
import { ChevronRight, ChevronDown, Database, Table, Folder, FolderOpen, Plus, Search, Server, Columns, Hash, Eye, Variable, Trash2, Edit2, Play, Zap, Code, Download, Upload, Loader2, Terminal, Check, AlertCircle, Square, X } from "lucide-react";
import { PROVIDERS } from "../../config/providers";
import { DatabaseConnection } from "../../contexts/ConnectionContext";
import { useConnections } from "../../contexts/useConnections";
import { useSettings } from "../../store/settingsStore";
import { ConnectionDialog } from "./ConnectionDialog";
import { useConfirmDialog } from "../ui/ConfirmDialog";
import { save, open } from "@tauri-apps/plugin-dialog";
import { getConnectionsFileName } from "../../config/app";
import { SchemaSelectionDialog } from "./SchemaSelectionDialog";
import { CreateTableDialog } from "./CreateTableDialog";
import { CreateDatabaseDialog } from "./CreateDatabaseDialog";
import { logger } from "../../utils/logger";
import { buildConnectionTree, type FolderTreeNode } from "../../utils/folderTree";

interface TreeNode {
  id: string;
  name: string;
  icon: "server" | "database" | "schema" | "table" | "view" | "column" | "index" | "function" | "trigger" | "folder" | "loading";
  children?: TreeNode[];
  expanded?: boolean;
  action?: () => void;
  contextMenuId?: string;
  providerType?: string;
  color?: string;
}

interface TableDetails {
  columns: { name: string; type: string; nullable: boolean; default: string | null }[];
  constraints: { name: string; type: string; definition: string }[];
  foreignKeys: { columns: string[]; refTable: string; refColumns: string[] }[];
  indexes: { name: string; columns: string[]; unique: boolean }[];
  triggers: string[];
}

interface DatabaseExplorerProps {
  /** Whether AppLayout's Add Connection dialog is currently open.
   *  Used to disable tree keyboard navigation while the dialog is up. */
  isAddConnectionDialogOpen?: boolean;
}

export function DatabaseExplorer({ isAddConnectionDialogOpen = false }: DatabaseExplorerProps = {}) {
  const { connections, activeConnection, selectedDatabase, databases, removeConnection, updateConnection, connectToDatabase, schemaItems, loadSchema, getDDL, generateStatement, isLoadingSchema, currentDb, schemaProgress, dropDatabase, createDatabase, createTable, exportConnections, importConnections, vaultCredentials, initialLoadDone, getSelectedSchemas, folders, addFolder, renameFolder, removeFolder, moveConnectionToFolder, moveFolder } = useConnections();
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editingConnection, setEditingConnection] = useState<DatabaseConnection | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [schemaTree, setSchemaTree] = useState<TreeNode[]>([]);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; connectionId: string } | null>(null);
  /** Move-to-folder picker (#104). `kind` distinguishes connection vs folder
   *  so we route to the right context-method and skip self+descendants. */
  const [moveTarget, setMoveTarget] = useState<{ kind: "connection" | "folder"; id: string; name: string } | null>(null);
  const [connectingConnectionIds, setConnectingConnectionIds] = useState<Set<string>>(new Set());
  const isConnecting = connectingConnectionIds.size > 0;
  const beginConnect = (id: string) => setConnectingConnectionIds(prev => {
    const next = new Set(prev);
    next.add(id);
    return next;
  });
  const endConnect = (id: string) => setConnectingConnectionIds(prev => {
    const next = new Set(prev);
    next.delete(id);
    return next;
  });
  const [loadingDatabases, setLoadingDatabases] = useState<Set<string>>(new Set());
  const [schemaContextMenu, setSchemaContextMenu] = useState<{ x: number; y: number; node: TreeNode } | null>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<string | null>(null);
  const [tableDetails, setTableDetails] = useState<Record<string, TableDetails>>({});
  const [loadingTableDetails, setLoadingTableDetails] = useState<Set<string>>(new Set());
  const [backupDialogOpen, setBackupDialogOpen] = useState(false);
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [backupTarget, setBackupTarget] = useState<{connId: string, dbName: string, connName: string} | null>(null);
  const [createTableTarget, setCreateTableTarget] = useState<{ schema?: string } | null>(null);
  const [isCreateTableOpen, setIsCreateTableOpen] = useState(false);
  const [isCreateDatabaseOpen, setIsCreateDatabaseOpen] = useState(false);
  const [backupType, setBackupType] = useState<"sql-schema"|"sql-full"|"json"|"directory">("sql-schema");
  const [backupLoading, setBackupLoading] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [backupStatus, setBackupStatus] = useState("");
  const [showSchemaDialog, setShowSchemaDialog] = useState(false);
  const [schemaDialogInfo, setSchemaDialogInfo] = useState<{connectionId: string, connectionName: string, databaseName: string, selectedSchemas: string[]} | null>(null);
  /**
   * "folders" → grouped by user-defined folders (#104). The default.
   *             With no folders defined the render degenerates to a flat
   *             list at the root, so new users see no regression.
   * "type"    → grouped by db engine (was the legacy `groupByType` toggle).
   * "flat"    → connections rendered in input order (pre-#104 default,
   *             still available for users who prefer it).
   *
   * Selection lives in component state and is not persisted across
   * launches in v1 (#116). The user picks via the popover on the
   * folder-icon button in the toolbar.
   */
  const [viewMode, setViewMode] = useState<"flat" | "type" | "folders">("folders");
  const [viewModeMenuOpen, setViewModeMenuOpen] = useState(false);
  const backupStopRef = useRef(false);
  const settings = useSettings();
  const confirmDialog = useConfirmDialog();
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const treeContainerRef = useRef<HTMLDivElement>(null);
  
  // Listen for jump events from global search
  useEffect(() => {
    const handleJumpEvent = (e: CustomEvent<{ id: string }>) => {
      logger.debug("Global jump event received:", e.detail.id);
      
      const targetId = e.detail.id;
      // Extract name from ID for search fallback
      let term = targetId;
      if (targetId.startsWith("table-")) term = targetId.replace("table-", "");
      else if (targetId.startsWith("view-")) term = targetId.replace("view-", "");
      else if (targetId.startsWith("func-")) term = targetId.replace("func-", "");
      
      // If the node starts with a prefix, we can try to find by ID directly or by name
      executeJump(term, targetId);
    };

    window.addEventListener("jump-to-explorer-node", handleJumpEvent as EventListener);
    return () => window.removeEventListener("jump-to-explorer-node", handleJumpEvent as EventListener);
  }, [schemaTree]);

  const executeJump = (term: string, targetId?: string) => {
    try {
      if (!term || term.trim() === "") return;
      
      const normalizedTerm = term.toLowerCase().trim();
      
      // Find first matching node path.
      //
      // Folder-icon nodes are skipped as match targets because they're
      // structural containers (Tables, Views, Indexes, etc.) the user
      // doesn't think of by name — EXCEPT user-defined connection folders
      // (#104), which ARE user-named and ought to be searchable. Those
      // carry a `folder:<id>` contextMenuId set by buildFolderNode.
      const findPath = (nodes: TreeNode[], searchId?: string, searchTerm?: string, path: string[] = []): string[] | null => {
        for (const node of nodes) {
          const idMatch = searchId && node.id === searchId;
          const isUserFolder = node.icon === "folder" && node.contextMenuId?.startsWith("folder:");
          const skipForName = !isUserFolder && ["folder", "server", "database", "loading"].includes(node.icon);
          const nameMatch = searchTerm && node.name.toLowerCase().includes(searchTerm) && !skipForName;

          if (idMatch || nameMatch) {
            return [...path, node.id];
          }

          if (node.children && node.children.length > 0) {
            const res = findPath(node.children, searchId, searchTerm, [...path, node.id]);
            if (res) return res;
          }
        }
        return null;
      };

      const path = findPath(schemaTree, targetId, normalizedTerm);
      
      if (path) {
        setExpandedNodes(prev => {
          const next = new Set(prev);
          path.forEach(id => next.add(id));
          return next;
        });
        
        setTimeout(() => {
          const idToFind = path[path.length - 1];
          const elementId = `node-${idToFind}`;
          const element = document.getElementById(elementId);
          
          if (element) {
            element.scrollIntoView({ behavior: "smooth", block: "center" });
            element.style.outline = "2px solid var(--color-accent)";
            element.style.outlineOffset = "-2px";
            element.style.backgroundColor = "color-mix(in srgb, var(--color-accent), transparent 80%)";
            
            setTimeout(() => {
              element.style.outline = "none";
              element.style.backgroundColor = "";
            }, 3000);
          }
        }, 500);
        return;
      }

      // Try connection match if no schema match
      const connMatch = connections.find(c => c.name.toLowerCase().includes(normalizedTerm));
      if (connMatch) {
        handleConnect(connMatch);
      }
    } catch (err) {
      console.error("Jump failed:", err);
    }
  };

  const handleJumpToSearch = () => {
    executeJump(searchTerm);
  };

  useEffect(() => {
    if (activeConnection && selectedDatabase) {
      loadSchema(selectedDatabase);
    }
  }, [activeConnection, selectedDatabase]);

  useEffect(() => {
    const buildConnNode = (conn: DatabaseConnection): TreeNode => {
      const isConnected = activeConnection?.id === conn.id;

      let connChildren: TreeNode[] = [];
      if (isConnected && databases.length > 0) {
        
                const dbNodes: TreeNode[] = databases.map(db => {
          const isDbActive = selectedDatabase === db;
          let dbChildren: TreeNode[] = [];
          
          // Always build children when database is active - either full content or loading placeholder
          if (isDbActive) {
            // Show loading while schema is loading
            if (isLoadingSchema || loadingDatabases.has(`db-${conn.id}-${db}`)) {
              dbChildren = [
                { id: `loading-schemas-${conn.id}-${db}`, name: "Loading schema...", icon: "folder", children: [] }
              ];
            } else if (schemaItems) {
              // Build schema content - even if empty arrays, show the structure
              const items = schemaItems || { tables: [], views: [], functions: [], triggers: [], indexes: [], sequences: [] };
              const schemasMap: Record<string, { tables: string[], views: string[], functions: string[], triggers: string[], indexes: string[], sequences: string[] }> = {};
              
              const treeCategories = ["tables", "views", "functions", "triggers", "indexes", "sequences"] as const;
              
              treeCategories.forEach((type) => {
                const list = items[type] as string[];
                if (!list) return;
                
                list.forEach(item => {
                  let schemaName = "public";
                  let objName = item;
                  if (item.includes(".")) {
                    const parts = item.split(".");
                    schemaName = parts[0];
                    objName = parts[1];
                  }
                  if (!schemasMap[schemaName]) schemasMap[schemaName] = { tables: [], views: [], functions: [], triggers: [], indexes: [], sequences: [] };
                  if (schemasMap[schemaName][type]) {
                    schemasMap[schemaName][type].push(objName);
                  }
                });
              });
              
              const getTableChildren = (schemaName: string, tableName: string) => {
                const tableId = `${schemaName}.${tableName}`;
                const details = tableDetails[tableId];
                const isLoading = loadingTableDetails.has(tableId);
                
                const children: TreeNode[] = [];
                
                // Always show Columns folder
                children.push({ 
                  id: `cols-${tableId}`, 
                  name: "Columns", 
                  icon: "folder",
                  children: details?.columns?.length > 0 ? details.columns.map(c => ({
                    id: `col-${tableId}-${c.name}`,
                    name: `${c.name} (${c.type}${c.nullable ? '' : ' NOT NULL'})`,
                    icon: "column"
                  })) : isLoading ? [{ id: `cols-loading-${tableId}`, name: "Loading...", icon: "folder" }] : []
                });
                
                // Always show Indexes folder if enabled
                if (settings.showIndexes) {
                  children.push({
                    id: `idxs-${tableId}`,
                    name: "Indexes",
                    icon: "folder",
                    children: details?.indexes?.length > 0 ? details.indexes.map(i => ({
                      id: `idx-${tableId}-${i.name}`,
                      name: `${i.name} (${i.columns.join(', ')}${i.unique ? ' UNIQUE' : ''})`,
                      icon: "index"
                    })) : isLoading ? [{ id: `idxs-loading-${tableId}`, name: "Loading...", icon: "folder" }] : []
                  });
                }
                
                // Always show Triggers folder if enabled
                if (settings.showTriggers) {
                  children.push({
                    id: `trigs-${tableId}`,
                    name: "Triggers",
                    icon: "folder",
                    children: details?.triggers?.length > 0 ? details.triggers.map(t => ({
                      id: `trig-${tableId}-${t}`,
                      name: t,
                      icon: "trigger"
                    })) : isLoading ? [{ id: `trigs-loading-${tableId}`, name: "Loading...", icon: "folder" }] : []
                  });
                }
                
                // Always show Foreign Keys folder
                children.push({
                  id: `fks-${tableId}`,
                  name: "Foreign Keys",
                  icon: "folder",
                  children: details?.foreignKeys?.length > 0 ? details.foreignKeys.map(fk => ({
                    id: `fk-${tableId}-${fk.refTable}`,
                    name: `${fk.refTable} (${fk.columns.join(', ')})`,
                    icon: "folder"
                  })) : isLoading ? [{ id: `fks-loading-${tableId}`, name: "Loading...", icon: "folder" }] : []
});
                
                return children;
              };
               

              const schemaNodes: TreeNode[] = Object.keys(schemasMap).sort().map(schemaName => {
                const sNode: TreeNode = { id: `schema-${conn.id}-${db}-${schemaName}`, name: schemaName, icon: "schema", children: [] };
                const sItems = schemasMap[schemaName];

                if (settings.showTables && sItems.tables.length > 0) {
                  sNode.children!.push({ 
                    id: `tables-${conn.id}-${db}-${schemaName}`, 
                    name: "Tables", 
                    icon: "folder", 
                    children: sItems.tables.map(t => ({ 
                      id: `table-${schemaName}.${t}`, 
                      name: t, 
                      icon: "table",
                      children: getTableChildren(schemaName, t)
                    })) 
                  });
                }
                if (settings.showViews && sItems.views.length > 0) {
                  sNode.children!.push({ id: `views-${conn.id}-${db}-${schemaName}`, name: "Views", icon: "folder", children: sItems.views.map(t => ({ id: `view-${schemaName}.${t}`, name: t, icon: "view" })) });
                }
                if (settings.showFunctions && sItems.functions.length > 0) {
                  sNode.children!.push({ id: `funcs-${conn.id}-${db}-${schemaName}`, name: "Functions", icon: "folder", children: sItems.functions.map(t => ({ id: `func-${schemaName}.${t}`, name: t, icon: "function" })) });
                }
                if (settings.showTriggers && sItems.triggers.length > 0) {
                  sNode.children!.push({ id: `trigs-${conn.id}-${db}-${schemaName}`, name: "Triggers", icon: "folder", children: sItems.triggers.map(t => ({ id: `trig-${schemaName}.${t}`, name: t, icon: "trigger" })) });
                }
                if (settings.showIndexes && sItems.indexes.length > 0) {
                  sNode.children!.push({ id: `idxs-${conn.id}-${db}-${schemaName}`, name: "Indexes", icon: "folder", children: sItems.indexes.map(t => ({ id: `idx-${schemaName}.${t}`, name: t, icon: "index" })) });
                }
                if (settings.showSequences && sItems.sequences && sItems.sequences.length > 0) {
                  sNode.children!.push({ id: `seqs-${conn.id}-${db}-${schemaName}`, name: "Sequences", icon: "folder", children: sItems.sequences.map(t => ({ id: `seq-${schemaName}.${t}`, name: t, icon: "index" })) });
                }
                return sNode;
              });

              dbChildren = [
                { id: `schemas-root-${conn.id}-${db}`, name: "Schemas", icon: "folder", children: schemaNodes },
                { id: `events-${conn.id}-${db}`, name: "Event Triggers", icon: "folder" },
                { id: `exts-${conn.id}-${db}`, name: "Extensions", icon: "folder" },
                { id: `store-${conn.id}-${db}`, name: "Storage", icon: "folder" }
              ];
            }
          } else {
            // Not the active database - show placeholder structure
            dbChildren = [
              { id: `schemas-root-${conn.id}-${db}`, name: "Schemas", icon: "folder", children: [] },
              { id: `events-${conn.id}-${db}`, name: "Event Triggers", icon: "folder" },
              { id: `exts-${conn.id}-${db}`, name: "Extensions", icon: "folder" },
              { id: `store-${conn.id}-${db}`, name: "Storage", icon: "folder" }
            ];
          }

          return {
            id: `db-${conn.id}-${db}`,
            name: db,
            icon: "database",
            children: dbChildren,
            action: async () => {
              // If not active, connect and load schema
              setLoadingDatabases(prev => new Set(prev).add(`db-${conn.id}-${db}`));
              try {
                if (!isDbActive) {
                  await connectToDatabase(conn.id, db);
                } else if (!schemaItems) {
                  await loadSchema(db);
                }
              } finally {
                setLoadingDatabases(prev => {
                  const next = new Set(prev);
                  next.delete(`db-${conn.id}-${db}`);
                  return next;
                });
              }
            }
          };
        });


        connChildren = [{
          id: `dbs-container-${conn.id}`,
          name: "Databases",
          icon: "folder",
          children: dbNodes
        }];
      }

      return {
        id: `conn-${conn.id}`,
        name: `${conn.name.toUpperCase()} \u00a0\u00a0 ${conn.host}:${conn.port}`,
        icon: "server",
        contextMenuId: conn.id,
        providerType: conn.type,
        color: conn.color,
        children: connChildren,
        action: () => {
          if (!isConnected) {
            handleConnect(conn);
          }
        }
      };
    };

    // Recursive walk for the user-defined folder hierarchy (#104). Folder
    // nodes carry `contextMenuId` keyed `folder:<id>` so the same context-
    // menu handler can distinguish folder vs connection without an extra
    // type field on TreeNode.
    const buildFolderNode = (node: FolderTreeNode): TreeNode => {
      if (node.kind === "connection") {
        return buildConnNode(node.connection!);
      }
      return {
        id: `folder-${node.id}`,
        name: node.name,
        icon: "folder",
        contextMenuId: `folder:${node.id}`,
        children: node.children.map(buildFolderNode),
      };
    };

    let tree: TreeNode[];
    if (viewMode === "type") {
      const grouped: Record<string, DatabaseConnection[]> = {};
      connections.forEach(conn => {
        const type = conn.type || "other";
        if (!grouped[type]) grouped[type] = [];
        grouped[type].push(conn);
      });

      tree = Object.entries(grouped).map(([type, conns]) => ({
        id: `group-${type}`,
        name: PROVIDERS.find(pr => pr.id === type)?.name || type.toUpperCase(),
        icon: "folder" as const,
        children: conns.map(buildConnNode),
      }));
    } else if (viewMode === "folders") {
      tree = buildConnectionTree(folders, connections).map(buildFolderNode);
    } else {
      tree = connections.map(buildConnNode);
    }

    setSchemaTree(tree);
  }, [connections, activeConnection, selectedDatabase, settings, schemaItems, databases, isLoadingSchema, loadingDatabases, tableDetails, loadingTableDetails, viewMode, folders]);

  const toggleExpand = async (nodeId: string) => {
    const wasExpanded = expandedNodes.has(nodeId);
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
    
    // Load table details when expanding columns/constraints/indexes/etc
    if (!wasExpanded && (nodeId.startsWith("cols-") || nodeId.startsWith("idxs-") || nodeId.startsWith("trigs-") || nodeId.startsWith("fks-") || nodeId.startsWith("cons-"))) {
      const tableId = nodeId.replace(/^(cols|idxs|trigs|fks|cons)-/, "");
      await loadTableDetails(tableId);
    }
    
    // When expanding schemas folder, reload schema if not loaded
    if (!wasExpanded && nodeId.startsWith("schemas-root-") && !schemaItems) {
      if (selectedDatabase) {
        await loadSchema(selectedDatabase);
      }
    }
  };
  
  const loadTableDetails = async (tableId: string) => {
    if (tableDetails[tableId] || loadingTableDetails.has(tableId)) return;
    let schemaName = 'public';
    let tableName = tableId;
    if (tableId.includes('.')) {
      const parts = tableId.split('.');
      schemaName = parts[0];
      tableName = parts.slice(1).join('.');
    }
    
    if (!activeConnection || !currentDb) return;
    
    setLoadingTableDetails(prev => new Set(prev).add(tableId));
    
    try {
      const details: TableDetails = { columns: [], constraints: [], foreignKeys: [], indexes: [], triggers: [] };
      
      if (["postgres", "supabase"].includes(activeConnection.type)) {
        // Load columns
        const cols = await currentDb.select(`
          SELECT column_name, data_type, is_nullable, column_default, udt_name
          FROM information_schema.columns 
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position
        `, [schemaName, tableName]);
        details.columns = cols.map((c: any) => ({
          name: c.column_name,
          type: c.udt_name || c.data_type,
          nullable: c.is_nullable === 'YES',
          default: c.column_default
        }));
        
        // Load indexes
        const idxs = await currentDb.select(`
          SELECT indexname, indexdef
          FROM pg_indexes 
          WHERE schemaname = $1 AND tablename = $2
        `, [schemaName, tableName]);
        details.indexes = idxs.map((i: any) => {
          const colMatch = i.indexdef.match(/\(([^)]+)\)/);
          return { name: i.indexname, columns: colMatch ? colMatch[1].split(', ') : [], unique: i.indexdef.includes('UNIQUE') };
        });
        
        // Load triggers
        const trgs = await currentDb.select(`
          SELECT trigger_name 
          FROM information_schema.triggers 
          WHERE event_object_schema = $1 AND event_object_table = $2
        `, [schemaName, tableName]);
        details.triggers = trgs.map((t: any) => t.trigger_name);
        
        // Load foreign keys
        const fks = await currentDb.select(`
          SELECT 
            kcu.column_name,
            ccu.table_name AS foreign_table_name,
            ccu.column_name AS foreign_column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu 
            ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = tc.constraint_name
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = $1 AND tc.table_name = $2
        `, [schemaName, tableName]);
        
        // Group FKs by constraint
        const fkMap: Record<string, { columns: string[]; refTable: string; refColumns: string[] }> = {};
        for (const fk of fks) {
          const conName = `${fk.column_name}_${fk.foreign_table_name}`;
          if (!fkMap[conName]) {
            fkMap[conName] = { columns: [], refTable: fk.foreign_table_name, refColumns: [] };
          }
          fkMap[conName].columns.push(fk.column_name);
          fkMap[conName].refColumns.push(fk.foreign_column_name);
        }
        details.foreignKeys = Object.values(fkMap);
        
        // Load constraints
        const cons = await currentDb.select(`
          SELECT constraint_name, constraint_type
          FROM information_schema.table_constraints 
          WHERE table_schema = $1 AND table_name = $2
        `, [schemaName, tableName]);
        details.constraints = cons.map((c: any) => ({
          name: c.constraint_name,
          type: c.constraint_type,
          definition: ''
        }));
      }
      
      setTableDetails(prev => ({ ...prev, [tableId]: details }));
    } catch (e) {
      console.error("Failed to load table details:", e);
    } finally {
      setLoadingTableDetails(prev => {
        const next = new Set(prev);
        next.delete(tableId);
        return next;
      });
    }
  };

  const handleConnect = async (conn: DatabaseConnection) => {
    // If we have a vaultCredentialId already, just connect
    if (conn.vaultCredentialId) {
      beginConnect(conn.id);
      try {
        await connectToDatabase(conn.id);
        // Automatically open a query window and focus it
        window.dispatchEvent(new CustomEvent("open-query-window"));
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent("focus-editor"));
        }, 100);
      } catch (error: any) {
        console.error("Connection failed:", error);
        confirmDialog.dialog({
          title: "Connection Failed",
          message: error.message || String(error),
          confirmLabel: "OK",
          type: "danger"
        });
      } finally {
        endConnect(conn.id);
      }
      return;
    }

    // Only prompt for a vault profile when:
    //   1. The connection is explicitly configured as a vault connection
    //      (`isVault === true`), AND
    //   2. It hasn't picked a profile yet (`!vaultCredentialId`), AND
    //   3. The user has any vault credentials at all to choose from.
    //
    // Previously this branch only checked condition 3, so a manual
    // connection (`isVault === false`) or a legacy connection without
    // the flag would still trip the picker as long as the user had
    // any vault credential stored anywhere — see #109.
    if (conn.isVault === true && !conn.vaultCredentialId && vaultCredentials.length > 0) {
      const selectedProfileId = await confirmDialog.dialog({
        title: "Select Credential Profile",
        message: `How would you like to connect to "${conn.name}"?`,
        inputLabel: "Vault Profile",
        confirmLabel: "Connect",
        cancelLabel: "Cancel",
        type: "info",
        selectOptions: vaultCredentials.map(vc => ({ label: `${vc.name} (${vc.username})`, value: vc.id })),
        requireInput: false
      });

      if (selectedProfileId !== null) {
        // Get the actual vault credential to pass directly (avoiding state race condition)
        const selectedVaultCred = vaultCredentials.find(vc => vc.id === selectedProfileId);
        
        // Update connection with the selected profile for future use
        updateConnection(conn.id, { vaultCredentialId: selectedProfileId || undefined, isVault: true });
        
        // Connect with the selected vault credential directly (not relying on state update)
        beginConnect(conn.id);
        try {
          await connectToDatabase(conn.id, undefined, selectedVaultCred);
        } catch (error: any) {
          console.error("Connection failed:", error);
          confirmDialog.dialog({ title: "Connection Failed", message: String(error), confirmLabel: "OK", type: "danger" });
        } finally {
          endConnect(conn.id);
        }
      }
      return;
    }

    // Default connection (no vault profile available or chosen)
    beginConnect(conn.id);
    try {
      await connectToDatabase(conn.id);
    } catch (error: any) {
      console.error("Connection failed:", error);
      confirmDialog.dialog({
        title: "Connection Failed",
        message: error.message || String(error),
        confirmLabel: "OK",
        type: "danger"
      });
    } finally {
      endConnect(conn.id);
    }
  };

  const handleContextMenu = (e: React.MouseEvent, connectionId: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, connectionId });
  };

  const closeContextMenu = () => {
    setContextMenu(null);
    setSchemaContextMenu(null);
    setActiveSubmenu(null);
    setViewModeMenuOpen(false);
  };

  // Close context menus and dialogs on ESC or click outside
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeContextMenu();
        setBackupDialogOpen(false);
        setRestoreDialogOpen(false);
        setIsCreateTableOpen(false);
        setIsCreateDatabaseOpen(false);
        setShowEditDialog(false);
        setShowSchemaDialog(false);
      }
    };
    const handleClickOutside = () => closeContextMenu();
    
    window.addEventListener("keydown", handleEsc);
    window.addEventListener("click", handleClickOutside);
    return () => {
      window.removeEventListener("keydown", handleEsc);
      window.removeEventListener("click", handleClickOutside);
    };
  }, []);

  const handleEdit = (conn: DatabaseConnection) => {
    setEditingConnection(conn);
    setShowEditDialog(true);
    closeContextMenu();
  };

  const handleDelete = (id: string) => {
    removeConnection(id);
    closeContextMenu();
  };

  const executeBackup = async () => {
    if (!backupTarget) {
      setBackupStatus("Error: No database selected");
      return;
    }

    backupStopRef.current = false;
    const conn = activeConnection;
    const { connId: _connId, dbName } = backupTarget;
    
    logger.debug("executeBackup: backupTarget:", backupTarget, "activeConnection:", conn?.id);

    if (!conn) {
      setBackupStatus("Error: No active connection");
      return;
    }

    logger.debug("executeBackup: starting backup for", dbName, "on connection", conn.name);

    // Helper to check cancellation with small delay
    const checkCancelled = () => {
      if (backupStopRef.current) {
        setBackupStatus("Backup cancelled");
        setBackupLoading(false);
        return true;
      }
      return false;
    };

    // Small delay helper
    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    try {
      setBackupLoading(true);
      setBackupStatus("Connecting to database...");
      await delay(10);
      if (checkCancelled()) return;

      await connectToDatabase(conn.id, dbName);
      await delay(10);
      if (checkCancelled()) return;
      logger.debug("executeBackup: connected to database");
      
      setBackupStatus("Loading schema...");
      await loadSchema(dbName);
      await delay(10);
      if (checkCancelled()) return;
      logger.debug("executeBackup: schema loaded, tables:", schemaItems?.tables?.length, "views:", schemaItems?.views?.length);
      
      if (!schemaItems) {
        setBackupStatus("Failed to load schema - no schema items returned");
        return;
      }

      let output: string = "";
      let extension: string = "";

      if (backupType === "json") {
        setBackupStatus("Generating JSON backup...");
        const backup = {
          database: dbName,
          connection: conn.name,
          type: conn.type,
          timestamp: new Date().toISOString(),
          tables: {} as Record<string, { schema: string, data?: unknown[] }>,
        };

        for (const table of schemaItems.tables) {
          if (backupStopRef.current) { setBackupStatus("Backup cancelled"); setBackupLoading(false); return; }
          setBackupStatus(`Backing up table: ${table}...`);
          const ddl = await getDDL("table", table);
          backup.tables[table] = { schema: ddl };
        }

        for (const view of schemaItems.views) {
          if (backupStopRef.current) { setBackupStatus("Backup cancelled"); setBackupLoading(false); return; }
          const ddl = await getDDL("view", view);
          if (!backup.tables[view]) {
            backup.tables[view] = { schema: ddl };
          }
        }

        for (const func of schemaItems.functions) {
          if (backupStopRef.current) { setBackupStatus("Backup cancelled"); setBackupLoading(false); return; }
          const ddl = await getDDL("function", func);
          if (!backup.tables[func]) {
            backup.tables[func] = { schema: ddl };
          }
        }

        output = JSON.stringify(backup, null, 2);
        extension = "json";
      } else if (backupType === "sql-schema" || backupType === "sql-full") {
        setBackupStatus("Generating SQL backup...");
        const lines: string[] = [
          `-- Backup: ${dbName}`,
          `-- Connection: ${conn.name}`,
          `-- Type: ${conn.type}`,
          `-- Generated: ${new Date().toISOString()}`,
          "",
        ];

        for (const table of schemaItems.tables) {
          if (checkCancelled()) return;
          setBackupStatus(`Backing up table: ${table}...`);
          const ddl = await getDDL("table", table);
          lines.push(ddl, "");
        }

        for (const view of schemaItems.views) {
          if (checkCancelled()) return;
          const ddl = await getDDL("view", view);
          lines.push(ddl, "");
        }

        for (const func of schemaItems.functions) {
          if (checkCancelled()) return;
          const ddl = await getDDL("function", func);
          lines.push(ddl, "");
        }

        output = lines.join("\n");
        extension = "sql";
      } else if (backupType === "directory") {
        setBackupStatus("Selecting backup directory...");
        const dirPath = await open({
          directory: true,
          multiple: false,
          title: "Select Directory for Backup"
        });

        if (!dirPath || typeof dirPath !== 'string') {
          setBackupStatus("Backup cancelled");
          setBackupLoading(false);
          return;
        }

        if (checkCancelled()) return;

        setBackupStatus("Creating directory structure...");
        const { mkdir, writeTextFile } = await import("@tauri-apps/plugin-fs");
        const { join } = await import("@tauri-apps/api/path");
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const targetDir = await join(dirPath, `${dbName}_backup_${timestamp}`);
        
        await mkdir(targetDir, { recursive: true });

        // Save metadata
        const metadata = {
          database: dbName,
          connection: conn.name,
          type: conn.type,
          timestamp: new Date().toISOString(),
          tables: schemaItems.tables,
          views: schemaItems.views,
          functions: schemaItems.functions
        };
        await writeTextFile(await join(targetDir, "metadata.json"), JSON.stringify(metadata, null, 2));

        const subfolders = ["tables", "views", "functions"];
        for (const sub of subfolders) {
          await mkdir(await join(targetDir, sub), { recursive: true });
        }

        for (const table of schemaItems.tables) {
          if (checkCancelled()) return;
          setBackupStatus(`Backing up table: ${table}...`);
          const ddl = await getDDL("table", table);
          await writeTextFile(await join(targetDir, "tables", `${table}.sql`), ddl);
        }

        for (const view of schemaItems.views) {
          if (checkCancelled()) return;
          setBackupStatus(`Backing up view: ${view}...`);
          const ddl = await getDDL("view", view);
          await writeTextFile(await join(targetDir, "views", `${view}.sql`), ddl);
        }

        for (const func of schemaItems.functions) {
          if (checkCancelled()) return;
          setBackupStatus(`Backing up function: ${func}...`);
          const ddl = await getDDL("function", func);
          await writeTextFile(await join(targetDir, "functions", `${func}.sql`), ddl);
        }

        setBackupStatus("Backup complete!");
        setTimeout(() => setBackupDialogOpen(false), 1500);
        return;
      }

      if (checkCancelled()) return;

      const path = await save({
        defaultPath: `${dbName}_backup_${Date.now()}.${extension}`,
        filters: [{ name: "Backup Files", extensions: [extension] }],
      });

      if (!path) {
        setBackupStatus("Backup cancelled");
        return;
      }

      if (checkCancelled()) return;

      setBackupStatus("Saving backup file...");

      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(path, output);

      setBackupStatus("Backup complete!");
      setTimeout(() => setBackupDialogOpen(false), 1000);

    } catch (err: any) {
      if (err.name === 'AbortError' || err.message?.includes('abort')) {
        setBackupStatus("Backup cancelled");
      } else {
        console.error("Backup failed:", err);
        setBackupStatus(`Backup failed: ${err}`);
      }
    } finally {
      setBackupLoading(false);
    }
  };

  const executeRestore = async () => {
    if (!backupTarget || !activeConnection || !currentDb) {
      setBackupStatus("Error: No active connection");
      return;
    }
    
    const { connId, dbName: _dbName } = backupTarget;
    const conn = connections.find(c => c.id === connId);
    if (!conn) {
      setBackupStatus("Error: Connection not found");
      return;
    }

    const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

    // Use the same stop ref as backup (they can't run simultaneously)
    backupStopRef.current = false;

    const checkCancelled = () => {
      if (backupStopRef.current) {
        setBackupStatus("Restore cancelled");
        setRestoreLoading(false);
        return true;
      }
      return false;
    };

    try {
      setRestoreLoading(true);
      setBackupStatus("Selecting backup file...");

      if (checkCancelled()) return;

      const path = await open({
        multiple: false,
        filters: [
          { name: "SQL Files", extensions: ["sql"] },
          { name: "JSON Files", extensions: ["json"] },
        ],
      });

      if (!path || Array.isArray(path)) {
        setBackupStatus("Restore cancelled");
        setRestoreLoading(false);
        return;
      }

      if (checkCancelled()) return;

      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const { join } = await import("@tauri-apps/api/path");
      
      if (path.endsWith("metadata.json")) {
        setBackupStatus("Reading directory backup metadata...");
        const metadata = JSON.parse(await readTextFile(path));
        const baseDir = path.replace(/metadata\.json$/, "");
        
        let total = (metadata.tables?.length || 0) + (metadata.views?.length || 0) + (metadata.functions?.length || 0);
        let current = 0;
        let success = 0;
        const errors: string[] = [];

        const processItems = async (items: string[], subfolder: string) => {
          for (const item of items) {
            if (checkCancelled()) return;
            current++;
            setBackupStatus(`Restoring ${current}/${total}: ${item}...`);
            try {
              const itemPath = await join(baseDir, subfolder, `${item}.sql`);
              const sql = await readTextFile(itemPath);
              await currentDb.execute(sql);
              success++;
            } catch (e: any) {
              errors.push(`${subfolder}/${item}: ${e.message || String(e)}`);
            }
          }
        };

        if (metadata.tables) await processItems(metadata.tables, "tables");
        if (metadata.views) await processItems(metadata.views, "views");
        if (metadata.functions) await processItems(metadata.functions, "functions");

        if (checkCancelled()) return;
        if (errors.length > 0) {
          setBackupStatus(`Restored ${success}/${total}, errors: ${errors.length}`);
        } else {
          setBackupStatus(`Restore complete! ${success} objects restored.`);
          setTimeout(() => setRestoreDialogOpen(false), 1500);
        }
        return;
      }

      const content = await readTextFile(path);

      if (checkCancelled()) return;

      if (path.endsWith(".json")) {
        const backup = JSON.parse(content);
        
        if (!backup.tables || typeof backup.tables !== "object") {
          setBackupStatus("Invalid backup format");
          setRestoreLoading(false);
          return;
        }

        const entries = Object.entries(backup.tables as Record<string, { schema: string }>);
        const total = entries.length;
        let success = 0;
        const errors: string[] = [];

        for (let i = 0; i < entries.length; i++) {
          if (checkCancelled()) return;
          const [name, data] = entries[i];
          setBackupStatus(`Restoring ${i + 1}/${total}: ${name}...`);
          await delay(10);
          
          try {
            await currentDb.execute(data.schema);
            success++;
          } catch (sqlErr: any) {
            errors.push(`${name}: ${sqlErr?.message || sqlErr?.toString() || "Unknown error"}`);
          }
        }

        if (checkCancelled()) return;

        if (errors.length > 0) {
          setBackupStatus(`Restored ${success}/${total}, errors: ${errors.length}`);
        } else {
          setBackupStatus(`Restore complete! ${success} objects restored.`);
          setTimeout(() => setRestoreDialogOpen(false), 1500);
        }
      } else {
        setBackupStatus("Executing SQL...");
        
        try {
          const allLines = content.split("\n");
          const statements: string[] = [];
          let current = "";
          
          for (const line of allLines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("--")) continue;
            current += " " + trimmed;
            if (trimmed.endsWith(";")) {
              statements.push(current.trim());
              current = "";
            }
          }
          
          if (!statements.length) {
            setBackupStatus("Error: No valid SQL statements found");
            setRestoreLoading(false);
            return;
          }
          
          const total = statements.length;
          let success = 0;
          const errors: string[] = [];
          
          for (let i = 0; i < statements.length; i++) {
            if (checkCancelled()) return;
            const stmt = statements[i].replace(/;$/, "").trim();
            if (!stmt) continue;
            setBackupStatus(`Executing ${i + 1}/${total}...`);
            await delay(10);
            try {
              await currentDb.execute(stmt);
              success++;
            } catch (sqlErr: any) {
              const errMsg = sqlErr?.message || sqlErr?.toString() || "Unknown error";
              errors.push(`Statement ${i + 1}: ${errMsg}`);
            }
          }
          
          if (checkCancelled()) return;

          if (errors.length > 0) {
            setBackupStatus(`Restored ${success}/${total} statements. ${errors.length} errors:\n${errors.slice(0, 10).join("\n")}${errors.length > 10 ? `\n...and ${errors.length - 10} more` : ""}`);
          } else {
            setBackupStatus(`Restore complete! ${success} statements executed.`);
            setTimeout(() => setRestoreDialogOpen(false), 1500);
          }
        } catch (sqlErr: any) {
          setBackupStatus(`Execution Error: ${sqlErr?.message || sqlErr?.toString() || "Unknown error"}`);
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError' || err.message?.includes('abort')) {
        setBackupStatus("Restore cancelled");
      } else {
        setBackupStatus(`Restore failed: ${err}`);
      }
      setRestoreLoading(false);
    } finally {
      setRestoreLoading(false);
    }
  };

  const isLeafSchemaItem = (icon: string) => ["table", "view", "function", "trigger", "index"].includes(icon);
  const isFolderNode = (icon: string) => ["folder", "database", "schema"].includes(icon);

  const getCreateTemplate = (folderName: string): string | null => {
    const name = folderName.toLowerCase();
    if (name.includes("table")) {
      return `CREATE TABLE new_table (\n  id SERIAL PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n);`;
    } else if (name.includes("view")) {
      return `CREATE VIEW new_view AS\nSELECT * FROM table_name\nWHERE condition;`;
    } else if (name.includes("function")) {
      return `CREATE OR REPLACE FUNCTION new_function()\nRETURNS void AS $$\nBEGIN\n  -- function body\nEND;\n$$ LANGUAGE plpgsql;`;
    } else if (name.includes("trigger")) {
      return `CREATE TRIGGER new_trigger\n  AFTER INSERT ON table_name\n  FOR EACH ROW\n  EXECUTE FUNCTION trigger_function();`;
    } else if (name.includes("index")) {
      return `CREATE INDEX idx_name\n  ON table_name (column_name);`;
    } else if (name.includes("schema")) {
      return `CREATE SCHEMA new_schema;`;
    } else if (name.includes("sequence")) {
      return `CREATE SEQUENCE new_sequence START 1;`;
    } else if (name.includes("type")) {
      return `CREATE TYPE new_type AS ENUM ('value1', 'value2');`;
    } else if (name.includes("database")) {
      return `-- Template for Create Database\nCREATE DATABASE new_database\n  WITH \n  OWNER = postgres\n  TEMPLATE = template1\n  ENCODING = 'UTF8'\n  LC_COLLATE = 'en_US.utf8'\n  LC_CTYPE = 'en_US.utf8'\n  TABLESPACE = pg_default\n  CONNECTION LIMIT = -1\n  IS_TEMPLATE = False;`;
    }
    return null;
  };

  const renderTree = (nodes: TreeNode[], depth: number = 0) => {
    return nodes.map((node) => {
      const isExpanded = expandedNodes.has(node.id);
      const hasChildren = node.children && node.children.length > 0;
      const isLeaf = isLeafSchemaItem(node.icon);
      const isFolder = isFolderNode(node.icon);
      const isDbLoading = node.icon === "database" && loadingDatabases.has(node.id);
      const isServerConnecting = node.icon === "server" && !!node.contextMenuId && connectingConnectionIds.has(node.contextMenuId);
      const isSchemaLoading = node.icon === "database" && selectedDatabase === node.name && isLoadingSchema;
      const isSchemasLoading = node.id.startsWith("schemas-root-") && isLoadingSchema;
      const tableDetailId = node.id.replace(/^(cols|idxs|trigs|fks|cons|deps|refs|parts|ruls|polic)-/, "");
      const isTableDetailsLoading = node.icon === "folder" && tableDetailId !== node.id && loadingTableDetails.has(tableDetailId);

      return (
        <div key={node.id}>
          <button
            onClick={() => {
              // Left click: expand/collapse folders, trigger action for database and server
              if ((node.icon === "database" || node.icon === "server") && node.action) {
                node.action();
              }
              if (hasChildren || isFolder) {
                toggleExpand(node.id);
              }
              if (node.icon === "table") {
                const fullTableName = node.id.startsWith("table-") ? node.id.replace("table-", "") : node.name;
                const query = `SELECT * FROM ${fullTableName} LIMIT 1000`;
                window.dispatchEvent(new CustomEvent("run-specific-query", { 
                  detail: { query, name: fullTableName, lineNumber: 1 } 
                }));
              }
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (node.contextMenuId) {
                 handleContextMenu(e, node.contextMenuId);
              } else if (isLeaf || isFolder) {
                 setSchemaContextMenu({ x: e.clientX, y: e.clientY, node });
              }
            }}
            id={`node-${node.id}`}
            className={`w-full flex items-center gap-1 px-2 py-1 transition-colors text-sm text-left truncate ${
              focusedNodeId === node.id 
                ? "bg-indigo-500/20 ring-1 ring-inset ring-indigo-500/30" 
                : node.icon === "server" && node.color
                  ? "hover:brightness-110"
                  : "hover:bg-[var(--surface-raised)]"
            }`}
            style={{ 
              paddingLeft: `${depth * 16 + 8}px`,
              borderLeft: node.icon === "server" && node.color ? `3px solid ${node.color}` : undefined,
              backgroundColor: focusedNodeId === node.id
                ? undefined
                : node.icon === "server" && node.color 
                  ? `color-mix(in srgb, ${node.color}, transparent 85%)` 
                  : undefined
            }}
            disabled={isDbLoading || isSchemasLoading || isTableDetailsLoading}
            onMouseDown={() => setFocusedNodeId(node.id)}
            onDoubleClick={async () => {
              if (isLeaf) {
                try {
                  let iconType = node.icon;
                  let targetName = node.name;
                  const idParts = node.id.split("-");
                  if (idParts.length >= 2) {
                    const fullPath = idParts.slice(1).join("-");
                    if (fullPath.includes(".")) {
                      targetName = fullPath;
                      if (node.icon === "column") {
                        const pathParts = fullPath.split("-");
                        targetName = pathParts[0];
                        iconType = "table";
                      }
                    }
                  }
                  const ddl = await getDDL(iconType, targetName);
                  if (ddl) {
                    window.dispatchEvent(new CustomEvent("open-query-with-text", {
                      detail: { query: ddl, name: `DDL ${targetName}` }
                    }));
                  }
                } catch (e) {
                  console.error("Failed to get DDL:", e);
                }
              } else if (node.action) {
                node.action();
              }
              if (hasChildren || isFolder) toggleExpand(node.id);
            }}
          >
            {hasChildren || isFolder ? (
              <span onClick={(e) => { e.stopPropagation(); toggleExpand(node.id); }} className="hover:bg-[var(--border)] rounded text-[var(--text-secondary)]">
                {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              </span>
            ) : (
              <span className="w-3" />
            )}
            {isDbLoading || isServerConnecting ? <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--color-accent)]" /> : getIcon(node.icon, isExpanded, node.providerType, node.color)}
            <span className={`truncate ${node.icon === 'server' ? 'text-[var(--text-primary)] font-bold' : node.icon === 'database' ? 'text-[var(--text-secondary)] font-semibold' : 'text-[var(--text-primary)] opacity-90'}`}>
              {node.name}
              {node.icon === 'server' && activeConnection?.id === node.contextMenuId && <span className="ml-2 inline-block w-1.5 h-1.5 bg-[var(--color-success)] rounded-full" title="Connected" />}
            </span>
            {(isSchemaLoading || isSchemasLoading || isTableDetailsLoading) && (
              <Loader2 className="w-3 h-3 animate-spin ml-auto text-[var(--text-secondary)]" />
            )}
            {hasChildren && !(isSchemaLoading || isSchemasLoading || isTableDetailsLoading) && (
              <span className="text-[10px] text-[var(--text-secondary)] ml-auto">{node.children?.length}</span>
            )}
          </button>
          {hasChildren && isExpanded && node.children && renderTree(node.children, depth + 1)}
        </div>
      );
    });
  };

  const getVisibleNodes = (nodes: TreeNode[], acc: TreeNode[] = []): TreeNode[] => {
    for (const node of nodes) {
      acc.push(node);
      if (expandedNodes.has(node.id) && node.children) {
        getVisibleNodes(node.children, acc);
      }
    }
    return acc;
  };

  const findParentId = (nodes: TreeNode[], targetId: string, parentId: string | null = null): string | null => {
    for (const node of nodes) {
      if (node.id === targetId) return parentId;
      if (node.children) {
        const found = findParentId(node.children, targetId, node.id);
        if (found) return found;
      }
    }
    return null;
  };

  const scrollIdIntoView = (id: string) => {
    setTimeout(() => {
      const element = document.getElementById(`node-${id}`);
      if (element) {
        element.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    }, 50);
  };

  const handleTreeKeyDown = (e: React.KeyboardEvent) => {
    if (activeSubmenu || contextMenu || schemaContextMenu || isAddConnectionDialogOpen || showEditDialog || backupDialogOpen || restoreDialogOpen || isCreateTableOpen || isCreateDatabaseOpen || showSchemaDialog) return;

    const visibleNodes = getVisibleNodes(schemaTree);
    if (visibleNodes.length === 0) return;

    const currentIndex = visibleNodes.findIndex(n => n.id === focusedNodeId);

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        if (currentIndex < visibleNodes.length - 1) {
          const nextId = visibleNodes[currentIndex + 1].id;
          setFocusedNodeId(nextId);
          scrollIdIntoView(nextId);
        } else if (focusedNodeId === null) {
          const firstId = visibleNodes[0].id;
          setFocusedNodeId(firstId);
          scrollIdIntoView(firstId);
        }
        break;
      case "ArrowUp":
        e.preventDefault();
        if (currentIndex > 0) {
          const prevId = visibleNodes[currentIndex - 1].id;
          setFocusedNodeId(prevId);
          scrollIdIntoView(prevId);
        }
        break;
      case "ArrowRight":
        e.preventDefault();
        if (focusedNodeId && currentIndex !== -1) {
          const node = visibleNodes[currentIndex];
          const hasChildren = node.children && node.children.length > 0;
          const isFolder = isFolderNode(node.icon);
          if (hasChildren || isFolder) {
            if (!expandedNodes.has(node.id)) {
              toggleExpand(node.id);
            } else if (node.children && node.children.length > 0) {
              const firstChildId = node.children[0].id;
              setFocusedNodeId(firstChildId);
              scrollIdIntoView(firstChildId);
            }
          }
        }
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (focusedNodeId && currentIndex !== -1) {
          const node = visibleNodes[currentIndex];
          if (expandedNodes.has(node.id)) {
            toggleExpand(node.id);
          } else {
            const parentId = findParentId(schemaTree, focusedNodeId);
            if (parentId) {
              setFocusedNodeId(parentId);
              scrollIdIntoView(parentId);
            }
          }
        }
        break;
      case "Enter":
        e.preventDefault();
        if (focusedNodeId && currentIndex !== -1) {
          const node = visibleNodes[currentIndex];
          if (node.action) {
            node.action();
          } else if (node.children || isFolderNode(node.icon)) {
            toggleExpand(node.id);
          } else if (isLeafSchemaItem(node.icon)) {
             (async () => {
                try {
                  const targetName = node.id.startsWith("table-") ? node.id.replace("table-", "") : node.name;
                  const ddl = await getDDL(node.icon, targetName);
                  if (ddl) {
                    window.dispatchEvent(new CustomEvent("open-query-with-text", {
                      detail: { query: ddl, name: `DDL ${node.name}` }
                    }));
                  }
                } catch (e) {}
             })();
          }
        }
        break;
      case "Home":
        e.preventDefault();
        if (visibleNodes.length > 0) {
          setFocusedNodeId(visibleNodes[0].id);
          scrollIdIntoView(visibleNodes[0].id);
        }
        break;
      case "End":
        e.preventDefault();
        if (visibleNodes.length > 0) {
          const lastId = visibleNodes[visibleNodes.length - 1].id;
          setFocusedNodeId(lastId);
          scrollIdIntoView(lastId);
        }
        break;
    }
  };

  const getProviderIcon = (providerType?: string, color?: string) => {
    const p = PROVIDERS.find(pr => pr.id === providerType);
    const style = color ? { color } : undefined;
    if (p?.icon) {
      const Icon = p.icon;
      return <Icon className="w-3.5 h-3.5" style={style} />;
    }
    return <Database className="w-3.5 h-3.5" style={style || { color: '#60a5fa' }} />;
  };

  const getIcon = (type: TreeNode["icon"], isExpanded: boolean, providerType?: string, color?: string) => {
    if (type === "server") {
      return getProviderIcon(providerType, color);
    }
    switch (type) {
      case "database": return <Database className="w-3.5 h-3.5 text-cyan-500" />;
      case "schema": return <Server className="w-3.5 h-3.5 text-orange-400" />;
      case "table": return <Table className="w-3.5 h-3.5 text-blue-300" />;
      case "view": return <Eye className="w-3.5 h-3.5 text-purple-400" />;
      case "column": return <Columns className="w-3.5 h-3.5 text-gray-400" />;
      case "index": return <Hash className="w-3.5 h-3.5 text-green-400" />;
      case "function": return <Variable className="w-3.5 h-3.5 text-red-400" />;
      case "trigger": return <Zap className="w-3.5 h-3.5 text-yellow-500" />;
      case "folder": return isExpanded ? <FolderOpen className="w-3.5 h-3.5 text-yellow-500" /> : <Folder className="w-3.5 h-3.5 text-yellow-500" />;
      case "loading": return <Loader2 className="w-3.5 h-3.5 text-blue-400 animate-spin" />;
      default: return <Folder className="w-3.5 h-3.5" />;
    }
  };

  const isLoading = isLoadingSchema || loadingDatabases.size > 0 || loadingTableDetails.size > 0 || isConnecting;

  return (
    <div className="flex flex-col h-full" onClick={closeContextMenu}>
      {/* Header */}
      <div className="p-2 border-b border-[var(--border)]">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold">Database Explorer</h3>
          <div className="flex items-center gap-1">
            {/* View-mode + New-Folder popover (#116). One stable icon
                button; click opens a menu with radio options for the
                three grouping modes plus a "+ New folder" action. This
                replaces the previous 3-state cycle button, which was
                undiscoverable — users had to click 2-3 times to
                accidentally find that folders existed. */}
            <div className="relative">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setViewModeMenuOpen((v) => !v);
                }}
                className={`p-1 rounded transition-all ${
                  viewModeMenuOpen
                    ? "bg-[var(--color-accent)]/20 text-[var(--color-accent)]"
                    : "hover:bg-[var(--border)] text-[var(--text-secondary)]"
                }`}
                title="View mode + new folder"
              >
                <FolderOpen className="w-4 h-4" />
              </button>
              {viewModeMenuOpen && (
                <div
                  className="absolute right-0 top-full mt-1 z-50 min-w-[180px] bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-xl py-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-[var(--text-secondary)] opacity-60">
                    Group by
                  </div>
                  {(
                    [
                      { id: "folders" as const, label: "Folders" },
                      { id: "type" as const, label: "By type" },
                      { id: "flat" as const, label: "Flat" },
                    ]
                  ).map((opt) => {
                    const selected = viewMode === opt.id;
                    return (
                      <button
                        key={opt.id}
                        onClick={() => {
                          setViewMode(opt.id);
                          setViewModeMenuOpen(false);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                      >
                        <span
                          className={`w-3 h-3 rounded-full border-2 shrink-0 flex items-center justify-center ${
                            selected
                              ? "border-[var(--color-accent)]"
                              : "border-[var(--text-secondary)]"
                          }`}
                        >
                          {selected && (
                            <span className="block w-1 h-1 rounded-full bg-[var(--color-accent)]" />
                          )}
                        </span>
                        <span>{opt.label}</span>
                      </button>
                    );
                  })}
                  <div className="h-px bg-[var(--border)] my-1" />
                  <button
                    onClick={async () => {
                      const name = window.prompt("New folder name");
                      setViewModeMenuOpen(false);
                      if (name && name.trim()) {
                        await addFolder(name, null);
                        // If the user was in a different view, switch them
                        // to folders so they can see the thing they just
                        // created. Otherwise the create silently does
                        // nothing visible.
                        setViewMode("folders");
                      }
                    }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                  >
                    <Plus className="w-3.5 h-3.5 text-emerald-400" />
                    New folder…
                  </button>
                </div>
              )}
            </div>

            <button
              onClick={async () => {
                try {
                  const path = await save({
                    filters: [{ name: 'JSON', extensions: ['json'] }],
                    defaultPath: getConnectionsFileName()
                  });

                  // If path is null, user canceled (e.g. pressed ESC)
                  if (!path) return;

                  await exportConnections(path, false);
                  confirmDialog.dialog({
                    title: "Export Successful",
                    message: `Connections exported to ${path}`,
                    confirmLabel: "OK",
                    type: "success"
                  });
                } catch (e: any) {
                  confirmDialog.dialog({
                    title: "Export Failed",
                    message: "Failed to export connections: " + String(e.message || e),
                    confirmLabel: "OK",
                    type: "danger"
                  });
                }
              }}
              className="p-1 rounded hover:bg-[var(--border)]"
              title="Export Connections"
            >
              <Download className="w-4 h-4" />
            </button>
            <button
              onClick={async () => {
                try {
                  const path = await open({
                    multiple: false,
                    filters: [{ name: 'JSON', extensions: ['json'] }]
                  });
                  
                  // If path is null, user canceled (e.g. pressed ESC)
                  if (!path) return;

                  const count = await importConnections(path as string);
                  confirmDialog.dialog({
                    title: "Import Successful",
                    message: `Imported ${count} connections from backup file. Passwords have been skipped for security.`,
                    confirmLabel: "Awesome",
                    type: "success"
                  });
                } catch (e: any) {
                  confirmDialog.dialog({
                    title: "Import Failed",
                    message: "The connection file format is invalid: " + String(e),
                    confirmLabel: "OK",
                    type: "danger",
                    helpInstructions: `Your backup file must be a JSON object with the following structure:

{
  "connections": [
    {
      "id": "<unique-string>",
      "name": "<connection name>",
      "db_type": "postgres",
      "host": "<hostname>",
      "port": 5432,
      "database": "<database name>",
      "username": "<username>"
    }
  ],
  "version": 2
}

Note: "version" must be a number (e.g. 2), not a string like "0.1.0".`
                  });
                }
              }}
              className="p-1 rounded hover:bg-[var(--border)]"
              title="Import Connections"
            >
              <Upload className="w-4 h-4" />
            </button>
            <button
              onClick={() => window.dispatchEvent(new CustomEvent("open-new-connection"))}
              className="p-1 rounded hover:bg-[var(--border)]"
              title="Add Connection"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="relative flex gap-1">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--text-secondary)]" />
            <input
              type="text"
              placeholder="Search..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.keyCode === 13) {
                  handleJumpToSearch();
                }
              }}
              className="w-full pl-7 pr-2 py-1 text-xs rounded bg-[var(--background)] border border-[var(--border)] outline-none focus:border-[var(--color-accent)]"
            />
          </div>
          <button 
            onClick={() => {
              handleJumpToSearch();
            }}
            className="px-2 py-0.5 rounded bg-[var(--color-accent)]/10 text-[var(--color-accent)] border border-[var(--color-accent)]/20 hover:bg-[var(--color-accent)]/20 text-[10px] font-bold"
          >
            GO
          </button>
        </div>
      </div>

      <div className="h-0 min-h-0 flex-1 overflow-hidden">
        <div 
          ref={treeContainerRef}
          tabIndex={0}
          onKeyDown={handleTreeKeyDown}
          className="w-full h-full overflow-y-auto pt-1 bg-[var(--surface)] scrollbar-thin outline-none focus:ring-1 focus:ring-indigo-500/30"
        >
          {schemaTree.length > 0 ? (
            renderTree(schemaTree)
          ) : !initialLoadDone ? (
            <div className="p-4 text-center text-xs text-[var(--text-secondary)] flex flex-col items-center">
              <Loader2 className="w-6 h-6 mb-2 opacity-50 animate-spin" />
              <p>Loading connections...</p>
            </div>
          ) : (
            <div className="p-4 text-center text-xs text-[var(--text-secondary)] flex flex-col items-center">
              <Database className="w-6 h-6 mb-2 opacity-50" />
              <p>No connections configured</p>
              <button
                 onClick={() => window.dispatchEvent(new CustomEvent("open-new-connection"))}
                 className="mt-2 text-[var(--color-accent)] hover:underline"
              >
                 Add a connection
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Loading Status Bar */}
      {isLoading && (
        <div className="flex flex-col">
          <div className="h-1 bg-[var(--surface-raised)] overflow-hidden">
            <div 
              className="h-full bg-[var(--color-accent)] animate-pulse" 
              style={{ width: "100%" }} 
            />
          </div>
          <div className="px-2 py-1.5 bg-[var(--surface)] border-t border-[var(--border)] text-[10px] flex items-center gap-2">
            <Loader2 className="w-3 h-3 animate-spin text-[var(--color-accent)]" />
            <span>{(() => {
              if (connectingConnectionIds.size > 0) {
                const names = Array.from(connectingConnectionIds)
                  .map(id => connections.find(c => c.id === id)?.name)
                  .filter(Boolean) as string[];
                if (names.length === 1) return `Connecting to ${names[0]}...`;
                if (names.length > 1) return `Connecting to ${names.length} connections...`;
                return "Connecting...";
              }
              if (loadingDatabases.size > 0) {
                return `Loading database${loadingDatabases.size > 1 ? `s (${loadingDatabases.size})` : ""}...`;
              }
              if (isLoadingSchema) {
                const target = selectedDatabase ? ` from ${selectedDatabase}` : "";
                return `Loading schema${target} (${schemaProgress.phase} ${schemaProgress.current}/${schemaProgress.total})...`;
              }
              if (loadingTableDetails.size > 0) {
                return `Loading table details (${loadingTableDetails.size})...`;
              }
              return "Working...";
            })()}</span>
          </div>
        </div>
      )}

      {/* Context Menu (Connection or Folder). Folder rows carry a
          `folder:<id>` contextMenuId set by buildFolderNode — we branch
          here rather than maintaining a second piece of state. */}
      {contextMenu && contextMenu.connectionId.startsWith("folder:") && (
        <div
          className="fixed bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-xl py-1 z-50 min-w-[180px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {(() => {
            const folderId = contextMenu.connectionId.slice("folder:".length);
            const folder = folders.find((f) => f.id === folderId);
            if (!folder) return null;
            return (
              <>
                <button
                  onClick={async () => {
                    const name = window.prompt("Rename folder", folder.name);
                    if (name && name.trim()) {
                      await renameFolder(folderId, name);
                    }
                    closeContextMenu();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                >
                  <Edit2 className="w-3 h-3" /> Rename
                </button>
                <button
                  onClick={async () => {
                    const name = window.prompt("New subfolder name");
                    if (name && name.trim()) {
                      await addFolder(name, folderId);
                      // Open the parent so the new subfolder is visible.
                      setExpandedNodes((prev) => new Set(prev).add(`folder-${folderId}`));
                    }
                    closeContextMenu();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                >
                  <Plus className="w-3 h-3 text-emerald-400" /> New subfolder
                </button>
                <button
                  onClick={() => {
                    setMoveTarget({ kind: "folder", id: folderId, name: folder.name });
                    closeContextMenu();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                >
                  <FolderOpen className="w-3 h-3 text-yellow-500" /> Move to folder…
                </button>
                <div className="h-px bg-[var(--border)] my-1" />
                <button
                  onClick={async () => {
                    // Preview what would happen before asking. removeFolder
                    // reparents children to the deleted folder's parent.
                    const subs = folders.filter((f) => f.parentId === folderId).length;
                    const conns = connections.filter((c) => c.folderId === folderId).length;
                    const message =
                      subs + conns === 0
                        ? `Delete folder "${folder.name}"?`
                        : `Delete folder "${folder.name}"? ${conns} connection${
                            conns === 1 ? "" : "s"
                          } and ${subs} subfolder${subs === 1 ? "" : "s"} will be moved to its parent.`;
                    const confirmed = await confirmDialog.confirm({
                      title: "Delete folder",
                      message,
                      confirmLabel: "Delete",
                      cancelLabel: "Keep",
                      type: "danger",
                    });
                    if (confirmed) {
                      await removeFolder(folderId);
                    }
                    closeContextMenu();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)] text-red-400"
                >
                  <Trash2 className="w-3 h-3" /> Delete folder
                </button>
              </>
            );
          })()}
        </div>
      )}
      {contextMenu && !contextMenu.connectionId.startsWith("folder:") && (
        <div
          className="fixed bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-xl py-1 z-50 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              const conn = connections.find(c => c.id === contextMenu.connectionId);
              if (conn) handleConnect(conn);
              closeContextMenu();
            }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
          >
            <Play className="w-3 h-3" /> Connect
          </button>
          <button
            onClick={() => {
              const conn = connections.find(c => c.id === contextMenu.connectionId);
              if (conn) handleEdit(conn);
            }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
          >
            <Edit2 className="w-3 h-3" /> Edit
          </button>
          {viewMode === "folders" && (
            <button
              onClick={() => {
                const conn = connections.find((c) => c.id === contextMenu.connectionId);
                if (conn) {
                  setMoveTarget({ kind: "connection", id: conn.id, name: conn.name });
                }
                closeContextMenu();
              }}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
            >
              <FolderOpen className="w-3 h-3 text-yellow-500" /> Move to folder…
            </button>
          )}
          <button
            onClick={async () => {
              const confirmed = await confirmDialog.confirm({
                title: "Delete Connection",
                message: "Are you sure you want to delete this connection? This cannot be undone.",
                confirmLabel: "Delete",
                cancelLabel: "Keep",
                type: "danger"
              });
              if (confirmed) {
                handleDelete(contextMenu.connectionId);
              }
            }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)] text-red-400"
          >
            <Trash2 className="w-3 h-3" /> Delete
          </button>
          <div className="h-px bg-[var(--border)] my-1" />
          <button
            onClick={() => {
              // We need to ensure we're connected to something to fetch owners/templates
              // But for now, we can just open it
              setIsCreateDatabaseOpen(true);
              closeContextMenu();
            }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
          >
            <Plus className="w-3 h-3 text-emerald-400" /> Create Database...
          </button>
        </div>
      )}

      {/* Move-to-folder picker (#104). Excludes self + descendants when
          moving a folder so the user can't construct a cycle. */}
      {moveTarget && (
        <MoveToFolderDialog
          target={moveTarget}
          folders={folders}
          onCancel={() => setMoveTarget(null)}
          onPick={async (parentId) => {
            try {
              if (moveTarget.kind === "connection") {
                await moveConnectionToFolder(moveTarget.id, parentId);
              } else {
                await moveFolder(moveTarget.id, parentId);
              }
              setMoveTarget(null);
            } catch (e) {
              // moveFolder throws on cycle / unknown parent; surface that
              // instead of swallowing it. The dialog stays open so the
              // user can pick a different destination.
              await confirmDialog.dialog({
                title: "Move failed",
                message: e instanceof Error ? e.message : String(e),
                confirmLabel: "OK",
                type: "danger",
              });
            }
          }}
        />
      )}

      {/* Schema Context Menu */}
      {schemaContextMenu && (
        <div
          className="fixed z-50 bg-[var(--surface)] border border-[var(--border)] shadow-xl rounded-lg py-1 min-w-[160px] animate-in fade-in zoom-in duration-100"
          style={{ left: schemaContextMenu.x, top: schemaContextMenu.y }}
        >
          {/* Database folder specific items if any (removed duplicate Create Database) */}

          {schemaContextMenu.node.icon === "database" && (
            <>
              <button
                onClick={() => {
                  window.dispatchEvent(new CustomEvent("open-query-window"));
                  closeContextMenu();
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
              >
                <Terminal className="w-3 h-3 text-[var(--color-accent)]" />
                Open SQL Editor
              </button>
              <button
                onClick={() => {
                  window.dispatchEvent(new CustomEvent("open-query-window-psql", {
                    detail: {
                      connectionId: activeConnection?.id,
                      connectionName: activeConnection?.name,
                      database: schemaContextMenu.node.name,
                    }
                  }));
                  closeContextMenu();
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
              >
                <Terminal className="w-3 h-3 text-blue-400" />
                Open PSQL (Console)
              </button>
              <button
                onClick={() => {
                  loadSchema(selectedDatabase || "");
                  closeContextMenu();
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
              >
                <Zap className="w-3 h-3 text-yellow-500" /> Refresh Schema
              </button>
              <button
                onClick={() => {
                  if (activeConnection && selectedDatabase) {
                    const currentSchemas = getSelectedSchemas(activeConnection.id, selectedDatabase);
                    setSchemaDialogInfo({
                      connectionId: activeConnection.id,
                      connectionName: activeConnection.name,
                      databaseName: selectedDatabase,
                      selectedSchemas: currentSchemas
                    });
                    setShowSchemaDialog(true);
                  }
                  closeContextMenu();
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
              >
                <Database className="w-3 h-3 text-cyan-400" /> Select Schemas...
              </button>
              
              <div className="h-px bg-[var(--border)] my-1" />
              
              {/* Create Submenu */}
              <div 
                className="relative group/submenu"
                onMouseEnter={() => setActiveSubmenu("create")}
                onMouseLeave={(e) => {
                  // Prevent flickering if moving directly to the submenu
                  const related = e.relatedTarget as HTMLElement;
                  if (related && (related.closest('.submenu-panel') || related.closest('.group\\/submenu'))) return;
                  setActiveSubmenu(null);
                }}
              >
                <div className="w-full flex items-center justify-between px-3 py-1.5 text-xs hover:bg-[var(--border)] cursor-default transition-colors">
                  <div className="flex items-center gap-2">
                    <Plus className="w-3 h-3 text-green-400" /> Create
                  </div>
                  <ChevronRight className="w-3 h-3 opacity-50" />
                </div>
                
                {activeSubmenu === "create" && (
                  <div 
                    className="absolute left-full top-0 ml-[-4px] bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-xl py-1 min-w-[180px] animate-in fade-in slide-in-from-left-2 duration-150 z-[60] submenu-panel"
                    onMouseEnter={() => setActiveSubmenu("create")}
                  >
                    <button
                      onClick={() => {
                        setCreateTableTarget({ schema: 'public' });
                        setIsCreateTableOpen(true);
                        closeContextMenu();
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                    >
                      <Table className="w-3 h-3 text-blue-400" /> Table
                    </button>
                    <button
                      onClick={() => {
                        window.dispatchEvent(new CustomEvent("open-query-with-text", { 
                          detail: { query: getCreateTemplate("Views") || "", name: "New View" } 
                        }));
                        closeContextMenu();
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                    >
                      <Eye className="w-3 h-3 text-purple-400" /> View
                    </button>
                    <button
                      onClick={() => {
                        window.dispatchEvent(new CustomEvent("open-query-with-text", { 
                          detail: { query: getCreateTemplate("Functions") || "", name: "New Function" } 
                        }));
                        closeContextMenu();
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                    >
                      <Variable className="w-3 h-3 text-red-400" /> Function
                    </button>
                    <button
                      onClick={() => {
                        window.dispatchEvent(new CustomEvent("open-query-with-text", { 
                          detail: { query: getCreateTemplate("Triggers") || "", name: "New Trigger" } 
                        }));
                        closeContextMenu();
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                    >
                      <Zap className="w-3 h-3 text-orange-400" /> Trigger
                    </button>
                    <button
                      onClick={() => {
                        window.dispatchEvent(new CustomEvent("open-query-with-text", { 
                          detail: { query: getCreateTemplate("Indexes") || "", name: "New Index" } 
                        }));
                        closeContextMenu();
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                    >
                      <Hash className="w-3 h-3 text-green-400" /> Index
                    </button>
                    <button
                      onClick={() => {
                        window.dispatchEvent(new CustomEvent("open-query-with-text", { 
                          detail: { query: getCreateTemplate("Schemas") || "", name: "New Schema" } 
                        }));
                        closeContextMenu();
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                    >
                      <Server className="w-3 h-3 text-yellow-500" /> Schema
                    </button>
                    <button
                      onClick={() => {
                        window.dispatchEvent(new CustomEvent("open-query-with-text", {
                          detail: { query: getCreateTemplate("Sequences") || "", name: "New Sequence" }
                        }));
                        closeContextMenu();
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                    >
                      <Hash className="w-3 h-3 text-cyan-400" /> Sequence
                    </button>
                    <button
                      onClick={() => {
                        window.dispatchEvent(new CustomEvent("open-query-with-text", {
                          detail: { query: getCreateTemplate("Types") || "", name: "New Type" }
                        }));
                        closeContextMenu();
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                    >
                      <Variable className="w-3 h-3 text-pink-400" /> Type
                    </button>
                    
                    <div className="h-px bg-[var(--border)] my-1" />
                    
                    <button
                      onClick={() => {
                        setIsCreateDatabaseOpen(true);
                        closeContextMenu();
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                    >
                      <Database className="w-3 h-3 text-emerald-400" /> Database (New)
                    </button>
                  </div>
                )}
              </div>

              {/* Tools Submenu */}
              <div 
                className="relative group/submenu"
                onMouseEnter={() => setActiveSubmenu("tools")}
                onMouseLeave={(e) => {
                  const related = e.relatedTarget as HTMLElement;
                  if (related && (related.closest('.submenu-panel') || related.closest('.group\\/submenu'))) return;
                  setActiveSubmenu(null);
                }}
              >
                <div className="w-full flex items-center justify-between px-3 py-1.5 text-xs hover:bg-[var(--border)] cursor-default transition-colors">
                  <div className="flex items-center gap-2">
                    <Check className="w-3 h-3 text-blue-400" /> Tools
                  </div>
                  <ChevronRight className="w-3 h-3 opacity-50" />
                </div>
                
                {activeSubmenu === "tools" && (
                  <div 
                    className="absolute left-full top-0 ml-[-4px] bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-xl py-1 min-w-[140px] animate-in fade-in slide-in-from-left-2 duration-150 z-[60] submenu-panel"
                    onMouseEnter={() => setActiveSubmenu("tools")}
                  >
                    <button
                      onClick={() => {
                        const nodeId = schemaContextMenu.node.id;
                        const dbName = schemaContextMenu.node.name;
                        const conn = activeConnection;
                        const connId = conn?.id || nodeId.split("-")[1] || "";
                        setBackupTarget({ connId, dbName, connName: conn?.name || dbName });
                        setBackupDialogOpen(true);
                        closeContextMenu();
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                    >
                      <Download className="w-3 h-3 text-emerald-400" /> Backup
                    </button>
                    <button
                      onClick={() => {
                        const nodeId = schemaContextMenu.node.id;
                        const dbName = schemaContextMenu.node.name;
                        const conn = activeConnection;
                        const connId = conn?.id || nodeId.split("-")[1] || "";
                        setBackupTarget({ connId, dbName, connName: conn?.name || dbName });
                        setRestoreDialogOpen(true);
                        closeContextMenu();
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                    >
                      <Upload className="w-3 h-3 text-blue-400" /> Restore
                    </button>
                  </div>
                )}
              </div>

              <div className="h-px bg-[var(--border)] my-1" />
              
              <button
                onClick={() => {
                  navigator.clipboard.writeText(schemaContextMenu.node.name);
                  closeContextMenu();
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
              >
                <Columns className="w-3 h-3 opacity-70" /> Copy Database Name
              </button>
              
              <button
                onClick={async () => {
                  const dbName = schemaContextMenu.node.name;
                  const confirmed = await confirmDialog.confirm({
                    title: "Drop Database?",
                    message: `Are you sure you want to drop the database "${dbName}"? This action is irreversible and all data will be permanently deleted.`,
                    confirmLabel: "Drop Database",
                    cancelLabel: "Cancel",
                    type: "danger",
                    helpInstructions: "1. Open Settings (cog icon)\n2. Go to 'Permissions & Rules' tab\n3. Toggle 'Allow SQL Execution' to ON"
                  });

                  if (confirmed) {
                    try {
                      await dropDatabase(dbName);
                      confirmDialog.dialog({
                        title: "Database Dropped",
                        message: `The database "${dbName}" has been successfully deleted.`,
                        type: "success"
                      });
                    } catch (e: any) {
                      confirmDialog.dialog({
                        title: "Drop Failed",
                        message: `Failed to drop database: ${e.message || String(e)}`,
                        type: "danger",
                        helpInstructions: "This action requires global execution permissions. Enable them in Settings > Permissions & Rules > Allow SQL Execution."
                      });
                    }
                  }
                  closeContextMenu();
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-red-500 hover:text-white transition-colors text-red-400"
              >
                <Trash2 className="w-3 h-3" /> Drop Database
              </button>
            </>
          )}

          {schemaContextMenu.node.id.startsWith("schemas-root-") && (
            <div className="px-3 py-1.5 text-[10px] font-bold uppercase text-[var(--text-secondary)] border-b border-[var(--border)] mb-1 tracking-wider">
              {schemaContextMenu.node.icon} — {schemaContextMenu.node.name}
            </div>
          )}
          
          {/* Leaf schema items: DDL, SQL statements */}
          {isLeafSchemaItem(schemaContextMenu.node.icon) && (
            <>
              <button
                onClick={async () => {
                  const ddl = await getDDL(schemaContextMenu.node.icon, schemaContextMenu.node.name);
                  window.dispatchEvent(new CustomEvent("open-query-with-text", { 
                    detail: { query: ddl, name: `DDL ${schemaContextMenu.node.name}` } 
                  }));
                  closeContextMenu();
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
              >
                <Code className="w-3 h-3" /> Show DDL
              </button>

              {(schemaContextMenu.node.icon === "table" || schemaContextMenu.node.icon === "view") && (
                <button
                  onClick={async () => {
                    const fullTableName = schemaContextMenu.node.id.replace(/^(table|view)-/, "");
                    const sql = await generateStatement("select", fullTableName);
                    window.dispatchEvent(new CustomEvent("run-specific-query", { 
                      detail: { query: sql, name: fullTableName, lineNumber: 1 } 
                    }));
                    closeContextMenu();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                >
                  <Search className="w-3 h-3" /> Select Top 100
                </button>
              )}

              {schemaContextMenu.node.icon === "table" && (
                <>
                  <button
                    onClick={async () => {
                      const fullTableName = schemaContextMenu.node.id.replace(/^table-/, "");
                      const confirmed = await confirmDialog.confirm({
                        title: "Generate INSERT",
                        message: `Generate INSERT statement for "${fullTableName}"? This will open in a new query tab.`,
                        confirmLabel: "Generate",
                        type: "info"
                      });
                      if (!confirmed) return;
                      const sql = await generateStatement("insert", fullTableName);
                      window.dispatchEvent(new CustomEvent("open-query-with-text", { 
                        detail: { query: sql, name: `Insert ${fullTableName}` } 
                      }));
                      closeContextMenu();
                    }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                  >
                    <Plus className="w-3 h-3" /> Insert Statement
                  </button>
                  <button
                    onClick={async () => {
                      const fullTableName = schemaContextMenu.node.id.replace(/^table-/, "");
                      const sql = await generateStatement("update", fullTableName);
                      window.dispatchEvent(new CustomEvent("open-query-with-text", { 
                        detail: { query: sql, name: `Update ${fullTableName}` } 
                      }));
                      closeContextMenu();
                    }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                  >
                    <Edit2 className="w-3 h-3" /> Update Statement
                  </button>
                  <button
                    onClick={async () => {
                      const fullTableName = schemaContextMenu.node.id.replace(/^table-/, "");
                      const confirmed = await confirmDialog.confirm({
                        title: "Generate DELETE",
                        message: `Generate DELETE statement for "${fullTableName}"? Be careful when executing this.`,
                        confirmLabel: "Generate",
                        type: "warning"
                      });
                      if (!confirmed) return;
                      const sql = await generateStatement("delete", fullTableName);
                      window.dispatchEvent(new CustomEvent("open-query-with-text", { 
                        detail: { query: sql, name: `Delete ${fullTableName}` } 
                      }));
                      closeContextMenu();
                    }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)] text-[var(--color-error)]"
                  >
                    <Trash2 className="w-3 h-3" /> Delete Statement
                  </button>
                </>
              )}
              
              <div className="h-px bg-[var(--border)] my-1" />

              <button
                onClick={() => {
                  navigator.clipboard.writeText(schemaContextMenu.node.name);
                  closeContextMenu();
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
              >
                <Columns className="w-3 h-3" /> Copy Name
              </button>
              <button
                onClick={async () => {
                  const confirmed = await confirmDialog.confirm({
                    title: `Drop ${schemaContextMenu.node.icon}`,
                    message: `Are you sure you want to generate a DROP statement for "${schemaContextMenu.node.name}"? This is a destructive operation.`,
                    confirmLabel: "Generate Drop SQL",
                    type: "danger"
                  });
                  if (!confirmed) return;
                  const itemType = schemaContextMenu.node.icon.toUpperCase();
                  const sql = `DROP ${itemType} IF EXISTS ${schemaContextMenu.node.name};`;
                  window.dispatchEvent(new CustomEvent("open-query-with-text", { 
                    detail: { query: `-- WARNING: This will permanently drop the ${itemType.toLowerCase()}\n${sql}`, name: `Drop ${schemaContextMenu.node.name}` } 
                  }));
                  closeContextMenu();
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)] text-red-400"
              >
                <Trash2 className="w-3 h-3" /> Drop {schemaContextMenu.node.icon}
              </button>
            </>
          )}

          {/* Folder/node Create New options (for non-database nodes like schemas, folders) */}
          {isFolderNode(schemaContextMenu.node.icon) && schemaContextMenu.node.icon !== "database" && (
            <>
              {/* Show Create New for the specific folder type */}
              {(() => {
                const nodeName = schemaContextMenu.node.name.toLowerCase();
                const isDatabaseFolder = nodeName.includes("database");
                const isTableFolder = nodeName.includes("table") && !nodeName.includes("schema");

                if (isDatabaseFolder) {
                  return (
                    <button
                      onClick={() => {
                        setIsCreateDatabaseOpen(true);
                        closeContextMenu();
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)] text-green-400"
                    >
                      <Plus className="w-3 h-3" /> Create New Database
                    </button>
                  );
                }

                if (isTableFolder) {
                  return (
                    <button
                      onClick={() => {
                        const schemaMatch = schemaContextMenu.node.id.match(/-([a-zA-Z0-9_]+)$/);
                        const schema = schemaMatch ? schemaMatch[1] : "public";
                        setCreateTableTarget({ schema });
                        setIsCreateTableOpen(true);
                        closeContextMenu();
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)] text-green-400"
                    >
                      <Plus className="w-3 h-3" /> Create New Table
                    </button>
                  );
                }

                const template = getCreateTemplate(schemaContextMenu.node.name);
                if (template) {
                  return (
                    <button
                      onClick={() => {
                        window.dispatchEvent(new CustomEvent("open-query-with-text", { 
                          detail: { query: template, name: `New ${schemaContextMenu.node.name.replace(/s$/, "")}` } 
                        }));
                        closeContextMenu();
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)] text-green-400"
                    >
                      <Plus className="w-3 h-3" /> Create New {schemaContextMenu.node.name.replace(/s$/, "")}
                    </button>
                  );
                }
                return null;
              })()}

              {/* For schema nodes only */}
              {(schemaContextMenu.node.icon === "schema") && (
                <>
                  <div className="h-px bg-[var(--border)] my-1" />
                  
                  {/* Create Submenu for Schema */}
                  <div 
                    className="relative group/submenu"
                    onMouseEnter={() => setActiveSubmenu("create")}
                    onMouseLeave={(e) => {
                      const related = e.relatedTarget as HTMLElement;
                      if (related && (related.closest('.submenu-panel') || related.closest('.group\\/submenu'))) return;
                      setActiveSubmenu(null);
                    }}
                  >
                    <div className="w-full flex items-center justify-between px-3 py-1.5 text-xs hover:bg-[var(--border)] cursor-default transition-colors">
                      <div className="flex items-center gap-2">
                        <Plus className="w-3 h-3 text-green-400" /> Create
                      </div>
                      <ChevronRight className="w-3 h-3 opacity-50" />
                    </div>
                    
                    {activeSubmenu === "create" && (
                      <div 
                        className="absolute left-full top-0 ml-[-4px] bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-xl py-1 min-w-[180px] animate-in fade-in slide-in-from-left-2 duration-150 z-[60] submenu-panel"
                        onMouseEnter={() => setActiveSubmenu("create")}
                      >
                        <button
                          onClick={() => {
                            setCreateTableTarget({ schema: schemaContextMenu.node.name });
                            setIsCreateTableOpen(true);
                            closeContextMenu();
                          }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                        >
                          <Table className="w-3 h-3 text-blue-400" /> Table
                        </button>
                        <button
                          onClick={() => {
                            window.dispatchEvent(new CustomEvent("open-query-with-text", { 
                              detail: { query: getCreateTemplate("Views") || "", name: "New View" } 
                            }));
                            closeContextMenu();
                          }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                        >
                          <Eye className="w-3 h-3 text-purple-400" /> View
                        </button>
                        <button
                          onClick={() => {
                            window.dispatchEvent(new CustomEvent("open-query-with-text", { 
                              detail: { query: getCreateTemplate("Functions") || "", name: "New Function" } 
                            }));
                            closeContextMenu();
                          }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                        >
                          <Variable className="w-3 h-3 text-red-400" /> Function
                        </button>
                        <button
                          onClick={() => {
                            window.dispatchEvent(new CustomEvent("open-query-with-text", { 
                              detail: { query: getCreateTemplate("Triggers") || "", name: "New Trigger" } 
                            }));
                            closeContextMenu();
                          }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                        >
                          <Zap className="w-3 h-3 text-orange-400" /> Trigger
                        </button>
                        <button
                          onClick={() => {
                            window.dispatchEvent(new CustomEvent("open-query-with-text", { 
                              detail: { query: getCreateTemplate("Indexes") || "", name: "New Index" } 
                            }));
                            closeContextMenu();
                          }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                        >
                          <Hash className="w-3 h-3 text-green-400" /> Index
                        </button>
                        <button
                          onClick={() => {
                            window.dispatchEvent(new CustomEvent("open-query-with-text", {
                              detail: { query: getCreateTemplate("Sequences") || "", name: "New Sequence" }
                            }));
                            closeContextMenu();
                          }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                        >
                          <Hash className="w-3 h-3 text-cyan-400" /> Sequence
                        </button>
                        <button
                          onClick={() => {
                            window.dispatchEvent(new CustomEvent("open-query-with-text", {
                              detail: { query: getCreateTemplate("Types") || "", name: "New Type" }
                            }));
                            closeContextMenu();
                          }}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                        >
                          <Variable className="w-3 h-3 text-pink-400" /> Type
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* Add Connection Dialog is owned by AppLayout (#84) — the "+" buttons
          above dispatch `open-new-connection` to trigger it. */}

      {/* Edit Connection Dialog */}
      {showEditDialog && editingConnection && (
        <ConnectionDialog 
          connection={editingConnection} 
          onClose={() => {
            setShowEditDialog(false);
            setEditingConnection(null);
          }} 
        />
      )}

      {/* Schema Selection Dialog */}
      {showSchemaDialog && schemaDialogInfo && (
        <SchemaSelectionDialog
          isOpen={showSchemaDialog}
          onClose={() => {
            setShowSchemaDialog(false);
            setSchemaDialogInfo(null);
          }}
          onApply={(selectedSchemas) => {
            if (selectedDatabase) {
              loadSchema(selectedDatabase, selectedSchemas);
            }
          }}
          connectionId={schemaDialogInfo.connectionId}
          connectionName={schemaDialogInfo.connectionName}
          databaseName={schemaDialogInfo.databaseName}
          currentSchemas={schemaDialogInfo.selectedSchemas}
        />
      )}

      {/* Backup Dialog */}
      {backupDialogOpen && backupTarget && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70" onClick={() => setBackupDialogOpen(false)} />
          <div className="relative w-[500px] bg-[var(--surface)] border border-[var(--border)] rounded-2xl shadow-2xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-lg">Backup Database</h3>
              <button onClick={() => setBackupDialogOpen(false)} className="p-1 hover:bg-[var(--border)] rounded"><ChevronRight className="w-4 h-4" /></button>
            </div>
            <div className="mb-4">
              <p className="text-sm text-[var(--text-secondary)] mb-2">Database: <span className="font-medium text-[var(--text-primary)]">{backupTarget.dbName}</span></p>
              <p className="text-sm text-[var(--text-secondary)]">Connection: <span className="font-medium text-[var(--text-primary)]">{backupTarget.connName}</span></p>
            </div>
            <div className="mb-4">
              <label className="text-xs font-bold uppercase text-[var(--text-secondary)]">Backup Type</label>
              <div className="mt-2 space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" checked={backupType === "sql-schema"} onChange={() => setBackupType("sql-schema")} className="text-indigo-500" />
                  <span className="text-sm">SQL Dump (Schema Only)</span>
                </label>
                <label className={`flex items-center gap-2 cursor-pointer ${activeConnection?.type !== 'postgres' && activeConnection?.type !== 'supabase' ? 'opacity-40 grayscale pointer-events-none' : ''}`}>
                  <input 
                    type="radio" 
                    checked={backupType === "sql-full"} 
                    onChange={() => setBackupType("sql-full")} 
                    className="text-indigo-500"
                    disabled={activeConnection?.type !== 'postgres' && activeConnection?.type !== 'supabase'} 
                  />
                  <span className="text-sm">SQL Dump (Schema + Data) <span className="text-[10px] opacity-70 ml-1">(PG Only)</span></span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" checked={backupType === "json"} onChange={() => setBackupType("json")} className="text-indigo-500" />
                  <span className="text-sm">JSON Backup (Portable)</span>
                </label>
                <label className={`flex items-center gap-2 cursor-pointer ${activeConnection?.type !== 'postgres' && activeConnection?.type !== 'supabase' ? 'opacity-40 grayscale pointer-events-none' : ''}`}>
                  <input 
                    type="radio" 
                    checked={backupType === "directory"} 
                    onChange={() => setBackupType("directory")} 
                    className="text-indigo-500"
                    disabled={activeConnection?.type !== 'postgres' && activeConnection?.type !== 'supabase'} 
                  />
                  <span className="text-sm">Directory Backup <span className="text-[10px] opacity-70 ml-1">(PG Only)</span></span>
                </label>
              </div>
            </div>
            {backupLoading && (
              <div className="mb-4 p-3 bg-indigo-500/10 border border-indigo-500/30 rounded-lg">
                <div className="flex items-center gap-2 text-indigo-400"><Loader2 className="w-4 h-4 animate-spin" /><span className="text-sm font-medium">Backing up...</span></div>
                <p className="text-xs text-indigo-300 mt-1">{backupStatus}</p>
              </div>
            )}
            <div className="flex justify-end gap-2 text-xs">
              {!['postgres', 'supabase'].includes(activeConnection?.type || '') && (
                <div className="mr-auto text-[var(--text-secondary)] italic flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" /> Some options limited for {activeConnection?.type}
                </div>
              )}
              <button 
                onClick={() => { if (backupLoading) { backupStopRef.current = true; setBackupStatus("Stopping..."); } else { setBackupDialogOpen(false); } }} 
                className="px-4 py-2 rounded-lg hover:bg-[var(--border)] transition-colors"
              >
                {backupLoading ? "Stop Backup" : "Cancel"}
              </button>
              <button 
                onClick={executeBackup} 
                disabled={backupLoading} 
                className="px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 flex items-center gap-2 disabled:opacity-50 shadow-lg shadow-indigo-500/20 transition-all font-semibold"
              >
                <Loader2 className={`w-3 h-3 ${backupLoading ? "animate-spin" : ""}`} />
                {backupLoading ? "Processing..." : "Start Backup"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Restore Dialog */}
      {restoreDialogOpen && backupTarget && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/70" onClick={() => !restoreLoading && setRestoreDialogOpen(false)} />
          <div className="relative w-[500px] bg-[var(--surface)] border border-[var(--border)] rounded-2xl shadow-2xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-lg flex items-center gap-2"><Upload className="w-5 h-5 text-indigo-400" /> Restore Database</h3>
              <button onClick={() => setRestoreDialogOpen(false)} className="p-1 hover:bg-[var(--border)] rounded transition-colors" disabled={restoreLoading}><X className="w-5 h-5" /></button>
            </div>
            <div className="mb-4 p-4 bg-[var(--surface-light)] border border-[var(--border)] rounded-xl">
              <div className="flex justify-between items-start">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-secondary)] mb-1">Target Database</p>
                  <p className="text-sm font-semibold text-emerald-400">{backupTarget.dbName}</p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-secondary)] mb-1">Server</p>
                  <p className="text-sm font-medium">{backupTarget.connName} ({activeConnection?.type})</p>
                </div>
              </div>
            </div>
            
            {!restoreLoading ? (
              <button onClick={executeRestore} className="w-full px-4 py-3 rounded-lg border border-[var(--border)] hover:bg-[var(--border)] flex items-center justify-center gap-2">
                <Upload className="w-4 h-4" />Select Backup File to Restore
              </button>
            ) : (
              <div className="space-y-3">
                <div className="p-4 bg-indigo-500/10 border border-indigo-500/30 rounded-lg">
                  <div className="flex items-center gap-2 text-indigo-400 mb-2"><Loader2 className="w-4 h-4 animate-spin" /><span className="text-sm font-medium">Restoring...</span></div>
                  <p className="text-xs text-indigo-300">{backupStatus}</p>
                </div>
                <button 
                  onClick={() => { backupStopRef.current = true; setBackupStatus("Stopping..."); }} 
                  className="w-full px-4 py-2 rounded-lg bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 text-sm font-medium flex items-center justify-center gap-2"
                >
                  <Square className="w-4 h-4" />Stop Restore
                </button>
              </div>
            )}
            
            {backupStatus.includes("complete") && !restoreLoading && (
              <div className="mt-4 p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg">
                <div className="flex items-center gap-2 text-emerald-400"><Check className="w-4 h-4" /><span className="text-sm font-medium">Restore Complete!</span></div>
              </div>
            )}
            
            {backupStatus.includes("Error") && !restoreLoading && (
              <div className="mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
                <div className="flex items-center gap-2 text-red-400 mb-2"><AlertCircle className="w-4 h-4" /><span className="text-sm font-medium">Errors Encountered</span></div>
                <pre className="text-xs text-red-300 mt-1 whitespace-pre-wrap max-h-48 overflow-y-auto scrollbar-thin">{backupStatus}</pre>
              </div>
            )}
          </div>
        </div>
      )}
      <CreateTableDialog
        isOpen={isCreateTableOpen}
        onClose={() => setIsCreateTableOpen(false)}
        onCreate={async (payload) => {
          await createTable({ ...payload, schema: createTableTarget?.schema });
        }}
        dbType={activeConnection?.type || "postgres"}
      />

      <CreateDatabaseDialog
        isOpen={isCreateDatabaseOpen}
        onClose={() => setIsCreateDatabaseOpen(false)}
        onCreate={async (payload) => {
          await createDatabase(payload);
        }}
        dbType={activeConnection?.type || "postgres"}
      />
    </div>
  );
}

// ── Move-to-folder picker dialog (#104) ─────────────────────────────────
//
// Renders a flat list of all folders with indentation reflecting depth,
// plus a "Root" option at the top. When moving a folder, the dialog hides
// the folder itself and its descendants — picking one of those would form
// a cycle, and ConnectionContext.moveFolder rejects it anyway.

import type { Folder as FolderModel } from "../../contexts/ConnectionContext";
import { descendantFolderIds } from "../../utils/folderTree";

interface MoveToFolderDialogProps {
  target: { kind: "connection" | "folder"; id: string; name: string };
  folders: FolderModel[];
  onCancel: () => void;
  onPick: (parentId: string | null) => void;
}

function MoveToFolderDialog({ target, folders, onCancel, onPick }: MoveToFolderDialogProps) {
  // Sort folders into a depth-aware list so the UI shows hierarchy without
  // needing a real tree component.
  const flat: { folder: FolderModel; depth: number }[] = [];
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

  const excluded =
    target.kind === "folder" ? descendantFolderIds(target.id, folders) : new Set<string>();

  return (
    <div
      className="fixed inset-0 z-[200] bg-black/50 flex items-center justify-center"
      onClick={onCancel}
    >
      <div
        className="bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-xl w-[360px] max-h-[480px] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between">
          <div className="text-sm font-semibold">Move "{target.name}" to…</div>
          <button onClick={onCancel} className="p-1 rounded hover:bg-[var(--border)]">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          <button
            onClick={() => onPick(null)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
          >
            <FolderOpen className="w-3.5 h-3.5 text-yellow-500" />
            <span className="font-medium">Root</span>
          </button>
          {flat
            .filter(({ folder }) => !excluded.has(folder.id))
            .map(({ folder, depth }) => (
              <button
                key={folder.id}
                onClick={() => onPick(folder.id)}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--border)]"
                style={{ paddingLeft: `${12 + depth * 16}px` }}
              >
                <Folder className="w-3.5 h-3.5 text-yellow-500" />
                <span>{folder.name}</span>
              </button>
            ))}
          {flat.length === 0 && (
            <div className="px-3 py-4 text-center text-xs text-[var(--text-secondary)] italic">
              No folders yet. Use the + button in the toolbar to create one.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}