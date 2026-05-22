import { describe, it, expect } from "vitest";
import { parseChangelog } from "./parseChangelog";

const SAMPLE = `# Changelog

Intro paragraph that should be ignored.

## [Unreleased]

### Added
- Foo
- Bar

## [1.0.2] - 2026-05-20

### Fixed
- Some fix.

## [1.0.1] - 2026-05-15

Release with a prose intro then a section.

### Added
- Initial public release.
`;

describe("parseChangelog", () => {
  it("splits the document into one entry per `## [version]` heading", () => {
    const entries = parseChangelog(SAMPLE);
    expect(entries.map((e) => e.version)).toEqual(["Unreleased", "1.0.2", "1.0.1"]);
  });

  it("extracts the release date when present and leaves it undefined for Unreleased", () => {
    const entries = parseChangelog(SAMPLE);
    expect(entries[0].date).toBeUndefined();
    expect(entries[1].date).toBe("2026-05-20");
    expect(entries[2].date).toBe("2026-05-15");
  });

  it("captures the body markdown for each version, trimmed", () => {
    const entries = parseChangelog(SAMPLE);
    expect(entries[0].body).toBe("### Added\n- Foo\n- Bar");
    expect(entries[1].body).toBe("### Fixed\n- Some fix.");
    expect(entries[2].body.startsWith("Release with a prose intro")).toBe(true);
    expect(entries[2].body.endsWith("- Initial public release.")).toBe(true);
  });

  it("ignores content before the first heading", () => {
    const entries = parseChangelog("# Title\n\nblurb\n\n## [1.0.0] - 2026-01-01\n\nbody");
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe("body");
  });

  it("handles an empty document", () => {
    expect(parseChangelog("")).toEqual([]);
  });

  it("handles a heading without a date", () => {
    const entries = parseChangelog("## [Unreleased]\n\nbody");
    expect(entries).toEqual([
      {
        version: "Unreleased",
        date: undefined,
        heading: "## [Unreleased]",
        body: "body",
      },
    ]);
  });

  it("does not split on `## ` headings that aren't `## [version]`", () => {
    const md = "## [1.0.0] - 2026-01-01\n\n## Changes\n\nbody";
    const entries = parseChangelog(md);
    expect(entries).toHaveLength(1);
    expect(entries[0].body).toBe("## Changes\n\nbody");
  });
});
