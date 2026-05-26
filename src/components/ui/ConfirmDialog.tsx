import { useState, createContext, useContext, ReactNode } from "react";
import { AlertTriangle, CheckCircle, Info, HelpCircle } from "lucide-react";
import { Dialog } from "./Dialog";
import { Button } from "./Button";
import { Input } from "./Input";
import { IconButton } from "./IconButton";
import { Select } from "./Select";

// Radix Select forbids empty-string item values, but the "No Profile" choice
// uses "" by design. Map it through this sentinel for the Select and back.
const NO_PROFILE_SENTINEL = "__no_profile__";

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
            <Dialog.Title onClose={handleCancel}>
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
                    <Select
                      label={options.inputLabel}
                      value={inputValue === "" ? NO_PROFILE_SENTINEL : inputValue}
                      onValueChange={(v) => setInputValue(v === NO_PROFILE_SENTINEL ? "" : v)}
                      options={[
                        { label: "No Profile (Manual Login)", value: NO_PROFILE_SENTINEL },
                        ...options.selectOptions.map((opt) => ({ label: opt.label, value: opt.value })),
                      ]}
                    />
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
