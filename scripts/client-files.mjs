// The files a browser actually executes or renders — the single source of truth.
//
// Both scripts/integrity.mjs (which publishes their hashes) and scripts/bundle.mjs (which packages
// them for self-hosting) read this list. They used to be able to disagree, and that is precisely
// how self-contained/ went stale: it was a hand-assembled copy that no longer resembled what was
// served, so it kept its own security posture frozen at August 3rd while simple/ moved on.
//
// Order is stable so INTEGRITY.md diffs cleanly and the zip is reproducible.
export const FILES = [
  "simple/index.html",
  "simple/broadcast.html",
  "simple/watch.html",
  "simple/earthseed.js",
  "simple/audio-capture-worklet.js",
  "simple/vendor/moq-net-0.1.5.mjs",
];

/** The path a browser requests, i.e. with the simple/ prefix stripped. */
export const urlFor = (rel) => rel.replace(/^simple/, "");
