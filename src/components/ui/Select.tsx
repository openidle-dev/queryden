import { forwardRef, useId } from "react";
import * as RadixSelect from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "../../lib/cn";

export interface SelectOption {
  label: string;
  value: string;
  disabled?: boolean;
}

export interface SelectProps {
  label?: string;
  hint?: string;
  error?: string;
  options: SelectOption[];
  /** Visual size; controls trigger height + font size. */
  selectSize?: "sm" | "md";
  /** Placeholder shown when no value is selected. */
  placeholder?: string;

  // Radix-compatible state props (controlled or uncontrolled)
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;

  disabled?: boolean;
  name?: string;
  id?: string;
  /** Optional class for the trigger. */
  className?: string;
}

/**
 * Theme-aware Select wrapping Radix Select for portal-rendered, keyboard-navigable,
 * a11y-correct dropdowns. The native `<select>` dropdown on Windows ignores dark
 * theme entirely — Radix gives us a styled popover we control completely.
 *
 * See GitHub issue #151.
 */
export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  {
    label,
    hint,
    error,
    options,
    placeholder,
    selectSize = "md",
    value,
    defaultValue,
    onValueChange,
    disabled,
    name,
    id,
    className,
  },
  ref
) {
  const fallbackId = useId();
  const selectId = id || fallbackId;
  const hasError = !!error;

  return (
    <div className="flex flex-col gap-1 min-w-0">
      {label && (
        <label
          htmlFor={selectId}
          className="text-xs font-medium text-[var(--neutral-12)] select-none"
        >
          {label}
        </label>
      )}

      <RadixSelect.Root
        value={value}
        defaultValue={defaultValue}
        onValueChange={onValueChange}
        disabled={disabled}
        name={name}
      >
        <RadixSelect.Trigger
          ref={ref}
          id={selectId}
          aria-invalid={hasError || undefined}
          aria-describedby={error ? `${selectId}-error` : hint ? `${selectId}-hint` : undefined}
          className={cn(
            "inline-flex items-center justify-between w-full gap-2",
            "bg-[var(--surface-base)] text-[var(--neutral-12)]",
            "border rounded-md transition-colors cursor-pointer",
            "focus:outline-none focus:ring-1",
            "data-[placeholder]:text-[var(--neutral-9)]",
            "disabled:cursor-not-allowed disabled:opacity-60",
            hasError
              ? "border-[var(--danger-9)] focus:border-[var(--danger-10)] focus:ring-[var(--danger-9)]/30"
              : "border-[var(--neutral-7)] focus:border-[var(--accent-8)] focus:ring-[var(--accent-8)]/30",
            selectSize === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3 text-sm",
            className
          )}
        >
          <RadixSelect.Value placeholder={placeholder} />
          <RadixSelect.Icon>
            <ChevronDown className="w-3.5 h-3.5 text-[var(--neutral-11)]" />
          </RadixSelect.Icon>
        </RadixSelect.Trigger>

        <RadixSelect.Portal>
          <RadixSelect.Content
            position="popper"
            sideOffset={4}
            className={cn(
              "z-[300] overflow-hidden",
              "bg-[var(--surface-overlay)] text-[var(--neutral-12)]",
              "border border-[var(--neutral-6)] rounded-md shadow-xl",
              "min-w-[var(--radix-select-trigger-width)] max-h-[var(--radix-select-content-available-height)]"
            )}
          >
            <RadixSelect.ScrollUpButton className="flex items-center justify-center h-6 bg-[var(--surface-overlay)] cursor-default">
              <ChevronUp className="w-3.5 h-3.5 text-[var(--neutral-11)]" />
            </RadixSelect.ScrollUpButton>

            <RadixSelect.Viewport className="p-1">
              {options.map((opt) => (
                <RadixSelect.Item
                  key={opt.value}
                  value={opt.value}
                  disabled={opt.disabled}
                  className={cn(
                    "relative flex items-center gap-2 px-2 py-1.5 pr-7 rounded-sm",
                    "text-xs text-[var(--neutral-12)]",
                    "outline-none cursor-pointer select-none",
                    "data-[highlighted]:bg-[var(--accent-9)] data-[highlighted]:text-white",
                    "data-[disabled]:text-[var(--neutral-9)] data-[disabled]:cursor-not-allowed"
                  )}
                >
                  <RadixSelect.ItemText>{opt.label}</RadixSelect.ItemText>
                  <RadixSelect.ItemIndicator className="absolute right-2 inline-flex items-center">
                    <Check className="w-3.5 h-3.5" />
                  </RadixSelect.ItemIndicator>
                </RadixSelect.Item>
              ))}
            </RadixSelect.Viewport>

            <RadixSelect.ScrollDownButton className="flex items-center justify-center h-6 bg-[var(--surface-overlay)] cursor-default">
              <ChevronDown className="w-3.5 h-3.5 text-[var(--neutral-11)]" />
            </RadixSelect.ScrollDownButton>
          </RadixSelect.Content>
        </RadixSelect.Portal>
      </RadixSelect.Root>

      {(hint || error) && (
        <p
          id={error ? `${selectId}-error` : `${selectId}-hint`}
          className={cn(
            "text-[11px] leading-tight",
            hasError ? "text-[var(--danger-11)]" : "text-[var(--neutral-11)]"
          )}
        >
          {error || hint}
        </p>
      )}
    </div>
  );
});
