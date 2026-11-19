import { describe, expect, it } from "vitest";
import {
  filterConnectionNodes,
  editTemplate,
  groupCheckState,
  groupNodesByDatabase,
  isNodeGroupBy,
  selectionAfterTemplateEdit,
  sanitizeTemplates,
  templateEditorView,
  templateMatch,
  toggleTargetGroup,
  upsertTemplate,
  type NodeTemplate,
} from "./multiQueryNodes";

const t = (connectionId: string, database: string) => ({ connectionId, database });

describe("sanitizeTemplates", () => {
  it("keeps well-formed templates and drops malformed, empty and duplicate-id ones", () => {
    const saved = [
      { id: "1", name: " Tenants ", targets: [t("a", "db1"), t("a", "db1"), { connectionId: "a" }], createdAt: 5 },
      { id: "1", name: "Dupe", targets: [t("a", "db2")] },
      { id: "2", name: "", targets: [t("a", "db2")] },
      { id: "3", name: "Empty", targets: [] },
      { id: "4", name: "Bad targets", targets: "a/db1" },
      null,
      "x",
    ];
    expect(sanitizeTemplates(saved)).toEqual([
      { id: "1", name: "Tenants", targets: [t("a", "db1")], createdAt: 5, updatedAt: 5 },
    ]);
  });

  it("returns nothing for a missing setting", () => {
    expect(sanitizeTemplates(undefined)).toEqual([]);
  });
});

describe("upsertTemplate", () => {
  const existing: NodeTemplate[] = [{ id: "1", name: "Prod", targets: [t("a", "db1")], createdAt: 1, updatedAt: 1 }];

  it("appends a new template", () => {
    const res = upsertTemplate(existing, "Staging", [t("b", "db2")], 10, () => "2");
    expect(res.replaced).toBe(false);
    expect(res.templates).toHaveLength(2);
    expect(res.template).toEqual({ id: "2", name: "Staging", targets: [t("b", "db2")], createdAt: 10, updatedAt: 10 });
  });

  it("replaces a same-named template case-insensitively, keeping its id and position", () => {
    const res = upsertTemplate(existing, " prod ", [t("a", "db1"), t("a", "db3")], 10, () => "new");
    expect(res.replaced).toBe(true);
    expect(res.templates).toEqual([
      { id: "1", name: "prod", targets: [t("a", "db1"), t("a", "db3")], createdAt: 1, updatedAt: 10 },
    ]);
  });
});

describe("templateMatch", () => {
  const tpl = [t("a", "db1"), t("b", "db1")];
  it("is exact for the same set in any order", () => {
    expect(templateMatch(tpl, [t("b", "db1"), t("a", "db1")])).toBe("exact");
  });
  it("is partial for a subset or superset", () => {
    expect(templateMatch(tpl, [t("a", "db1")])).toBe("partial");
    expect(templateMatch(tpl, [...tpl, t("c", "db1")])).toBe("partial");
  });
  it("is none when disjoint or empty", () => {
    expect(templateMatch(tpl, [t("c", "db1")])).toBe("none");
    expect(templateMatch(tpl, [])).toBe("none");
  });
});

describe("toggleTargetGroup", () => {
  it("adds the missing members when the group is not fully selected", () => {
    expect(toggleTargetGroup([t("a", "db1")], [t("a", "db1"), t("b", "db1")])).toEqual([t("a", "db1"), t("b", "db1")]);
  });
  it("removes only the group when it is fully selected", () => {
    expect(toggleTargetGroup([t("a", "db1"), t("b", "db1"), t("c", "x")], [t("a", "db1"), t("b", "db1")])).toEqual([
      t("c", "x"),
    ]);
  });
  it("is a no-op for an empty group", () => {
    expect(toggleTargetGroup([t("a", "db1")], [])).toEqual([t("a", "db1")]);
  });
});

const connections = [
  { id: "p", name: "Production", type: "postgres", host: "prod.internal", database: "postgres" },
  { id: "s", name: "Staging", type: "postgres", host: "stage.internal", database: "postgres" },
  { id: "m", name: "Legacy", type: "mysql", host: "old.internal", database: "shop" },
];
const listed = { p: ["app", "tenant_a", "tenant_b"], s: ["app", "tenant_a"] };

describe("filterConnectionNodes", () => {
  it("shows every connection with its listed or default databases when unfiltered", () => {
    expect(filterConnectionNodes(connections, listed, [], { query: "", selectedOnly: false })).toEqual([
      { connectionId: "p", databases: ["app", "tenant_a", "tenant_b"] },
      { connectionId: "s", databases: ["app", "tenant_a"] },
      { connectionId: "m", databases: ["shop"] },
    ]);
  });

  it("keeps all databases of a connection whose name, host or engine matches", () => {
    expect(filterConnectionNodes(connections, listed, [], { query: "STAGE", selectedOnly: false })).toEqual([
      { connectionId: "s", databases: ["app", "tenant_a"] },
    ]);
    expect(filterConnectionNodes(connections, listed, [], { query: "mysql", selectedOnly: false })).toEqual([
      { connectionId: "m", databases: ["shop"] },
    ]);
  });

  it("narrows to matching databases otherwise", () => {
    expect(filterConnectionNodes(connections, listed, [], { query: "tenant_", selectedOnly: false })).toEqual([
      { connectionId: "p", databases: ["tenant_a", "tenant_b"] },
      { connectionId: "s", databases: ["tenant_a"] },
    ]);
  });

  it("shows only selected databases when asked", () => {
    const selected = [t("p", "tenant_b"), t("m", "shop")];
    expect(filterConnectionNodes(connections, listed, selected, { query: "", selectedOnly: true })).toEqual([
      { connectionId: "p", databases: ["tenant_b"] },
      { connectionId: "m", databases: ["shop"] },
    ]);
    expect(filterConnectionNodes(connections, listed, selected, { query: "tenant", selectedOnly: true })).toEqual([
      { connectionId: "p", databases: ["tenant_b"] },
    ]);
  });
});

describe("groupNodesByDatabase", () => {
  it("groups same-named databases across connections, most widespread first", () => {
    const nodes = filterConnectionNodes(connections, listed, [], { query: "", selectedOnly: false });
    expect(groupNodesByDatabase(nodes)).toEqual([
      { database: "app", connectionIds: ["p", "s"] },
      { database: "tenant_a", connectionIds: ["p", "s"] },
      { database: "shop", connectionIds: ["m"] },
      { database: "tenant_b", connectionIds: ["p"] },
    ]);
  });
});

describe("isNodeGroupBy", () => {
  it("accepts only known modes", () => {
    expect(isNodeGroupBy("database")).toBe(true);
    expect(isNodeGroupBy("folder")).toBe(false);
    expect(isNodeGroupBy("schema")).toBe(false);
    expect(isNodeGroupBy(undefined)).toBe(false);
  });
});

describe("groupCheckState", () => {
  const group = [t("a", "db1"), t("b", "db1")];
  it("reports all, some or none of the group selected", () => {
    expect(groupCheckState(group, group)).toBe("all");
    expect(groupCheckState([t("a", "db1")], group)).toBe("some");
    expect(groupCheckState([t("c", "x")], group)).toBe("none");
    expect(groupCheckState(group, [])).toBe("none");
  });
});

describe("editTemplate", () => {
  const list: NodeTemplate[] = [
    { id: "1", name: "Prod", targets: [t("a", "db1")], createdAt: 1, updatedAt: 1 },
    { id: "2", name: "Staging", targets: [t("b", "db1")], createdAt: 1, updatedAt: 1 },
  ];

  it("renames and re-targets in place", () => {
    const res = editTemplate(list, "1", " Prod EU ", [t("a", "db1"), t("a", "db2")], 9);
    expect(res.error).toBeUndefined();
    expect(res.templates?.[0]).toEqual({ id: "1", name: "Prod EU", targets: [t("a", "db1"), t("a", "db2")], createdAt: 1, updatedAt: 9 });
    expect(res.templates?.[1]).toBe(list[1]);
  });

  it("allows a case-only rename of itself", () => {
    expect(editTemplate(list, "1", "PROD", [t("a", "db1")], 9).templates?.[0].name).toBe("PROD");
  });

  it("rejects an empty name, no databases, a name clash or a deleted template", () => {
    expect(editTemplate(list, "1", "  ", [t("a", "db1")], 9).error).toBe("Enter a template name.");
    expect(editTemplate(list, "1", "Prod", [], 9).error).toBe("A template needs at least one database.");
    expect(editTemplate(list, "1", "staging", [t("a", "db1")], 9).error).toBe('A template named "Staging" already exists.');
    expect(editTemplate(list, "gone", "X", [t("a", "db1")], 9).error).toBe("This template no longer exists.");
  });
});

describe("templateEditorView", () => {
  const members = [t("p", "tenant_a"), t("p", "dropped"), t("s", "app"), t("deleted", "old_db")];

  it("shows only the template's databases per server, flagging ones the server no longer lists", () => {
    const view = templateEditorView(connections, listed, members, { query: "", showAll: false });
    expect(view.servers).toEqual([
      { connectionId: "p", databases: [{ name: "tenant_a", missing: false }, { name: "dropped", missing: true }] },
      { connectionId: "s", databases: [{ name: "app", missing: false }] },
    ]);
    expect(view.orphaned).toEqual([t("deleted", "old_db")]);
  });

  it("does not flag databases on servers whose list has not been fetched yet", () => {
    const view = templateEditorView(connections, {}, [t("p", "tenant_a")], { query: "", showAll: false });
    expect(view.servers).toEqual([{ connectionId: "p", databases: [{ name: "tenant_a", missing: false }] }]);
  });

  it("adds every other database and server when showing all", () => {
    const view = templateEditorView(connections, listed, members, { query: "", showAll: true });
    expect(view.servers.map((s) => [s.connectionId, s.databases.map((d) => d.name)])).toEqual([
      ["p", ["app", "tenant_a", "tenant_b", "dropped"]],
      ["s", ["app", "tenant_a"]],
      ["m", ["shop"]],
    ]);
  });

  it("filters by server or database name", () => {
    expect(templateEditorView(connections, listed, members, { query: "tenant", showAll: true }).servers.map((s) => s.connectionId)).toEqual(["p", "s"]);
    expect(templateEditorView(connections, listed, members, { query: "legacy", showAll: true }).servers).toEqual([
      { connectionId: "m", databases: [{ name: "shop", missing: false }] },
    ]);
    expect(templateEditorView(connections, listed, members, { query: "old", showAll: false }).orphaned).toEqual([t("deleted", "old_db")]);
  });
});

describe("selectionAfterTemplateEdit", () => {
  const before = [t("a", "db1"), t("b", "db1")];
  const after = [t("a", "db1"), t("a", "db2"), t("gone", "x")];

  it("follows the edit when the selection matched the template", () => {
    expect(selectionAfterTemplateEdit(before, after, [t("b", "db1"), t("a", "db1")], false, ["a", "b"])).toEqual([
      t("a", "db1"),
      t("a", "db2"),
    ]);
  });

  it("follows the edit for the template last used, even after the tree changed", () => {
    expect(selectionAfterTemplateEdit(before, after, [t("c", "x")], true, ["a", "b", "c"])).toEqual([t("a", "db1"), t("a", "db2")]);
  });

  it("leaves the selection alone for a template that is not in use", () => {
    expect(selectionAfterTemplateEdit(before, after, [t("a", "db1")], false, ["a", "b"])).toBeNull();
    expect(selectionAfterTemplateEdit(before, after, [], false, ["a", "b"])).toBeNull();
  });
});

describe("template discovery and legacy name regressions", () => {
  const template = (id: string, name: string, database: string): NodeTemplate => ({ id, name, targets: [t("a", database)], createdAt: 1, updatedAt: 1 });

  it("resolves case-insensitive loaded names without losing target sets and remains stable on reload", () => {
    const result = sanitizeTemplates([template("1", "Prod", "one"), template("2", "PROD", "two"), template("3", "prod (2)", "three")]);
    expect(new Set(result.map(item => item.name.toLowerCase())).size).toBe(3);
    expect(result.map(item => item.targets)).toEqual([[t("a", "one")], [t("a", "two")], [t("a", "three")]]);
    expect(sanitizeTemplates(result)).toEqual(result);
  });

  it("checks every other ID when editing legacy duplicate names", () => {
    expect(editTemplate([template("1", "Prod", "one"), template("2", "PROD", "two")], "1", "Prod", [t("a", "one")], 2).error).toBeDefined();
  });

  it("keeps missing members saved while pruning confirmed missing execution targets and preserving unknown ones", () => {
    const members = [t("a", "present"), t("a", "missing"), t("b", "unknown")];
    expect(selectionAfterTemplateEdit(members, members, members, true, ["a", "b"], { a: ["present"] })).toEqual([t("a", "present"), t("b", "unknown")]);
    expect(members).toHaveLength(3);
  });
});
