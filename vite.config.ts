import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyDirBeforeWrite: true,
  },
  server: {
    port: 3000,
  },
  resolve: {
    alias: {
      // Use our patched connect.js instead of the one from node_modules
      "@kixelated/moq/connection/connect.js": resolve(__dirname, "src/patched-moq/connect.js"),
    },
  },
  optimizeDeps: {
    exclude: ["@kixelated/hang", "@kixelated/moq"],
  },
});
