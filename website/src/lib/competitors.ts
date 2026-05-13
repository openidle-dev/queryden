// Data source for /compare/[slug] pages. Each entry produces one comparison
// page. Numbers and prices should be defensible and dated — link to a public
// source where possible. Phrase "when X is better" honestly: a fair, calibrated
// comparison ranks better and earns more trust than a hit piece.

export interface CompetitorRow {
  /** Label shown in the comparison table's first column. */
  label: string;
  /** QueryDen value. */
  ours: string;
  /** Competitor value. */
  theirs: string;
}

export interface Competitor {
  /** URL slug. Used at /compare/[slug]. */
  slug: string;
  /** Display name. */
  name: string;
  /** Short tagline used in titles + cards. */
  tagline: string;
  /** Long-form blurb shown above the table. One or two paragraphs. */
  intro: string;
  /** Comparison rows. Keep it scannable — 8 to 12 rows max. */
  rows: CompetitorRow[];
  /** Honest "when X is better than QueryDen" bullets. */
  theyWin: string[];
  /** Honest "when QueryDen is better than X" bullets. */
  weWin: string[];
  /** Source URL for the competitor (homepage / GitHub). */
  sourceUrl: string;
  /** Optional. Date these numbers were measured / verified. */
  measuredAt?: string;
}

export const COMPETITORS: Competitor[] = [
  // ---------- DBeaver Community Edition ----------
  {
    slug: 'dbeaver',
    name: 'DBeaver CE',
    tagline: 'Open-source SQL client built on Eclipse and the JVM',
    intro: `DBeaver Community Edition is the most-used open-source SQL client. It supports 90+ engines including NoSQL and is feature-deep — but the cost is a ~250 MB Eclipse-based installer, a JVM startup penalty, and a UI that inherits Eclipse's density. QueryDen is the opposite trade: fewer engines, native binaries, smaller footprint, and a focus on the relational + Supabase workflow.`,
    rows: [
      { label: 'Engines supported',           ours: '6 (PG · MySQL · MariaDB · SQLite · Cockroach · Supabase)', theirs: '90+ (incl. NoSQL)' },
      { label: 'Installer size',              ours: '~11 MB',                                       theirs: '~250 MB' },
      { label: 'Native binary',               ours: 'Yes (Tauri · Rust)',                            theirs: 'No (Eclipse · JVM)' },
      { label: 'Typical RAM',                 ours: '~120 MB',                                       theirs: '~600 MB' },
      { label: 'Cold start',                  ours: 'Sub-second',                                    theirs: '3–8 seconds' },
      { label: 'License',                     ours: 'MIT',                                           theirs: 'Apache 2.0 (CE)' },
      { label: 'Telemetry',                   ours: 'Zero outbound calls',                          theirs: 'Opt-out' },
      { label: 'Credentials vault',           ours: 'AES-256-GCM + machine-locked',                  theirs: 'Master password (file-based)' },
      { label: 'AI assistant',                ours: 'BYO key (OpenAI · Anthropic · Google · Ollama)', theirs: 'Paid (DBeaver AI)' },
      { label: 'Visual EXPLAIN ANALYZE',      ours: 'Yes',                                           theirs: 'Yes' },
      { label: 'Price (1 seat)',              ours: 'Free',                                          theirs: 'Free (CE) · paid PRO available' },
    ],
    theyWin: [
      'You work across NoSQL, ClickHouse, MongoDB, Cassandra, or other engines QueryDen does not support.',
      'You need DBeaver-specific extensions or have an existing Eclipse plugin workflow.',
      'You manage 50+ saved connections and prefer DBeaver\'s hierarchical project structure.',
    ],
    weWin: [
      'You want sub-second app launch and ~11 MB on disk, not a JVM-based installer.',
      'You work primarily with Postgres, MySQL, SQLite, CockroachDB, or Supabase and want a focused tool rather than a generalist.',
      'You care about credential security: QueryDen\'s vault is machine-locked, so a copied vault file is useless on another laptop.',
      'You want zero telemetry by default with no opt-out checkbox to remember.',
    ],
    sourceUrl: 'https://dbeaver.io/',
    measuredAt: '2026-05',
  },

  // ---------- DataGrip ----------
  {
    slug: 'datagrip',
    name: 'DataGrip',
    tagline: 'JetBrains\' commercial database IDE',
    intro: `DataGrip is JetBrains\' commercial database IDE. It inherits the JetBrains platform — meaning excellent refactoring, intentions, and code intelligence, but also a ~700 MB install and JVM startup. It\'s subscription-priced at $229/year per seat. QueryDen targets the same relational workflow with a fraction of the footprint and an MIT license.`,
    rows: [
      { label: 'Engines supported',           ours: '6 relational',                                  theirs: '15+ relational' },
      { label: 'Installer size',              ours: '~11 MB',                                       theirs: '~700 MB' },
      { label: 'Native binary',               ours: 'Yes (Tauri · Rust)',                            theirs: 'No (JetBrains JVM)' },
      { label: 'Typical RAM',                 ours: '~120 MB',                                       theirs: '~900 MB' },
      { label: 'Cold start',                  ours: 'Sub-second',                                    theirs: '8–15 seconds' },
      { label: 'License',                     ours: 'MIT (open source)',                            theirs: 'Commercial · closed source' },
      { label: 'Price (1 seat)',              ours: 'Free',                                          theirs: '$229/year (Year 1)' },
      { label: 'Telemetry',                   ours: 'Zero outbound calls',                          theirs: 'Opt-out' },
      { label: 'Credentials vault',           ours: 'AES-256-GCM + machine-locked',                  theirs: 'OS keychain integration' },
      { label: 'AI assistant',                ours: 'BYO key (multiple providers)',                  theirs: 'JetBrains AI (paid)' },
    ],
    theyWin: [
      'You already live in the JetBrains ecosystem (IntelliJ, GoLand, PyCharm) and want database tooling that inherits the same shortcuts and refactoring intelligence.',
      'You need deep schema refactoring, multi-engine support, and JetBrains-grade code intelligence.',
      'Your employer pays for JetBrains licenses already.',
    ],
    weWin: [
      'You want a SQL client, not a full database IDE — and you do not want to pay $229/year for it.',
      'You care about installer size and cold-start performance: ~11 MB vs ~700 MB, sub-second vs 8+ seconds.',
      'You prefer open source: every line of QueryDen including the encryption code is on GitHub under MIT.',
      'You want machine-locked credential storage that prevents a copied vault file from being opened on another laptop.',
    ],
    sourceUrl: 'https://www.jetbrains.com/datagrip/',
    measuredAt: '2026-05',
  },

  // ---------- TablePlus ----------
  {
    slug: 'tableplus',
    name: 'TablePlus',
    tagline: 'Commercial native SQL client',
    intro: `TablePlus is a commercial native SQL client that\'s well-regarded for its UI polish. It\'s closed source and licensed per seat ($89 one-time, with a free tier that limits open tabs/windows). QueryDen targets the same native, fast, focused experience — but as MIT-licensed open source with zero telemetry and a machine-locked credentials vault.`,
    rows: [
      { label: 'Engines supported',           ours: '6 relational + Supabase',                       theirs: '20+ relational' },
      { label: 'Installer size',              ours: '~11 MB',                                       theirs: '~50 MB' },
      { label: 'Native binary',               ours: 'Yes (Tauri · Rust · cross-platform)',           theirs: 'Yes (per-OS native)' },
      { label: 'License',                     ours: 'MIT (open source)',                            theirs: 'Commercial · closed source' },
      { label: 'Price (1 seat)',              ours: 'Free',                                          theirs: '$89 one-time' },
      { label: 'Free tier limits',            ours: 'No limits',                                     theirs: 'Limited open tabs/windows' },
      { label: 'Telemetry',                   ours: 'Zero outbound calls',                          theirs: 'Crash reports' },
      { label: 'Credentials vault',           ours: 'AES-256-GCM + machine-locked',                  theirs: 'OS keychain' },
      { label: 'AI assistant',                ours: 'Yes (BYO key)',                                 theirs: 'No' },
      { label: 'Visual EXPLAIN ANALYZE',      ours: 'Yes',                                           theirs: 'No' },
    ],
    theyWin: [
      'You want a mature, polished commercial product with a long track record on macOS.',
      'You need NoSQL or document database support TablePlus offers and QueryDen does not.',
      'The free tier limits are not a blocker and you\'re happy paying $89 for a perpetual license.',
    ],
    weWin: [
      'You want an open-source tool whose encryption code you can audit (~300 lines of Rust on GitHub).',
      'You want a smaller installer (~11 MB vs ~50 MB) and no free-tier tab limits.',
      'You need a built-in AI assistant with bring-your-own-key support across multiple providers.',
      'You want visual EXPLAIN ANALYZE for query planning, which TablePlus does not provide.',
    ],
    sourceUrl: 'https://tableplus.com/',
    measuredAt: '2026-05',
  },

  // ---------- pgAdmin ----------
  {
    slug: 'pgadmin',
    name: 'pgAdmin 4',
    tagline: 'The official PostgreSQL administration tool',
    intro: `pgAdmin is the official PostgreSQL administration tool, maintained by the PostgreSQL Global Development Group. It\'s a Python + web stack that runs a local web server and serves the UI to your browser. It is PostgreSQL-only and ships under the PostgreSQL license. QueryDen targets a multi-engine workflow with a native desktop UI instead of a browser-served local web app.`,
    rows: [
      { label: 'Engines supported',           ours: '6 (PG · MySQL · MariaDB · SQLite · Cockroach · Supabase)', theirs: 'PostgreSQL only' },
      { label: 'Installer size',              ours: '~11 MB',                                       theirs: '~200 MB' },
      { label: 'UI delivery',                 ours: 'Native window (Tauri)',                         theirs: 'Browser-served local web app' },
      { label: 'Stack',                       ours: 'Rust + WebView',                                theirs: 'Python · Flask · web' },
      { label: 'License',                     ours: 'MIT',                                           theirs: 'PostgreSQL license' },
      { label: 'Telemetry',                   ours: 'Zero outbound calls',                          theirs: 'None' },
      { label: 'AI assistant',                ours: 'Yes (BYO key, multiple providers)',             theirs: 'No' },
      { label: 'Credentials vault',           ours: 'AES-256-GCM + machine-locked',                  theirs: 'Master password (file-based)' },
      { label: 'Multi-DB workflow',           ours: 'First-class',                                   theirs: 'PostgreSQL focus' },
    ],
    theyWin: [
      'You exclusively work with PostgreSQL and want the official tool maintained by the PG community.',
      'You need pgAdmin-specific admin features (e.g., backup/restore via pg_dump in the UI, full role/permission UIs).',
      'You\'re comfortable with the browser-served local web app model and don\'t mind the resource footprint.',
    ],
    weWin: [
      'You work across more than just PostgreSQL — Supabase, MySQL, SQLite, CockroachDB all in one tool.',
      'You want a native desktop window, not a browser tab pointing at localhost.',
      'You prefer a ~11 MB installer to a ~200 MB Python + Flask install.',
      'You want machine-locked credential storage and an integrated AI assistant.',
    ],
    sourceUrl: 'https://www.pgadmin.org/',
    measuredAt: '2026-05',
  },

  // ---------- Beekeeper Studio ----------
  {
    slug: 'beekeeper',
    name: 'Beekeeper Studio',
    tagline: 'Open-source MIT-licensed SQL client built on Electron',
    intro: `Beekeeper Studio is the closest open-source competitor to QueryDen: same MIT license, same multi-engine focus, similar UI philosophy. The differentiator is the runtime — Beekeeper is built on Electron (Chromium + Node + the app code, ~200 MB installer), QueryDen is built on Tauri (system WebView + Rust, ~11 MB installer). If you specifically want to avoid Electron, that\'s the trade.`,
    rows: [
      { label: 'Engines supported',           ours: '6 (PG · MySQL · MariaDB · SQLite · Cockroach · Supabase)', theirs: '10+ relational' },
      { label: 'Installer size',              ours: '~11 MB',                                       theirs: '~200 MB' },
      { label: 'Runtime',                     ours: 'Tauri (system WebView + Rust)',                 theirs: 'Electron (bundled Chromium + Node)' },
      { label: 'Typical RAM',                 ours: '~120 MB',                                       theirs: '~400 MB' },
      { label: 'License',                     ours: 'MIT',                                           theirs: 'MIT (community) · paid Ultimate' },
      { label: 'Price',                       ours: 'Free',                                          theirs: 'Free / $19 (Ultimate)' },
      { label: 'Telemetry',                   ours: 'Zero outbound calls',                          theirs: 'Opt-out' },
      { label: 'Credentials vault',           ours: 'AES-256-GCM + machine-locked',                  theirs: 'OS keychain' },
      { label: 'AI assistant',                ours: 'Yes (BYO key, multiple providers)',             theirs: 'Yes (BYO key, Ultimate)' },
    ],
    theyWin: [
      'You need engines QueryDen does not yet support (e.g., SQL Server, Oracle, Redis).',
      'You prefer the Beekeeper Studio Ultimate features (encrypted workspace sync, etc.) and are happy to pay.',
      'Your team standardized on Beekeeper already.',
    ],
    weWin: [
      'You want to avoid Electron — ~11 MB vs ~200 MB, ~120 MB RAM vs ~400 MB RAM.',
      'You want a machine-locked credential vault that fails to decrypt on another machine, not just OS keychain delegation.',
      'You want everything (including the AI assistant) on the free tier with no paid SKU.',
      'You want zero outbound calls by default with no opt-out checkbox to remember.',
    ],
    sourceUrl: 'https://www.beekeeperstudio.io/',
    measuredAt: '2026-05',
  },
];

export function getCompetitor(slug: string): Competitor | undefined {
  return COMPETITORS.find((c) => c.slug === slug);
}
