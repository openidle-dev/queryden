import {
  ReactNode,
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";

export type TooltipSide = "top" | "bottom" | "left" | "right";

export interface TooltipProps {
  content: ReactNode;
  /** Side to render on. Default `top`. */
  side?: TooltipSide;
  /** Show delay in ms. Default 300. */
  delay?: number;
  /** Optional class for the tooltip body. */
  className?: string;
  /** Wrapped trigger element. Must accept ref. */
  children: ReactNode;
}

const sideOffset = 6;

/**
 * Minimal hover/focus tooltip. Uses a portal so it isn't clipped by `overflow:hidden`
 * parents — important inside resizable panels and modal dialogs.
 *
 * Not a full positioning engine: it doesn't flip when near the viewport edge.
 * Reach for a real library (Floating UI) when we need that.
 */
export function Tooltip({
  content,
  side = "top",
  delay = 300,
  className,
  children,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLElement | null>(null);
  const timeoutRef = useRef<number | null>(null);

  const show = () => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => setOpen(true), delay);
  };
  const hide = () => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    setOpen(false);
  };

  useEffect(() => () => {
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
  }, []);

  useEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    let top = 0;
    let left = 0;
    switch (side) {
      case "top":
        top = rect.top - sideOffset;
        left = rect.left + rect.width / 2;
        break;
      case "bottom":
        top = rect.bottom + sideOffset;
        left = rect.left + rect.width / 2;
        break;
      case "left":
        top = rect.top + rect.height / 2;
        left = rect.left - sideOffset;
        break;
      case "right":
        top = rect.top + rect.height / 2;
        left = rect.right + sideOffset;
        break;
    }
    setPos({ top, left });
  }, [open, side]);

  // Wrap a single element trigger and forward our handlers + ref.
  let trigger: ReactNode = children;
  if (isValidElement(children)) {
    const child = children as React.ReactElement<any>;
    trigger = cloneElement(child, {
      ref: (node: HTMLElement | null) => {
        triggerRef.current = node;
        const childRef = (child as any).ref;
        if (typeof childRef === "function") childRef(node);
        else if (childRef && typeof childRef === "object") childRef.current = node;
      },
      onMouseEnter: (e: React.MouseEvent) => {
        child.props.onMouseEnter?.(e);
        show();
      },
      onMouseLeave: (e: React.MouseEvent) => {
        child.props.onMouseLeave?.(e);
        hide();
      },
      onFocus: (e: React.FocusEvent) => {
        child.props.onFocus?.(e);
        show();
      },
      onBlur: (e: React.FocusEvent) => {
        child.props.onBlur?.(e);
        hide();
      },
    });
  }

  const translate =
    side === "top"
      ? "translate(-50%, -100%)"
      : side === "bottom"
      ? "translate(-50%, 0%)"
      : side === "left"
      ? "translate(-100%, -50%)"
      : "translate(0%, -50%)";

  return (
    <>
      {trigger}
      {open &&
        createPortal(
          <div
            role="tooltip"
            style={{ top: pos.top, left: pos.left, transform: translate }}
            className={cn(
              "fixed z-[300] pointer-events-none",
              "px-2 py-1 text-[11px] leading-tight rounded-md",
              "bg-[var(--surface-overlay)] text-[var(--neutral-12)]",
              "border border-[var(--neutral-6)] shadow-lg",
              "whitespace-nowrap max-w-xs",
              className
            )}
          >
            {content}
          </div>,
          document.body
        )}
    </>
  );
}
