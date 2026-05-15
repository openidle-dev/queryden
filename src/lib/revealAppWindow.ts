/**
 * Reveal the Tauri main window after the React tree has painted.
 *
 * Tauri creates the window with `visible: false` so users never see the
 * empty/half-painted shell while WebView2 initializes and the bundle boots.
 * We show it after the first browser paint, with a hard fallback so a broken
 * render path can never leave the window invisible forever.
 */

const FAILSAFE_MS = 4000;

function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as Window & { __TAURI_INTERNALS__?: unknown };
  return !!w.__TAURI_INTERNALS__;
}

async function show(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  if (await win.isVisible()) return;
  await win.show();
  await win.setFocus();
}

export function revealAppWindow(): void {
  if (!isTauri()) return;

  let done = false;
  const reveal = () => {
    if (done) return;
    done = true;
    void show().catch((err) => {
      console.error("Failed to reveal app window:", err);
    });
  };

  // Wait two animation frames so the first paint has actually flushed
  // before we unhide the OS window — avoids a flash of empty chrome.
  requestAnimationFrame(() => requestAnimationFrame(reveal));

  // Failsafe: never let a render error keep the window hidden.
  setTimeout(reveal, FAILSAFE_MS);
}
