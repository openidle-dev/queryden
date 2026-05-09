import { create } from "zustand";

export type AIProvider = "openai" | "anthropic" | "google" | "local";

interface AIState {
  provider: AIProvider;
  apiKey: string;
  model: string;
  endpoint: string;
  enabled: boolean;
  setProvider: (p: AIProvider) => void;
  setApiKey: (k: string) => void;
  setModel: (m: string) => void;
  setEndpoint: (e: string) => void;
  setEnabled: (e: boolean) => void;
}

export const useAI = create<AIState>()((set) => ({
  provider: "openai",
  apiKey: "",
  model: "gpt-4o",
  endpoint: "",
  enabled: false,
  setProvider: (provider) => set({ provider }),
  setApiKey: (apiKey) => set({ apiKey }),
  setModel: (model) => set({ model }),
  setEndpoint: (endpoint) => set({ endpoint }),
  setEnabled: (enabled) => set({ enabled }),
}));
