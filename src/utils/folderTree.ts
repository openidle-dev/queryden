/**
 * Folder-tree helpers for the Database Explorer (#104).
 *
 * The Rust storage layer is intentionally dumb — it persists folders as a
 * flat list with `parentId` pointers and trusts the frontend to enforce
 * invariants (no cycles, dangling folderId → root). These helpers are the
 * one place that logic lives, so it stays pure-functional and unit-testable
 * outside of Tauri.
 */
import type { Folder, DatabaseConnection } from "../contexts/ConnectionContext";

/** A node in the rendered explorer tree. Loose shape — keeps the helper
 *  reusable from anywhere that needs to walk folders + connections. */
export interface FolderTreeNode {
  kind: "folder" | "connection";
  id: string;
  name: string;
  /** Sort key — lower = earlier among siblings. Folders sort by `order` then
   *  name; connections by insertion order (caller decides). */
  order: number;
  /** Original folder/connection object. Useful for the renderer to pull
   *  icons / context-menu IDs without re-querying state. */
  folder?: Folder;
  connection?: DatabaseConnection;
  children: FolderTreeNode[];
}

/**
 * Build a forest of folder + connection nodes from the flat lists.
 *
 * Rules:
 *  - Folders sort first within each parent (by `order`, then name).
 *  - Connections follow folders within the same parent, in input order.
 *  - A connection whose `folderId` doesn't match any folder is treated as
 *    a root connection (the folder was likely deleted before its
 *    connections were reparented; the frontend's removeFolder reparents
 *    eagerly, but defence in depth).
 *  - Cycles in the folder list (a → b → a) would cause infinite recursion;
 *    we defend with a `visited` set and silently drop any folder we've
 *    already seen in the current branch.
 */
export function buildConnectionTree(
  folders: Folder[],
  connections: DatabaseConnection[],
): FolderTreeNode[] {
  const folderIds = new Set(folders.map((f) => f.id));

  const childrenByParent = new Map<string | null, Folder[]>();
  for (const f of folders) {
    const key = f.parentId ?? null;
    const arr = childrenByParent.get(key) ?? [];
    arr.push(f);
    childrenByParent.set(key, arr);
  }
  for (const arr of childrenByParent.values()) {
    arr.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  }

  const connsByFolder = new Map<string | null, DatabaseConnection[]>();
  for (const c of connections) {
    // Dangling folderId → root.
    const fid = c.folderId && folderIds.has(c.folderId) ? c.folderId : null;
    const arr = connsByFolder.get(fid) ?? [];
    arr.push(c);
    connsByFolder.set(fid, arr);
  }

  function build(parentId: string | null, visited: Set<string>): FolderTreeNode[] {
    const folderChildren = (childrenByParent.get(parentId) ?? [])
      .filter((f) => !visited.has(f.id))
      .map((f) => {
        const nextVisited = new Set(visited);
        nextVisited.add(f.id);
        const node: FolderTreeNode = {
          kind: "folder",
          id: f.id,
          name: f.name,
          order: f.order,
          folder: f,
          children: build(f.id, nextVisited),
        };
        return node;
      });

    const connChildren = (connsByFolder.get(parentId) ?? []).map((c, i) => ({
      kind: "connection" as const,
      id: c.id,
      name: c.name,
      // After all folders. Stable input order within the connection group.
      order: 1_000_000 + i,
      connection: c,
      children: [],
    }));

    return [...folderChildren, ...connChildren];
  }

  return build(null, new Set());
}

/**
 * Return the IDs of `folderId` and every descendant folder. Used to:
 *  - prevent picking a descendant as a folder's new parent (which would
 *    create a cycle), and
 *  - cascade-reparent on delete.
 */
export function descendantFolderIds(folderId: string, folders: Folder[]): Set<string> {
  const childrenByParent = new Map<string, Folder[]>();
  for (const f of folders) {
    if (f.parentId) {
      const arr = childrenByParent.get(f.parentId) ?? [];
      arr.push(f);
      childrenByParent.set(f.parentId, arr);
    }
  }

  const out = new Set<string>([folderId]);
  const stack = [folderId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const child of childrenByParent.get(cur) ?? []) {
      if (!out.has(child.id)) {
        out.add(child.id);
        stack.push(child.id);
      }
    }
  }
  return out;
}

/**
 * Returns true if reparenting `folderId` under `newParentId` would create
 * a cycle — i.e. `newParentId` is the folder itself or one of its
 * descendants. The caller should refuse the operation when this returns true.
 */
export function wouldCreateCycle(
  folderId: string,
  newParentId: string | null,
  folders: Folder[],
): boolean {
  if (newParentId === null) return false;
  if (newParentId === folderId) return true;
  return descendantFolderIds(folderId, folders).has(newParentId);
}
