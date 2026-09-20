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
  // TEMPORARY, alongside the relay shutdown. Loaded by index.html and broadcast.html; inert
  // unless /api/config says broadcasting is closed. Delete this line with the file.
  "simple/offline-notice.js",
  "simple/audio-capture-worklet.js",
  "simple/overlay.js",
  "simple/chat.js",
  // Burned into the picture rather than overlaid in the DOM, so they travel inside the E2E
  // media encryption like every other pixel. qr.js is imported by compositor.js alone.
  "simple/qr.js",
  // Every device the broadcast page opens goes through here: camera, screen and microphone,
  // composited into one canvas and mixed into one audio track. Loaded by a dynamic import, so
  // the watch page never fetches it.
  "simple/compositor.js",
  // The burn-ins the compositor draws. Three files rather than one because the clock is useful
  // on its own and the city table is data; all three are reached by dynamic import, so a page
  // that never switches a burn-in on never fetches them.
  "simple/edge-clock.js",
  "simple/geo-stamp.js",
  "simple/nearest-city.js",
  // The seeds demo. Two files, reached from one dynamic import in earthseed.js, so deleting the
  // demo is deleting these two lines and those two files.
  "simple/seeds.js",
  "simple/seeds-recovery.js",
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
