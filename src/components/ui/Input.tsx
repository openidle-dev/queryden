import { InputHTMLAttributes, ReactNode, forwardRef, useId } from "react";
import { cn } from "../../lib/cn";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  leftIcon?: ReactNode;
  rightSlot?: ReactNode;
  /** Visual size; controls height + font size. */
  inputSize?: "sm" | "md";
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    label,
    hint,
    error,
    leftIcon,
    rightSlot,
    inputSize = "md",
    id,
    className,
    disabled,
    ...rest
  },
  ref
) {
  const fallbackId = useId();
  const inputId = id || fallbackId;
  const hasError = !!error;

  return (
    <div className="flex flex-col gap-1 min-w-0">
      {label && (
        <label
          htmlFor={inputId}
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
        {leftIcon && (
          <span className="pl-2 text-[var(--neutral-11)] [&_svg]:w-3.5 [&_svg]:h-3.5">
            {leftIcon}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          disabled={disabled}
          aria-invalid={hasError || undefined}
          aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
          className={cn(
            "flex-1 min-w-0 bg-transparent outline-none",
            "text-[var(--neutral-12)] placeholder:text-[var(--neutral-9)]",
            "disabled:cursor-not-allowed",
            inputSize === "sm" ? "h-7 px-2.5 text-xs" : "h-9 px-3 text-sm",
            className
          )}
          {...rest}
        />
        {rightSlot && (
          <span className="pr-2 text-[var(--neutral-11)] [&_svg]:w-3.5 [&_svg]:h-3.5">
            {rightSlot}
          </span>
        )}
      </div>
      {(hint || error) && (
        <p
          id={error ? `${inputId}-error` : `${inputId}-hint`}
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
