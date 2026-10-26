import { loader } from "@monaco-editor/react";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";

// Slim Monaco entry: the core editor + standalone runtime, with **no** built-in
// language modes or language workers. The default `monaco-editor` entry
// (`editor/editor.main.js`) pulls in ~80 basic-languages contributions plus
// four language workers (JSON, TS, CSS, HTML) that we never use — QueryDen
// only edits SQL.
//
// This is `editor.main.js` without its language imports: the shared editor
// features, the contributions `editor.main.js` adds on top of them (the
// suggest widget and document semantic tokens among them — without those,
// completion and table/alias colouring silently stop), and the API.
// `monacoSetup.test.ts` fails if a Monaco upgrade adds one we don't import.
//
// We then re-add only the SQL Monarch contribution for syntax highlighting in
// the query editor, Compare dialog, and Definition viewer. SQL autocomplete
// and hover providers are registered dynamically in QueryEditor at mount time.
import "monaco-editor/features/register.all.js";
import "monaco-editor/editor/browser/coreCommands.js";
import "monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js";
import "monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution.js";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js";
import "monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus.js";
import "monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens.js";
import "monaco-editor/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/editor/common/standaloneStrings.js";
import "monaco-editor/languages/definitions/sql/register.js";
import * as monacoRuntime from "monaco-editor/editor/editor.api.js";

// Borrow the namespace types from the main entry without dragging its runtime.
import type * as MonacoTypes from "monaco-editor";
const monaco = monacoRuntime as typeof MonacoTypes;

// Wire the editor worker so Monaco doesn't log "Could not create web worker(s)"
// and fall back to main-thread execution for diff / search / link computation.
// Vite's `?worker` import returns a constructor that bundles the worker into
// its own self-contained chunk at build time. CSP already permits this via
// the `worker-src 'self' blob:` directive in tauri.conf.json. See #102.
//
// Only the base editor worker is wired here — the JSON/TS/CSS/HTML language
// workers are intentionally absent because this entry doesn't load those
// language services.
self.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

// Register a locally bundled Monaco with @monaco-editor/react so it doesn't
// reach for a CDN at runtime (the app's CSP forbids that anyway).
//
// This module is imported by every component that mounts a Monaco editor.
// Those components are themselves lazy-loaded, which keeps Monaco out of the
// cold-start bundle entirely — it only loads when the user first opens the
// query editor or one of the Monaco-using modals.
loader.config({ monaco });

// Re-export the slim namespace for callers that need `monaco.Range`,
// `monaco.KeyMod`, etc. (e.g. `QueryEditor.tsx`).
export { monaco };
