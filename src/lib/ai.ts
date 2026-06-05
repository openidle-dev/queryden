import { useAI } from "../store/aiStore";

export async function callAI(systemPrompt: string, userPrompt: string): Promise<string> {
  const ai = useAI.getState();

  if (!ai.enabled || !ai.apiKey) {
    throw new Error("AI is not configured");
  }

  let endpoint = "";
  let body: Record<string, any> = {};
  let headers: Record<string, string> = {};

  if (ai.provider === "openai") {
    endpoint = ai.endpoint || "https://api.openai.com/v1/chat/completions";
    headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${ai.apiKey}`,
    };
    body = {
      model: ai.model || "gpt-5.5",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 2000,
      temperature: 0.3,
    };
  } else if (ai.provider === "anthropic") {
    endpoint = ai.endpoint || "https://api.anthropic.com/v1/messages";
    headers = {
      "Content-Type": "application/json",
      "x-api-key": ai.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    };
    body = {
      model: ai.model || "claude-sonnet-4-6",
      messages: [{ role: "user", content: userPrompt }],
      system: systemPrompt,
      max_tokens: 2000,
    };
  } else if (ai.provider === "google") {
    endpoint = ai.endpoint || `https://generativelanguage.googleapis.com/v1beta/models/${ai.model || "gemini-3.5-flash"}:generateContent?key=${ai.apiKey}`;
    headers = { "Content-Type": "application/json" };
    body = {
      contents: [{ parts: [{ text: `System: ${systemPrompt}\n\nUser: ${userPrompt}` }] }],
      generationConfig: { maxOutputTokens: 2000, temperature: 0.3 },
    };
  } else if (ai.provider === "local") {
    endpoint = ai.endpoint || "http://localhost:11434/api/chat";
    body = {
      model: ai.model || "llama3.2",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      stream: false,
    };
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`AI API error (${response.status}): ${err}`);
  }

  const result = await response.json();

  if (ai.provider === "openai") {
    return result.choices?.[0]?.message?.content || "";
  } else if (ai.provider === "anthropic") {
    return result.content?.[0]?.text || "";
  } else if (ai.provider === "google") {
    return result.candidates?.[0]?.content?.parts?.[0]?.text || "";
  } else if (ai.provider === "local") {
    return result.message?.content || "";
  }
  return "";
}
