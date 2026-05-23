import { ButtonHTMLAttributes, forwardRef, ReactNode } from "react";
import { cn } from "../../lib/cn";
import type { ButtonVariant, ButtonSize } from "./Button";

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: ReactNode;
  /** Accessible label, also used as native tooltip via `title`. */
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const sizeClasses: Record<ButtonSize, string> = {
  xs: "h-6 w-6 rounded-sm [&_svg]:w-3 [&_svg]:h-3",
  sm: "h-7 w-7 rounded-sm [&_svg]:w-3.5 [&_svg]:h-3.5",
  md: "h-8 w-8 rounded-md [&_svg]:w-4 [&_svg]:h-4",
};

const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-[var(--accent-9)] text-white hover:bg-[var(--accent-10)] disabled:bg-[var(--neutral-6)] disabled:text-[var(--neutral-11)]",
  secondary: "bg-[var(--neutral-3)] text-[var(--neutral-12)] border border-[var(--neutral-6)] hover:bg-[var(--neutral-4)] disabled:bg-[var(--neutral-2)] disabled:text-[var(--neutral-9)]",
  ghost: "bg-transparent text-[var(--neutral-11)] hover:bg-[var(--neutral-4)] hover:text-[var(--neutral-12)] disabled:text-[var(--neutral-8)] disabled:hover:bg-transparent",
  destructive: "bg-[var(--danger-9)] text-white hover:bg-[var(--danger-10)] disabled:bg-[var(--neutral-6)] disabled:text-[var(--neutral-11)]",
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    icon,
    label,
    variant = "ghost",
    size = "md",
    className,
    type = "button",
    title,
    "aria-label": ariaLabel,
    ...rest
  },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={ariaLabel || label}
      title={title || label}
      className={cn(
        "inline-flex items-center justify-center",
        "transition-colors select-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-8)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--surface-base)]",
        "disabled:cursor-not-allowed",
        sizeClasses[size],
        variantClasses[variant],
        className
      )}
      {...rest}
    >
      {icon}
    </button>
  );
});
