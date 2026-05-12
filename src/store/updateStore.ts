import { create } from 'zustand';
import { invokeCmd, UpdateCheckResultDto } from '../lib/ipc';

// ── Types ──────────────────────────────────────────────────────────

export type UpdateCheckResult = UpdateCheckResultDto;

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
      const result = await invokeCmd('check_for_updates_v2');
      set({
        result,
        phase: result.update_available ? 'available' : 'up-to-date',
      });
    } catch (err: unknown) {
      set({
        phase: 'error',
        error: String(err ?? 'Failed to check for updates'),
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
      const path = await invokeCmd('download_update', {
        url: result.download_url,
        assetName: result.asset_name,
      });
      set({ phase: 'ready', downloadPath: path, downloadProgress: 100 });
    } catch (err: unknown) {
      set({
        phase: 'error',
        error: String(err ?? 'Download failed'),
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
      await invokeCmd('install_update', { filePath: downloadPath });
      // The app will exit after this, but just in case:
      set({ phase: 'idle' });
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
      result: null,
      downloadPath: null,
      downloadProgress: 0,
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
