import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const packagePath = path.join(rootDir, 'package.json');
const cargoPath = path.join(rootDir, 'src-tauri', 'Cargo.toml');
const tauriConfigPath = path.join(rootDir, 'src-tauri', 'tauri.conf.json');

function bumpVersion() {
  // 1. Bump package.json
  const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
  const versionParts = pkg.version.split('.');
  versionParts[2] = parseInt(versionParts[2]) + 1;
  const newVersion = versionParts.join('.');
  pkg.version = newVersion;
  fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`Bumping package.json version to ${newVersion}`);

  // 2. Bump Cargo.toml
  let cargo = fs.readFileSync(cargoPath, 'utf8');
  cargo = cargo.replace(/^version = ".*"/m, `version = "${newVersion}"`);
  fs.writeFileSync(cargoPath, cargo);
  console.log(`Bumping Cargo.toml version to ${newVersion}`);

  // 3. Bump tauri.conf.json
  const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8'));
  tauriConfig.version = newVersion;
  fs.writeFileSync(tauriConfigPath, JSON.stringify(tauriConfig, null, 2) + '\n');
  console.log(`Bumping tauri.conf.json version to ${newVersion}`);

  return newVersion;
}

try {
  bumpVersion();
} catch (err) {
  console.error('Failed to bump version:', err);
  process.exit(1);
}
