import { useState, useEffect } from "react";
import { Sparkles, Send } from "lucide-react";
import { useAI } from "../../store/aiStore";
import { callAI } from "../../lib/ai";
import { Dialog } from "../ui/Dialog";
import { Button } from "../ui/Button";

interface AIAssistantDialogProps {
  isOpen: boolean;
  onClose: () => void;
  currentQuery: string;
  onUpdateQuery: (query: string) => void;
}

const SUGGESTIONS = ["Optimize current query", "Generate JOINs for active tables", "Explain query plan"];

export function AIAssistantDialog({ isOpen, onClose, currentQuery, onUpdateQuery }: AIAssistantDialogProps) {
  const ai = useAI();
  const [prompt, setPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setPrompt("");
      setError(null);
    }
  }, [isOpen]);

  const handleGenerate = async () => {
    if (!prompt.trim() || !ai.enabled || isGenerating) return;
    setIsGenerating(true);
    setError(null);

    try {
      const systemPrompt = `You are an expert SQL query assistant. Your task is to help users write, optimize, and understand SQL queries. Follow these rules:
- Return ONLY the SQL query, no explanations or markdown formatting unless the user explicitly asks.
- If the user provides an existing query, analyze and modify it according to their request.
- If no query exists, generate a new one based on the user's description.
- Use appropriate SQL features and best practices for the likely database engine.
- Add helpful comments for complex logic.
- Keep responses concise and focused on the SQL.`;

      const userPrompt = currentQuery
        ? `Existing query:\n${currentQuery}\n\nRequest: ${prompt}`
        : prompt;

      const result = await callAI(systemPrompt, userPrompt);
      if (result) {
        onUpdateQuery(result);
      }
      onClose();
    } catch (err: any) {
      setError(err?.message || "AI request failed. Check your API key and endpoint settings.");
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <Dialog open={isOpen} onClose={onClose} size="xl">
      <Dialog.Title onClose={onClose} className="bg-gradient-to-r from-[var(--accent-3)] to-transparent">
        <span className="inline-flex items-center gap-3">
          <span className="p-1.5 bg-[var(--accent-3)] rounded-lg">
            <Sparkles className="w-4 h-4 text-[var(--accent-11)]" />
          </span>
          <span className="flex flex-col leading-tight">
            <span>AI SQL Assistant</span>
            {ai.enabled && ai.apiKey && (
              <span className="text-[10px] font-normal text-[var(--neutral-11)] uppercase tracking-widest">
                Powered by {ai.provider} • {ai.model}
              </span>
            )}
          </span>
        </span>
      </Dialog.Title>

      <Dialog.Body>
        {!ai.enabled || !ai.apiKey ? (
          <div className="bg-[var(--warning-3)] border border-[var(--warning-6)] rounded-md p-4 text-center">
            <p className="text-[var(--warning-11)] font-bold mb-2">AI is not configured</p>
            <p className="text-xs text-[var(--neutral-11)]">Enable AI and add your API key in Settings to use the assistant.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div>
              <label className="block text-xs font-medium text-[var(--neutral-12)] mb-2">What do you want to do?</label>
              <div className="relative">
                <textarea
                  autoFocus
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="e.g. 'Write a query to find the top 5 customers by order volume this month' or 'Optimize the current query for speed'"
                  className="w-full h-32 p-4 pb-12 bg-[var(--surface-base)] border border-[var(--accent-6)] rounded-lg outline-none focus:border-[var(--accent-6)] resize-none text-sm text-[var(--neutral-12)] placeholder:text-[var(--neutral-9)]"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleGenerate();
                    }
                  }}
                />
                <div className="absolute bottom-3 right-3 flex items-center gap-2">
                  <span className="text-[10px] text-[var(--neutral-11)]">Shift+Enter for newline, Enter to send</span>
                  <Button
                    onClick={handleGenerate}
                    loading={isGenerating}
                    disabled={!prompt.trim()}
                    size="sm"
                    leftIcon={isGenerating ? undefined : <Send className="w-3.5 h-3.5" />}
                    className="bg-[var(--accent-9)] hover:bg-[var(--accent-10)] text-white disabled:bg-[var(--neutral-6)] disabled:text-[var(--neutral-11)]"
                  >
                    Generate
                  </Button>
                </div>
              </div>
            </div>

            {error && (
              <div className="bg-[var(--danger-3)] border border-[var(--danger-6)] rounded-md p-3 text-sm text-[var(--danger-11)]">
                {error}
              </div>
            )}
            <div className="flex gap-2.5">
              {SUGGESTIONS.map(suggestion => (
                <Button
                  key={suggestion}
                  onClick={() => setPrompt(suggestion)}
                  variant="secondary"
                  size="xs"
                  className="flex-1 text-[var(--neutral-11)] hover:text-[var(--accent-11)] hover:border-[var(--accent-6)]"
                >
                  {suggestion}
                </Button>
              ))}
            </div>
          </div>
        )}
      </Dialog.Body>
    </Dialog>
  );
}
