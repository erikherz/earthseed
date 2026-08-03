// Minimal / modern-only build: the libav.js Opus polyfill (~1.75 MB of wasm) is
// stripped. Browsers with native WebCodecs Opus (Chrome, Edge, Firefox, Safari 17+)
// never load it — src/webcodecs-polyfill.ts's install() returns early on them. This
// stub stands in for @kixelated/libavjs-webcodecs-polyfill so the polyfill code
// never enters the bundle. If a browser without native Opus reaches install(), it
// throws a clear error instead of silently failing.
export async function load() {
  throw new Error(
    "libav Opus polyfill is not bundled in the minimal build — this browser lacks native WebCodecs Opus.",
  );
}
export default { load };
