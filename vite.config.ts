import { defineConfig, Plugin } from "vite";
import { resolve, dirname as pathDirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathDirname(__filename);

// Custom plugin to redirect moq connection module to our patched version
function patchMoqConnection(): Plugin {
  const patchedDir = resolve(__dirname, "src/patched-moq");
  const moqDir = resolve(__dirname, "node_modules/@kixelated/moq");

  return {
    name: "patch-moq-connection",
    enforce: "pre",
    resolveId(source, importer) {
      // Intercept imports to connection/connect.js from within moq package
      if (importer?.includes("@kixelated/moq") && source === "./connect.js") {
        console.log("[patch-moq] Redirecting ./connect.js to patched version");
        return resolve(patchedDir, "connect.js");
      }
      // Intercept the connection/index.js import from moq/index.js
      if (importer?.includes("@kixelated/moq") && source === "./connection/index.js") {
        console.log("[patch-moq] Redirecting ./connection/index.js to patched version");
        return resolve(patchedDir, "index.js");
      }
      // Handle relative imports from our patched files - resolve to moq package
      // The patched files use ../ to go up from connection/ to moq root
      if (importer?.includes("src/patched-moq") && source.startsWith("../")) {
        // Remove the leading ../ since we're already at moq root level
        const relativePath = source.replace(/^\.\.\//, "");
        const resolved = resolve(moqDir, relativePath);
        console.log("[patch-moq] Resolving", source, "from patched file to", resolved);
        return resolved;
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [patchMoqConnection()],
  build: {
    outDir: "dist",
    emptyDirBeforeWrite: true,
  },
  server: {
    port: 3000,
  },
  optimizeDeps: {
    exclude: ["@kixelated/hang", "@kixelated/moq"],
  },
});
