import { ButtonHTMLAttributes, forwardRef, HTMLAttributes, ReactNode, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../../lib/cn";

/**
 * Presentational popover/context-menu primitives.
 *
 * These are intentionally *not* trigger-bound (no Radix wrapper): the app's
 * context menus are positioned at the cursor (right-click over a canvas grid,
 * where per-cell DOM triggers don't exist) and the consumers already own the
 * open/close lifecycle (cursor coords + a global outside-click listener). The
 * primitive standardizes only the chrome — surface, border, item hover tones,
 * labels, separators, and submenu layout.
 */

export type MenuTone = "default" | "success" | "warning" | "danger";

const toneHover: Record<MenuTone, string> = {
  default: "hover:bg-[var(--accent-9)] hover:text-white",
  success: "hover:bg-[var(--success-9)] hover:text-white",
  warning: "hover:bg-[var(--warning-9)] hover:text-white",
  danger: "hover:bg-[var(--danger-9)] hover:text-white",
};

const itemBase =
  "w-full px-3 py-1.5 text-left text-[11px] flex items-center gap-2 transition-colors cursor-pointer outline-none disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-inherit";

const panelChrome =
  "bg-[var(--surface-overlay)] border border-[var(--neutral-6)] rounded-xl shadow-2xl py-1.5";

export interface MenuProps extends HTMLAttributes<HTMLDivElement> {
  /** Viewport coordinates for fixed positioning (e.g. from a contextmenu event). */
  x?: number;
  y?: number;
}

/**
 * Fixed-position menu container. Pass `x`/`y` (viewport coords, e.g.
 * `clientX`/`clientY` from a contextmenu event) to anchor at the cursor; the
 * position is clamped into the viewport so the menu never renders off-screen.
 * The consumer is responsible for closing it (outside click / Escape). Stops
 * click propagation so clicks inside the menu don't trigger the outside-click
 * close.
 */
export const Menu = forwardRef<HTMLDivElement, MenuProps>(function Menu(
  { x, y, className, style, onClick, children, ...rest },
  ref
) {
  const positioned = x !== undefined || y !== undefined;
  const innerRef = useRef<HTMLDivElement>(null);
  const [clamped, setClamped] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!positioned) {
      setClamped(null);
      return;
    }
    const el = innerRef.current;
    const w = el?.offsetWidth ?? 224;
    const h = el?.offsetHeight ?? 320;
    const left = Math.max(4, Math.min(x ?? 4, window.innerWidth - w - 4));
    const top = Math.max(4, Math.min(y ?? 4, window.innerHeight - h - 4));
    setClamped((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
  }, [x, y, children, positioned]);

  return (
    <div
      ref={(node) => {
        (innerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
      }}
      className={cn(
        positioned && "fixed z-[100]",
        "w-56",
        panelChrome,
        "animate-in zoom-in-95 duration-100",
        className
      )}
      style={positioned ? { top: clamped?.top ?? y, left: clamped?.left ?? x, ...style } : style}
      onClick={(e) => {
        e.stopPropagation();
        onClick?.(e);
      }}
      {...rest}
    >
      {children}
    </div>
  );
});

export interface MenuItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ReactNode;
  /** Hover accent — map destructive actions to "danger", etc. */
  tone?: MenuTone;
  /** Right-aligned content (e.g. a submenu chevron or shortcut hint). */
  rightSlot?: ReactNode;
}

export const MenuItem = forwardRef<HTMLButtonElement, MenuItemProps>(function MenuItem(
  { icon, tone = "default", rightSlot, className, children, type = "button", ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(itemBase, toneHover[tone], rightSlot && "justify-between", className)}
      {...rest}
    >
      {rightSlot ? (
        <>
          <span className="flex items-center gap-2 min-w-0">
            {icon}
            {children}
          </span>
          {rightSlot}
        </>
      ) : (
        <>
          {icon}
          {children}
        </>
      )}
    </button>
  );
});

export interface MenuLabelProps extends HTMLAttributes<HTMLDivElement> {
  /** Adds a bottom rule under the label (used for the first/section header). */
  bordered?: boolean;
  /** Dimmed treatment used for nested-submenu headers. */
  subtle?: boolean;
}

export function MenuLabel({ bordered, subtle, className, children, ...rest }: MenuLabelProps) {
  return (
    <div
      className={cn(
        "px-3 py-1 text-[9px] uppercase font-bold text-[var(--neutral-11)] tracking-widest mb-1",
        bordered && "border-b border-[var(--neutral-6)] pb-1",
        subtle && "opacity-60",
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function MenuSeparator({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("my-1 border-t border-[var(--neutral-6)] opacity-50", className)} {...rest} />;
}

export interface MenuSubProps {
  icon?: ReactNode;
  label: ReactNode;
  /** Width of the nested panel. */
  width?: string;
  children: ReactNode;
}

/** Gap kept between a flyout and the window edge. */
const VIEWPORT_MARGIN = 4;
/** The flyout overlaps its parent menu by this much so the pointer can cross over. */
const FLYOUT_OVERLAP = 8;

export interface FlyoutPlacement {
  /** Open to the right of the trigger, or flip to its left. */
  side: "right" | "left";
  /** Offset from the trigger's top; negative shifts the panel up so it fits. */
  top: number;
}

/**
 * Where a submenu panel goes so all of it stays in the window: beside the
 * trigger on the side with room, shifted up (a drop-up) when it would run
 * past the bottom edge.
 */
export function placeFlyout(
  trigger: { top: number; left: number; right: number },
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
): FlyoutPlacement {
  const fitsRight = trigger.right - FLYOUT_OVERLAP + panel.width <= viewport.width - VIEWPORT_MARGIN;
  const fitsLeft = trigger.left + FLYOUT_OVERLAP - panel.width >= VIEWPORT_MARGIN;
  const side = fitsRight || !fitsLeft ? "right" : "left";
  const overflowBottom = trigger.top + panel.height - (viewport.height - VIEWPORT_MARGIN);
  const shiftUp = Math.max(0, overflowBottom);
  // Never push the panel above the window's top edge.
  const top = 0 - Math.min(shiftUp, Math.max(0, trigger.top - VIEWPORT_MARGIN));
  return { side, top };
}

/**
 * Hover-expanding submenu. The trigger row matches MenuItem styling; the
 * nested panel reuses the same chrome and opens beside the trigger, flipping
 * left and/or up when the window edge would cut it off.
 */
export function MenuSub({ icon, label, width = "w-48", children }: MenuSubProps) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<FlyoutPlacement | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    const trigger = triggerRef.current?.getBoundingClientRect();
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    const next = placeFlyout(
      trigger,
      { width: panel.offsetWidth, height: panel.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPlacement((prev) => (prev && prev.side === next.side && prev.top === next.top ? prev : next));
  }, [open, children]);

  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        ref={triggerRef}
        type="button"
        className={cn(itemBase, toneHover.default, "justify-between", open && "bg-[var(--accent-9)] text-white")}
        onClick={() => setOpen(true)}
      >
        <span className="flex items-center gap-2 min-w-0">
          {icon}
          {label}
        </span>
        <ChevronRight className="w-3 h-3 opacity-50" />
      </button>
      {open && (
        <div
          ref={panelRef}
          className={cn(
            "absolute z-10",
            width,
            panelChrome,
            placement?.side === "left" ? "right-[calc(100%-8px)]" : "left-[calc(100%-8px)]",
          )}
          // Measured before it is shown, so it never flashes in the wrong spot.
          style={{ top: placement?.top ?? 0, visibility: placement ? "visible" : "hidden" }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
