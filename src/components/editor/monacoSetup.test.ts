import { describe, it, expect } from "vitest";
import editorMainSource from "monaco-editor/editor/editor.main.js?raw";
import registerAllSource from "monaco-editor/features/register.all.js?raw";
import setupSource from "./monacoSetup.ts?raw";

// monacoSetup.ts rebuilds Monaco's `editor.main.js` without its languages.
// Monaco 0.57 moved the suggest widget and document semantic tokens out of
// the shared feature list; missing either one silently turns off completion
// or table/alias colouring. This fails when an upgrade adds a contribution
// that the slim entry doesn't import.

/** Relative imports of an `esm/vs` file, as paths relative to `esm/vs`. */
function importsOf(source: string, fileDir: string): string[] {
  return [...source.matchAll(/^(?:import|export)\s[^'"]*?['"]([^'"]+)['"]/gm)]
    .map((m) => m[1])
    .filter((spec) => spec.startsWith("."))
    .map((spec) => normalize(`${fileDir}/${spec}`));
}

function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

describe("slim Monaco entry", () => {
  it("imports every editor contribution that editor.main.js does, minus languages", () => {
    const slim = new Set(
      [...setupSource.matchAll(/^import\s(?:[^'"]*from\s)?["']monaco-editor\/([^"'?]+)["']/gm)].map((m) => m[1]),
    );
    expect(slim).toContain("features/register.all.js");
    expect(slim).toContain("editor/editor.api.js");

    const covered = new Set([...slim, ...importsOf(registerAllSource, "features")]);
    const missing = importsOf(editorMainSource, "editor").filter(
      (p) => !p.startsWith("languages/") && !p.startsWith("../") && !p.endsWith(".css") && !covered.has(p),
    );
    expect(missing).toEqual([]);
  });
});
