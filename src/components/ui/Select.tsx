import { forwardRef, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { cn } from "../../lib/cn";
import { edgeEnabledIndex, nextEnabledIndex, placeListbox, typeaheadIndex, type ListboxPlacement } from "./selectLogic";

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

  // Controlled (`value`) or uncontrolled (`defaultValue`) state.
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;

  disabled?: boolean;
  name?: string;
  id?: string;
  /** Optional class for the trigger. */
  className?: string;
}

/** Typed characters within this window add to one type-to-select search. */
const TYPEAHEAD_RESET_MS = 700;

/**
 * Theme-aware select: a button that opens a listbox in a portal. The native
 * `<select>` dropdown on Windows ignores dark theme entirely (#151).
 *
 * Replaces the Radix Select this wrapper used to render: Radix gives every
 * option a new ref callback on each render and sets state from those refs
 * while React commits, which could chain into "Maximum update depth
 * exceeded" when a Select re-rendered while open.
 *
 * Keyboard: ↑/↓/Enter/Space open; ↑/↓/Home/End/PageUp/PageDown move;
 * Enter/Space choose; Escape/Tab close; typing jumps to a matching option.
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
  const listId = `${selectId}-listbox`;
  const hasError = !!error;

  const [uncontrolled, setUncontrolled] = useState(defaultValue);
  const current = value !== undefined ? value : uncontrolled;
  const selectedIndex = options.findIndex((o) => o.value === current);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [placement, setPlacement] = useState<ListboxPlacement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const typeahead = useRef<{ text: string; at: number }>({ text: "", at: 0 });

  const setTriggerRef = useCallback((node: HTMLButtonElement | null) => {
    triggerRef.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  }, [ref]);

  const openList = (startAt?: number) => {
    if (disabled) return;
    setActive(startAt ?? (selectedIndex >= 0 && !options[selectedIndex].disabled ? selectedIndex : edgeEnabledIndex(options, "first")));
    setPlacement(null);
    setOpen(true);
  };

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const choose = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    if (value === undefined) setUncontrolled(option.value);
    if (option.value !== current) onValueChange?.(option.value);
    close();
  };

  // Measure once the list is in the DOM, before paint, so it never flashes in the wrong spot.
  const reposition = useCallback(() => {
    const trigger = triggerRef.current?.getBoundingClientRect();
    const list = listRef.current;
    if (!trigger || !list) return;
    const next = placeListbox(
      trigger,
      { width: list.scrollWidth, height: list.scrollHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setPlacement((prev) => (prev && prev.top === next.top && prev.left === next.left && prev.maxHeight === next.maxHeight && prev.minWidth === next.minWidth ? prev : next));
  }, []);

  useLayoutEffect(() => {
    if (open) reposition();
  }, [open, options.length, reposition]);

  // Keep the highlighted option in view.
  useEffect(() => {
    if (!open || active < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, placement]);

  // Close on a press outside. Follow the field when the window resizes or a
  // container around it scrolls; scrolling elsewhere (a grid, a console)
  // leaves the list alone.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || listRef.current?.contains(target)) return;
      close(false);
    };
    const onScroll = (e: Event) => {
      const target = e.target;
      const trigger = triggerRef.current;
      if (!trigger || target === listRef.current) return;
      if (target === document || (target instanceof Node && target.contains(trigger))) reposition();
    };
    document.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", reposition);
    };
    // close/reposition only touch refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // An option list that loses the active option (e.g. it finished loading) keeps a valid highlight.
  useEffect(() => {
    if (open && (active >= options.length || (active >= 0 && options[active]?.disabled))) {
      setActive(edgeEnabledIndex(options, "first"));
    }
  }, [open, options, active]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const key = e.key;
    if (!open) {
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
        e.preventDefault();
        openList(key === "ArrowUp" && selectedIndex < 0 ? edgeEnabledIndex(options, "last") : undefined);
      }
      return;
    }
    const pageStep = (dir: 1 | -1) => {
      let i = active;
      for (let k = 0; k < 10; k++) {
        const next = nextEnabledIndex(options, i, dir);
        if (next < 0 || (dir === 1 ? next < i : next > i)) break;
        i = next;
      }
      return i;
    };
    switch (key) {
      case "ArrowDown": e.preventDefault(); setActive((i) => nextEnabledIndex(options, i, 1)); return;
      case "ArrowUp": e.preventDefault(); setActive((i) => nextEnabledIndex(options, i, -1)); return;
      case "Home": e.preventDefault(); setActive(edgeEnabledIndex(options, "first")); return;
      case "End": e.preventDefault(); setActive(edgeEnabledIndex(options, "last")); return;
      case "PageDown": e.preventDefault(); setActive(pageStep(1)); return;
      case "PageUp": e.preventDefault(); setActive(pageStep(-1)); return;
      case "Enter":
      case " ":
        e.preventDefault();
        if (key === " " && typeahead.current.text && Date.now() - typeahead.current.at < TYPEAHEAD_RESET_MS) {
          // A space inside a typed search ("my db") is part of the search.
          break;
        }
        choose(active);
        return;
      case "Escape":
        // The list's own Escape: a surrounding dialog must stay open.
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      case "Tab":
        close(false);
        return;
    }
    if (key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const now = Date.now();
      const text = now - typeahead.current.at < TYPEAHEAD_RESET_MS ? typeahead.current.text + key : key;
      typeahead.current = { text, at: now };
      const match = typeaheadIndex(options, text, active);
      if (match >= 0) setActive(match);
    }
  };

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

      <button
        ref={setTriggerRef}
        id={selectId}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        aria-invalid={hasError || undefined}
        aria-describedby={error ? `${selectId}-error` : hint ? `${selectId}-hint` : undefined}
        disabled={disabled}
        data-placeholder={selected ? undefined : ""}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onKeyDown}
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
        <span className="truncate">{selected ? selected.label : current ? current : placeholder}</span>
        <ChevronDown className="w-3.5 h-3.5 shrink-0 text-[var(--neutral-11)]" />
      </button>
      {name && <input type="hidden" name={name} value={current ?? ""} />}

      {open && createPortal(
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-labelledby={label ? undefined : selectId}
          className={cn(
            "fixed z-[300] overflow-y-auto p-1",
            "bg-[var(--surface-overlay)] text-[var(--neutral-12)]",
            "border border-[var(--neutral-6)] rounded-md shadow-xl",
          )}
          style={placement
            ? { top: placement.top, left: placement.left, minWidth: placement.minWidth, maxHeight: placement.maxHeight }
            : { top: 0, left: 0, visibility: "hidden" }}
          // Keep focus on the trigger, which drives keyboard navigation.
          onMouseDown={(e) => e.preventDefault()}
        >
          {options.map((opt, index) => {
            const isSelected = opt.value === current;
            return (
              <div
                key={opt.value}
                id={`${listId}-${index}`}
                data-index={index}
                role="option"
                aria-selected={isSelected}
                aria-disabled={opt.disabled || undefined}
                onMouseMove={() => { if (!opt.disabled && active !== index) setActive(index); }}
                onClick={() => choose(index)}
                className={cn(
                  "relative flex items-center gap-2 px-2 py-1.5 pr-7 rounded-sm",
                  "text-xs whitespace-nowrap select-none",
                  opt.disabled
                    ? "text-[var(--neutral-9)] cursor-not-allowed"
                    : "cursor-pointer",
                  !opt.disabled && index === active && "bg-[var(--accent-9)] text-white",
                )}
              >
                {opt.label}
                {isSelected && (
                  <span className="absolute right-2 inline-flex items-center">
                    <Check className="w-3.5 h-3.5" />
                  </span>
                )}
              </div>
            );
          })}
        </div>,
        document.body,
      )}

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
