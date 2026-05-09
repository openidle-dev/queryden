import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

// ── Types ──────────────────────────────────────────────────────────

export interface UpdateCheckResult {
  update_available: boolean;
  current_version: string;
  latest_version: string;
  release_name: string | null;
  changelog: string | null;
  release_url: string;
  published_at: string | null;
  download_url: string | null;
  download_size: number | null;
  asset_name: string | null;
}

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
  result: UpdateCheckResult | null;
  downloadPath: string | null;
  downloadProgress: number;
  error: string | null;
  buildDate: string | null;
  /** Whether the notification badge was dismissed by the user */
  dismissed: boolean;

  // Actions
  checkForUpdates: () => Promise<void>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  dismiss: () => void;
  reset: () => void;
  fetchBuildDate: () => Promise<void>;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  phase: 'idle',
  result: null,
  downloadPath: null,
  downloadProgress: 0,
  error: null,
  buildDate: null,
  dismissed: false,

  checkForUpdates: async () => {
    set({ phase: 'checking', error: null, dismissed: false });
    try {
      const result = await invoke<UpdateCheckResult>('check_for_updates_v2');
      set({
        result,
        phase: result.update_available ? 'available' : 'up-to-date',
      });
    } catch (err: any) {
      set({
        phase: 'error',
        error: err?.toString() ?? 'Failed to check for updates',
      });
    }
  },

  downloadUpdate: async () => {
    const { result } = get();
    if (!result?.download_url || !result?.asset_name) {
      set({ phase: 'error', error: 'No download URL available for this platform' });
      return;
    }

    set({ phase: 'downloading', downloadProgress: 0, error: null });

    try {
      const path = await invoke<string>('download_update', {
        url: result.download_url,
        assetName: result.asset_name,
      });
      set({ phase: 'ready', downloadPath: path, downloadProgress: 100 });
    } catch (err: any) {
      set({
        phase: 'error',
        error: err?.toString() ?? 'Download failed',
      });
    }
  },

  installUpdate: async () => {
    const { downloadPath } = get();
    if (!downloadPath) {
      set({ phase: 'error', error: 'No downloaded update found' });
      return;
    }
    set({ phase: 'installing', error: null });

    try {
      await invoke('install_update', { filePath: downloadPath });
      // The app will exit after this, but just in case:
      set({ phase: 'idle' });
    } catch (err: any) {
      set({
        phase: 'error',
        error: err?.toString() ?? 'Installation failed',
      });
    }
  },

  dismiss: () => set({ dismissed: true }),

  reset: () =>
    set({
      phase: 'idle',
      result: null,
      downloadPath: null,
      downloadProgress: 0,
      error: null,
      dismissed: false,
    }),

  fetchBuildDate: async () => {
    try {
      const date = await invoke<string>('get_build_info');
      set({ buildDate: date });
    } catch {
      set({ buildDate: 'dev' });
    }
  },
}));
