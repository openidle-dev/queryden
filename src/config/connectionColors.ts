/**
 * Preset swatch colors offered in the connection-color picker.
 *
 * These are data, not theme tokens — a connection's color is a
 * user-chosen identity marker rendered as-is in the sidebar, so it must
 * stay constant across light/dark themes rather than following the scale.
 */
export const CONNECTION_COLOR_PRESETS = [
  "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899",
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#14b8a6", "#64748b", "#1e293b", "#ffffff",
] as const;

/** Default connection color when none is set. */
export const DEFAULT_CONNECTION_COLOR = "#06b6d4";
