import { defineConfig, Plugin } from "vite";
import { resolve, dirname as pathDirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathDirname(__filename);

// Fix broken .ts imports in @moq/hang compiled JS
function fixMoqHangWorklets(): Plugin {
  return {
    name: "fix-moq-hang-worklets",
    enforce: "pre",
    resolveId(source, importer) {
      // Fix: ./render-worklet.ts?worker&url -> ./render-worklet.js?worker&url
      if (source === "./render-worklet.ts?worker&url" && importer?.includes("@moq/hang")) {
        const dir = pathDirname(importer);
        return { id: resolve(dir, "render-worklet.js") + "?worker&url", external: false };
      }
      // Fix: ./capture-worklet.ts?worker&url -> ./capture-worklet.js?worker&url
      if (source === "./capture-worklet.ts?worker&url" && importer?.includes("@moq/hang")) {
        const dir = pathDirname(importer);
        return { id: resolve(dir, "capture-worklet.js") + "?worker&url", external: false };
      }
      return null;
    },
  };
}

// Fix broken exports in @moq/hang-ui
function fixMoqHangUI(): Plugin {
  const hangUIDir = resolve(__dirname, "node_modules/@moq/hang-ui");

  return {
    name: "fix-moq-hang-ui",
    enforce: "pre",
    resolveId(source) {
      if (source === "@moq/hang-ui/publish/element") {
        return resolve(hangUIDir, "publish-controls.esm.js");
      }
      if (source === "@moq/hang-ui/watch/element") {
        return resolve(hangUIDir, "watch-controls.esm.js");
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [fixMoqHangWorklets(), fixMoqHangUI()],
  build: {
    outDir: "dist",
    emptyDirBeforeWrite: true,
  },
  server: {
    port: 3000,
  },
  optimizeDeps: {
    exclude: ["@moq/hang", "@moq/hang-ui", "@moq/lite"],
  },
});
