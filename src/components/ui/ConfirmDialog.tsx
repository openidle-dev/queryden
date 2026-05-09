import { useState, createContext, useContext, ReactNode } from "react";
import { AlertTriangle, CheckCircle, Info, HelpCircle } from "lucide-react";

interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  type?: "warning" | "info" | "success" | "danger";
  onConfirm?: () => void;
  onCancel?: () => void;
  helpInstructions?: string;
}

interface DialogOptions extends ConfirmOptions {
  inputLabel?: string;
  inputPlaceholder?: string;
  inputDefaultValue?: string;
  requireInput?: boolean;
  onInput?: (value: string) => void;
  inputType?: string;
  selectOptions?: { label: string; value: string }[];
}

interface ConfirmDialogContextType {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  dialog: (options: DialogOptions) => Promise<string | null>;
}

const ConfirmDialogContext = createContext<ConfirmDialogContextType | null>(null);

export function useConfirmDialog() {
  const ctx = useContext(ConfirmDialogContext);
  if (!ctx) {
    return {
      confirm: async (_opts: ConfirmOptions) => true,
      dialog: async (_opts: DialogOptions) => null
    };
  }
  return ctx;
}

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [options, setOptions] = useState<DialogOptions | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [resolvePromise, setResolvePromise] = useState<((value: string | boolean | null) => void) | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const openConfirm = (opts: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setOptions({ ...opts, type: opts.type || "warning" });
      setInputValue("");
      setShowHelp(false);
      setResolvePromise(() => resolve);
      setIsOpen(true);
    });
  };

  const openDialog = (opts: DialogOptions): Promise<string | null> => {
    return new Promise((resolve) => {
      setOptions(opts);
      setInputValue(opts.inputDefaultValue || (opts.selectOptions?.length ? opts.selectOptions[0].value : ""));
      setResolvePromise(() => resolve);
      setIsOpen(true);
    });
  };

  const handleConfirm = () => {
    if (options?.requireInput && inputValue.trim() === "") return;
    resolvePromise?.(inputValue || true);
    setIsOpen(false);
  };

  const handleCancel = () => {
    resolvePromise?.(null);
    setIsOpen(false);
  };

  const typeColors = {
    warning: "border-[var(--color-warning)] bg-[var(--surface)] text-[var(--color-warning)]",
    info: "border-[var(--color-info)] bg-[var(--surface)] text-[var(--color-info)]",
    success: "border-[var(--color-success)] bg-[var(--surface)] text-[var(--color-success)]",
    danger: "border-[var(--color-error)] bg-[var(--surface)] text-[var(--color-error)]",
  };

  const typeIcons = {
    warning: AlertTriangle,
    info: Info,
    success: CheckCircle,
    danger: AlertTriangle,
  };

  return (
    <ConfirmDialogContext.Provider value={{ confirm: openConfirm, dialog: openDialog }}>
      {children}
      {isOpen && options && (
        <div className="fixed inset-0 z-[200] bg-black/60 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className={`bg-[var(--surface)] rounded-lg shadow-2xl w-full max-w-md border ${typeColors[options.type || "warning"]}`}>
            <div className="p-4 border-b border-[var(--border)] flex items-center gap-3">
              {(() => {
                const IconComp = typeIcons[options.type || "warning"];
                return <IconComp className="w-5 h-5" />;
              })()}
              <h2 className="text-sm font-semibold flex-1 text-[var(--text-primary)]">{options.title}</h2>
              {options.helpInstructions && (
                <button 
                  onClick={() => setShowHelp(!showHelp)}
                  className="p-1 hover:bg-[var(--border)] rounded transition-colors text-[var(--text-secondary)]"
                  title="How to enable this?"
                >
                  <HelpCircle className="w-4 h-4" />
                </button>
              )}
            </div>
            <div className="p-4">
              <p className="text-xs text-[var(--text-secondary)]">{options.message}</p>
              
              {showHelp && options.helpInstructions && (
                <div className="mt-4 p-3 bg-blue-500/10 border border-blue-500/20 rounded-md text-[10px] space-y-2">
                  <div className="font-bold flex items-center gap-1">
                    <Info className="w-3 h-3" />
                    How to enable / allow this:
                  </div>
                  <div className="whitespace-pre-line text-[var(--text-secondary)]">
                    {options.helpInstructions}
                  </div>
                </div>
              )}
              {options.inputLabel && (
                <div className="mt-4">
                  <label className="text-xs font-medium block mb-1 text-[var(--text-primary)]">{options.inputLabel}</label>
                  {options.selectOptions ? (
                    <select
                      value={inputValue}
                      onChange={(e) => setInputValue(e.target.value)}
                      className="w-full bg-[var(--background)] border border-[var(--border)] rounded px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
                      autoFocus
                    >
                      <option value="">No Profile (Manual Login)</option>
                      {options.selectOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={options.inputType || "text"}
                      value={inputValue}
                      onChange={(e) => setInputValue(e.target.value)}
                      placeholder={options.inputPlaceholder}
                      className="w-full bg-[var(--background)] border border-[var(--border)] rounded px-3 py-2 text-sm outline-none focus:border-[var(--color-accent)]"
                      autoFocus
                    />
                  )}
                </div>
              )}
            </div>
            <div className="p-4 border-t border-[var(--border)] flex justify-end gap-2">
              <button
                onClick={handleCancel}
                className="px-4 py-2 text-xs rounded hover:bg-[var(--surface-hover)] text-[var(--text-secondary)]"
              >
                {options.cancelLabel || "Cancel"}
              </button>
              <button
                onClick={handleConfirm}
                disabled={options.requireInput && inputValue.trim() === ""}
                className="px-4 py-2 text-xs rounded bg-[var(--color-accent)] hover:opacity-80 disabled:opacity-30"
              >
                {options.confirmLabel || "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmDialogContext.Provider>
  );
}