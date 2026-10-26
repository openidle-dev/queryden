import { invokeCmd, type AiModelDto } from "./ipc";
import { useAI, type AIProvider } from "../store/aiStore";

export type AIModel = AiModelDto;

/** Local servers (Ollama, LM Studio) accept requests without a key. */
export function providerNeedsApiKey(provider: AIProvider): boolean {
  return provider !== "local";
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

// Tauri rejects with the Rust `Err(String)`; callers expect `Error.message`.
function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

export async function listModels(provider: AIProvider, endpoint: string, apiKey: string): Promise<AIModel[]> {
  try {
    return await invokeCmd("ai_list_models", {
      provider,
      endpoint: blankToNull(endpoint),
      apiKey: blankToNull(apiKey),
    });
  } catch (e) {
    throw toError(e);
  }
}

export async function callAI(systemPrompt: string, userPrompt: string): Promise<string> {
  const ai = useAI.getState();

  if (!ai.enabled || (providerNeedsApiKey(ai.provider) && !ai.apiKey.trim())) {
    throw new Error("AI is not configured");
  }
  if (!ai.model.trim()) {
    throw new Error("No AI model selected. Pick one in Settings → AI Assistant.");
  }

  try {
    return await invokeCmd("ai_complete", {
      provider: ai.provider,
      endpoint: blankToNull(ai.endpoint),
      apiKey: blankToNull(ai.apiKey),
      model: ai.model.trim(),
      systemPrompt,
      userPrompt,
    });
  } catch (e) {
    throw toError(e);
  }
}
