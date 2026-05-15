// Parses the canonical /CHANGELOG.md at the repo root into structured
// entries for the website's /changelog page. CHANGELOG.md is the
// source of truth — contributors edit it via PR as part of releases,
// and the website reflects it automatically on the next build.
//
// Expected format (Keep a Changelog 1.1.0):
//
//   ## [Unreleased]
//   ## [1.2.3] - 2026-05-13
//
//   Optional preamble paragraph(s) describing the release.
//
//   ### Added | Changed | Fixed | Security | <any other heading>
//   - bullet
//   - bullet
//
// Unknown section headings (e.g. "Infrastructure", "Note") are kept
// and rendered with the `note` kind chip. The [Unreleased] section
// is intentionally skipped.

import CHANGELOG_RAW from '../../../CHANGELOG.md?raw';

export type Kind = 'added' | 'changed' | 'fixed' | 'security' | 'note';

export interface Note {
  kind: Kind;
  /** Optional section label shown next to the chip — e.g. "Infrastructure"
   *  for non-standard sections. Undefined for standard Added/Changed/Fixed/Security. */
  label?: string;
  /** Safe inline HTML — escaped raw text with a small markdown subset applied
   *  (code spans, bold, italic, links). Safe to use with Astro's set:html. */
  body: string;
}

export interface ChangelogEntry {
  version: string;          // e.g. "1.0.11"
  date: string;             // ISO YYYY-MM-DD
  /** Plain-text first sentence, used as page heading. Safe to render as text. */
  title?: string;
  /** Array of safe inline-HTML paragraphs (escaped + small markdown subset).
   *  Pass each through set:html. */
  preamble?: string[];
  notes: Note[];
}

const STANDARD_KINDS = new Set(['added', 'changed', 'fixed', 'security']);

// HTML-escape then apply a small markdown subset. Source is the repo's
// own CHANGELOG.md (maintainer-controlled), but we escape first anyway —
// otherwise a stray `<` in a bullet would render as broken HTML.
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function mdInline(s: string): string {
  let out = escapeHtml(s);
  // Inline code: `text` — must run first so emphasis inside backticks is preserved.
  out = out.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  // Links: [text](url) — only http(s), relative, or anchor URLs.
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*|#[^)\s]*)\)/g,
    (_, text, url) => `<a href="${url}">${text}</a>`);
  // Bold: **text**
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_, c) => `<strong>${c}</strong>`);
  // Italic: *text* — avoid matching ** by requiring non-* boundaries.
  out = out.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, (_, pre, c) => `${pre}<em>${c}</em>`);
  return out;
}

function classifySection(header: string): { kind: Kind; label?: string } {
  const key = header.trim().toLowerCase();
  if (STANDARD_KINDS.has(key)) return { kind: key as Kind };
  if (key === 'note' || key === 'notes') return { kind: 'note' };
  // Unknown heading — keep label for UI display, classify as note.
  return { kind: 'note', label: header.trim() };
}

function parseBullets(sectionBody: string): string[] {
  const lines = sectionBody.split('\n');
  const bullets: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const text = current.join(' ').trim();
    if (text) bullets.push(text);
    current = [];
  };
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (/^[-*]\s+/.test(line)) {
      flush();
      current.push(line.replace(/^[-*]\s+/, ''));
    } else if (/^\s+\S/.test(line) && current.length > 0) {
      // Continuation of the current bullet (indented wrap line)
      current.push(line.trim());
    } else if (line.trim() === '') {
      flush();
    } else if (current.length > 0) {
      // Non-empty non-indented non-bullet line breaks the list
      flush();
    }
  }
  flush();
  return bullets;
}

function parseEntry(version: string, date: string, body: string): ChangelogEntry {
  // Split on "### Header" — parts[0] is the preamble before any section.
  const parts = body.split(/^### /m);
  const preambleRaw = parts[0].trim();

  let title: string | undefined;
  let preamble: string[] | undefined;
  if (preambleRaw) {
    // First sentence, stopped at period+space or newline. Strip markdown for plain-text title.
    const firstSentence = preambleRaw
      .split(/\.(\s+|$)|\n/)[0]
      .replace(/[*_`]/g, '')
      .trim();
    if (firstSentence.length > 0 && firstSentence.length <= 80) {
      title = firstSentence;
    }
    // Split preamble into paragraphs on blank lines, transform each to safe HTML.
    preamble = preambleRaw
      .split(/\n{2,}/)
      .map((p) => p.replace(/\n/g, ' ').trim())
      .filter((p) => p.length > 0)
      .map(mdInline);
  }

  const notes: Note[] = [];
  for (const part of parts.slice(1)) {
    const newlineIdx = part.indexOf('\n');
    const header = newlineIdx === -1 ? part : part.slice(0, newlineIdx);
    const sectionBody = newlineIdx === -1 ? '' : part.slice(newlineIdx + 1);
    const { kind, label } = classifySection(header);
    for (const bullet of parseBullets(sectionBody)) {
      notes.push({ kind, label, body: mdInline(bullet) });
    }
  }

  return { version, date, title, preamble, notes };
}

function parseChangelog(md: string): ChangelogEntry[] {
  // Match "## [version] - YYYY-MM-DD" headers. Versions without dates
  // (like [Unreleased]) are matched but filtered out below.
  const headerRe = /^## \[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?\s*$/gm;
  const matches = Array.from(md.matchAll(headerRe));
  const entries: ChangelogEntry[] = [];

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const version = m[1];
    const date = m[2];
    if (!date || version.toLowerCase() === 'unreleased') continue;

    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : md.length;
    const body = md.slice(start, end);
    entries.push(parseEntry(version, date, body));
  }
  return entries;
}

export const CHANGELOG: ChangelogEntry[] = parseChangelog(CHANGELOG_RAW);
