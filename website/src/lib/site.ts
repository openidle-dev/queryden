// Single source of truth for site-wide values. Anything that drifts
// (version, repo URL, download links, comparison numbers) lives here.

import pkg from '../../../package.json';

export const SITE = {
  name: 'QueryDen',
  version: pkg.version,
  repo: 'https://github.com/openidle-dev/queryden',
  homepage: 'https://queryden.openidle.com',
} as const;

// Build-time GitHub star count. null on rate-limit, offline, or any error.
async function fetchStarCount(): Promise<number | null> {
  if (process.env.QUERYDEN_SKIP_GH_STARS === '1') return null;
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`https://api.github.com/repos/${SITE.repo.replace('https://github.com/', '')}`, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'queryden-website-build' },
      signal: ctrl.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const json = await res.json() as { stargazers_count?: number };
    return typeof json.stargazers_count === 'number' ? json.stargazers_count : null;
  } catch {
    return null;
  }
}
export const STARS: number | null = await fetchStarCount();
export function formatStars(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return Math.round(n / 1000) + 'k';
}

// Topical announcement pill above the hero headline. Rotate per release
// — keep it specific, link to something concrete. Set to `null` to hide.
//   label: short verb phrase, e.g. "Read the encryption code"
//   detail: one quantitative clause, e.g. "300 lines of Rust"
//   href: deep link to the proof
export const ANNOUNCEMENT: { label: string; detail: string; href: string } | null = {
  label:  'Read the encryption code',
  detail: 'AES-256-GCM + Argon2id',
  href:   '/security',
};

export const NAV = [
  { href: '/#product',  label: 'Product' },
  { href: '/security',  label: 'Security' },
  { href: '/#compare',  label: 'Compare' },
  { href: '/changelog', label: 'Changelog' },
  { href: '/docs',      label: 'Docs' },
] as const;

// Receipts shown directly under the hero CTA. Numbers are measured against
// the current release v1.0.8. Update when you publish a new release:
//   - Installer size: from the GitHub release assets (native installers only)
//   - Cold start:     median of 5 stopwatch runs from launch → usable window
//   - Engines:        the connector list below
//   - Telemetry:      verify in the OS network monitor or DevTools
export const RECEIPTS = [
  { value: '~11 MB',     label: 'Installer',       detail: '7.9 MB on Windows · 10.8 MB macOS · 10.9 MB Linux .deb.' },
  { value: '6 engines',  label: 'One binary',      detail: 'Postgres · MySQL · MariaDB · SQLite · CockroachDB · Supabase.' },
  { value: '<TODO> s',   label: 'Cold start',      detail: 'Measured locally — replace with median of 5 stopwatch runs.' },
  { value: '0',          label: 'Telemetry calls', detail: 'Verify in the OS network monitor. Nothing phones home.' },
] as const;

// Competitor footprint shown as the "vs" line under the receipts.
// These are public/approximate ranges, not benchmarks. Linked so anyone
// can verify the source of the claim.
export const COMPETITOR_FOOTPRINT = [
  { name: 'DataGrip',     size: '~700 MB', ram: '~900 MB', stack: 'JetBrains JVM' },
  { name: 'DBeaver CE',   size: '~250 MB', ram: '~600 MB', stack: 'Eclipse / Java' },
  { name: 'Beekeeper',    size: '~200 MB', ram: '~400 MB', stack: 'Electron' },
  { name: 'pgAdmin 4',    size: '~200 MB', ram: '~350 MB', stack: 'Python + web' },
] as const;

export const PLATFORMS = [
  { os: 'macOS',   arch: 'Apple Silicon', ext: 'dmg',            primary: true  },
  { os: 'Windows', arch: 'x86_64',        ext: 'exe',            primary: true  },
  { os: 'Linux',   arch: 'x86_64',        ext: 'AppImage / deb', primary: true  },
] as const;

// ---------- Release metadata ----------
//
// The website fetches the actual latest release from the GitHub API at
// build time. Behavior depends on env vars:
//
//   QUERYDEN_REQUIRE_LIVE_RELEASE=1
//     Fail the build if the fetch fails. USE THIS IN PRODUCTION/CI
//     (Vercel project settings → Environment Variables → Production).
//     Prevents shipping a deploy with stale version info.
//
//   QUERYDEN_SKIP_GH_RELEASE=1
//     Force the fallback. Useful for offline local dev or reproducible
//     builds. Mutually exclusive with REQUIRE_LIVE_RELEASE.
//
//   (neither set, default)
//     Try live fetch; fall back silently to RELEASE_FALLBACK on error.
//     Suitable for local dev.
//
// RELEASE_FALLBACK is a manual snapshot — keep it roughly in sync with
// the latest release so failed-fetch dev builds still look sane.

export interface ReleaseAsset {
  os: string;
  arch: string;
  file: string;
  sizeMB: number;
  primary: boolean;
}
export interface Release {
  tag: string;
  publishedAt: string; // YYYY-MM-DD
  assets: ReleaseAsset[];
}

const RELEASE_FALLBACK: Release = {
  tag:         'v1.0.11',
  publishedAt: '2026-05-13',
  assets: [
    { os: 'macOS',   arch: 'Apple Silicon',     file: 'QueryDen_1.0.11_aarch64.dmg',    sizeMB: 11.2, primary: true  },
    { os: 'Windows', arch: 'x86_64',            file: 'QueryDen_1.0.11_x64-setup.exe',  sizeMB:  8.2, primary: true  },
    { os: 'Linux',   arch: 'x86_64 · .deb',     file: 'QueryDen_1.0.11_amd64.deb',      sizeMB: 11.4, primary: true  },
    { os: 'Linux',   arch: 'x86_64 · AppImage', file: 'QueryDen_1.0.11_amd64.AppImage', sizeMB: 83.9, primary: false },
  ],
};

// Maps a release asset filename to display metadata. Returns null for
// non-installer assets (sigs, checksums, updater manifest, app bundle).
function classifyAsset(name: string, sizeBytes: number): ReleaseAsset | null {
  if (/\.(sha256|sig)$/i.test(name)) return null;
  if (name === 'latest.json' || name.endsWith('.app.tar.gz')) return null;

  const sizeMB = Math.round((sizeBytes / 1024 / 1024) * 10) / 10;
  if (/_aarch64\.dmg$/i.test(name))   return { os: 'macOS',   arch: 'Apple Silicon',     file: name, sizeMB, primary: true  };
  if (/_x64-setup\.exe$/i.test(name)) return { os: 'Windows', arch: 'x86_64',            file: name, sizeMB, primary: true  };
  if (/_amd64\.deb$/i.test(name))     return { os: 'Linux',   arch: 'x86_64 · .deb',     file: name, sizeMB, primary: true  };
  if (/_amd64\.AppImage$/i.test(name))return { os: 'Linux',   arch: 'x86_64 · AppImage', file: name, sizeMB, primary: false };
  return null;
}

interface GhRelease {
  tag_name?: string;
  published_at?: string;
  assets?: Array<{ name?: string; size?: number }>;
}

async function fetchLatestRelease(): Promise<Release> {
  if (process.env.QUERYDEN_SKIP_GH_RELEASE === '1') {
    return RELEASE_FALLBACK;
  }
  const strict = process.env.QUERYDEN_REQUIRE_LIVE_RELEASE === '1';
  const failOrFallback = (reason: string): Release => {
    if (strict) {
      throw new Error(`[site.ts] QUERYDEN_REQUIRE_LIVE_RELEASE=1 and release fetch failed: ${reason}`);
    }
    console.warn(`[site.ts] release fetch failed (${reason}) — using RELEASE_FALLBACK`);
    return RELEASE_FALLBACK;
  };

  let res: Response;
  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 4000);
    res = await fetch(`https://api.github.com/repos/${SITE.repo.replace('https://github.com/', '')}/releases/latest`, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'queryden-website-build' },
      signal: ctrl.signal,
    });
    clearTimeout(timeout);
  } catch (e) {
    return failOrFallback(`network error: ${(e as Error).message}`);
  }
  if (!res.ok) return failOrFallback(`HTTP ${res.status}`);

  let json: GhRelease;
  try {
    json = await res.json() as GhRelease;
  } catch (e) {
    return failOrFallback(`malformed JSON: ${(e as Error).message}`);
  }
  if (!json.tag_name || !json.published_at || !Array.isArray(json.assets)) {
    return failOrFallback('missing tag_name / published_at / assets');
  }

  const assets = json.assets
    .map((a) => classifyAsset(a.name ?? '', a.size ?? 0))
    .filter((a): a is ReleaseAsset => a !== null);
  if (assets.length === 0) return failOrFallback('no installer assets classified');

  return {
    tag:         json.tag_name,
    publishedAt: json.published_at.slice(0, 10),
    assets,
  };
}

export const RELEASE: Release = await fetchLatestRelease();

export function downloadUrl(file: string): string {
  return `${SITE.repo}/releases/download/${RELEASE.tag}/${file}`;
}

export function shaUrl(file: string): string {
  return `${SITE.repo}/releases/download/${RELEASE.tag}/${file}.sha256`;
}
