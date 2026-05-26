// Monaco renders its own canvas/DOM and ignores the app's CSS variables, so the
// blue theme needs a dedicated Monaco theme whose colors mirror the `.theme-blue`
// tokens in globals.css. Built-in `vs`/`vs-dark` cover light/dark; only the navy
// blue variant must be registered. `inherit: true` keeps vs-dark's syntax token
// colors and we only override the chrome (backgrounds, gutter, widgets).

type Monaco = typeof import("monaco-editor");

export const QUERYDEN_BLUE_THEME = "queryden-blue";

let blueThemeDefined = false;

/** Register QueryDen's custom Monaco themes. Safe to call on every editor mount. */
export function defineMonacoThemes(monaco: Monaco): void {
  if (blueThemeDefined) return;
  monaco.editor.defineTheme(QUERYDEN_BLUE_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [],
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
  blueThemeDefined = true;
}

/** Map the resolved app theme to the Monaco theme name. */
export function resolveMonacoTheme(theme: "dark" | "light" | "blue"): string {
  if (theme === "light") return "vs";
  if (theme === "blue") return QUERYDEN_BLUE_THEME;
  return "vs-dark";
}
