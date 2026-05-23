import { SelectHTMLAttributes, forwardRef, useId } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/cn";

export interface SelectOption {
  label: string;
  value: string;
  disabled?: boolean;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: string;
  error?: string;
  options: SelectOption[];
  /** Visual size; controls height + font size. */
  selectSize?: "sm" | "md";
  /** Optional placeholder rendered as the first disabled option. */
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  {
    label,
    hint,
    error,
    options,
    placeholder,
    selectSize = "md",
    id,
    className,
    disabled,
    ...rest
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
      <div
        className={cn(
          "relative flex items-center w-full",
          "bg-[var(--surface-base)]",
          "border rounded-md transition-colors",
          hasError
            ? "border-[var(--danger-9)] focus-within:border-[var(--danger-10)] focus-within:ring-1 focus-within:ring-[var(--danger-9)]/30"
            : "border-[var(--neutral-7)] focus-within:border-[var(--accent-8)] focus-within:ring-1 focus-within:ring-[var(--accent-8)]/30",
          disabled && "opacity-60 cursor-not-allowed"
        )}
      >
        <select
          ref={ref}
          id={selectId}
          disabled={disabled}
          aria-invalid={hasError || undefined}
          aria-describedby={error ? `${selectId}-error` : hint ? `${selectId}-hint` : undefined}
          className={cn(
            "appearance-none w-full pr-8 bg-transparent outline-none",
            "text-[var(--neutral-12)]",
            "disabled:cursor-not-allowed",
            selectSize === "sm" ? "h-7 pl-2.5 text-xs" : "h-9 pl-3 text-sm",
            className
          )}
          {...rest}
        >
          {placeholder && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options.map((opt) => (
            <option key={opt.value} value={opt.value} disabled={opt.disabled}>
              {opt.label}
            </option>
          ))}
        </select>
        <ChevronDown
          className="pointer-events-none absolute right-2 w-3.5 h-3.5 text-[var(--neutral-11)]"
          aria-hidden="true"
        />
      </div>
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
