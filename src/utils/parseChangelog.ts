// Parser for the Keep-a-Changelog format used in CHANGELOG.md.
// Splits the document into per-version entries: `## [version] - date`
// becomes one entry; `## [Unreleased]` becomes an entry with no date.
// See #144 for the in-app viewer that consumes this.

export interface ChangelogEntry {
  /** Version identifier: "1.0.19", or "Unreleased". */
  version: string;
  /** Release date (YYYY-MM-DD) — undefined for "Unreleased" and for entries
   *  that for whatever reason omit the trailing date. */
  date?: string;
  /** Original `## [version] - date` heading text, for "is this Unreleased?" checks. */
  heading: string;
  /** Body markdown for this version — everything between this heading and the
   *  next `## [` heading, with leading/trailing blank lines stripped. */
  body: string;
}

const HEADING_RE = /^## \[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?\s*$/;

export function parseChangelog(markdown: string): ChangelogEntry[] {
  const lines = markdown.split(/\r?\n/);
  const entries: ChangelogEntry[] = [];

  let current: ChangelogEntry | null = null;
  let bodyLines: string[] = [];

  const flush = () => {
    if (current) {
      current.body = bodyLines.join("\n").replace(/^\s+|\s+$/g, "");
      entries.push(current);
    }
  };

  for (const line of lines) {
    const match = HEADING_RE.exec(line);
    if (match) {
      flush();
      current = {
        version: match[1],
        date: match[2] || undefined,
        heading: line,
        body: "",
      };
      bodyLines = [];
    } else if (current) {
      bodyLines.push(line);
    }
    // Lines before the first `## [` heading (title, intro paragraph) are ignored.
  }
  flush();

  return entries;
}
