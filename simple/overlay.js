// The broadcaster's overlay: structured blocks, built as DOM, never parsed from HTML.
//
// Ported in spirit from Wallflower's src/overlay-sanitize.ts, which takes raw HTML from the
// broadcaster and runs DOMPurify over it. That design cannot work here, and the reason is worth
// understanding before changing anything in this file.
//
// ── WHY THIS IS NOT AN HTML SANITISER ───────────────────────────────────────────────────────
//
// earthseed.live serves `require-trusted-types-for 'script'; trusted-types 'none'`. Together
// those say: every string-to-HTML sink in this origin requires a TrustedHTML, and NO policy may
// be created to mint one. There is no route from a string to DOM in this document. innerHTML
// throws. outerHTML throws. insertAdjacentHTML throws. document.write throws. And
// `DOMParser.parseFromString` throws, which is the one that surprises people — it is a Trusted
// Types sink too.
//
// DOMPurify was vendored here on 20 Sep 2026 and removed the same day. Under this policy it does
// not fail loudly: it parses internally through an innerHTML sink, catches the violation, and
// returns an EMPTY result for every input including `<p>hi</p>`. A test suite written against it
// passes every "no script survived" assertion vacuously. That is a worse failure than a crash,
// and it is why this file exists in the shape it does. See simple/vendor/README.md.
//
// So the broadcaster does not send markup. They send a list of BLOCKS, and this builds the DOM
// with createElement and textContent. Nothing is ever parsed, so nothing needs sanitising — the
// class of bug DOMPurify exists to prevent is not reachable from here, rather than being defended
// against. That is a better position to be in, and it is the only one the CSP allows.
//
// ── WHAT IS BEING DEFENDED ──────────────────────────────────────────────────────────────────
//
// The content key. The viewer's document derives a media key from the share link's `#k=` fragment
// and holds it in memory, so any script running in that document can read it and hand the
// plaintext to someone the broadcaster never shared it with. The overlay is content from one
// person rendered in another person's document — the one place in this client where that happens.
//
// ── THE BLOCK FORMAT ────────────────────────────────────────────────────────────────────────
//
//   {"t":"h",     "text":"…"}                     a heading
//   {"t":"p",     "text":"…"}                     a paragraph
//   {"t":"ul",    "items":["…","…"]}              a bulleted list
//   {"t":"ol",    "items":["…","…"]}              a numbered list
//   {"t":"a",     "text":"…", "href":"https://…"} a link, opened in a new tab
//   {"t":"img",   "src":"https://…", "alt":"…"}   an image
//   {"t":"hr"}                                    a rule
//   {"t":"embed", "src":"https://…", "height":N}  a third-party page
//
// Every `text`, `alt` and `items` entry is assigned with textContent, so `<script>` in one of them
// is five characters on screen and nothing else. No block carries a style, a class, an id or a
// name: `id` and `name` in particular create named properties on `window` and `document`, which is
// the DOM-clobbering class of bug, and an overlay has no need for either.
//
// ── EMBEDS, WHICH ARE THE ONE REAL TRADE ────────────────────────────────────────────────────
//
// An embed is a third party's page inside ours, and the rule that makes it survivable is simple:
// it must not be OUR origin. A cross-origin frame cannot touch `window.parent` — the same-origin
// policy stops it — so a poll, a video or a map can run all the script it likes and never reach
// the key. Two shapes break that and are refused:
//
//   - a same-host src (`/`, `https://earthseed.live/…`), which IS this origin and can walk
//     straight up to the parent document;
//   - anything non-https, so an embed cannot downgrade the page.
//
// `srcdoc` is not in the format at all. In Wallflower it had to be stripped, because a broadcaster
// could write it; here there is no way to express it.
//
// Three attributes are then set by us rather than accepted from anyone, because each is a way for
// the frame to climb back out:
//
//   - `sandbox` — notably WITHOUT allow-top-navigation, so an embed cannot navigate the viewer
//     away from the broadcast they are watching. allow-same-origin is present and is safe
//     precisely because the src was forced cross-origin: it gives the frame its OWN origin, not
//     ours, which is what its cookies and storage need.
//   - `allow` — permissions delegation. Left unset, an embed could ask for `camera; microphone;
//     geolocation` and be handed the viewer's devices by a page they trusted for a broadcast.
//   - `referrerpolicy` — the share link lives in the URL. Not sending it to a third party.
//
// Setting `src` on an iframe is NOT a Trusted Types sink — only `<script src>` is, via
// TrustedScriptURL — so embeds work under `trusted-types 'none'` unchanged.
//
// The remaining hole is a frame navigating ITSELF to this origin after load, which
// allow-same-origin would then make same-origin. The Worker closes it from the other side by
// serving `frame-ancestors 'none'`, so no earthseed.live document can be framed at all. BOTH
// HALVES ARE REQUIRED; do not remove one because the other looks sufficient.

/** Bounds. Not security — the blocks are already inert — but an overlay is not a document. */
const MAX_BLOCKS = 40;
const MAX_TEXT = 2000;
const MAX_ITEMS = 40;
const MAX_EMBED_HEIGHT = 1080;
const MIN_EMBED_HEIGHT = 80;

// No allow-top-navigation: an embed must not be able to navigate the viewer off the broadcast.
const IFRAME_SANDBOX = "allow-scripts allow-same-origin allow-popups allow-forms allow-presentation";
// Media only. Never camera, microphone, geolocation or display-capture.
const IFRAME_ALLOW = "autoplay; fullscreen; encrypted-media; picture-in-picture; clipboard-write";

const text = (v) => (typeof v === "string" ? v.slice(0, MAX_TEXT) : "");

/**
 * An https URL, or null.
 *
 * Resolved against this document, so a bare "/x" or "//host/x" is judged as the browser would
 * load it rather than as the string it looks like. `sameOriginOk: false` additionally refuses our
 * own host — see the embed reasoning above.
 */
function httpsUrl(raw, { sameOriginOk }) {
  if (typeof raw !== "string" || !raw) return null;
  let u;
  try {
    u = new URL(raw, window.location.href);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  if (!sameOriginOk && u.host === window.location.host) return null;
  return u.href;
}

/**
 * Build one block, or null if it is not something we render.
 *
 * @param {any} b
 * @param {(why: string) => void} drop  records why a block was refused, for the author's preview
 */
function buildBlock(b, drop) {
  if (!b || typeof b !== "object") {
    drop("a block that is not an object");
    return null;
  }

  switch (b.t) {
    case "h": {
      // h2, not h1: the page owns its own heading level and an overlay is inside it.
      const el = document.createElement("h2");
      el.textContent = text(b.text);
      return el.textContent ? el : (drop("an empty heading"), null);
    }

    case "p": {
      const el = document.createElement("p");
      el.textContent = text(b.text);
      return el.textContent ? el : (drop("an empty paragraph"), null);
    }

    case "ul":
    case "ol": {
      if (!Array.isArray(b.items)) {
        drop(`a ${b.t} with no items`);
        return null;
      }
      const el = document.createElement(b.t);
      for (const item of b.items.slice(0, MAX_ITEMS)) {
        const li = document.createElement("li");
        li.textContent = text(item);
        if (li.textContent) el.appendChild(li);
      }
      return el.childElementCount ? el : (drop(`an empty ${b.t}`), null);
    }

    case "a": {
      const href = httpsUrl(b.href, { sameOriginOk: true });
      if (!href) {
        drop("a link that is not https");
        return null;
      }
      const el = document.createElement("a");
      el.href = href;
      el.textContent = text(b.text) || href;
      el.target = "_blank";
      // target="_blank" hands the opened page a live handle on ours via window.opener, which is
      // enough to navigate this tab somewhere else while the viewer is looking at the new one.
      el.rel = "noopener noreferrer";
      return el;
    }

    case "img": {
      // data:image is allowed here and nowhere else: an inline image is bytes, not a fetch, and
      // it cannot carry script — an SVG could, which is why the prefix is checked exactly.
      const inline = typeof b.src === "string" && /^data:image\/(png|jpeg|gif|webp);base64,/.test(b.src);
      const src = inline ? b.src : httpsUrl(b.src, { sameOriginOk: true });
      if (!src) {
        drop("an image that is not https or an inline raster");
        return null;
      }
      const el = document.createElement("img");
      el.src = src;
      el.alt = text(b.alt);
      el.loading = "lazy";
      // Not sending the share link, which lives in the URL, to whoever hosts the image.
      el.referrerPolicy = "no-referrer";
      return el;
    }

    case "hr":
      return document.createElement("hr");

    case "embed": {
      const src = httpsUrl(b.src, { sameOriginOk: false });
      if (!src) {
        drop("an embed that is not https, or is on this site");
        return null;
      }
      const el = document.createElement("iframe");
      el.src = src;
      el.setAttribute("sandbox", IFRAME_SANDBOX);
      el.setAttribute("allow", IFRAME_ALLOW);
      el.setAttribute("referrerpolicy", "no-referrer");
      const h = Number(b.height);
      el.height = String(
        Number.isFinite(h) ? Math.min(MAX_EMBED_HEIGHT, Math.max(MIN_EMBED_HEIGHT, Math.round(h))) : 360
      );
      return el;
    }

    default:
      drop(`an unknown block type ${JSON.stringify(b.t)}`);
      return null;
  }
}

/**
 * Turn stored overlay content into DOM, and report what was refused.
 *
 * Accepts the JSON string as stored in `streams.overlay_html`, or an already-parsed array. A
 * string that is not valid JSON is not an error worth throwing over — it is an overlay written by
 * an older client, or by hand, and the right response is an empty overlay and a note saying so.
 *
 * Returns a DocumentFragment. There is deliberately no way to get an HTML string out of this
 * module: the first caller to assign one to innerHTML would throw in production and look like a
 * rendering bug, and the fix that suggests itself at 2am is loosening the CSP.
 *
 * @param {string | unknown[]} stored
 * @returns {{ fragment: DocumentFragment, removed: string[] }}
 */
export function renderOverlay(stored) {
  const removed = new Set();
  const drop = (why) => removed.add(why);

  let blocks = stored;
  if (typeof stored === "string") {
    const trimmed = stored.trim();
    if (!trimmed) return { fragment: document.createDocumentFragment(), removed: [] };
    try {
      blocks = JSON.parse(trimmed);
    } catch {
      return {
        fragment: document.createDocumentFragment(),
        removed: ["overlay content that is not valid JSON blocks"],
      };
    }
  }

  const fragment = document.createDocumentFragment();
  if (!Array.isArray(blocks)) {
    return { fragment, removed: ["overlay content that is not a list of blocks"] };
  }

  if (blocks.length > MAX_BLOCKS) drop(`${blocks.length - MAX_BLOCKS} block(s) past the limit of ${MAX_BLOCKS}`);

  for (const b of blocks.slice(0, MAX_BLOCKS)) {
    const el = buildBlock(b, drop);
    if (el) fragment.appendChild(el);
  }

  return { fragment, removed: [...removed] };
}

/**
 * Put an overlay on screen, replacing whatever was there.
 *
 * The only supported way to render one. `replaceChildren` adopts real nodes and is not a Trusted
 * Types sink.
 *
 * @param {Element} host
 * @param {string | unknown[]} stored
 * @returns {string[]} what was refused, for the author's preview
 */
export function mountOverlay(host, stored) {
  const { fragment, removed } = renderOverlay(stored);
  host.replaceChildren(fragment);
  return removed;
}
