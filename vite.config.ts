import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "apps/web",
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./apps/web/src", import.meta.url)),
      "@noteforge/music-core": fileURLToPath(new URL("./packages/music-core/src/index.ts", import.meta.url)),
      "@noteforge/pitch-engine": fileURLToPath(new URL("./packages/pitch-engine/src/index.ts", import.meta.url)),
      "@noteforge/trainer-core": fileURLToPath(new URL("./packages/trainer-core/src/index.ts", import.meta.url))
    }
  },
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    sourcemap: false
  },
  server: {
    host: "127.0.0.1",
    port: 4173
  }
});
