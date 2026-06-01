import { useState, useEffect, useRef } from "react";
import { ChevronRight, ChevronDown, Database, Table, Folder, FolderOpen, Plus, Search, Server, Columns, Hash, Eye, Variable, Trash2, Edit2, Play, Zap, Code, Download, Upload, Loader2, Terminal, Check, AlertCircle, Square, HardDrive, User, Users } from "lucide-react";
import { ImportExportDialog } from "./ImportExportDialog";
import { PROVIDERS } from "../../config/providers";
import { DatabaseConnection } from "../../contexts/ConnectionContext";
import { useConnections } from "../../contexts/useConnections";
import { useSettings } from "../../store/settingsStore";
import { ConnectionDialog } from "./ConnectionDialog";
import { useConfirmDialog } from "../ui/ConfirmDialog";
import { save, open } from "@tauri-apps/plugin-dialog";
import { SchemaSelectionDialog } from "./SchemaSelectionDialog";
import { CreateTableDialog } from "./CreateTableDialog";
import { CreateDatabaseDialog } from "./CreateDatabaseDialog";
import { CreateLoginRoleDialog } from "./CreateLoginRoleDialog";
import { logger } from "../../utils/logger";
import { quoteIdentifier } from "../../utils/sqlSecurity";
import { buildConnectionTree, descendantFolderIds, type FolderTreeNode } from "../../utils/folderTree";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "../ui/Menu";
import { Dialog } from "../ui/Dialog";

interface TreeNode {
  id: string;
  name: string;
  icon: "server" | "database" | "schema" | "table" | "view" | "column" | "index" | "function" | "trigger" | "type" | "procedure" | "operator" | "foreign_table" | "language" | "extension" | "tablespace" | "login_role" | "group_role" | "folder" | "loading";
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
  const { connections, activeConnection, selectedDatabase, databases, removeConnection, updateConnection, connectToDatabase, schemaItems, loadSchema, getDDL, generateStatement, isLoadingSchema, currentDb, schemaProgress, dropDatabase, createDatabase, createRole, createTable, vaultCredentials, initialLoadDone, getSelectedSchemas, folders, addFolder, renameFolder, removeFolder, moveConnectionToFolder, moveFolder, roles, dropRole, tablespaces } = useConnections();
  // Ref keeps the latest activeConnection so server-node action() closures
  // always see the current value, not the one captured at tree-build time.
  const activeConnectionRef = useRef(activeConnection);
  activeConnectionRef.current = activeConnection;
  const currentDbRef = useRef(currentDb);
  currentDbRef.current = currentDb;
  const connectingRef = useRef<Set<string>>(new Set());
  const loadingDatabasesRef = useRef<Set<string>>(new Set());
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
  const beginConnect = (id: string) => {
    connectingRef.current.add(id);
    setConnectingConnectionIds(new Set(connectingRef.current));
  };
  const endConnect = (id: string) => {
    connectingRef.current.delete(id);
    setConnectingConnectionIds(new Set(connectingRef.current));
  };
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
  const [isCreateRoleOpen, setIsCreateRoleOpen] = useState(false);
  const [backupType, setBackupType] = useState<"sql-schema"|"sql-full"|"json"|"directory">("sql-schema");
  const [backupLoading, setBackupLoading] = useState(false);
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [backupStatus, setBackupStatus] = useState("");
  const [showImportExport, setShowImportExport] = useState(false);
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
  const [dragState, setDragState] = useState<{ kind: "connection" | "folder"; id: string } | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [dragOverRoot, setDragOverRoot] = useState(false);
  const autoExpandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
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
            element.style.outline = "2px solid var(--accent-9)";
            element.style.outlineOffset = "-2px";
            element.style.backgroundColor = "color-mix(in srgb, var(--accent-9), transparent 80%)";
            
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
      const isConnected = activeConnectionRef.current?.id === conn.id;

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
              const items = schemaItems || { tables: [], views: [], functions: [], triggers: [], indexes: [], sequences: [], types: [], procedures: [], operators: [], foreignTables: [] };
              const schemasMap: Record<string, { tables: string[], views: string[], functions: string[], triggers: string[], indexes: string[], sequences: string[], types: string[], procedures: string[], operators: string[], foreignTables: string[] }> = {};
              
              const treeCategories = ["tables", "views", "functions", "triggers", "indexes", "sequences", "types", "procedures", "operators", "foreignTables"] as const;
              
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
                  if (!schemasMap[schemaName]) schemasMap[schemaName] = { tables: [], views: [], functions: [], triggers: [], indexes: [], sequences: [], types: [], procedures: [], operators: [], foreignTables: [] };
                  if (schemasMap[schemaName][type]) {
                    schemasMap[schemaName][type].push(objName);
                  }
                });
              });
              
              const getTableChildren = (schemaName: string, tableName: string) => {
                const tableId = `${schemaName}.${tableName}`;
                const cacheKey = tableDetailsCacheKey(tableId);
                const details = cacheKey ? tableDetails[cacheKey] : undefined;
                const isLoading = cacheKey ? loadingTableDetails.has(cacheKey) : false;
                
                const children: TreeNode[] = [];
                
                // Always show Columns folder
                children.push({ 
                  id: `cols-${tableId}`, 
                  name: "Columns", 
                  icon: "folder",
                  children: (details?.columns?.length ?? 0) > 0 ? details!.columns!.map(c => ({
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
                    children: (details?.indexes?.length ?? 0) > 0 ? details!.indexes!.map(i => ({
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
                    children: (details?.triggers?.length ?? 0) > 0 ? details!.triggers!.map(t => ({
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
                  children: (details?.foreignKeys?.length ?? 0) > 0 ? details!.foreignKeys!.map(fk => ({
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
                if (settings.showTypes && sItems.types && sItems.types.length > 0) {
                  sNode.children!.push({ id: `types-${conn.id}-${db}-${schemaName}`, name: "Types", icon: "folder", children: sItems.types.map(t => ({ id: `type-${schemaName}.${t}`, name: t, icon: "type" })) });
                }
                if (settings.showProcedures && sItems.procedures && sItems.procedures.length > 0) {
                  sNode.children!.push({ id: `procs-${conn.id}-${db}-${schemaName}`, name: "Procedures", icon: "folder", children: sItems.procedures.map(p => ({ id: `proc-${schemaName}.${p}`, name: p, icon: "procedure" })) });
                }
                if (settings.showOperators && sItems.operators && sItems.operators.length > 0) {
                  sNode.children!.push({ id: `ops-${conn.id}-${db}-${schemaName}`, name: "Operators", icon: "folder", children: sItems.operators.map(o => ({ id: `op-${schemaName}.${o}`, name: o, icon: "operator" })) });
                }
                if (settings.showForeignTables && sItems.foreignTables && sItems.foreignTables.length > 0) {
                  sNode.children!.push({ id: `fts-${conn.id}-${db}-${schemaName}`, name: "Foreign Tables", icon: "folder", children: sItems.foreignTables.map(ft => ({ id: `ft-${schemaName}.${ft}`, name: ft, icon: "foreign_table" })) });
                }
                return sNode;
              });

              const hasEventTriggers = items.eventTriggers && items.eventTriggers.length > 0;
              const hasExtensions = items.extensions && items.extensions.length > 0;
              const hasLanguages = items.languages && items.languages.length > 0;

              dbChildren = [
                { id: `schemas-root-${conn.id}-${db}`, name: "Schemas", icon: "folder", children: schemaNodes },
              ];
              if (hasEventTriggers) {
                dbChildren.push({ id: `events-${conn.id}-${db}`, name: "Event Triggers", icon: "folder", children: items.eventTriggers!.map(t => ({ id: `evt-${conn.id}-${db}-${t}`, name: t, icon: "trigger" })) });
              }
              if (hasExtensions) {
                dbChildren.push({ id: `exts-${conn.id}-${db}`, name: "Extensions", icon: "folder", children: items.extensions!.map(e => ({ id: `ext-${conn.id}-${db}-${e}`, name: e, icon: "extension" })) });
              }
              if (hasLanguages) {
                dbChildren.push({ id: `langs-${conn.id}-${db}`, name: "Languages", icon: "folder", children: items.languages!.map(l => ({ id: `lang-${conn.id}-${db}-${l}`, name: l, icon: "language" })) });
              }
              if (["postgres", "supabase", "cockroach"].includes(conn.type) && tablespaces.length > 0) {
                dbChildren.push({
                  id: `store-${conn.id}-${db}`,
                  name: "Storage",
                  icon: "folder",
                  children: tablespaces.map(ts => ({
                    id: `tablespace-${conn.id}-${ts.name}`,
                    name: `${ts.name}  (${ts.size || '?'}, ${ts.owner})`,
                    icon: "tablespace"
                  }))
                });
              } else {
                dbChildren.push({ id: `store-${conn.id}-${db}`, name: "Storage", icon: "folder" });
              }
            }
          } else {
            // Not the active database - show placeholder structure
            const isPg = ["postgres", "supabase"].includes(conn.type);
            dbChildren = [
              { id: `schemas-root-${conn.id}-${db}`, name: "Schemas", icon: "folder", children: [] },
            ];
            if (isPg) {
              dbChildren.push({ id: `events-${conn.id}-${db}`, name: "Event Triggers", icon: "folder" });
              dbChildren.push({ id: `exts-${conn.id}-${db}`, name: "Extensions", icon: "folder" });
              dbChildren.push({ id: `langs-${conn.id}-${db}`, name: "Languages", icon: "folder" });
            }
            dbChildren.push({ id: `store-${conn.id}-${db}`, name: "Storage", icon: "folder" });
          }

          return {
            id: `db-${conn.id}-${db}`,
            name: db,
            icon: "database",
            children: dbChildren,
            action: async () => {
              const dbKey = `db-${conn.id}-${db}`;
              if (loadingDatabasesRef.current.has(dbKey)) return;
              loadingDatabasesRef.current.add(dbKey);
              // If not active, connect and load schema
              setLoadingDatabases(prev => new Set(prev).add(dbKey));
              try {
                if (!isDbActive) {
                  await connectToDatabase(conn.id, db);
                } else if (!schemaItems) {
                  await loadSchema(db);
                }
              } finally {
                loadingDatabasesRef.current.delete(dbKey);
                setLoadingDatabases(prev => {
                  const next = new Set(prev);
                  next.delete(dbKey);
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

        // Add Login/Group Roles at server level for PostgreSQL connections (pgAdmin style)
        if (["postgres", "supabase", "cockroach"].includes(conn.type)) {
          const loginChildren: TreeNode[] = roles.login.map(r => ({ id: `login-role-${conn.id}-${r}`, name: r, icon: "login_role" }));
          const groupChildren: TreeNode[] = roles.group.map(r => ({ id: `group-role-${conn.id}-${r}`, name: r, icon: "group_role" }));
          const roleChildren: TreeNode[] = [];
          if (loginChildren.length > 0) {
            roleChildren.push({ id: `login-roles-${conn.id}`, name: "Login Roles", icon: "folder", children: loginChildren, contextMenuId: `login-roles-${conn.id}` });
          }
          if (groupChildren.length > 0) {
            roleChildren.push({ id: `group-roles-${conn.id}`, name: "Group Roles", icon: "folder", children: groupChildren });
          }
          if (roleChildren.length > 0) {
            connChildren.push({
              id: `roles-root-${conn.id}`,
              name: "Login/Group Roles",
              icon: "folder",
              children: roleChildren
            });
          }
        }
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
          // Read activeConnectionRef at call time, not tree-build time, so
          // switching between servers always sees the actual connected state.
          if (activeConnectionRef.current?.id !== conn.id || !currentDbRef.current) {
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
  }, [connections, activeConnection, selectedDatabase, settings, schemaItems, databases, isLoadingSchema, loadingDatabases, tableDetails, loadingTableDetails, viewMode, folders, roles, tablespaces]);

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
  
  // Cache keys are scoped by connection+database so a `public.users` table in
  // connection A doesn't share metadata with a same-named table in connection B
  // (or in a different database on the same connection). Without this scoping
  // the cache could hand back stale `columnTypes` for a different schema.
  const tableDetailsCacheKey = (tableId: string): string | null => {
    if (!activeConnection || !selectedDatabase) return null;
    return `${activeConnection.id}::${selectedDatabase}::${tableId}`;
  };

  const loadTableDetails = async (tableId: string): Promise<TableDetails | undefined> => {
    const key = tableDetailsCacheKey(tableId);
    if (!key) return undefined;
    if (tableDetails[key]) return tableDetails[key];
    if (loadingTableDetails.has(key)) return undefined;
    let schemaName = 'public';
    let tableName = tableId;
    if (tableId.includes('.')) {
      const parts = tableId.split('.');
      schemaName = parts[0];
      tableName = parts.slice(1).join('.');
    }

    if (!activeConnection || !currentDb) return undefined;

    setLoadingTableDetails(prev => new Set(prev).add(key));
    
    try {
      const details: TableDetails = { columns: [], constraints: [], foreignKeys: [], indexes: [], triggers: [] };
      
      if (["postgres", "supabase", "cockroach"].includes(activeConnection.type)) {
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
      } else if (["mysql", "mariadb"].includes(activeConnection.type)) {
        const cols = await currentDb.select(`
          SELECT column_name, data_type, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = ?
          ORDER BY ordinal_position
        `, [tableName]);
        details.columns = cols.map((c: any) => ({
          name: c.column_name,
          type: c.data_type,
          nullable: c.is_nullable === 'YES',
          default: c.column_default,
        }));

        const idxs = await currentDb.select(`SHOW INDEX FROM ${quoteIdentifier(tableName, activeConnection.type)}`);
        const idxMap: Record<string, { columns: string[]; unique: boolean }> = {};
        for (const idx of idxs) {
          if (!idxMap[idx.Key_name]) {
            idxMap[idx.Key_name] = { columns: [], unique: idx.Non_unique === 0 };
          }
          idxMap[idx.Key_name].columns.push(idx.Column_name);
        }
        details.indexes = Object.entries(idxMap).map(([name, info]) => ({
          name,
          columns: info.columns,
          unique: info.unique,
        }));

        const trgs = await currentDb.select(`
          SELECT trigger_name
          FROM information_schema.triggers
          WHERE event_object_schema = DATABASE() AND event_object_table = ?
        `, [tableName]);
        details.triggers = trgs.map((t: any) => t.trigger_name);

        const fks = await currentDb.select(`
          SELECT kcu.column_name, kcu.referenced_table_name, kcu.referenced_column_name
          FROM information_schema.key_column_usage kcu
          JOIN information_schema.table_constraints tc
            ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema
          WHERE tc.constraint_type = 'FOREIGN KEY' AND kcu.table_schema = DATABASE() AND kcu.table_name = ?
        `, [tableName]);
        const fkMap: Record<string, { columns: string[]; refTable: string; refColumns: string[] }> = {};
        for (const fk of fks) {
          const conName = `${fk.column_name}_${fk.referenced_table_name}`;
          if (!fkMap[conName]) {
            fkMap[conName] = { columns: [], refTable: fk.referenced_table_name, refColumns: [] };
          }
          fkMap[conName].columns.push(fk.column_name);
          fkMap[conName].refColumns.push(fk.referenced_column_name);
        }
        details.foreignKeys = Object.values(fkMap);

        const cons = await currentDb.select(`
          SELECT constraint_name, constraint_type
          FROM information_schema.table_constraints
          WHERE table_schema = DATABASE() AND table_name = ?
        `, [tableName]);
        details.constraints = cons.map((c: any) => ({
          name: c.constraint_name,
          type: c.constraint_type,
          definition: '',
        }));
      } else if (activeConnection.type === "sqlite") {
        const quotedTable = quoteIdentifier(tableName, activeConnection.type);

        const cols = await currentDb.select(`PRAGMA table_info(${quotedTable})`);
        details.columns = cols.map((c: any) => ({
          name: c.name,
          type: c.type || 'TEXT',
          nullable: c.notnull === 0,
          default: c.dflt_value,
        }));

        const idxs = await currentDb.select(`PRAGMA index_list(${quotedTable})`);
        for (const idx of idxs) {
          const idxInfo = await currentDb.select(`PRAGMA index_info(${quoteIdentifier(idx.name, activeConnection.type)})`);
          details.indexes.push({
            name: idx.name,
            columns: idxInfo.map((i: any) => i.name),
            unique: idx.unique === 1,
          });
        }

        const trgs = await currentDb.select("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = $1", [tableName]);
        details.triggers = trgs.map((t: any) => t.name);

        const fks = await currentDb.select(`PRAGMA foreign_key_list(${quotedTable})`);
        const fkMap: Record<string, { columns: string[]; refTable: string; refColumns: string[] }> = {};
        for (const fk of fks) {
          const conName = `${fk.from}_${fk.table}`;
          if (!fkMap[conName]) {
            fkMap[conName] = { columns: [], refTable: fk.table, refColumns: [] };
          }
          fkMap[conName].columns.push(fk.from);
          fkMap[conName].refColumns.push(fk.to);
        }
        details.foreignKeys = Object.values(fkMap);
      }
      
      setTableDetails(prev => ({ ...prev, [key]: details }));
      return details;
    } catch (e) {
      console.error("Failed to load table details:", e);
      return undefined;
    } finally {
      setLoadingTableDetails(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const handleConnect = async (conn: DatabaseConnection) => {
    if (connectingRef.current.has(conn.id)) return;
    // Auto-expand the server node after successful connection
    const expandServerNode = () => {
      setExpandedNodes(prev => {
        const next = new Set(prev);
        next.add(`conn-${conn.id}`);
        return next;
      });
    };

    // If we have a vaultCredentialId already, just connect
    if (conn.vaultCredentialId) {
      beginConnect(conn.id);
      try {
        await connectToDatabase(conn.id);
        expandServerNode();
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
          expandServerNode();
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
      expandServerNode();
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
        setIsCreateRoleOpen(false);
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

  const isLeafSchemaItem = (icon: string) => ["table", "view", "function", "trigger", "index", "type", "procedure", "operator", "foreign_table", "language", "extension", "tablespace", "login_role", "group_role"].includes(icon);
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
    } else if (name.includes("procedure")) {
      return `CREATE OR REPLACE PROCEDURE new_procedure()\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  -- procedure body\nEND;\n$$;`;
    } else if (name.includes("operator")) {
      return `CREATE OPERATOR !! (\n  FUNCTION = function_name,\n  LEFTARG = integer,\n  RIGHTARG = integer\n);`;
    } else if (name.includes("foreign table")) {
      return `CREATE FOREIGN TABLE new_foreign_table (\n  id INTEGER,\n  name TEXT\n)\nSERVER foreign_server\nOPTIONS (schema_name 'public', table_name 'remote_table');`;
    } else if (name.includes("tablespace") || name.includes("storage")) {
      return `CREATE TABLESPACE new_tablespace\n  OWNER postgres\n  LOCATION '/path/to/data_directory';`;
    } else if (name.includes("database")) {
      return `-- Template for Create Database\nCREATE DATABASE new_database\n  WITH \n  OWNER = postgres\n  TEMPLATE = template1\n  ENCODING = 'UTF8'\n  LC_COLLATE = 'en_US.utf8'\n  LC_CTYPE = 'en_US.utf8'\n  TABLESPACE = pg_default\n  CONNECTION LIMIT = -1\n  IS_TEMPLATE = False;`;
    }
    return null;
  };

  /** True when cursor is over a row that is a valid drop target. */
  const isValidDropTarget = (node: TreeNode): boolean => {
    if (!dragState) return false;
    const nodeContextId = node.contextMenuId;
    if (!nodeContextId) return false;
    // Only folders are valid drop targets
    if (!nodeContextId.startsWith("folder:")) return false;
    // Can't drop onto yourself
    if (dragState.kind === "connection" && nodeContextId === `folder:${dragState.id}`) return false;
    // Folders can't be dropped onto themselves or their descendants (cycle prevention)
    if (dragState.kind === "folder") {
      if (nodeContextId === `folder:${dragState.id}`) return false;
      if (descendantFolderIds(dragState.id, folders).has(node.id.replace("folder-", ""))) return false;
    }
    return true;
  };

  const handleDragStart = (e: React.DragEvent, node: TreeNode) => {
    const ctxId = node.contextMenuId;
    if (!ctxId) return;
    const isFolder = ctxId.startsWith("folder:");
    const kind = isFolder ? "folder" : "connection";
    const id = isFolder ? ctxId.replace("folder:", "") : ctxId;
    setDragState({ kind, id });
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", JSON.stringify({ kind, id }));
  };

  const handleDragEnd = () => {
    if (autoExpandTimerRef.current) {
      clearTimeout(autoExpandTimerRef.current);
      autoExpandTimerRef.current = null;
    }
    setDragState(null);
    setDropTargetId(null);
    setDragOverRoot(false);
  };

  const handleDragOver = (e: React.DragEvent, node: TreeNode) => {
    if (!dragState) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOverRoot(false);
    setDropTargetId((prev) => (prev === node.id ? prev : node.id));

    // Auto-expand: 600ms timer on collapsed expandable folders
    const isCollapsibleFolder = node.contextMenuId?.startsWith("folder:");
    const isCollapsed = !expandedNodes.has(node.id);
    const hasChildNodes = node.children && node.children.length > 0;
    if (isCollapsibleFolder && isCollapsed && hasChildNodes) {
      if (!autoExpandTimerRef.current) {
        autoExpandTimerRef.current = setTimeout(() => {
          autoExpandTimerRef.current = null;
          toggleExpand(node.id);
        }, 600);
      }
    } else {
      if (autoExpandTimerRef.current) {
        clearTimeout(autoExpandTimerRef.current);
        autoExpandTimerRef.current = null;
      }
    }

    if (!isValidDropTarget(node)) {
      e.dataTransfer.dropEffect = "none";
      return;
    }
    e.dataTransfer.dropEffect = "move";
  };

  const handleDragLeave = (e: React.DragEvent) => {
    // Only clear if actually leaving the node (not entering a child)
    if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropTargetId(null);
      if (autoExpandTimerRef.current) {
        clearTimeout(autoExpandTimerRef.current);
        autoExpandTimerRef.current = null;
      }
    }
  };

  const handleDrop = async (e: React.DragEvent, node: TreeNode) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTargetId(null);
    setDragOverRoot(false);
    if (autoExpandTimerRef.current) {
      clearTimeout(autoExpandTimerRef.current);
      autoExpandTimerRef.current = null;
    }
    if (!dragState) return;
    const ctxId = node.contextMenuId;
    if (!ctxId || !ctxId.startsWith("folder:")) return;
    const targetFolderId = ctxId.replace("folder:", "");
    if (dragState.kind === "connection") {
      await moveConnectionToFolder(dragState.id, targetFolderId);
    } else if (dragState.kind === "folder") {
      if (dragState.id === targetFolderId) return;
      if (descendantFolderIds(dragState.id, folders).has(targetFolderId)) return;
      await moveFolder(dragState.id, targetFolderId);
    }
    setDragState(null);
  };

  const handleRootDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDropTargetId(null);
    setDragOverRoot(false);
    if (autoExpandTimerRef.current) {
      clearTimeout(autoExpandTimerRef.current);
      autoExpandTimerRef.current = null;
    }
    if (!dragState) return;
    // Drop to root: parentId = null
    if (dragState.kind === "connection") {
      await moveConnectionToFolder(dragState.id, null);
    } else if (dragState.kind === "folder") {
      await moveFolder(dragState.id, null);
    }
    setDragState(null);
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
      const tableDetailCacheKey = tableDetailId !== node.id ? tableDetailsCacheKey(tableDetailId) : null;
      const isTableDetailsLoading = node.icon === "folder" && !!tableDetailCacheKey && loadingTableDetails.has(tableDetailCacheKey);

      /** Only user-created folders (those with a "folder:" contextMenuId)
       *  are valid drop targets. Schema-level "folder" nodes like Tables,
       *  Views, Columns are not. */
      const isUserFolderNode = (node.contextMenuId?.startsWith("folder:")) ?? false;
      const isServerNode = node.icon === "server" && !!node.contextMenuId;
      /** Drag sources: both user folders and server connections. */
      const isDragSource = isUserFolderNode || isServerNode;
      /** Drop targets: only user folders. */
      const isDropTarget = isUserFolderNode;
      const isValid = isDropTarget && isValidDropTarget(node) && dropTargetId === node.id;
      const isInvalid = isDropTarget && !isValid && dropTargetId === node.id;

      return (
        <div
          key={node.id}
          data-node-id={node.id}
          onDragOver={isDropTarget ? (e) => { handleDragOver(e, node); } : undefined}
          onDragLeave={isDropTarget ? handleDragLeave : undefined}
          onDrop={isDropTarget ? (e) => { handleDrop(e, node); } : undefined}
          className={isValid || isInvalid ? "relative" : undefined}
        >
          {isValid && (
            <div className="absolute inset-0 rounded border-2 border-dashed border-[var(--accent-8)] pointer-events-none z-10" />
          )}
          {isInvalid && (
            <div className="absolute inset-0 rounded border-2 border-solid border-[var(--danger-8)] bg-[var(--danger-3)]/30 pointer-events-none z-10" />
          )}
          <button
            draggable={isDragSource}
            onDragStart={isDragSource ? (e) => { handleDragStart(e, node); } : undefined}
            onDragEnd={isDragSource ? handleDragEnd : undefined}
            onClick={async () => {
              // Left click: expand/collapse folders, trigger action for database and server
              if ((node.icon === "database" || node.icon === "server") && node.action) {
                node.action();
              }
              // Always toggle expand for server nodes so the user sees
              // immediate visual feedback even before children are loaded.
              if (hasChildren || isFolder || node.icon === "server") {
                toggleExpand(node.id);
              }
              if (node.icon === "table") {
                const fullTableName = node.id.startsWith("table-") ? node.id.replace("table-", "") : node.name;
                const query = `SELECT * FROM ${fullTableName} LIMIT 50`;
                // Issue #51: ensure the table's column types are loaded so the
                // data grid can pick the date/time overlay editor by real SQL
                // type instead of by column-name substring. `loadTableDetails`
                // returns the cached/freshly-loaded details so we don't have to
                // wait for a re-render to read them from state.
                const details = await loadTableDetails(fullTableName);
                const columnTypes: Record<string, string> | undefined = details
                  ? Object.fromEntries(details.columns.map(c => [c.name, c.type]))
                  : undefined;
                window.dispatchEvent(new CustomEvent("run-specific-query", {
                  detail: { query, name: fullTableName, lineNumber: 1, columnTypes }
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
              isDragSource ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
            } ${
              focusedNodeId === node.id
                ? "bg-[var(--accent-3)] ring-1 ring-inset ring-[var(--accent-6)]"
                : node.icon === "server" && node.color
                  ? "hover:brightness-110"
                  : "hover:bg-[var(--surface-elevated)]"
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
              }
              if (hasChildren || isFolder || node.icon === "server") toggleExpand(node.id);
            }}
          >
            {hasChildren || isFolder ? (
              <span onClick={(e) => { e.stopPropagation(); toggleExpand(node.id); }} className="hover:bg-[var(--neutral-5)] rounded text-[var(--neutral-11)]">
                {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              </span>
            ) : (
              <span className="w-3" />
            )}
            {isDbLoading || isServerConnecting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--accent-9)] shrink-0" />
            ) : (
              <span className="hover:bg-[var(--neutral-4)] rounded p-0.5 shrink-0 flex items-center justify-center">
                {getIcon(node.icon, isExpanded, node.providerType, node.color)}
              </span>
            )}
            <span className={`truncate ${node.icon === 'server' ? 'text-[var(--neutral-12)] font-bold' : node.icon === 'database' ? 'text-[var(--neutral-11)] font-semibold' : 'text-[var(--neutral-12)] opacity-90'}`}>
              {node.name}
              {node.icon === 'server' && activeConnection?.id === node.contextMenuId && <span className="ml-2 inline-block w-1.5 h-1.5 bg-[var(--success-9)] rounded-full" title="Connected" />}
            </span>
            {(isSchemaLoading || isSchemasLoading || isTableDetailsLoading) && (
              <Loader2 className="w-3 h-3 animate-spin ml-auto text-[var(--neutral-11)] shrink-0" />
            )}
            {hasChildren && !(isSchemaLoading || isSchemasLoading || isTableDetailsLoading) && (
              <span className="text-[10px] text-[var(--neutral-11)] ml-auto">{node.children?.length}</span>
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
    if (activeSubmenu || contextMenu || schemaContextMenu || isAddConnectionDialogOpen || showEditDialog || backupDialogOpen || restoreDialogOpen || isCreateTableOpen || isCreateDatabaseOpen || isCreateRoleOpen || showSchemaDialog) return;

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
      case "type": return <Code className="w-3.5 h-3.5 text-cyan-400" />;
      case "function": return <Variable className="w-3.5 h-3.5 text-red-400" />;
      case "procedure": return <Terminal className="w-3.5 h-3.5 text-red-400" />;
      case "operator": return <Plus className="w-3.5 h-3.5 text-orange-400" />;
      case "foreign_table": return <Database className="w-3.5 h-3.5 text-indigo-400" />;
      case "language": return <Terminal className="w-3.5 h-3.5 text-pink-400" />;
      case "extension": return <Server className="w-3.5 h-3.5 text-teal-400" />;
      case "tablespace": return <HardDrive className="w-3.5 h-3.5 text-amber-400" />;
      case "login_role": return <User className="w-3.5 h-3.5 text-green-400" />;
      case "group_role": return <Users className="w-3.5 h-3.5 text-blue-400" />;
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
      <div className="p-2 border-b border-[var(--neutral-6)]">
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
              <IconButton
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setViewModeMenuOpen((v) => !v);
                }}
                className={viewModeMenuOpen ? "bg-[var(--accent-3)] text-[var(--accent-11)] hover:bg-[var(--accent-4)]" : undefined}
                title="View mode + new folder"
                label="View mode + new folder"
                icon={<FolderOpen />}
              />
              {viewModeMenuOpen && (
                <div
                  className="absolute right-0 top-full mt-1 z-50 min-w-[180px] bg-[var(--surface-overlay)] border border-[var(--neutral-6)] rounded-lg shadow-xl py-1"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-[var(--neutral-11)] opacity-60">
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
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--neutral-4)] cursor-pointer"
                      >
                        <span
                          className={`w-3 h-3 rounded-full border-2 shrink-0 flex items-center justify-center ${
                            selected
                              ? "border-[var(--accent-9)]"
                              : "border-[var(--neutral-8)]"
                          }`}
                        >
                          {selected && (
                            <span className="block w-1 h-1 rounded-full bg-[var(--accent-9)]" />
                          )}
                        </span>
                        <span>{opt.label}</span>
                      </button>
                    );
                  })}
                  <div className="h-px bg-[var(--neutral-6)] my-1" />
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
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--neutral-4)] cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5 text-[var(--neutral-11)]" />
                    New folder…
                  </button>
                </div>
              )}
            </div>

            <IconButton
              size="sm"
              onClick={() => setShowImportExport(true)}
              title="Import / Export Connections"
              label="Import / Export Connections"
              icon={<Upload />}
            />
            <IconButton
              size="sm"
              onClick={() => {
                let folderId: string | undefined;
                if (focusedNodeId?.startsWith("folder-")) {
                  folderId = focusedNodeId.slice("folder-".length);
                }
                window.dispatchEvent(new CustomEvent("open-new-connection", { detail: { folderId } }));
              }}
              title="Add Connection"
              label="Add Connection"
              icon={<Plus />}
            />
          </div>
        </div>
        <div className="relative flex gap-1">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-[var(--neutral-11)]" />
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
              className="w-full pl-7 pr-2 py-1 text-xs rounded bg-[var(--surface-base)] border border-[var(--neutral-6)] outline-none focus:border-[var(--accent-8)] text-[var(--neutral-12)] placeholder:text-[var(--neutral-9)]"
            />
          </div>
          <Button
            size="xs"
            onClick={() => { handleJumpToSearch(); }}
            className="font-bold bg-[var(--accent-3)] text-[var(--accent-11)] border border-[var(--accent-6)] hover:bg-[var(--accent-4)]"
          >
            GO
          </Button>
        </div>
      </div>

      <div className="h-0 min-h-0 flex-1 overflow-hidden">
        <div 
          ref={treeContainerRef}
          tabIndex={0}
          onKeyDown={handleTreeKeyDown}
          onDragOver={(e) => {
            if (dragState) {
              e.preventDefault();
              setDragOverRoot(true);
              setDropTargetId("__root__");
            }
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) {
              setDragOverRoot(false);
              setDropTargetId(prev => prev === "__root__" ? null : prev);
            }
          }}
          onDrop={handleRootDrop}
          className="w-full h-full overflow-y-auto pt-1 bg-[var(--surface-panel)] scrollbar-thin outline-none focus:ring-1 focus:ring-[var(--accent-8)]/30"
        >
          {schemaTree.length > 0 ? (
            renderTree(schemaTree)
          ) : !initialLoadDone ? (
            <div className="p-4 text-center text-xs text-[var(--neutral-11)] flex flex-col items-center">
              <Loader2 className="w-6 h-6 mb-2 opacity-50 animate-spin" />
              <p>Loading connections...</p>
            </div>
          ) : (
            <div className="p-4 text-center text-xs text-[var(--neutral-11)] flex flex-col items-center">
              <Database className="w-6 h-6 mb-2 opacity-50" />
              <p>No connections configured</p>
              <button
                 onClick={() => window.dispatchEvent(new CustomEvent("open-new-connection"))}
                 className="mt-2 text-[var(--accent-11)] hover:underline cursor-pointer"
              >
                 Add a connection
              </button>
            </div>
          )}

          {dragOverRoot && dragState && (
            <div className="sticky bottom-0 mx-2 mb-2 p-3 text-center text-xs text-[var(--accent-11)] border-2 border-dashed border-[var(--accent-8)] rounded bg-[var(--accent-3)]/40">
              Drop here to move to top level
            </div>
          )}
        </div>
      </div>

      {/* Loading Status Bar */}
      {isLoading && (
        <div className="flex flex-col">
          <div className="h-1 bg-[var(--surface-elevated)] overflow-hidden">
            <div
              className="h-full bg-[var(--accent-9)] animate-pulse"
              style={{ width: "100%" }}
            />
          </div>
          <div className="px-2 py-1.5 bg-[var(--surface-panel)] border-t border-[var(--neutral-6)] text-[10px] flex items-center gap-2">
            <Loader2 className="w-3 h-3 animate-spin text-[var(--accent-9)]" />
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
        <Menu x={contextMenu.x} y={contextMenu.y} className="w-auto min-w-[180px]">
          {(() => {
            const folderId = contextMenu.connectionId.slice("folder:".length);
            const folder = folders.find((f) => f.id === folderId);
            if (!folder) return null;
            return (
              <>
                <MenuItem
                  icon={<Edit2 className="w-3 h-3" />}
                  onClick={async () => {
                    const name = window.prompt("Rename folder", folder.name);
                    if (name && name.trim()) {
                      await renameFolder(folderId, name);
                    }
                    closeContextMenu();
                  }}
                >
                  Rename
                </MenuItem>
                <MenuItem
                  icon={<Plus className="w-3 h-3" />}
                  onClick={async () => {
                    const name = window.prompt("New subfolder name");
                    if (name && name.trim()) {
                      await addFolder(name, folderId);
                      // Open the parent so the new subfolder is visible.
                      setExpandedNodes((prev) => new Set(prev).add(`folder-${folderId}`));
                    }
                    closeContextMenu();
                  }}
                >
                  New subfolder
                </MenuItem>
                <MenuItem
                  icon={<Database className="w-3 h-3" />}
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent("open-new-connection", { detail: { folderId } }));
                    closeContextMenu();
                  }}
                >
                  New connection
                </MenuItem>
                <MenuItem
                  icon={<FolderOpen className="w-3 h-3" />}
                  onClick={() => {
                    setMoveTarget({ kind: "folder", id: folderId, name: folder.name });
                    closeContextMenu();
                  }}
                >
                  Move to folder…
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  tone="danger"
                  icon={<Trash2 className="w-3 h-3" />}
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
                >
                  Delete folder
                </MenuItem>
              </>
            );
          })()}
        </Menu>
      )}
      {contextMenu && contextMenu.connectionId.startsWith("login-roles-") && (
        <Menu x={contextMenu.x} y={contextMenu.y} className="w-auto min-w-[180px]">
          <MenuLabel>Login Roles</MenuLabel>
          <MenuItem
            tone="success"
            icon={<Plus className="w-3 h-3" />}
            onClick={() => {
              setIsCreateRoleOpen(true);
              closeContextMenu();
            }}
          >
            Create Login Role...
          </MenuItem>
        </Menu>
      )}
      {contextMenu && !contextMenu.connectionId.startsWith("folder:") && !contextMenu.connectionId.startsWith("login-roles-") && (
        <Menu x={contextMenu.x} y={contextMenu.y} className="w-auto min-w-[160px]">
          <MenuItem
            icon={<Play className="w-3 h-3" />}
            onClick={() => {
              const conn = connections.find(c => c.id === contextMenu.connectionId);
              if (conn) handleConnect(conn);
              closeContextMenu();
            }}
          >
            Connect
          </MenuItem>
          <MenuItem
            icon={<Edit2 className="w-3 h-3" />}
            onClick={() => {
              const conn = connections.find(c => c.id === contextMenu.connectionId);
              if (conn) handleEdit(conn);
            }}
          >
            Edit
          </MenuItem>
          {viewMode === "folders" && (
            <MenuItem
              icon={<FolderOpen className="w-3 h-3" />}
              onClick={() => {
                const conn = connections.find((c) => c.id === contextMenu.connectionId);
                if (conn) {
                  setMoveTarget({ kind: "connection", id: conn.id, name: conn.name });
                }
                closeContextMenu();
              }}
            >
              Move to folder…
            </MenuItem>
          )}
          <MenuItem
            tone="danger"
            icon={<Trash2 className="w-3 h-3" />}
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
          >
            Delete
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<Plus className="w-3 h-3" />}
            onClick={() => {
              // We need to ensure we're connected to something to fetch owners/templates
              // But for now, we can just open it
              setIsCreateDatabaseOpen(true);
              closeContextMenu();
            }}
          >
            Create Database...
          </MenuItem>
        </Menu>
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
        <Menu x={schemaContextMenu.x} y={schemaContextMenu.y} className="w-auto min-w-[160px]">
          {/* Database folder specific items if any (removed duplicate Create Database) */}

          {schemaContextMenu.node.icon === "database" && (
            <>
              <MenuItem
                icon={<Terminal className="w-3 h-3" />}
                onClick={() => {
                  window.dispatchEvent(new CustomEvent("open-query-window", {
                    detail: { connectionId: activeConnection?.id, connectionName: activeConnection?.name, database: schemaContextMenu.node.name }
                  }));
                  closeContextMenu();
                }}
              >
                Open SQL Editor
              </MenuItem>
              <MenuItem
                icon={<Terminal className="w-3 h-3" />}
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
              >
                Open PSQL (Console)
              </MenuItem>
              <MenuItem
                icon={<Zap className="w-3 h-3" />}
                onClick={() => {
                  loadSchema(selectedDatabase || "");
                  closeContextMenu();
                }}
              >
                Refresh Schema
              </MenuItem>
              <MenuItem
                icon={<Database className="w-3 h-3" />}
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
              >
                Select Schemas...
              </MenuItem>

              <MenuSeparator />

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
                <div className="w-full flex items-center justify-between px-3 py-1.5 text-xs hover:bg-[var(--neutral-4)] cursor-default transition-colors">
                  <div className="flex items-center gap-2">
                    <Plus className="w-3 h-3" /> Create
                  </div>
                  <ChevronRight className="w-3 h-3 opacity-50" />
                </div>

                {activeSubmenu === "create" && (
                  <div
                    className="absolute left-full top-0 ml-[-4px] bg-[var(--surface-overlay)] border border-[var(--neutral-6)] rounded-lg shadow-xl py-1 min-w-[180px] animate-in fade-in slide-in-from-left-2 duration-150 z-[60] submenu-panel"
                    onMouseEnter={() => setActiveSubmenu("create")}
                  >
                    <MenuItem
                      icon={<Table className="w-3 h-3" />}
                      onClick={() => {
                        setCreateTableTarget({ schema: 'public' });
                        setIsCreateTableOpen(true);
                        closeContextMenu();
                      }}
                    >
                      Table
                    </MenuItem>
                    <MenuItem
                      icon={<Eye className="w-3 h-3" />}
                      onClick={() => {
                        window.dispatchEvent(new CustomEvent("open-query-with-text", {
                          detail: { query: getCreateTemplate("Views") || "", name: "New View" }
                        }));
                        closeContextMenu();
                      }}
                    >
                      View
                    </MenuItem>
                    <MenuItem
                      icon={<Variable className="w-3 h-3" />}
                      onClick={() => {
                        window.dispatchEvent(new CustomEvent("open-query-with-text", {
                          detail: { query: getCreateTemplate("Functions") || "", name: "New Function" }
                        }));
                        closeContextMenu();
                      }}
                    >
                      Function
                    </MenuItem>
                    <MenuItem
                      icon={<Zap className="w-3 h-3" />}
                      onClick={() => {
                        window.dispatchEvent(new CustomEvent("open-query-with-text", {
                          detail: { query: getCreateTemplate("Triggers") || "", name: "New Trigger" }
                        }));
                        closeContextMenu();
                      }}
                    >
                      Trigger
                    </MenuItem>
                    <MenuItem
                      icon={<Hash className="w-3 h-3" />}
                      onClick={() => {
                        window.dispatchEvent(new CustomEvent("open-query-with-text", {
                          detail: { query: getCreateTemplate("Indexes") || "", name: "New Index" }
                        }));
                        closeContextMenu();
                      }}
                    >
                      Index
                    </MenuItem>
                    <MenuItem
                      icon={<Server className="w-3 h-3" />}
                      onClick={() => {
                        window.dispatchEvent(new CustomEvent("open-query-with-text", {
                          detail: { query: getCreateTemplate("Schemas") || "", name: "New Schema" }
                        }));
                        closeContextMenu();
                      }}
                    >
                      Schema
                    </MenuItem>
                    <MenuItem
                      icon={<Hash className="w-3 h-3" />}
                      onClick={() => {
                        window.dispatchEvent(new CustomEvent("open-query-with-text", {
                          detail: { query: getCreateTemplate("Sequences") || "", name: "New Sequence" }
                        }));
                        closeContextMenu();
                      }}
                    >
                      Sequence
                    </MenuItem>
                    <MenuItem
                      icon={<Variable className="w-3 h-3" />}
                      onClick={() => {
                        window.dispatchEvent(new CustomEvent("open-query-with-text", {
                          detail: { query: getCreateTemplate("Types") || "", name: "New Type" }
                        }));
                        closeContextMenu();
                      }}
                    >
                      Type
                    </MenuItem>

                    <MenuSeparator />

                    <MenuItem
                      icon={<Database className="w-3 h-3" />}
                      onClick={() => {
                        setIsCreateDatabaseOpen(true);
                        closeContextMenu();
                      }}
                    >
                      Database (New)
                    </MenuItem>
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
                <div className="w-full flex items-center justify-between px-3 py-1.5 text-xs hover:bg-[var(--neutral-4)] cursor-default transition-colors">
                  <div className="flex items-center gap-2">
                    <Check className="w-3 h-3" /> Tools
                  </div>
                  <ChevronRight className="w-3 h-3 opacity-50" />
                </div>

                {activeSubmenu === "tools" && (
                  <div
                    className="absolute left-full top-0 ml-[-4px] bg-[var(--surface-overlay)] border border-[var(--neutral-6)] rounded-lg shadow-xl py-1 min-w-[140px] animate-in fade-in slide-in-from-left-2 duration-150 z-[60] submenu-panel"
                    onMouseEnter={() => setActiveSubmenu("tools")}
                  >
                    <MenuItem
                      icon={<Download className="w-3 h-3" />}
                      onClick={() => {
                        const nodeId = schemaContextMenu.node.id;
                        const dbName = schemaContextMenu.node.name;
                        const conn = activeConnection;
                        const connId = conn?.id || nodeId.split("-")[1] || "";
                        setBackupTarget({ connId, dbName, connName: conn?.name || dbName });
                        setBackupDialogOpen(true);
                        closeContextMenu();
                      }}
                    >
                      Backup
                    </MenuItem>
                    <MenuItem
                      icon={<Upload className="w-3 h-3" />}
                      onClick={() => {
                        const nodeId = schemaContextMenu.node.id;
                        const dbName = schemaContextMenu.node.name;
                        const conn = activeConnection;
                        const connId = conn?.id || nodeId.split("-")[1] || "";
                        setBackupTarget({ connId, dbName, connName: conn?.name || dbName });
                        setRestoreDialogOpen(true);
                        closeContextMenu();
                      }}
                    >
                      Restore
                    </MenuItem>
                  </div>
                )}
              </div>

              <MenuSeparator />

              <MenuItem
                icon={<Columns className="w-3 h-3 opacity-70" />}
                onClick={() => {
                  navigator.clipboard.writeText(schemaContextMenu.node.name);
                  closeContextMenu();
                }}
              >
                Copy Database Name
              </MenuItem>

              <MenuItem
                tone="danger"
                icon={<Trash2 className="w-3 h-3" />}
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
              >
                Drop Database
              </MenuItem>
            </>
          )}

          {schemaContextMenu.node.id.startsWith("schemas-root-") && (
            <MenuLabel bordered>
              {schemaContextMenu.node.icon} — {schemaContextMenu.node.name}
            </MenuLabel>
          )}
          
          {/* Leaf schema items: DDL, SQL statements */}
          {isLeafSchemaItem(schemaContextMenu.node.icon) && (
            <>
              <MenuItem
                icon={<Code className="w-3 h-3" />}
                onClick={async () => {
                  const ddl = await getDDL(schemaContextMenu.node.icon, schemaContextMenu.node.name);
                  window.dispatchEvent(new CustomEvent("open-query-with-text", {
                    detail: { query: ddl, name: `DDL ${schemaContextMenu.node.name}` }
                  }));
                  closeContextMenu();
                }}
              >
                Show DDL
              </MenuItem>

              {(schemaContextMenu.node.icon === "table" || schemaContextMenu.node.icon === "view") && (
                <MenuItem
                  icon={<Search className="w-3 h-3" />}
                  onClick={async () => {
                    const fullTableName = schemaContextMenu.node.id.replace(/^(table|view)-/, "");
                    const sql = await generateStatement("select", fullTableName);
                    // Issue #51: pass column SQL types so the grid picks the
                    // date/time overlay editor by type rather than by name.
                    const details = await loadTableDetails(fullTableName);
                    const columnTypes: Record<string, string> | undefined = details
                      ? Object.fromEntries(details.columns.map(c => [c.name, c.type]))
                      : undefined;
                    window.dispatchEvent(new CustomEvent("run-specific-query", {
                      detail: { query: sql, name: fullTableName, lineNumber: 1, columnTypes }
                    }));
                    closeContextMenu();
                  }}
                >
                  Select Top 100
                </MenuItem>
              )}

              {(schemaContextMenu.node.icon === "login_role" || schemaContextMenu.node.icon === "group_role") && (
                <MenuItem
                  tone="danger"
                  icon={<Trash2 className="w-3 h-3" />}
                  onClick={async () => {
                    const roleName = schemaContextMenu.node.name;
                    const confirmed = await confirmDialog.confirm({
                      title: `Drop Role`,
                      message: `Are you sure you want to permanently drop the role "${roleName}"? This cannot be undone.`,
                      confirmLabel: "Drop Role",
                      type: "danger"
                    });
                    if (!confirmed) return;
                    try {
                      await dropRole(roleName);
                    } catch (e: any) {
                      console.error("Drop role failed:", e);
                    }
                    closeContextMenu();
                  }}
                >
                  Drop Role
                </MenuItem>
              )}

              {schemaContextMenu.node.icon === "table" && (
                <>
                  <MenuItem
                    icon={<Plus className="w-3 h-3" />}
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
                  >
                    Insert Statement
                  </MenuItem>
                  <MenuItem
                    icon={<Edit2 className="w-3 h-3" />}
                    onClick={async () => {
                      const fullTableName = schemaContextMenu.node.id.replace(/^table-/, "");
                      const sql = await generateStatement("update", fullTableName);
                      window.dispatchEvent(new CustomEvent("open-query-with-text", {
                        detail: { query: sql, name: `Update ${fullTableName}` }
                      }));
                      closeContextMenu();
                    }}
                  >
                    Update Statement
                  </MenuItem>
                  <MenuItem
                    tone="danger"
                    icon={<Trash2 className="w-3 h-3" />}
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
                  >
                    Delete Statement
                  </MenuItem>
                </>
              )}

              <MenuSeparator />

              <MenuItem
                icon={<Columns className="w-3 h-3" />}
                onClick={() => {
                  navigator.clipboard.writeText(schemaContextMenu.node.name);
                  closeContextMenu();
                }}
              >
                Copy Name
              </MenuItem>
              {schemaContextMenu.node.icon !== "login_role" && schemaContextMenu.node.icon !== "group_role" && (
                <MenuItem
                  tone="danger"
                  icon={<Trash2 className="w-3 h-3" />}
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
              >
                Drop {schemaContextMenu.node.icon}
              </MenuItem>
            )}
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
                    <MenuItem
                      tone="success"
                      icon={<Plus className="w-3 h-3" />}
                      onClick={() => {
                        setIsCreateDatabaseOpen(true);
                        closeContextMenu();
                      }}
                    >
                      Create New Database
                    </MenuItem>
                  );
                }

                if (isTableFolder) {
                  return (
                    <MenuItem
                      tone="success"
                      icon={<Plus className="w-3 h-3" />}
                      onClick={() => {
                        const schemaMatch = schemaContextMenu.node.id.match(/-([a-zA-Z0-9_]+)$/);
                        const schema = schemaMatch ? schemaMatch[1] : "public";
                        setCreateTableTarget({ schema });
                        setIsCreateTableOpen(true);
                        closeContextMenu();
                      }}
                    >
                      Create New Table
                    </MenuItem>
                  );
                }

                const template = getCreateTemplate(schemaContextMenu.node.name);
                if (template) {
                  return (
                    <MenuItem
                      tone="success"
                      icon={<Plus className="w-3 h-3" />}
                      onClick={() => {
                        window.dispatchEvent(new CustomEvent("open-query-with-text", {
                          detail: { query: template, name: `New ${schemaContextMenu.node.name.replace(/s$/, "")}` }
                        }));
                        closeContextMenu();
                      }}
                    >
                      Create New {schemaContextMenu.node.name.replace(/s$/, "")}
                    </MenuItem>
                  );
                }
                return null;
              })()}

              {/* For schema nodes only */}
              {(schemaContextMenu.node.icon === "schema") && (
                <>
                  <MenuSeparator />

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
                    <div className="w-full flex items-center justify-between px-3 py-1.5 text-xs hover:bg-[var(--neutral-4)] cursor-default transition-colors">
                      <div className="flex items-center gap-2">
                        <Plus className="w-3 h-3" /> Create
                      </div>
                      <ChevronRight className="w-3 h-3 opacity-50" />
                    </div>

                    {activeSubmenu === "create" && (
                      <div
                        className="absolute left-full top-0 ml-[-4px] bg-[var(--surface-overlay)] border border-[var(--neutral-6)] rounded-lg shadow-xl py-1 min-w-[180px] animate-in fade-in slide-in-from-left-2 duration-150 z-[60] submenu-panel"
                        onMouseEnter={() => setActiveSubmenu("create")}
                      >
                        <MenuItem
                          icon={<Table className="w-3 h-3" />}
                          onClick={() => {
                            setCreateTableTarget({ schema: schemaContextMenu.node.name });
                            setIsCreateTableOpen(true);
                            closeContextMenu();
                          }}
                        >
                          Table
                        </MenuItem>
                        <MenuItem
                          icon={<Eye className="w-3 h-3" />}
                          onClick={() => {
                            window.dispatchEvent(new CustomEvent("open-query-with-text", {
                              detail: { query: getCreateTemplate("Views") || "", name: "New View" }
                            }));
                            closeContextMenu();
                          }}
                        >
                          View
                        </MenuItem>
                        <MenuItem
                          icon={<Variable className="w-3 h-3" />}
                          onClick={() => {
                            window.dispatchEvent(new CustomEvent("open-query-with-text", {
                              detail: { query: getCreateTemplate("Functions") || "", name: "New Function" }
                            }));
                            closeContextMenu();
                          }}
                        >
                          Function
                        </MenuItem>
                        <MenuItem
                          icon={<Zap className="w-3 h-3" />}
                          onClick={() => {
                            window.dispatchEvent(new CustomEvent("open-query-with-text", {
                              detail: { query: getCreateTemplate("Triggers") || "", name: "New Trigger" }
                            }));
                            closeContextMenu();
                          }}
                        >
                          Trigger
                        </MenuItem>
                        <MenuItem
                          icon={<Hash className="w-3 h-3" />}
                          onClick={() => {
                            window.dispatchEvent(new CustomEvent("open-query-with-text", {
                              detail: { query: getCreateTemplate("Indexes") || "", name: "New Index" }
                            }));
                            closeContextMenu();
                          }}
                        >
                          Index
                        </MenuItem>
                        <MenuItem
                          icon={<Hash className="w-3 h-3" />}
                          onClick={() => {
                            window.dispatchEvent(new CustomEvent("open-query-with-text", {
                              detail: { query: getCreateTemplate("Sequences") || "", name: "New Sequence" }
                            }));
                            closeContextMenu();
                          }}
                        >
                          Sequence
                        </MenuItem>
                        <MenuItem
                          icon={<Variable className="w-3 h-3" />}
                          onClick={() => {
                            window.dispatchEvent(new CustomEvent("open-query-with-text", {
                              detail: { query: getCreateTemplate("Types") || "", name: "New Type" }
                            }));
                            closeContextMenu();
                          }}
                        >
                          Type
                        </MenuItem>
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </Menu>
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
        <Dialog
          open
          onClose={() => { if (!backupLoading) setBackupDialogOpen(false); }}
          dismissOnBackdrop={!backupLoading}
          dismissOnEsc={!backupLoading}
          className="max-w-[500px]"
        >
          <Dialog.Title onClose={backupLoading ? undefined : () => setBackupDialogOpen(false)}>Backup Database</Dialog.Title>
          <Dialog.Body>
            <div className="mb-4">
              <p className="text-sm text-[var(--neutral-11)] mb-2">Database: <span className="font-medium text-[var(--neutral-12)]">{backupTarget.dbName}</span></p>
              <p className="text-sm text-[var(--neutral-11)]">Connection: <span className="font-medium text-[var(--neutral-12)]">{backupTarget.connName}</span></p>
            </div>
            <div className="mb-4">
              <label className="text-xs font-bold uppercase text-[var(--neutral-11)]">Backup Type</label>
              <div className="mt-2 space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" checked={backupType === "sql-schema"} onChange={() => setBackupType("sql-schema")} className="accent-[var(--accent-9)]" />
                  <span className="text-sm">SQL Dump (Schema Only)</span>
                </label>
                <label className={`flex items-center gap-2 cursor-pointer ${activeConnection?.type !== 'postgres' && activeConnection?.type !== 'supabase' ? 'opacity-40 grayscale pointer-events-none' : ''}`}>
                  <input
                    type="radio"
                    checked={backupType === "sql-full"}
                    onChange={() => setBackupType("sql-full")}
                    className="accent-[var(--accent-9)]"
                    disabled={activeConnection?.type !== 'postgres' && activeConnection?.type !== 'supabase'}
                  />
                  <span className="text-sm">SQL Dump (Schema + Data) <span className="text-[10px] opacity-70 ml-1">(PG Only)</span></span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" checked={backupType === "json"} onChange={() => setBackupType("json")} className="accent-[var(--accent-9)]" />
                  <span className="text-sm">JSON Backup (Portable)</span>
                </label>
                <label className={`flex items-center gap-2 cursor-pointer ${activeConnection?.type !== 'postgres' && activeConnection?.type !== 'supabase' ? 'opacity-40 grayscale pointer-events-none' : ''}`}>
                  <input
                    type="radio"
                    checked={backupType === "directory"}
                    onChange={() => setBackupType("directory")}
                    className="accent-[var(--accent-9)]"
                    disabled={activeConnection?.type !== 'postgres' && activeConnection?.type !== 'supabase'}
                  />
                  <span className="text-sm">Directory Backup <span className="text-[10px] opacity-70 ml-1">(PG Only)</span></span>
                </label>
              </div>
            </div>
            {backupLoading && (
              <div className="p-3 bg-[var(--accent-3)] border border-[var(--accent-6)] rounded-lg">
                <div className="flex items-center gap-2 text-[var(--accent-11)]"><Loader2 className="w-4 h-4 animate-spin" /><span className="text-sm font-medium">Backing up...</span></div>
                <p className="text-xs text-[var(--accent-11)] opacity-80 mt-1">{backupStatus}</p>
              </div>
            )}
          </Dialog.Body>
          <Dialog.Footer>
            {!['postgres', 'supabase'].includes(activeConnection?.type || '') && (
              <div className="mr-auto text-xs text-[var(--neutral-11)] italic flex items-center gap-1">
                <AlertCircle className="w-3 h-3" /> Some options limited for {activeConnection?.type}
              </div>
            )}
            <Button
              variant={backupLoading ? "destructive" : "secondary"}
              size="sm"
              onClick={() => { if (backupLoading) { backupStopRef.current = true; setBackupStatus("Stopping..."); } else { setBackupDialogOpen(false); } }}
            >
              {backupLoading ? "Stop Backup" : "Cancel"}
            </Button>
            <Button variant="primary" size="sm" onClick={executeBackup} disabled={backupLoading} loading={backupLoading}>
              {backupLoading ? "Processing..." : "Start Backup"}
            </Button>
          </Dialog.Footer>
        </Dialog>
      )}

      {/* Restore Dialog */}
      {restoreDialogOpen && backupTarget && (
        <Dialog
          open
          onClose={() => { if (!restoreLoading) setRestoreDialogOpen(false); }}
          dismissOnBackdrop={!restoreLoading}
          dismissOnEsc={!restoreLoading}
          className="max-w-[500px]"
        >
          <Dialog.Title onClose={restoreLoading ? undefined : () => setRestoreDialogOpen(false)}>
            <span className="flex items-center gap-2"><Upload className="w-4 h-4 text-[var(--accent-11)]" /> Restore Database</span>
          </Dialog.Title>
          <Dialog.Body>
            <div className="mb-4 p-4 bg-[var(--surface-base)] border border-[var(--neutral-6)] rounded-xl">
              <div className="flex justify-between items-start">
                <div>
                  <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--neutral-11)] mb-1">Target Database</p>
                  <p className="text-sm font-semibold text-[var(--success-11)]">{backupTarget.dbName}</p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--neutral-11)] mb-1">Server</p>
                  <p className="text-sm font-medium">{backupTarget.connName} ({activeConnection?.type})</p>
                </div>
              </div>
            </div>

            {!restoreLoading ? (
              <Button variant="secondary" onClick={executeRestore} className="w-full" leftIcon={<Upload className="w-4 h-4" />}>
                Select Backup File to Restore
              </Button>
            ) : (
              <div className="space-y-3">
                <div className="p-4 bg-[var(--accent-3)] border border-[var(--accent-6)] rounded-lg">
                  <div className="flex items-center gap-2 text-[var(--accent-11)] mb-2"><Loader2 className="w-4 h-4 animate-spin" /><span className="text-sm font-medium">Restoring...</span></div>
                  <p className="text-xs text-[var(--accent-11)] opacity-80">{backupStatus}</p>
                </div>
                <Button variant="destructive" onClick={() => { backupStopRef.current = true; setBackupStatus("Stopping..."); }} className="w-full" leftIcon={<Square className="w-4 h-4" />}>
                  Stop Restore
                </Button>
              </div>
            )}

            {backupStatus.includes("complete") && !restoreLoading && (
              <div className="mt-4 p-3 bg-[var(--success-3)] border border-[var(--success-6)] rounded-lg">
                <div className="flex items-center gap-2 text-[var(--success-11)]"><Check className="w-4 h-4" /><span className="text-sm font-medium">Restore Complete!</span></div>
              </div>
            )}

            {backupStatus.includes("Error") && !restoreLoading && (
              <div className="mt-4 p-3 bg-[var(--danger-3)] border border-[var(--danger-6)] rounded-lg">
                <div className="flex items-center gap-2 text-[var(--danger-11)] mb-2"><AlertCircle className="w-4 h-4" /><span className="text-sm font-medium">Errors Encountered</span></div>
                <pre className="text-xs text-[var(--danger-11)] opacity-80 mt-1 whitespace-pre-wrap max-h-48 overflow-y-auto scrollbar-thin">{backupStatus}</pre>
              </div>
            )}
          </Dialog.Body>
        </Dialog>
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

      <CreateLoginRoleDialog
        isOpen={isCreateRoleOpen}
        onClose={() => setIsCreateRoleOpen(false)}
        onCreate={async (payload) => {
          await createRole(payload);
        }}
      />

      {showImportExport && <ImportExportDialog onClose={() => setShowImportExport(false)} />}
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
    <Dialog open onClose={onCancel} className="max-w-[360px] max-h-[480px]">
      <Dialog.Title onClose={onCancel}>Move "{target.name}" to…</Dialog.Title>
      <Dialog.Body className="p-0 py-1">
        <button
          onClick={() => onPick(null)}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--neutral-4)] cursor-pointer"
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
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--neutral-4)] cursor-pointer"
              style={{ paddingLeft: `${12 + depth * 16}px` }}
            >
              <Folder className="w-3.5 h-3.5 text-yellow-500" />
              <span>{folder.name}</span>
            </button>
          ))}
        {flat.length === 0 && (
          <div className="px-3 py-4 text-center text-xs text-[var(--neutral-11)] italic">
            No folders yet. Use the + button in the toolbar to create one.
          </div>
        )}
      </Dialog.Body>
    </Dialog>
  );
}