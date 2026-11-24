import { useRef, type MouseEvent } from "react";

/**
 * Decides whether a click on a modal backdrop should close it. The browser
 * sends `click` to the common ancestor of where the button went down and
 * where it came up, so dragging a scrollbar or selecting text inside a
 * dialog and releasing past its edge produces a click "on the backdrop".
 * Only a press that also started on the backdrop counts.
 */
export function createBackdropDismissTracker() {
  let pressedOnBackdrop = false;
  return {
    press(onBackdrop: boolean, button: number) {
      pressedOnBackdrop = onBackdrop && button === 0;
    },
    release(onBackdrop: boolean, button: number): boolean {
      const dismiss = pressedOnBackdrop && onBackdrop && button === 0;
      pressedOnBackdrop = false;
      return dismiss;
    },
  };
}

/** `onMouseDown` / `onClick` for a backdrop element that closes on a genuine backdrop click. */
export function useBackdropDismiss(onDismiss: () => void, enabled = true) {
  const tracker = useRef(createBackdropDismissTracker()).current;
  return {
    onMouseDown: (e: MouseEvent<HTMLElement>) => tracker.press(e.target === e.currentTarget, e.button),
    onClick: (e: MouseEvent<HTMLElement>) => {
      if (tracker.release(e.target === e.currentTarget, e.button) && enabled) onDismiss();
    },
  };
}
