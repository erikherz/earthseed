import { defineConfig } from "vite";
import { moqWebTransportOnly, mediaCryptoPatch } from "./vite.config";

// #85 "Own your copy" build. Same PROVEN ES-module app as the hosted Tier-2 build,
// but with a RELATIVE base ("./") so the entry + every chunk resolve next to the
// page — nothing loads from tinymoq.com. The output directory is fully
// self-contained: pin it to IPFS (`ipfs add -r`), unzip it locally, or drop it on
// any static host and it runs with no code dependency on us.
//
//   npx vite build --config vite.selfcontained.config.ts   →   dist-own/ (index.html + assets/)
//
// Then `node scripts/build-own.mjs` turns index.html into a self-contained
// send.html / view.html (relative asset paths, no crossorigin — same origin as the
// page) and lays out earthseed/own/ + own.zip for download.
//
// Trust model unchanged: still broker mode (pk_ → tinymoq.com/cdn/assign, DHT
// discovery, gated fleet). The DIFFERENCE from the hosted build is only WHERE the
// app code lives: here it's inside the pin, so the broadcaster owns the code that
// captures and transmits their media. @moq's decode/audio workers are Blob-based
// (origin-independent), so this runs from ipfs://, file://, or any host.
export default defineConfig({
  base: "./",
  plugins: [moqWebTransportOnly(), mediaCryptoPatch()],
  resolve: { alias: { buffer: "buffer/" } },
  build: { outDir: "dist-own", emptyOutDir: true },
});
