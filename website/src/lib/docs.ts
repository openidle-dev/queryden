// Docs sidebar / section metadata. Order matters — drives sidebar rendering.

import { getCollection, type CollectionEntry } from 'astro:content';

export type DocSection =
  | 'getting-started'
  | 'engines'
  | 'editor'
  | 'ai'
  | 'security'
  | 'troubleshooting';

export const SECTIONS: ReadonlyArray<{ slug: DocSection; label: string; blurb: string }> = [
  { slug: 'getting-started',   label: 'Getting started', blurb: 'Install, set up the vault, run your first query.' },
  { slug: 'engines',           label: 'Engines',         blurb: 'Postgres, MySQL, SQLite, CockroachDB, Supabase quirks.' },
  { slug: 'editor',            label: 'Editor',          blurb: 'Keymap, autocomplete, formatting, statement-aware run.' },
  { slug: 'ai',                label: 'AI assistant',    blurb: 'BYO key for OpenAI, Anthropic, Gemini, Ollama. EXPLAIN-aware fixes.' },
  { slug: 'security',          label: 'Security',        blurb: 'Vault internals, machine binding, auditing, threat model.' },
  { slug: 'troubleshooting',   label: 'Troubleshooting', blurb: 'Common errors, performance tips, log locations.' },
] as const;

export interface DocNavEntry {
  slug: string;        // full slug, e.g. "getting-started/install"
  title: string;
  order: number;
  draft: boolean;
}

export interface DocSectionGroup {
  section: DocSection;
  label: string;
  blurb: string;
  entries: DocNavEntry[];
}

// Build the sidebar tree from the docs collection. Sorted by section order
// (declared above) and then by per-entry order, then by title.
export async function getDocsNav(): Promise<DocSectionGroup[]> {
  const all = await getCollection('docs', (e) => !e.data.draft);
  const bySection = new Map<DocSection, DocNavEntry[]>();
  for (const e of all) {
    const arr = bySection.get(e.data.section) ?? [];
    arr.push({
      slug: e.id.replace(/\.(md|mdx)$/, ''),
      title: e.data.title,
      order: e.data.order,
      draft: e.data.draft,
    });
    bySection.set(e.data.section, arr);
  }
  for (const arr of bySection.values()) {
    arr.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
  }
  return SECTIONS.map((s) => ({
    section: s.slug,
    label: s.label,
    blurb: s.blurb,
    entries: bySection.get(s.slug) ?? [],
  }));
}

// Find prev/next sibling for the "next page" footer.
export function findSiblings(
  groups: DocSectionGroup[],
  currentSlug: string
): { prev?: DocNavEntry; next?: DocNavEntry } {
  const flat = groups.flatMap((g) => g.entries);
  const idx = flat.findIndex((e) => e.slug === currentSlug);
  if (idx === -1) return {};
  return { prev: flat[idx - 1], next: flat[idx + 1] };
}

export type DocEntry = CollectionEntry<'docs'>;
