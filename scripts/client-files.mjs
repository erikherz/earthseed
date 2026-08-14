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
  "simple/request.html",
  "simple/trust.html",
  "simple/theme.css",
  "simple/custom.css",
  "simple/favicon.svg",
  "simple/earthseed.js",
  "simple/audio-capture-worklet.js",
  "simple/vendor/moq-net-0.1.5.mjs",
];

// reports.html is deliberately ABSENT. It is the operator console, not part of the client: it is
// no use to a self-hoster without the admin password, and shipping it in the release zip would
// invite someone to serve an admin login that talks to a Worker they do not run.

// custom.css is the one file a self-hoster is invited to change, so it is the one file whose
// hash is expected to differ on someone else's deployment. It is still listed above, and still
// verified strictly against earthseed.live: this site offers no styling of its own, so a
// custom.css there that differs from the shipped bytes is a tampering signal rather than a theme.
// On any other origin, `--verify` reports a difference here as customisation instead of failure.
export const CUSTOMIZABLE = new Set(["simple/custom.css"]);

/** The path a browser requests, i.e. with the simple/ prefix stripped. */
export const urlFor = (rel) => rel.replace(/^simple/, "");
