import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

// Register a locally bundled Monaco with @monaco-editor/react so it doesn't
// reach for a CDN at runtime (the app's CSP forbids that anyway).
//
// This module is imported by every component that mounts a Monaco editor.
// Those components are themselves lazy-loaded, which keeps Monaco out of the
// cold-start bundle entirely — it only loads when the user first opens the
// query editor or one of the Monaco-using modals.
loader.config({ monaco });
