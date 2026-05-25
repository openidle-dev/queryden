import { useState, createContext, useContext, ReactNode } from "react";
import { AlertTriangle, CheckCircle, Info, HelpCircle } from "lucide-react";
import { Dialog } from "./Dialog";
import { Button } from "./Button";
import { Input } from "./Input";
import { IconButton } from "./IconButton";

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

// Maps the four dialog types to their accent icon, accent color token, and
// confirm button variant. Keeps the visual contract identical to the previous
// bespoke implementation while sourcing colors from the design system tokens.
const typeMeta = {
  warning: { Icon: AlertTriangle, color: "var(--warning-9)",  confirm: "primary"     as const },
  info:    { Icon: Info,          color: "var(--accent-9)",   confirm: "primary"     as const },
  success: { Icon: CheckCircle,   color: "var(--success-9)",  confirm: "primary"     as const },
  danger:  { Icon: AlertTriangle, color: "var(--danger-9)",   confirm: "destructive" as const },
};

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

  const type = options?.type || "warning";
  const meta = typeMeta[type];

  return (
    <ConfirmDialogContext.Provider value={{ confirm: openConfirm, dialog: openDialog }}>
      {children}
      <Dialog open={isOpen && !!options} onClose={handleCancel} size="md">
        {options && (
          <>
            <Dialog.Title accentClassName="border-l-2" onClose={handleCancel}>
              <span className="inline-flex items-center gap-2">
                <meta.Icon className="w-4 h-4" style={{ color: meta.color }} />
                <span>{options.title}</span>
              </span>
              {options.helpInstructions && (
                <IconButton
                  icon={<HelpCircle />}
                  label="How to enable this?"
                  size="sm"
                  variant="ghost"
                  onClick={(e) => { e.stopPropagation(); setShowHelp(!showHelp); }}
                  className="ml-2"
                />
              )}
            </Dialog.Title>

            <Dialog.Body>
              <p className="text-xs text-[var(--neutral-11)]">{options.message}</p>

              {showHelp && options.helpInstructions && (
                <div className="mt-4 p-3 bg-[var(--accent-3)] border border-[var(--accent-6)] rounded-md text-[10px] space-y-2">
                  <div className="font-bold flex items-center gap-1 text-[var(--neutral-12)]">
                    <Info className="w-3 h-3" />
                    How to enable / allow this:
                  </div>
                  <div className="whitespace-pre-line text-[var(--neutral-11)]">
                    {options.helpInstructions}
                  </div>
                </div>
              )}

              {options.inputLabel && (
                <div className="mt-4">
                  {options.selectOptions ? (
                    // Native select kept here because Radix Select rejects
                    // empty-string values ("No Profile" sentinel uses ""). Migration
                    // to Radix tracked under #152.
                    <div className="flex flex-col gap-1 min-w-0">
                      <label className="text-xs font-medium text-[var(--neutral-12)] select-none">
                        {options.inputLabel}
                      </label>
                      <select
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        className="h-9 px-3 text-sm bg-[var(--surface-base)] border border-[var(--neutral-7)] rounded-md outline-none text-[var(--neutral-12)] focus:border-[var(--accent-8)] focus:ring-1 focus:ring-[var(--accent-8)]/30 cursor-pointer"
                        autoFocus
                      >
                        <option value="">No Profile (Manual Login)</option>
                        {options.selectOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <Input
                      label={options.inputLabel}
                      type={options.inputType || "text"}
                      value={inputValue}
                      onChange={(e) => setInputValue(e.target.value)}
                      placeholder={options.inputPlaceholder}
                      autoFocus
                    />
                  )}
                </div>
              )}
            </Dialog.Body>

            <Dialog.Footer>
              <Button variant="ghost" size="sm" onClick={handleCancel}>
                {options.cancelLabel || "Cancel"}
              </Button>
              <Button
                variant={meta.confirm}
                size="sm"
                onClick={handleConfirm}
                disabled={options.requireInput && inputValue.trim() === ""}
              >
                {options.confirmLabel || "Confirm"}
              </Button>
            </Dialog.Footer>
          </>
        )}
      </Dialog>
    </ConfirmDialogContext.Provider>
  );
}
