import { ButtonHTMLAttributes, forwardRef, ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "../../lib/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
export type ButtonSize = "xs" | "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

const sizeClasses: Record<ButtonSize, string> = {
  xs: "h-6 px-2 text-[11px] gap-1 rounded-sm",
  sm: "h-7 px-2.5 text-xs gap-1.5 rounded-sm",
  md: "h-8 px-3 text-xs gap-2 rounded-md",
};

const variantClasses: Record<ButtonVariant, string> = {
  // Solid accent — for the single primary action in a view
  primary: cn(
    "bg-[var(--accent-9)] text-white",
    "hover:bg-[var(--accent-10)]",
    "active:bg-[var(--accent-10)]",
    "disabled:bg-[var(--neutral-6)] disabled:text-[var(--neutral-11)]"
  ),
  // Subtle elevated — for secondary / "Cancel" type actions
  secondary: cn(
    "bg-[var(--neutral-3)] text-[var(--neutral-12)] border border-[var(--neutral-6)]",
    "hover:bg-[var(--neutral-4)] hover:border-[var(--neutral-7)]",
    "active:bg-[var(--neutral-5)]",
    "disabled:bg-[var(--neutral-2)] disabled:text-[var(--neutral-9)] disabled:border-[var(--neutral-6)]"
  ),
  // Transparent rest — for toolbar / inline actions
  ghost: cn(
    "bg-transparent text-[var(--neutral-12)]",
    "hover:bg-[var(--neutral-4)]",
    "active:bg-[var(--neutral-5)]",
    "disabled:text-[var(--neutral-9)] disabled:hover:bg-transparent"
  ),
  // Destructive (delete / drop / disconnect)
  destructive: cn(
    "bg-[var(--danger-9)] text-white",
    "hover:bg-[var(--danger-10)]",
    "active:bg-[var(--danger-10)]",
    "disabled:bg-[var(--neutral-6)] disabled:text-[var(--neutral-11)]"
  ),
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    loading = false,
    leftIcon,
    rightIcon,
    disabled,
    className,
    children,
    type = "button",
    ...rest
  },
  ref
) {
  const isDisabled = disabled || loading;
  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      data-loading={loading || undefined}
      className={cn(
        "inline-flex items-center justify-center font-medium leading-none",
        "transition-colors select-none whitespace-nowrap",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-8)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--surface-base)]",
        "disabled:cursor-not-allowed",
        sizeClasses[size],
        variantClasses[variant],
        className
      )}
      {...rest}
    >
      {loading ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
      ) : (
        leftIcon
      )}
      {children}
      {!loading && rightIcon}
    </button>
  );
});
