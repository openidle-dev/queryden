import {
  HTMLAttributes,
  ReactNode,
  useEffect,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "../../lib/cn";
import { IconButton } from "./IconButton";

export type DialogSize = "sm" | "md" | "lg" | "xl";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  /** Width preset. Use `full` via className if you need something custom. */
  size?: DialogSize;
  /** Click on the backdrop closes the dialog. Default true. */
  dismissOnBackdrop?: boolean;
  /** Esc closes the dialog. Default true. */
  dismissOnEsc?: boolean;
  /** Optional class added to the dialog panel. */
  className?: string;
  /** Optional class added to the backdrop. */
  backdropClassName?: string;
  /** Initial focus element. Defaults to the dialog panel itself. */
  initialFocusRef?: React.RefObject<HTMLElement>;
  children: ReactNode;
}

const sizeClasses: Record<DialogSize, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-2xl",
};

/**
 * Headless modal dialog with portal, backdrop, and Esc/click-to-close.
 * Compose via Dialog.Title / Dialog.Body / Dialog.Footer.
 */
export function Dialog({
  open,
  onClose,
  size = "md",
  dismissOnBackdrop = true,
  dismissOnEsc = true,
  className,
  backdropClassName,
  initialFocusRef,
  children,
}: DialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    (initialFocusRef?.current ?? panelRef.current)?.focus();

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissOnEsc) {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      previouslyFocused?.focus?.();
    };
  }, [open, dismissOnEsc, onClose, initialFocusRef]);

  if (!open) return null;

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-[200] flex items-center justify-center p-4",
        "bg-black/60 backdrop-blur-sm",
        backdropClassName
      )}
      onClick={(e) => {
        if (e.target === e.currentTarget && dismissOnBackdrop) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        className={cn(
          "w-full outline-none",
          "bg-[var(--surface-elevated)] text-[var(--neutral-12)]",
          "border border-[var(--neutral-6)] rounded-lg shadow-2xl",
          "flex flex-col max-h-[calc(100vh-2rem)]",
          sizeClasses[size],
          className
        )}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}

// ---- Compound parts -------------------------------------------------------

export interface DialogTitleProps extends HTMLAttributes<HTMLDivElement> {
  onClose?: () => void;
  /** Optional accent strip color (e.g. for warning/info dialogs). */
  accentClassName?: string;
}

Dialog.Title = function DialogTitle({
  children,
  onClose,
  accentClassName,
  className,
  ...rest
}: DialogTitleProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-4 h-12 border-b border-[var(--neutral-6)]",
        "text-sm font-semibold text-[var(--neutral-12)]",
        accentClassName,
        className
      )}
      {...rest}
    >
      <div className="flex-1 min-w-0 truncate">{children}</div>
      {onClose && (
        <IconButton
          icon={<X />}
          label="Close"
          size="sm"
          variant="ghost"
          onClick={onClose}
        />
      )}
    </div>
  );
};

Dialog.Body = function DialogBody({
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex-1 overflow-auto px-4 py-4 text-sm text-[var(--neutral-12)]",
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
};

Dialog.Footer = function DialogFooter({
  children,
  className,
  ...rest
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex items-center justify-end gap-2 px-4 h-12 border-t border-[var(--neutral-6)]",
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
};
