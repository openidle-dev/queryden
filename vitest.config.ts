import { defineConfig } from "vitest/config";

// Vitest reads vite.config.ts by default, but the production manualChunks /
// Tailwind plugins are unnecessary for unit tests and slow them down. This
// minimal config keeps test runs fast and isolated.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    globals: false,
    // Tests touching `import.meta.env.DEV` see this value at module load time.
    // Vitest defaults DEV=true, which is what we want for testing the
    // dev-only logger.
  },
});
