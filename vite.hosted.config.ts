import { defineConfig } from "vite";
import { moqWebTransportOnly, mediaCryptoPatch } from "./vite.config";

// Tier-2 STAGE B (v2): build the PROVEN ES-module app but with every asset URL
// pointed at tinymoq.com/app/ via `base`. The two static files then load the entry
// as a cross-origin module <script> (tinymoq serves /app/* with ACAO, so the module
// + its chunk imports fetch fine), and @moq's workers are Blob-based (same-origin to
// the page regardless of where the JS came from) — so this works hosted anywhere,
// unlike the single-file IIFE, whose bundling broke the decode path.
//
//   npx vite build --config vite.hosted.config.ts   →   dist-app/ (index.html + assets/)
//
// Same @moq crypto seams + WT-only patches (reused plugins) → encryption unchanged.
export default defineConfig({
  base: "https://tinymoq.com/app/",
  plugins: [moqWebTransportOnly(), mediaCryptoPatch()],
  resolve: { alias: { buffer: "buffer/" } },
  build: { outDir: "dist-app", emptyOutDir: true },
});
