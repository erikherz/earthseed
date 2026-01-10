import { defineConfig } from "vite";
import { resolve } from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  build: {
    outDir: "dist",
    emptyDirBeforeWrite: true,
  },
  server: {
    port: 3000,
  },
  resolve: {
    alias: [
      // Use our patched connect.js instead of the one from node_modules
      // Match both with and without .js extension
      {
        find: /^@kixelated\/moq\/connection\/connect(\.js)?$/,
        replacement: resolve(__dirname, "src/patched-moq/connect.js"),
      },
    ],
  },
  optimizeDeps: {
    exclude: ["@kixelated/hang", "@kixelated/moq"],
  },
});
