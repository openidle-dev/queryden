import { describe, it, expect } from "vitest";
import { Database } from "lucide-react";
import { filterProviders, getComingSoonCount } from "./filterProviders";
import { PROVIDERS, type DatabaseProvider } from "../../config/providers";

const make = (overrides: Partial<DatabaseProvider> & Pick<DatabaseProvider, "id" | "name">): DatabaseProvider => ({
  icon: Database,
  color: "text-white",
  bg: "bg-white/10",
  type: "RDBMS",
  ...overrides,
});

const FIXTURE: DatabaseProvider[] = [
  make({ id: "postgres", name: "PostgreSQL" }),
  make({ id: "mysql", name: "MySQL" }),
  make({ id: "sqlite", name: "SQLite", type: "Embedded" }),
  make({ id: "mongo", name: "MongoDB", type: "NoSQL", comingSoon: true }),
  make({ id: "redis", name: "Redis", type: "NoSQL", comingSoon: true }),
  make({ id: "snowflake", name: "Snowflake", type: "Cloud", comingSoon: true }),
];

describe("filterProviders", () => {
  it("excludes coming-soon providers when showAll is false", () => {
    const result = filterProviders(FIXTURE, { showAll: false });
    expect(result.map(p => p.id)).toEqual(["postgres", "mysql", "sqlite"]);
    expect(result.every(p => !p.comingSoon)).toBe(true);
  });

  it("includes coming-soon providers when showAll is true", () => {
    const result = filterProviders(FIXTURE, { showAll: true });
    expect(result).toHaveLength(FIXTURE.length);
    expect(result.some(p => p.comingSoon)).toBe(true);
  });

  it("filters by search within the default (supported-only) tier", () => {
    const result = filterProviders(FIXTURE, { showAll: false, search: "sql" });
    // Matches PostgreSQL, MySQL, SQLite — but NOT MongoDB even though it's NoSQL,
    // because coming-soon tier is hidden when showAll=false.
    expect(result.map(p => p.id)).toEqual(["postgres", "mysql", "sqlite"]);
  });

  it("filters by search within the show-all tier (matches coming-soon too)", () => {
    const result = filterProviders(FIXTURE, { showAll: true, search: "red" });
    expect(result.map(p => p.id)).toEqual(["redis"]);
  });

  it("treats search as case-insensitive and trims whitespace", () => {
    expect(filterProviders(FIXTURE, { showAll: false, search: "  POSTGRES  " }).map(p => p.id)).toEqual([
      "postgres",
    ]);
  });

  it("applies category filter alongside the tier filter", () => {
    const result = filterProviders(FIXTURE, { showAll: true, category: "NoSQL" });
    expect(result.map(p => p.id)).toEqual(["mongo", "redis"]);
  });

  it("treats 'All' and 'Popular' as no-op categories", () => {
    const all = filterProviders(FIXTURE, { showAll: true, category: "All" });
    const popular = filterProviders(FIXTURE, { showAll: true, category: "Popular" });
    expect(all).toHaveLength(FIXTURE.length);
    expect(popular).toHaveLength(FIXTURE.length);
  });
});

describe("getComingSoonCount", () => {
  it("counts only providers explicitly marked comingSoon", () => {
    expect(getComingSoonCount(FIXTURE)).toBe(3);
  });

  it("returns 0 when nothing is marked", () => {
    const supportedOnly = FIXTURE.filter(p => !p.comingSoon);
    expect(getComingSoonCount(supportedOnly)).toBe(0);
  });

  it("matches the real PROVIDERS catalog count", () => {
    const expected = PROVIDERS.filter(p => p.comingSoon === true).length;
    expect(getComingSoonCount(PROVIDERS)).toBe(expected);
  });
});
