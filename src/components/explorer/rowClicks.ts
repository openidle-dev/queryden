/**
 * Double-click detection for explorer rows from plain `click` events.
 *
 * WebKitGTK (Tauri's Linux webview) doesn't deliver the native `dblclick`
 * event to draggable elements, and connection rows are draggable (drag into a
 * folder), so relying on `onDoubleClick` left double-click on a connection
 * doing nothing. `detail` is the browser's click count; the same-row timing
 * check covers webviews that don't count clicks on draggable rows either.
 */
export interface LastRowClick {
  id: string;
  at: number;
}

export const DOUBLE_CLICK_MS = 450;

/** Whether this click completes a double-click, and what to remember for the next one. */
export function classifyRowClick(
  nodeId: string,
  detail: number,
  now: number,
  last: LastRowClick | null,
): { isDouble: boolean; next: LastRowClick | null } {
  const isDouble = detail === 2 || (last !== null && last.id === nodeId && now - last.at < DOUBLE_CLICK_MS);
  // After a double-click, start over: a third quick click is not another double.
  return { isDouble, next: isDouble ? null : { id: nodeId, at: now } };
}
