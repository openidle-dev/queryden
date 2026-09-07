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
    setClamped({
      left: Math.max(4, Math.min(x ?? 4, window.innerWidth - w - 4)),
      top: Math.max(4, Math.min(y ?? 4, window.innerHeight - h - 4)),
    });
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

/**
 * Hover-expanding submenu. The trigger row matches MenuItem styling; the nested
 * panel reuses the same chrome and flies out to the right on hover.
 */
export function MenuSub({ icon, label, width = "w-48", children }: MenuSubProps) {
  return (
    <div className="relative group/submenu">
      <button type="button" className={cn(itemBase, toneHover.default, "justify-between")}>
        <span className="flex items-center gap-2 min-w-0">
          {icon}
          {label}
        </span>
        <ChevronRight className="w-3 h-3 opacity-50" />
      </button>
      <div
        className={cn(
          "hidden group-hover/submenu:block absolute left-[calc(100%-8px)] top-0",
          width,
          panelChrome,
          "animate-in slide-in-from-left-1 duration-150"
        )}
      >
        {children}
      </div>
    </div>
  );
}
