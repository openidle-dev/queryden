import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

// Bundle Monaco locally instead of pulling it from a CDN at runtime. This
// removes a network dependency for a desktop SQL editor and keeps everything
// inside the app's CSP.
loader.config({ monaco });

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);