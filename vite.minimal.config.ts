import { defineConfig } from "vite";
import path from "node:path";
import { moqWebTransportOnly, mediaCryptoPatch } from "./vite.config";

// TCB-minimal build (spike ①): same app, but the libav.js Opus polyfill
// (~1.75 MB wasm, 76% of the shipped bytes) is aliased to a stub so it never
// enters the bundle. Targets modern browsers with native WebCodecs Opus — which
// the app already prefers at runtime ("native Opus supported, skipping polyfill").
//
//   npx vite build --config vite.minimal.config.ts   →   dist-min/
//
// copyPublicDir:false so the vendored libav wasm under public/vendor is NOT copied
// either — the whole codec dependency leaves the TCB. Relative base so the result
// is self-contained (run it off a laptop, like the owned build).
export default defineConfig({
  base: "./",
  plugins: [moqWebTransportOnly(), mediaCryptoPatch()],
  resolve: {
    alias: {
      buffer: "buffer/",
      "@kixelated/libavjs-webcodecs-polyfill": path.resolve("scripts/stub-polyfill.js"),
    },
  },
  build: { outDir: "dist-min", emptyOutDir: true, target: "es2022", copyPublicDir: false },
});
