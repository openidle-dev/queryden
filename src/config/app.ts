import { getName, getVersion } from '@tauri-apps/api/app';

let cachedInfo: { name: string; version: string } | null = null;

export async function getAppConfig() {
  if (cachedInfo) return cachedInfo;
  try {
    const [name, version] = await Promise.all([getName(), getVersion()]);
    cachedInfo = { name, version };
    return cachedInfo;
  } catch {
    return { name: 'QueryDen', version: '0.1.0' };
  }
}

export const APP_NAME_FALLBACK = 'QueryDen';
export const APP_VERSION_FALLBACK = '1.0.1';

export function getDefaultDatabaseName(): string {
  const name = cachedInfo?.name || APP_NAME_FALLBACK;
  return `${name.toLowerCase()}.db`;
}

export function getConnectionsFileName(): string {
  const name = cachedInfo?.name || APP_NAME_FALLBACK;
  return `${name.toLowerCase()}-connections.json`;
}