import { create } from 'zustand';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { getVersion } from '@tauri-apps/api/app';
import { invokeCmd } from '../lib/ipc';

// ── Types ──────────────────────────────────────────────────────────

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error';

interface UpdateState {
  phase: UpdatePhase;
  /** The pending update returned by tauri-plugin-updater, or null. */
  update: Update | null;
  /** Installed version. Populated on every check, regardless of phase. */
  currentVersion: string | null;
  /** 0..100, kept in sync with download events. */
  downloadProgress: number;
  downloadedBytes: number;
  totalBytes: number | null;
  error: string | null;
  buildDate: string | null;
  /** Whether the user dismissed the notification badge for this update. */
  dismissed: boolean;

  // Actions
  checkForUpdates: () => Promise<void>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  dismiss: () => void;
  reset: () => void;
  fetchBuildDate: () => Promise<void>;
}

/**
 * Derive the public release page URL for a given version. The plugin
 * doesn't expose this — we synthesise it so the UI can offer "View on
 * GitHub" links.
 */
export function releaseUrl(version: string): string {
  return `https://github.com/openidle-dev/queryden/releases/tag/v${version}`;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  phase: 'idle',
  update: null,
  currentVersion: null,
  downloadProgress: 0,
  downloadedBytes: 0,
  totalBytes: null,
  error: null,
  buildDate: null,
  dismissed: false,

  checkForUpdates: async () => {
    set({ phase: 'checking', error: null, dismissed: false });
    try {
      const update = await check();
      const currentVersion = update?.currentVersion ?? (await getVersion());
      if (update) {
        set({ update, currentVersion, phase: 'available' });
      } else {
        set({ update: null, currentVersion, phase: 'up-to-date' });
      }
    } catch (err: unknown) {
      set({
        phase: 'error',
        error: String(err ?? 'Failed to check for updates'),
      });
    }
  },

  downloadUpdate: async () => {
    const { update } = get();
    if (!update) {
      set({ phase: 'error', error: 'No update available' });
      return;
    }

    set({
      phase: 'downloading',
      downloadProgress: 0,
      downloadedBytes: 0,
      totalBytes: null,
      error: null,
    });

    try {
      await update.download((event) => {
        if (event.event === 'Started') {
          set({ totalBytes: event.data.contentLength ?? null });
        } else if (event.event === 'Progress') {
          const downloaded = get().downloadedBytes + event.data.chunkLength;
          const total = get().totalBytes;
          set({
            downloadedBytes: downloaded,
            downloadProgress: total
              ? Math.min(100, (downloaded / total) * 100)
              : 0,
          });
        } else if (event.event === 'Finished') {
          set({ downloadProgress: 100 });
        }
      });
      set({ phase: 'ready' });
    } catch (err: unknown) {
      set({
        phase: 'error',
        error: String(err ?? 'Download failed'),
      });
    }
  },

  installUpdate: async () => {
    const { update } = get();
    if (!update) {
      set({ phase: 'error', error: 'No update downloaded' });
      return;
    }
    set({ phase: 'installing', error: null });

    try {
      await update.install();
      // The plugin's install() doesn't auto-restart on most platforms.
      // We tell the process plugin to relaunch so the user lands on the
      // new build instead of staring at a closed window.
      await relaunch();
    } catch (err: unknown) {
      set({
        phase: 'error',
        error: String(err ?? 'Installation failed'),
      });
    }
  },

  dismiss: () => set({ dismissed: true }),

  reset: () =>
    set({
      phase: 'idle',
      update: null,
      downloadProgress: 0,
      downloadedBytes: 0,
      totalBytes: null,
      error: null,
      dismissed: false,
    }),

  fetchBuildDate: async () => {
    try {
      const date = await invokeCmd('get_build_info');
      set({ buildDate: date });
    } catch {
      set({ buildDate: 'dev' });
    }
  },
}));
