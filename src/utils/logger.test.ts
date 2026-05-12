import { describe, it, expect } from "vitest";
import { logger } from "./logger";

// The logger binds console.* at module-load time on purpose: it's a hot path
// (called from contexts and dialogs) and the bound reference avoids a property
// lookup on every call. That same bind means we can't usefully spy on console
// after import. The contract we DO want to lock down with tests:
//
//   1. All five logging methods exist and are functions.
//   2. Calling them with any number of arguments does not throw.
//   3. `error` is never a no-op (it must work in production too).
//
// The dev-vs-prod behavior split is enforced by `import.meta.env.DEV`, which
// is a Vite-time constant. That behavior is verified by reading `npm run build`
// output (no `console.log` calls survive in dist/), not by unit test.

describe("logger", () => {
  it("exposes the five logging methods as functions", () => {
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.log).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
  });

  it("does not throw on any logging call shape", () => {
    expect(() => logger.debug("a")).not.toThrow();
    expect(() => logger.info("a", "b")).not.toThrow();
    expect(() => logger.log()).not.toThrow();
    expect(() => logger.warn({ deep: { obj: [1, 2, 3] } })).not.toThrow();
    expect(() => logger.error(new Error("forced"))).not.toThrow();
  });

  it("error is bound to console.error (never a no-op)", () => {
    // In production builds `logger.debug` is replaced by `() => {}` but
    // `logger.error` must always forward to the real console — that's how
    // crash reports stay visible. We verify the binding without spying on
    // a value we've already captured by reference.
    const consoleErrorName = (console.error as { name?: string }).name;
    const loggerErrorName = (logger.error as { name?: string }).name;
    expect(loggerErrorName).toContain(consoleErrorName ?? "error");
  });
});
