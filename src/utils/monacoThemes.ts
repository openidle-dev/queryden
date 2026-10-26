// Monaco renders its own canvas/DOM and ignores the app's CSS variables, so
// every app theme maps to a dedicated Monaco theme. Chrome colours mirror the
// app tokens in globals.css; syntax colours follow DataGrip's Darcula (dark,
// blue) and IntelliJ Light (light) schemes: orange keywords, purple
// tables/columns, green strings, blue numbers, grey italic comments.
// Token names come from `components/editor/sqlLanguage.ts` (`*.sql`).

type Monaco = typeof import("monaco-editor");
type TokenRule = import("monaco-editor").editor.ITokenThemeRule;

export const QUERYDEN_DARK_THEME = "queryden-dark";
export const QUERYDEN_LIGHT_THEME = "queryden-light";
export const QUERYDEN_BLUE_THEME = "queryden-blue";

const DARCULA_RULES: TokenRule[] = [
  { token: "", foreground: "A9B7C6" },
  { token: "keyword", foreground: "CC7832" },
  { token: "type", foreground: "CC7832" },
  { token: "predefined", foreground: "FFC66D" },
  { token: "identifier", foreground: "9876AA" },
  { token: "identifier.quote", foreground: "9876AA" },
  // Semantic tokens (sqlLanguage.ts): tables / schemas / aliases.
  { token: "table", foreground: "4FC1C4" },
  { token: "schema", foreground: "6FA3A5" },
  { token: "alias", foreground: "9876AA", fontStyle: "italic" },
  { token: "function", foreground: "FFC66D" },
  { token: "string", foreground: "6A8759" },
  { token: "string.quote", foreground: "6A8759" },
  { token: "string.escape", foreground: "CC7832" },
  { token: "number", foreground: "6897BB" },
  { token: "comment", foreground: "808080", fontStyle: "italic" },
  { token: "variable", foreground: "B389C5", fontStyle: "italic" },
  { token: "operator", foreground: "A9B7C6" },
  { token: "delimiter", foreground: "CC7832" },
  { token: "delimiter.dot", foreground: "A9B7C6" },
  { token: "delimiter.parenthesis", foreground: "A9B7C6" },
  { token: "delimiter.square", foreground: "A9B7C6" },
];

const INTELLIJ_LIGHT_RULES: TokenRule[] = [
  { token: "", foreground: "080808" },
  { token: "keyword", foreground: "0033B3" },
  { token: "type", foreground: "0033B3" },
  { token: "predefined", foreground: "00627A" },
  { token: "identifier", foreground: "871094" },
  { token: "identifier.quote", foreground: "871094" },
  { token: "table", foreground: "00807F" },
  { token: "schema", foreground: "3F7F7E" },
  { token: "alias", foreground: "871094", fontStyle: "italic" },
  { token: "function", foreground: "00627A" },
  { token: "string", foreground: "067D17" },
  { token: "string.quote", foreground: "067D17" },
  { token: "string.escape", foreground: "0037A6" },
  { token: "number", foreground: "1750EB" },
  { token: "comment", foreground: "8C8C8C", fontStyle: "italic" },
  { token: "variable", foreground: "6B2FBA", fontStyle: "italic" },
  { token: "operator", foreground: "080808" },
  { token: "delimiter", foreground: "080808" },
];

let themesDefined = false;

/** Register QueryDen's custom Monaco themes. Safe to call on every editor mount. */
export function defineMonacoThemes(monaco: Monaco): void {
  if (themesDefined) return;

  monaco.editor.defineTheme(QUERYDEN_DARK_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: DARCULA_RULES,
    colors: {
      "editor.foreground": "#A9B7C6",
    },
  });

  monaco.editor.defineTheme(QUERYDEN_LIGHT_THEME, {
    base: "vs",
    inherit: true,
    rules: INTELLIJ_LIGHT_RULES,
    colors: {
      "editor.foreground": "#080808",
    },
  });

  monaco.editor.defineTheme(QUERYDEN_BLUE_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: DARCULA_RULES,
    colors: {
      "editor.background": "#0b1020",                    // --neutral-1
      "editor.foreground": "#e6e9f2",                    // --neutral-12
      "editorLineNumber.foreground": "#5b6580",          // --neutral-9
      "editorLineNumber.activeForeground": "#9aa3bd",    // --neutral-11
      "editor.lineHighlightBackground": "#0f1526",       // --neutral-2
      "editor.selectionBackground": "#1a4090",           // --accent-6
      "editor.inactiveSelectionBackground": "#15357a",   // --accent-5
      "editorCursor.foreground": "#60a5fa",              // --accent-10
      "editorGutter.background": "#0b1020",              // --neutral-1
      "editorIndentGuide.background1": "#1b2336",        // --neutral-4
      "editorIndentGuide.activeBackground1": "#2c3650",  // --neutral-7
      "editorWidget.background": "#0f1526",              // --neutral-2
      "editorWidget.border": "#232c40",                  // --neutral-6
      "editorSuggestWidget.background": "#0f1526",       // --neutral-2
      "editorSuggestWidget.border": "#232c40",           // --neutral-6
      "editorSuggestWidget.selectedBackground": "#1b2336", // --neutral-4
      "editorHoverWidget.background": "#0f1526",         // --neutral-2
      "editorHoverWidget.border": "#232c40",             // --neutral-6
      "input.background": "#0f1526",                     // --neutral-2
      "dropdown.background": "#0f1526",                  // --neutral-2
      "minimap.background": "#0b1020",                   // --neutral-1
      "scrollbarSlider.background": "#2c365080",         // --neutral-7 @ 50%
      "scrollbarSlider.hoverBackground": "#3a4768aa",    // --neutral-8
    },
  });

  themesDefined = true;
}

/** Map the resolved app theme to the Monaco theme name. */
export function resolveMonacoTheme(theme: "dark" | "light" | "blue"): string {
  if (theme === "light") return QUERYDEN_LIGHT_THEME;
  if (theme === "blue") return QUERYDEN_BLUE_THEME;
  return QUERYDEN_DARK_THEME;
}
