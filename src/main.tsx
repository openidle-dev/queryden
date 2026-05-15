import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { revealAppWindow } from "./lib/revealAppWindow";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);

revealAppWindow();
