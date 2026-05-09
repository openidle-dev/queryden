import { create } from "zustand";
import { useSettings } from "./settingsStore";

interface VaultState {
  hasVaultEnabled: boolean;
  setHasVaultEnabled: (enabled: boolean) => void;
  initFromSettings: () => void;
}

// Vault state is stored in settings (via Rust backend)
// This store provides a convenient interface, reading from settings
export const useVault = create<VaultState>((set) => ({
  hasVaultEnabled: true,
  
  setHasVaultEnabled: (enabled: boolean) => {
    set({ hasVaultEnabled: enabled });
    // Persist to settings (which saves to Rust backend)
    useSettings.getState().setSetting('hasVaultEnabled', enabled);
  },
  
  initFromSettings: () => {
    const settings = useSettings.getState();
    if (settings.hasVaultEnabled !== undefined) {
      set({ hasVaultEnabled: settings.hasVaultEnabled });
    }
  },
}));
