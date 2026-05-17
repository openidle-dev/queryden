import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

const splashStartedAt = performance.now();
const MIN_SPLASH_MS = 700;
const FADE_MS = 320;

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// Fade out the boot splash once React has painted AND a minimum on-screen
// time has elapsed. Without the minimum, a fast warm boot can flash the
// splash for ~80 ms — long enough to be perceptible, too short to be read.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    const elapsed = performance.now() - splashStartedAt;
    const remaining = Math.max(0, MIN_SPLASH_MS - elapsed);
    setTimeout(() => {
      const splash = document.getElementById("qd-splash");
      if (!splash) return;
      splash.classList.add("qd-splash--fade");
      setTimeout(() => splash.remove(), FADE_MS);
    }, remaining);
  });
});
