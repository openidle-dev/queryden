/**
 * Dev-only logger. No-op in production builds so SQL queries, connection
 * metadata, and other internal state don't leak to devtools / Sentry / users.
 *
 * Use `logger.debug/info/warn` for diagnostic output. Keep `console.error`
 * (or `logger.error`) for real errors — those always log.
 */

const isDev = import.meta.env.DEV;

type LogFn = (...args: unknown[]) => void;

const noop: LogFn = () => {};

export const logger = {
  debug: isDev ? console.debug.bind(console) : noop,
  info: isDev ? console.info.bind(console) : noop,
  log: isDev ? console.log.bind(console) : noop,
  warn: isDev ? console.warn.bind(console) : noop,
  error: console.error.bind(console),
} as const;
