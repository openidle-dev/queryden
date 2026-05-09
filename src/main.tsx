import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { loader } from "@monaco-editor/react";

// Configure Monaco loader to use a specific stable version and avoid source map 404s
// This fix works consistently across Linux and Windows.
loader.config({
  paths: {
    vs: "https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs"
  }
});

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);