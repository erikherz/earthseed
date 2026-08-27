// The broadcast shutter, browser side.
//
// TEMPORARY. This exists for periods when the relay fleet is deliberately not running, so that
// clicking Broadcast or Go live says a sentence instead of failing at a broker that is not there.
// It is driven entirely by GET /api/config, so turning it off is a var change in wrangler.jsonc
// and a deploy — nothing in this file or in the two pages that call it needs editing to flip it.
//
// This is NOT the enforcement. The Worker refuses /api/broadcast/start and /api/broadcast/challenge
// on its own, which binds every client including one with this file removed. What is here is only
// the difference between a person reading an explanation and a person reading a 502.
//
// Deliberately a separate file rather than an export of earthseed.js: index.html loads no client
// code at all today, and pulling the whole broadcaster onto the landing page to show one dialog
// would be a poor trade. It also means deleting this feature later is one file, one line in
// scripts/client-files.mjs, and two script tags.
//
// Every node here is built with createElement/textContent. The enforced policy sets
// `require-trusted-types-for 'script'` and `trusted-types 'none'`, so innerHTML would throw — and
// the message is operator-supplied text, which is exactly the input that should never be markup.

const ENDPOINT = "/api/config";

/**
 * Ask the Worker whether broadcasting is open.
 *
 * FAIL OPEN. A 404 (a self-hosted Worker predating this endpoint), a network blip, or malformed
 * JSON must not block broadcasting: the Worker is the authority and will refuse on its own if it
 * means to. The cost of guessing wrong in this direction is one honest error message later; the
 * cost of guessing wrong in the other is a site that says it is closed when it is open.
 */
async function shutterState() {
  try {
    const r = await fetch(ENDPOINT, { cache: "no-store" });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d || d.broadcast_offline !== true) return null;
    return typeof d.offline_message === "string" && d.offline_message.trim()
      ? d.offline_message.trim()
      : "Temporarily offline.";
  } catch {
    return null;
  }
}

/** Build the dialog once and reuse it; repeated clicks should not stack copies in the DOM. */
let dialog = null;

// Styles live here rather than in theme.css because this whole feature is meant to be removable
// in one piece — and because the two pages that use it are styled differently: broadcast.html
// loads theme.css, while index.html carries its own inline <style> and defines none of the
// --es-* variables. So every value reads a variable WITH a fallback: themed on the broadcast
// page, self-sufficient on the landing page. (There is no style-src in the enforced policy, so
// an injected stylesheet is permitted; only scripts are hash-pinned.)
const CSS = `
.offline-notice {
  border: 1px solid var(--es-border-strong, #3a475a);
  border-radius: 10px;
  background: var(--es-surface, #141a24);
  color: var(--es-fg, #e0e0e0);
  font: inherit;
  max-width: min(30rem, calc(100vw - 2rem));
  padding: 1.25rem 1.4rem;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.45);
}
.offline-notice::backdrop { background: rgba(0, 0, 0, 0.55); }
.offline-notice p { margin: 0 0 0.75rem; line-height: 1.5; }
.offline-notice .offline-notice-contact { margin-bottom: 1.1rem; }
.offline-notice a { color: var(--es-accent, #4ea1ff); }
.offline-notice button {
  border: 1px solid var(--es-border-strong, #3a475a);
  border-radius: 7px;
  background: var(--es-surface-2, #1b2330);
  color: inherit;
  font: inherit;
  padding: 0.45rem 1.1rem;
  cursor: pointer;
}
`;

function injectStyles() {
  if (document.getElementById("offline-notice-css")) return;
  const style = document.createElement("style");
  style.id = "offline-notice-css";
  style.textContent = CSS;
  document.head.appendChild(style);
}

function buildDialog(message) {
  injectStyles();
  const el = document.createElement("dialog");
  el.className = "offline-notice";
  el.setAttribute("aria-label", "Broadcasting is temporarily offline");

  const p = document.createElement("p");
  p.textContent = message;
  el.appendChild(p);

  // The address is a link rather than plain text so it works on a phone, where selecting and
  // copying an email out of a modal is genuinely awkward. Parsed out of the message so the
  // wording stays in one place — the var — instead of being half here and half there.
  const email = (message.match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [])[0];
  if (email) {
    const a = document.createElement("a");
    a.href = `mailto:${email}`;
    a.textContent = email;
    const line = document.createElement("p");
    line.className = "offline-notice-contact";
    line.appendChild(a);
    el.appendChild(line);
  }

  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", () => el.close());
  el.appendChild(close);

  document.body.appendChild(el);
  return el;
}

function show(message) {
  if (!dialog) dialog = buildDialog(message);
  if (!dialog.open) dialog.showModal();
}

/**
 * Wire the shutter to whatever entry points exist on this page.
 *
 * Selectors are matched leniently on purpose: index.html links to ./broadcast.html, broadcast.html
 * has the #go button, and a page that has neither simply gets nothing. Nothing here throws if an
 * element is absent, because this module is loaded by more than one page.
 */
export async function installOfflineNotice() {
  const message = await shutterState();
  if (!message) return; // open for business — leave every control exactly as it was

  const intercept = (el) => {
    el.addEventListener(
      "click",
      (ev) => {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        show(message);
      },
      // Capture, so this runs BEFORE the page's own click handler. On broadcast.html the Go live
      // handler is attached by earthseed.js, and a bubbling listener would fire after it had
      // already begun asking for a relay.
      true
    );
  };

  for (const a of document.querySelectorAll('a[href$="broadcast.html"], a[href="/broadcast"]')) {
    intercept(a);
  }
  const go = document.getElementById("go");
  if (go) intercept(go);
}
