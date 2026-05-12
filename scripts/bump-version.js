/**
 * Keep the four places that track QueryDen's version in lockstep:
 *   - package.json          (frontend)
 *   - src-tauri/Cargo.toml  (Rust crate manifest)
 *   - src-tauri/Cargo.lock  (Rust dependency lock — bumped via `cargo update`)
 *   - src-tauri/tauri.conf.json (bundle metadata)
 *
 * Usage:
 *   node scripts/bump-version.js patch        # 1.0.4 -> 1.0.5
 *   node scripts/bump-version.js minor        # 1.0.4 -> 1.1.0
 *   node scripts/bump-version.js major        # 1.0.4 -> 2.0.0
 *   node scripts/bump-version.js 1.2.3        # explicit target
 *   node scripts/bump-version.js              # defaults to "patch"
 *
 * After running, review the diff, commit, tag, and push:
 *   git add -A && git commit -m "chore: release vX.Y.Z"
 *   git tag vX.Y.Z && git push --tags
 *
 * The release workflow takes it from there.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const packagePath = path.join(rootDir, 'package.json');
const cargoTomlPath = path.join(rootDir, 'src-tauri', 'Cargo.toml');
const cargoLockPath = path.join(rootDir, 'src-tauri', 'Cargo.lock');
const tauriConfigPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function parseSemver(v) {
  if (!SEMVER_RE.test(v)) throw new Error(`Not a semver: ${v}`);
  return v.split('.').map(Number);
}

function computeNextVersion(current, arg) {
  if (SEMVER_RE.test(arg)) return arg;

  const [maj, min, pat] = parseSemver(current);
  switch (arg) {
    case 'patch': return `${maj}.${min}.${pat + 1}`;
    case 'minor': return `${maj}.${min + 1}.0`;
    case 'major': return `${maj + 1}.0.0`;
    default:
      throw new Error(`Unknown bump argument: "${arg}". Use patch | minor | major | X.Y.Z.`);
  }
}

function rewriteJson(file, mutate) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(data);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function rewriteCargoToml(file, newVersion) {
  // Match only the [package] version, not [dependencies] entries.
  const src = fs.readFileSync(file, 'utf8');
  const updated = src.replace(/^version = "[^"]*"/m, `version = "${newVersion}"`);
  if (updated === src) throw new Error(`Could not find package version line in ${file}`);
  fs.writeFileSync(file, updated);
}

function syncCargoLock(crate) {
  // `cargo update -p <crate>` is the lockfile-friendly way to refresh a
  // single package's entry; we use --offline so this doesn't hit the network.
  try {
    execSync(`cargo update -p ${crate} --offline`, {
      cwd: path.join(rootDir, 'src-tauri'),
      stdio: 'inherit',
    });
  } catch {
    console.warn(`[bump-version] cargo update failed; you may need to run "cargo check" once before tagging.`);
  }
}

function main() {
  const arg = process.argv[2] ?? 'patch';

  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const current = pkg.version;
  const next = computeNextVersion(current, arg);

  console.log(`Bumping ${current} -> ${next}`);

  rewriteJson(packagePath, (j) => { j.version = next; });
  console.log(`  package.json         -> ${next}`);

  rewriteCargoToml(cargoTomlPath, next);
  console.log(`  src-tauri/Cargo.toml -> ${next}`);

  rewriteJson(tauriConfigPath, (j) => { j.version = next; });
  console.log(`  tauri.conf.json      -> ${next}`);

  syncCargoLock(pkg.name);
  console.log(`  src-tauri/Cargo.lock -> ${next} (via cargo update)`);

  // Sanity check at the very end: make sure all four agree.
  const finalPkg = JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
  const finalToml = fs.readFileSync(cargoTomlPath, 'utf8').match(/^version = "([^"]+)"/m)?.[1];
  const finalConf = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8')).version;
  const finalLock = fs.readFileSync(cargoLockPath, 'utf8')
    .match(/name = "queryden"\nversion = "([^"]+)"/)?.[1];

  const all = [finalPkg, finalToml, finalConf, finalLock];
  if (new Set(all).size !== 1) {
    console.error(`\nDrift detected after bump: ${JSON.stringify({ finalPkg, finalToml, finalConf, finalLock })}`);
    process.exit(1);
  }

  console.log(`\nAll four files now report ${next}. Next:`);
  console.log(`  git add -A && git commit -m "chore: release v${next}"`);
  console.log(`  git tag v${next} && git push --follow-tags`);
}

try {
  main();
} catch (err) {
  console.error('bump-version failed:', err.message);
  process.exit(1);
}
