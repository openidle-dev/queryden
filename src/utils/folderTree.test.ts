import { describe, it, expect } from "vitest";
import {
  buildConnectionTree,
  descendantFolderIds,
  wouldCreateCycle,
} from "./folderTree";
import type { Folder, DatabaseConnection } from "../contexts/ConnectionContext";

// ── Fixtures ─────────────────────────────────────────────────────────────

const conn = (id: string, folderId: string | null = null): DatabaseConnection => ({
  id,
  name: id.toUpperCase(),
  type: "postgres",
  database: "db",
  folderId,
});

const folder = (
  id: string,
  parentId: string | null = null,
  order = 0,
  name = id,
): Folder => ({ id, name, parentId, order });

// ── buildConnectionTree ──────────────────────────────────────────────────

describe("buildConnectionTree", () => {
  it("returns an empty forest for no folders and no connections", () => {
    expect(buildConnectionTree([], [])).toEqual([]);
  });

  it("renders root-level connections flat", () => {
    const tree = buildConnectionTree([], [conn("a"), conn("b")]);
    expect(tree).toHaveLength(2);
    expect(tree.map((n) => ({ kind: n.kind, id: n.id }))).toEqual([
      { kind: "connection", id: "a" },
      { kind: "connection", id: "b" },
    ]);
  });

  it("nests connections inside their folder", () => {
    const folders = [folder("prod")];
    const conns = [conn("c1", "prod"), conn("c2"), conn("c3", "prod")];
    const tree = buildConnectionTree(folders, conns);

    expect(tree).toHaveLength(2);
    expect(tree[0].kind).toBe("folder");
    expect(tree[0].children.map((n) => n.id)).toEqual(["c1", "c3"]);
    // Root-level c2 comes after the folder.
    expect(tree[1].id).toBe("c2");
  });

  it("supports arbitrary nesting and the issue #104 example", () => {
    // Group 1 → { Server 1, Subgroup 1 → { Server 2, Server 3 } }
    const folders = [folder("g1"), folder("sub1", "g1")];
    const conns = [conn("s1", "g1"), conn("s2", "sub1"), conn("s3", "sub1")];
    const tree = buildConnectionTree(folders, conns);

    expect(tree).toHaveLength(1);
    const g1 = tree[0];
    expect(g1.kind).toBe("folder");
    expect(g1.children.map((n) => `${n.kind}:${n.id}`)).toEqual([
      "folder:sub1",
      "connection:s1",
    ]);
    const sub1 = g1.children[0];
    expect(sub1.children.map((n) => n.id)).toEqual(["s2", "s3"]);
  });

  it("treats a dangling folderId as root (folder was deleted)", () => {
    const tree = buildConnectionTree([], [conn("orphan", "ghost-folder")]);
    expect(tree).toHaveLength(1);
    expect(tree[0].kind).toBe("connection");
    expect(tree[0].id).toBe("orphan");
  });

  it("sorts sibling folders by order, then name", () => {
    const folders = [
      folder("b", null, 5, "Beta"),
      folder("a", null, 5, "Alpha"),
      folder("c", null, 1, "Cee"),
    ];
    const tree = buildConnectionTree(folders, []);
    // Order 1 (Cee) first; then order-5 ties broken by name (Alpha, Beta).
    expect(tree.map((n) => n.id)).toEqual(["c", "a", "b"]);
  });

  it("does not infinite-loop on a cyclic folder list", () => {
    // a → b → a. The frontend's wouldCreateCycle check should make this
    // unreachable, but defence in depth.
    const folders: Folder[] = [
      { id: "a", name: "A", parentId: "b", order: 0 },
      { id: "b", name: "B", parentId: "a", order: 0 },
    ];
    // Neither folder has a root parent, so the tree should be empty (both
    // are excluded by the parentId=null traversal).
    expect(() => buildConnectionTree(folders, [])).not.toThrow();
    const tree = buildConnectionTree(folders, []);
    expect(tree).toEqual([]);
  });
});

// ── descendantFolderIds ──────────────────────────────────────────────────

describe("descendantFolderIds", () => {
  it("includes the folder itself", () => {
    const ids = descendantFolderIds("a", [folder("a")]);
    expect(ids.has("a")).toBe(true);
    expect(ids.size).toBe(1);
  });

  it("walks the full subtree", () => {
    const folders = [
      folder("a"),
      folder("b", "a"),
      folder("c", "b"),
      folder("d", "a"),
      folder("e"), // unrelated
    ];
    const ids = descendantFolderIds("a", folders);
    expect([...ids].sort()).toEqual(["a", "b", "c", "d"]);
  });
});

// ── wouldCreateCycle ─────────────────────────────────────────────────────

describe("wouldCreateCycle", () => {
  const folders = [folder("a"), folder("b", "a"), folder("c", "b")];

  it("allows moving to root", () => {
    expect(wouldCreateCycle("a", null, folders)).toBe(false);
  });

  it("rejects making a folder its own parent", () => {
    expect(wouldCreateCycle("a", "a", folders)).toBe(true);
  });

  it("rejects moving an ancestor under a descendant", () => {
    expect(wouldCreateCycle("a", "b", folders)).toBe(true);
    expect(wouldCreateCycle("a", "c", folders)).toBe(true);
  });

  it("allows lateral moves", () => {
    const lateral = [folder("a"), folder("b")];
    expect(wouldCreateCycle("a", "b", lateral)).toBe(false);
  });

  it("allows moving a descendant under an unrelated folder", () => {
    const tree = [
      folder("a"),
      folder("b", "a"),
      folder("unrelated"),
    ];
    expect(wouldCreateCycle("b", "unrelated", tree)).toBe(false);
  });
});
