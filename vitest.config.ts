import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
      "@noteforge/music-core": fileURLToPath(new URL("./packages/music-core/src/index.ts", import.meta.url)),
      "@noteforge/pitch-engine": fileURLToPath(new URL("./packages/pitch-engine/src/index.ts", import.meta.url)),
      "@noteforge/trainer-core": fileURLToPath(new URL("./packages/trainer-core/src/index.ts", import.meta.url))
    }
  },
  test: {
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: [
        "apps/web/src/**/*.{ts,tsx}",
        "packages/*/src/**/*.ts"
      ],
      exclude: ["**/*.d.ts"],
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "coverage"
    }
  }
});
