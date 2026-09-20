// Seeds — client for the tipping + prepaid-bandwidth DEMO.
//
// Ported from Wallflower's src/seeds/seeds-client.ts. The economy, the wording and the screens
// are its; what is rebuilt is the rendering, for a reason given below.
//
// ── NOTHING HERE IS REAL MONEY ──────────────────────────────────────────────────────────────
//
// "Top up" credits a vault server-side with no card. "Cash out" shows the true fee arithmetic
// and then stops. No payment processor is involved at any point — see src/worker/seeds.ts and
// migration 0014. Every surface that could be mistaken for money says "demo" in the interface
// itself, which is a requirement of being visible by default rather than decoration: a
// money-shaped widget nobody asked for is the one that ends up in a screenshot without its
// context.
//
// ── WHY THIS DOES NOT BUILD HTML STRINGS ────────────────────────────────────────────────────
//
// Wallflower's version renders with `innerHTML` in eight places. Under earthseed.live's CSP —
// `require-trusted-types-for 'script'; trusted-types 'none'` — every one of those throws, and
// `DOMParser.parseFromString` is a sink too, so there is no string-to-DOM route in this origin
// at all. See simple/overlay.js, which hit the same wall on the same day.
//
// So everything is built with `h()` below: createElement, textContent, setAttribute. One thing
// falls out of that worth naming — Wallflower needs an `escapeHTML()` helper for vault names,
// because a name is typed by a person and interpolated into markup. There is no equivalent here
// and there cannot be: a name goes in as `textContent`, so a name containing `<script>` is
// twelve characters on screen. The escaping bug class is unreachable rather than defended
// against.
//
// ── SELF-CONTAINED ON PURPOSE ───────────────────────────────────────────────────────────────
//
// It injects its own DOM and styles, reads the current broadcast id off the page rather than
// being handed it, and is reached from exactly ONE line in earthseed.js. That keeps the blast
// radius of a demo on a live site to a single import: with the demo off, initSeeds() returns
// before touching anything.
//
// ── THE IDENTITY, AND THE TRADE IT MAKES ────────────────────────────────────────────────────
//
// A vault is derived from a recovery phrase (simple/seeds-recovery.js) and held in
// localStorage. It is NOT the per-broadcast node key, which is non-extractable and has to stay
// that way.
//
// This is the one persistent pseudonym in Earthseed, and it is the one thing here that makes
// monetised broadcasts linkable to each other. Everything else in this client is deliberately
// unlinkable across sessions. That trade is real, it is opt-in — no vault is created until
// someone opens the panel — and it belongs on /trust before any of this stops being a demo.

import { checkPhrase, describeProblem, deriveVault, newPhrase, normalise, PHRASE_LENGTH } from "./seeds-recovery.js";

/**
 * The OFF switch, not the on switch.
 *
 * Visible by default, with `?seeds=0` as a sticky per-browser escape hatch. Wallflower ran this
 * opt-in behind `?seeds=1` while the economy was being built and found the flaw: the only people
 * who ever saw it already knew what it was, which is the least informative possible audience for
 * a demo whose whole purpose is to discover whether the idea reads to a stranger.
 */
const OFF_KEY = "es:seeds:off";
const VAULTS_KEY = "es:seeds:vaults";

/** The whole economy hangs off this one number. Matches VIEWER_MINUTES_PER_SEED in the Worker. */
const SEED_VIEWER_MINUTES = 1000;

/** Earthseed broadcast names are 52 characters of base32 — an Ed25519 public key. */
const NODE_RE = /^[a-z2-7]{52}$/;

/* ── state ────────────────────────────────────────────────────────────────────────────────── */

/** @typedef {{pubkey:string, secret:string, phrase?:string, name:string}} Stored */

/** @type {Stored[]} */ let vaults = [];
/** @type {Stored|null} */ let stored = null;
/** @type {any} */ let vault = null;
/** @type {"main"|"switch"|"phrase"|"restore"} */ let view = "main";
let restoreError = "";
let panelOpen = false;
/** @type {string|null} */ let attachedStream = null;

/**
 * The vault of the stream being WATCHED, which is a different thing from your own.
 *
 * This is the number that does the persuading. "You have 0.999 seeds" is a bank statement and
 * tells a viewer nothing; "this stream goes dark in 40 minutes" is a reason to act. A viewer is
 * not managing a balance, they are deciding whether someone stays on the air.
 */
/** @type {any} */ let watchingVault = null;

/**
 * The last cash-out quote, held in state rather than written straight into the DOM.
 *
 * It has to survive a re-render. The balance moves on its own — burn accrues server-side on every
 * viewer heartbeat — so this panel refreshes every 15 seconds, and render() replaces the whole
 * subtree. Writing the quote directly into a box meant it vanished mid-read, on a timer, with no
 * indication why. Caught by the e2e suite as a flake before anyone had to see it happen.
 *
 * Cleared on anything that changes the balance, since a stale quote is worse than none.
 */
/** @type {any} */ let quote = null;

/* ── formatting ───────────────────────────────────────────────────────────────────────────── */

const money = (n) => `$${n.toFixed(2)}`;
const seedsText = (n) => (n >= 100 ? n.toFixed(0) : n.toFixed(n < 1 ? 3 : 2));

/** Minutes -> "3h 20m", because "200 viewer-minutes" means nothing to a person. */
function minutesText(mins) {
  if (mins < 60) return `${Math.round(mins)} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}

async function api(path, body) {
  const res = await fetch(new URL(path, location.href), {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ── reading the page ─────────────────────────────────────────────────────────────────────── */

/**
 * The broadcast id, read off whatever page we are on.
 *
 * A viewer's URL carries `?node=`; a broadcaster's share link appears in #share once they are
 * live. Sniffing it rather than being handed it is what lets this module stay out of
 * earthseed.js's internals — the one import stays one import.
 */
function currentStreamId() {
  const fromQuery = new URL(location.href).searchParams.get("node");
  if (fromQuery && NODE_RE.test(fromQuery)) return fromQuery;

  const share = /** @type {HTMLInputElement|null} */ (document.getElementById("share"));
  if (share?.value) {
    try {
      const id = new URL(share.value).searchParams.get("node");
      if (id && NODE_RE.test(id)) return id;
    } catch {
      /* half-typed or empty */
    }
  }
  return null;
}

/** Are we the one publishing? On this site that is a whole separate page. */
const isBroadcasting = () => location.pathname.endsWith("/broadcast.html");

/* ── DOM helper ───────────────────────────────────────────────────────────────────────────── */

/**
 * Build an element. The only way anything in this file reaches the DOM.
 *
 * Children may be nodes, strings or null/false — so a conditional row is `cond && h(...)`.
 * NOTE that this only holds for children passed THROUGH h(). A view returning a plain array
 * straight to replaceChildren has to filter the falsy entries itself; see refresh().
 * without a wrapper, exactly where a template literal would have used a ternary returning "".
 *
 * Arrays are flattened one level, so a helper can return several nodes without a wrapper
 * element — a wrapper would otherwise show up in the layout as a stray div.
 *
 * @param {string} tag
 * @param {Record<string, any>|null} [props]
 * @param {...(Node|string|null|false|undefined|(Node|string|null|false|undefined)[])} kids
 */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = String(v);
    else if (k === "act") el.dataset.act = v;
    else if (k === "style") Object.assign(el.style, v);
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
  }
  return el;
}

/** A label/value line. */
const row = (label, value) => h("div", { class: "es-seed-row" }, h("span", { text: label }), h("b", { text: value }));
const sub = (text) => h("div", { class: "es-seed-sub" }, text);
const note = (warn, ...kids) => h("div", { class: warn ? "es-seed-note es-seed-warn" : "es-seed-note" }, ...kids);
const btn = (act, label, ghost) =>
  h("button", { class: ghost ? "es-seed-btn es-seed-ghost" : "es-seed-btn", act, type: "button" }, label);

/* ── styles ───────────────────────────────────────────────────────────────────────────────── */

// Everything is expressed through simple/theme.css's tokens rather than hard-coded colours, so
// the panel follows the site's light/dark themes instead of carrying a third palette that drifts.
// A <style> element with textContent is not a Trusted Types sink.
const CSS = `
.es-seed-pill {
  position: fixed; right: 16px; bottom: 16px; z-index: 40;
  display: flex; align-items: center; gap: 8px;
  padding: 10px 14px; border-radius: 999px; cursor: pointer;
  background: var(--es-button-bg); color: var(--es-fg);
  border: 1px solid var(--es-border-strong);
  font: 600 13px/1.2 var(--es-font); box-shadow: 0 6px 24px rgba(0,0,0,.25);
}
.es-seed-pill:hover { border-color: var(--es-accent); }
.es-seed-pill .es-seed-low { color: var(--es-danger); }
.es-seed-panel {
  position: fixed; right: 16px; bottom: 72px; z-index: 41;
  width: min(380px, calc(100vw - 32px)); max-height: min(72vh, 720px); overflow-y: auto;
  padding: 16px; border-radius: 14px;
  background: var(--es-bg); color: var(--es-fg);
  border: 1px solid var(--es-border-strong);
  box-shadow: 0 18px 48px rgba(0,0,0,.35);
  font: 400 13px/1.5 var(--es-font);
}
.es-seed-panel h3 { margin: 0 0 2px; font-size: 14px; }
.es-seed-panel h2 { margin: 0 0 6px; font-size: 16px; }
.es-seed-sub { color: var(--es-hint); font-size: 12px; margin-bottom: 8px; }
.es-seed-big { font-size: 26px; font-weight: 700; margin: 10px 0 6px; }
.es-seed-big small { font-size: 13px; font-weight: 500; color: var(--es-hint); }
.es-seed-big.es-seed-low { color: var(--es-danger); }
.es-seed-row { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; }
.es-seed-row span { color: var(--es-hint); }
.es-seed-hr { height: 1px; background: var(--es-border); margin: 14px 0; }
.es-seed-btn {
  display: block; width: 100%; margin: 8px 0 0; padding: var(--es-button-padding);
  border-radius: 8px; cursor: pointer; font: 600 13px/1.2 var(--es-font);
  background: var(--es-button-primary-bg); color: var(--es-button-primary-fg);
  border: 1px solid var(--es-button-border);
}
.es-seed-btn.es-seed-ghost { background: var(--es-button-bg); color: var(--es-button-fg); }
.es-seed-btn:hover { border-color: var(--es-accent); }
.es-seed-btn[disabled] { opacity: var(--es-button-disabled-opacity); cursor: default; }
.es-seed-link {
  background: none; border: 0; padding: 0; cursor: pointer;
  color: var(--es-link); font: inherit; text-decoration: underline;
}
.es-seed-link:hover { color: var(--es-link-hover); }
.es-seed-note {
  margin: 10px 0; padding: 9px 11px; border-radius: 8px; font-size: 12px;
  background: var(--es-field-bg); border: 1px solid var(--es-border);
}
.es-seed-note.es-seed-warn { border-color: var(--es-danger); }
.es-seed-input {
  width: 100%; margin-top: 8px; padding: var(--es-control-padding); border-radius: 8px;
  background: var(--es-field-bg); color: var(--es-field-fg);
  border: 1px solid var(--es-field-border); font: 400 13px var(--es-font);
}
.es-seed-key, .es-seed-phrase {
  font: 400 12px/1.6 var(--es-font-mono); word-break: break-all;
  margin: 8px 0; padding: 8px; border-radius: 6px;
  background: var(--es-field-bg); border: 1px solid var(--es-border);
}
.es-seed-phrase { font-size: 14px; letter-spacing: .3px; word-break: normal; }
.es-seed-tag {
  display: inline-block; margin-left: 6px; padding: 1px 7px; border-radius: 999px;
  font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
  background: var(--es-accent-dim); color: var(--es-accent); vertical-align: middle;
}
.es-seed-vaulthead {
  display: flex; justify-content: space-between; align-items: baseline;
  gap: 10px; margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--es-border);
}
.es-seed-modal {
  position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.6); padding: 16px;
}
.es-seed-modal-box {
  width: min(320px, 100%); padding: 18px; border-radius: 14px; text-align: center;
  background: var(--es-bg); color: var(--es-fg); border: 1px solid var(--es-border-strong);
  font: 400 13px/1.5 var(--es-font);
}
.es-seed-ttt { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 12px 0; }
.es-seed-ttt button {
  aspect-ratio: 1; font-size: 26px; cursor: pointer; border-radius: 8px;
  background: var(--es-field-bg); color: var(--es-fg); border: 1px solid var(--es-border);
}
.es-seed-ttt button[disabled] { cursor: default; }
@media (prefers-reduced-motion: no-preference) { .es-seed-panel { scroll-behavior: smooth; } }
`;

function injectStyles() {
  if (document.getElementById("es-seed-css")) return;
  document.head.appendChild(h("style", { id: "es-seed-css", text: CSS }));
}

/* ── the vault store ──────────────────────────────────────────────────────────────────────── */

function loadStore() {
  try {
    const raw = localStorage.getItem(VAULTS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* unreadable, or a private window */
  }
  return null;
}

function saveStore() {
  try {
    localStorage.setItem(VAULTS_KEY, JSON.stringify({ active: stored?.pubkey ?? "", list: vaults }));
  } catch {
    /* private mode — the vault lives for this session only */
  }
}

/** A name that distinguishes vaults in the switcher without asking anyone to invent one. */
const nextVaultName = () => `Vault ${vaults.length + 1}`;

/** Mint a phrase-backed identity and make it the active one. */
async function createVault() {
  const phrase = await newPhrase();
  const { pubkey, secret } = await deriveVault(phrase);
  const fresh = { pubkey, secret, phrase, name: nextVaultName() };
  vaults.push(fresh);
  stored = fresh;
  saveStore();
  return fresh;
}

/** Point everything at a vault we already hold, and pull its balance. */
async function activate(pubkey) {
  const found = vaults.find((v) => v.pubkey === pubkey);
  if (!found) return;
  stored = found;
  saveStore();
  vault = null;
  watchingVault = null;
  await ensureVault();
}

async function ensureVault() {
  if (!stored) {
    const store = loadStore();
    if (store?.list?.length) {
      vaults = store.list;
      stored = vaults.find((v) => v.pubkey === store.active) ?? vaults[0];
    } else {
      await createVault();
    }
  }
  const res = await api("/api/seeds/vault", { pubkey: stored.pubkey, secret: stored.secret });
  vault = res.vault;
}

async function refresh() {
  if (!stored) return;
  try {
    vault = (await api(`/api/seeds/vault?pubkey=${encodeURIComponent(stored.pubkey)}`)).vault;
  } catch {
    /* transient; keep showing the last known balance rather than blanking it */
  }

  // The runway of whatever we are watching. Skipped while broadcasting, where the relevant vault
  // is already your own, and cleared when the stream is your own in the same browser — otherwise
  // the pill would urge you to rescue yourself.
  const streamId = currentStreamId();
  if (!isBroadcasting() && streamId) {
    try {
      const res = await api(`/api/seeds/stream?id=${encodeURIComponent(streamId)}`);
      watchingVault = res.attached && res.vault && res.vault.pubkey !== stored.pubkey ? res.vault : null;
    } catch {
      watchingVault = null;
    }
  } else {
    watchingVault = null;
  }

  render();
}

/* ── the gate on the free seed ────────────────────────────────────────────────────────────── */

/**
 * Tic-tac-toe against a flower.
 *
 * FRICTION, NOT SECURITY, and the Worker says so too: minting a vault is free, so no gate here
 * can stop farming — it can only raise the price. The real defence is that a farmed seed is
 * worth $1 of bandwidth that still has to be burned in front of real viewers.
 *
 * Being a game rather than a spinner is the point: fifteen seconds of playing reads as shorter
 * than fifteen seconds of waiting. You are not required to win.
 */
function playTicTacToe() {
  return new Promise((resolve) => {
    const board = Array(9).fill(null);
    const status = h("div", { class: "es-seed-sub", style: { minHeight: "20px", color: "var(--es-accent)", fontWeight: "600" } });
    const grid = h("div", { class: "es-seed-ttt" });
    const overlay = h(
      "div",
      { class: "es-seed-modal", role: "dialog", "aria-modal": "true", "aria-label": "One quick game" },
      h(
        "div",
        { class: "es-seed-modal-box" },
        h("h2", { text: "One quick game 🌻" }),
        sub("Beat the flower (or don't) and we'll plant your first seed."),
        grid,
        status
      )
    );

    const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
    const winner = () => {
      for (const [a, b, c] of LINES) if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
      return board.every(Boolean) ? "draw" : null;
    };

    const done = (msg) => {
      status.textContent = msg;
      for (const b of grid.children) b.setAttribute("disabled", "");
      setTimeout(() => {
        overlay.remove();
        resolve();
      }, 900);
    };

    const paint = () => {
      grid.replaceChildren(
        ...board.map((cell, i) =>
          h("button", { type: "button", text: cell ?? "", disabled: cell ? "" : null, "aria-label": `Square ${i + 1}`, "data-i": i })
        )
      );
    };

    grid.addEventListener("click", (ev) => {
      const t = /** @type {HTMLElement} */ (ev.target);
      const i = Number(t.dataset?.i);
      if (!Number.isInteger(i) || board[i] || winner()) return;

      board[i] = "🌱";
      paint();
      const afterPlayer = winner();
      if (afterPlayer) return done(afterPlayer === "draw" ? "A draw — seed planted." : "You win! Seed planted.");

      // The flower plays the first free square. Deliberately beatable: this is a turnstile, and
      // a turnstile that can refuse you is a different product.
      const free = board.map((c, n) => (c ? null : n)).filter((n) => n !== null);
      board[free[Math.floor(Math.random() * free.length)]] = "🌻";
      paint();
      const afterFlower = winner();
      if (afterFlower) done(afterFlower === "draw" ? "A draw — seed planted." : "The flower wins — seed planted anyway.");
    });

    paint();
    document.body.appendChild(overlay);
  });
}

async function claimFreeSeed() {
  await playTicTacToe();
  try {
    const res = await api("/api/seeds/grant", { pubkey: stored.pubkey, secret: stored.secret });
    vault = res.vault;
  } catch (e) {
    restoreError = String(e.message || e);
  }
  render();
}

/* ── panel views ──────────────────────────────────────────────────────────────────────────── */

/**
 * The cash-out quote, rebuilt from state on every render.
 *
 * Returns null when nothing has been asked for, so the box stays empty until someone presses the
 * button — but once asked, the answer survives the panel refreshing underneath it.
 */
function quoteNodes() {
  if (!quote) return null;
  if (!quote.eligible) {
    return note(true,
      `Not yet: ${seedsText(quote.seeds_available ?? 0)} of ${quote.minimum_seeds} cash-outable seeds.`,
      quote.not_cashable > 0
        ? h("div", { text: `${seedsText(quote.not_cashable)} seeds can be burned on streaming but not cashed out.` })
        : null);
  }
  return note(false,
    h("b", { text: `You'd receive ${money(quote.lines.net)}.` }),
    h("div", { text: `${seedsText(quote.seeds_available)} seeds, minus ${money(quote.lines.stripe_out)} payout fee.` }),
    h("div", { text: "We take nothing." }),
    // The lesson this screen exists to teach: a FLAT fee shrinks as a proportion the longer you
    // wait. Shown rather than described, because the numbers make the argument.
    ...(quote.waiting || []).map((w) =>
      h("div", { style: { opacity: ".8" },
        text: `Wait for ${w.at_seeds} and you'd save ${money(w.saved)} over ${w.payouts} payouts this size.` })),
    h("div", { style: { marginTop: "6px", opacity: ".8" }, text: "Demo — no payout is sent." }));
}

/** The economy. The main screen. */
function mainView() {
  const empty = vault.seeds <= 0;
  // 30 viewer-minutes is one viewer for half an hour, or ten for three. Deliberately generous:
  // the warning has to arrive while there is still time to act on it.
  const low = !empty && vault.viewer_minutes_left < 30;
  const streamId = currentStreamId();
  const broadcasting = isBroadcasting();

  // The phrase is offered when there is something to lose, not at vault creation. A new
  // broadcaster holds one free seed; a wall of warnings before they have seen any value is
  // friction that buys nothing.
  const worthLosing = vault.paid > 0 || vault.earned > 0;

  const out = [
    h(
      "div",
      { class: "es-seed-vaulthead" },
      h("span", {}, h("b", { text: stored.name }), vaults.length > 1 ? ` · ${vaults.length} here` : ""),
      h("button", { class: "es-seed-link", act: "switch", type: "button" }, "Switch ▾")
    ),
  ];

  if (worthLosing && !stored.phrase) {
    out.push(
      note(true, "This vault was made before recovery phrases and ", h("b", { text: "cannot be restored" }),
        " if this browser is cleared. Make a new one to get a phrase.")
    );
  } else if (worthLosing) {
    out.push(
      note(false, "Worth backing up now. ",
        h("button", { class: "es-seed-link", act: "show-phrase", type: "button" }, "Show recovery phrase"))
    );
  }

  // Watching someone else: THEIR runway is the headline and planting is the first control. Your
  // own balance still matters, but only as the means to do something about theirs.
  if (watchingVault) {
    const wLow = watchingVault.viewer_minutes_left < 30;
    out.push(
      h("h3", {}, "Keep them on the air", h("span", { class: "es-seed-tag", text: "demo" })),
      sub("This stream runs on seeds. When they're gone, it stops."),
      h("div", { class: wLow ? "es-seed-big es-seed-low" : "es-seed-big" },
        watchingVault.viewer_minutes_left > 0
          ? [minutesText(watchingVault.viewer_minutes_left), h("small", { text: " of streaming left" })]
          : "Out of seeds"),
      row("Their vault", `${seedsText(watchingVault.seeds)} seeds`),
      row("Every seed you plant", `+${minutesText(SEED_VIEWER_MINUTES)}`),
      h("div", { class: "es-seed-hr" })
    );
  }

  out.push(
    h("h3", {}, "Your vault", h("span", { class: "es-seed-tag", text: "demo" })),
    sub(`1 seed = $1 = ${SEED_VIEWER_MINUTES.toLocaleString()} viewer-minutes`),
    h("div", { class: low ? "es-seed-big es-seed-low" : "es-seed-big" },
      seedsText(vault.seeds), h("small", { text: " seeds" })),
    row("Streaming left", minutesText(vault.viewer_minutes_left)),
    vault.earned > 0 && row("of that, cash-outable", `${seedsText(vault.cashable)} seeds`),
    vault.gifted > 0 && row("sent by other creators", minutesText(Math.floor(vault.gifted * SEED_VIEWER_MINUTES))),
    row("Burned so far", `${seedsText(vault.burned)} seeds`)
  );

  if (vault.blocked) {
    out.push(note(true, h("b", { text: `You went ${seedsText(vault.debt)} seeds over.` }),
      " We didn't cut your last stream off, but you'll need to top up before starting another one. Any packet settles it first."));
  } else if (empty) {
    out.push(note(true, "Out of seeds — viewers can't watch until you get more."));
  } else if (low) {
    out.push(note(true, `Running low. At your current audience this is about ${minutesText(vault.viewer_minutes_left)} of streaming.`));
  }

  if (!vault.granted) out.push(btn("free", "🌻 Claim your free seed"));

  out.push(
    h("div", { class: "es-seed-hr" }),
    h("h3", { text: "Get seeds" }),
    sub("Seeds you buy pay for your own streaming, or can be planted on someone else. They can't be cashed out — only seeds people plant on you can."),
    btn("buy-small", "Top up — 10 seeds for $10.59 (mock)"),
    btn("buy", "Packet — 50 seeds for $51.75 (mock)", true),
    sub("The extra is the card fee — $0.59 on $10 and $1.75 on $50, which is why the bigger one goes further. It goes to the card network, not to us: every seed you buy is worth a whole dollar because we don't take a cut of it."),

    h("div", { class: "es-seed-hr" }),
    h("h3", { text: "Give seeds" })
  );

  if (streamId && !broadcasting) {
    out.push(
      sub(`Plant on this stream — each seed buys them ${minutesText(SEED_VIEWER_MINUTES)} more of one viewer watching.`),
      vault.plantable > 0
        ? sub(`You can plant ${seedsText(vault.plantable)}.`)
        : sub("You have none to plant — only seeds you bought can be planted."),
      h("input", { class: "es-seed-input", id: "es-seed-plant", type: "number", min: "1", value: "5", "aria-label": "Seeds to plant" }),
      btn("plant", "Plant seeds on this stream")
    );
  } else {
    out.push(sub("Open someone's stream to plant seeds on it."));
  }

  // Gifting: creator to creator, and what arrives can only ever be burned. It only ever REDUCES
  // the systemwide cashable balance, which is why re-gifting is allowed — every hop is a dead
  // end for cash.
  if (vault.giftable > 0 && streamId && !broadcasting) {
    out.push(
      h("div", { class: "es-seed-hr" }),
      h("h3", { text: "Pass it on" }),
      sub(`You can pass on ${seedsText(vault.giftable)} seeds. What arrives can only be burned on streaming — never cashed out, never planted.`),
      h("input", { class: "es-seed-input", id: "es-seed-gift", type: "number", min: "1", value: "1", "aria-label": "Seeds to pass on" }),
      btn("gift", "Pass seeds to this creator", true)
    );
  }

  out.push(
    h("div", { class: "es-seed-hr" }),
    h("h3", { text: "Cash out" }),
    sub("10 seeds minimum. Only seeds other people planted on you can be cashed out."),
    btn("quote", "See what you'd receive", true),
    h("div", { id: "es-seed-quote" }, quoteNodes()),

    h("div", { class: "es-seed-hr" }),
    note(false,
      "This vault's id — no account, no email. It identifies you; it does ",
      h("b", { text: "not" }),
      " restore you, so it is safe to share and useless as a backup.",
      h("div", { class: "es-seed-key", text: stored.pubkey }),
      btn("copykey", "Copy vault id", true),
      broadcasting && attachedStream ? h("div", { style: { marginTop: "8px" }, text: "Burning from this broadcast." }) : null,
      h("div", { style: { marginTop: "8px" }, text: "Nothing here charges a card or sends a payout." })
    )
  );

  return out;
}

/** The switcher: every identity this browser holds, and the two ways to get another. */
function switchView() {
  return [
    h("h2", { text: "Vaults in this browser" }),
    sub("Practising the economy means being both the fan who buys and the creator who receives. Switching beats keeping two browser profiles."),
    ...vaults.map((v) =>
      h(
        "div",
        { class: "es-seed-row" },
        h("span", {}, h("b", { text: v.name }), v.pubkey === stored.pubkey ? " · active" : "",
          v.phrase ? "" : h("span", { class: "es-seed-tag", text: "no phrase" })),
        v.pubkey === stored.pubkey
          ? h("span", { text: "—" })
          : h("button", { class: "es-seed-link", act: "use", "data-key": v.pubkey, type: "button" }, "Use")
      )
    ),
    h("div", { class: "es-seed-hr" }),
    btn("new-vault", "Create another vault"),
    btn("restore", "Restore one from a phrase", true),
    h("div", { class: "es-seed-hr" }),
    btn("back", "← Back", true),
  ];
}

/** Show the phrase. The only screen that puts recovery material on the glass. */
function phraseView() {
  if (!stored.phrase) {
    return [
      h("h2", { text: "No phrase for this vault" }),
      note(true, "This one predates recovery phrases, so there is nothing to write down and no way to restore it. Create a new vault and move on before it holds anything."),
      btn("back", "← Back", true),
    ];
  }
  return [
    h("h2", { text: "Your recovery phrase" }),
    sub(`These ${PHRASE_LENGTH} words ARE the vault. Anyone who has them has the seeds; if you lose them and clear this browser, nobody can get the vault back — not even us.`),
    h("div", { class: "es-seed-phrase", text: stored.phrase }),
    btn("copyphrase", "Copy phrase", true),
    note(false, "Write it on paper. A screenshot lives in the same place as the browser you are trying to survive."),
    btn("back", "← Back", true),
  ];
}

/** Restore: the checksum is what lets this say WHERE the mistake is. */
function restoreView() {
  return [
    h("h2", { text: "Restore a vault" }),
    sub(`Type the ${PHRASE_LENGTH} words in order. Case and extra spaces don't matter.`),
    h("textarea", { class: "es-seed-input", id: "es-seed-phrase-in", rows: "3", placeholder: "able acid acre …", "aria-label": "Recovery phrase" }),
    restoreError ? note(true, restoreError) : null,
    btn("do-restore", "Restore"),
    btn("back", "← Back", true),
  ];
}

/* ── render ───────────────────────────────────────────────────────────────────────────────── */

function render() {
  if (!vault || !stored) return;

  const pill = document.getElementById("es-seed-pill");
  if (pill) {
    // The pill says the most urgent true thing. Watching someone who is running out beats your
    // own balance; your own debt beats your own runway.
    const w = watchingVault;
    if (w && w.viewer_minutes_left < 60) {
      pill.replaceChildren(h("span", { class: "es-seed-low", text: `🌻 ${minutesText(w.viewer_minutes_left)} left` }));
    } else if (vault.blocked) {
      pill.replaceChildren(h("span", { class: "es-seed-low", text: "🌻 Top up to stream" }));
    } else {
      pill.replaceChildren(h("span", { text: `🌻 ${seedsText(vault.seeds)} seeds` }));
    }
  }

  const panel = document.getElementById("es-seed-panel");
  if (!panel || !panelOpen) return;

  const views = { main: mainView, switch: switchView, phrase: phraseView, restore: restoreView };
  // `.filter(Boolean)` is not tidiness. A view builds its children as an array and uses the same
  // `cond && row(...)` idiom that h() supports — but this call is replaceChildren, not h(), and
  // replaceChildren stringifies whatever it is given. So a false condition rendered the literal
  // word "false" as a line in the panel, which is exactly what it did in production between
  // "Streaming left" and "Burned so far" until 2026-09-20. h() filters its own children; this is
  // the one place that bypassed it.
  panel.replaceChildren(...(views[view] || mainView)().filter(Boolean));
}

/* ── interaction ──────────────────────────────────────────────────────────────────────────── */

const numberIn = (id, fallback) => {
  const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
  const n = Number(el?.value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

async function onPanelClick(ev) {
  const hit = /** @type {HTMLElement|null} */ (ev.target)?.closest?.("[data-act]");
  if (!hit) return;
  const target = /** @type {HTMLElement} */ (hit);
  const act = target.dataset.act;
  ev.preventDefault();

  const creds = () => ({ pubkey: stored.pubkey, secret: stored.secret });

  // Anything that moves money invalidates a quote that is on screen. Cleared here, once, rather
  // than in each of the five handlers that change a balance — a stale quote showing a payout the
  // vault can no longer make is worse than showing nothing.
  if (act !== "quote") quote = null;

  try {
    switch (act) {
      case "switch": view = "switch"; render(); return;
      case "back": view = "main"; restoreError = ""; render(); return;
      case "show-phrase": view = "phrase"; render(); return;
      case "restore": view = "restore"; restoreError = ""; render(); return;

      case "use":
        await activate(target.dataset.key);
        view = "main";
        await refresh();
        return;

      case "new-vault":
        await createVault();
        view = "main";
        await ensureVault();
        await refresh();
        return;

      case "do-restore": {
        const el = /** @type {HTMLTextAreaElement|null} */ (document.getElementById("es-seed-phrase-in"));
        const phrase = normalise(el?.value ?? "");
        const problem = await checkPhrase(phrase);
        if (problem) {
          restoreError = describeProblem(problem);
          render();
          return;
        }
        const { pubkey, secret } = await deriveVault(phrase);
        if (!vaults.some((v) => v.pubkey === pubkey)) {
          vaults.push({ pubkey, secret, phrase, name: nextVaultName() });
        }
        await activate(pubkey);
        view = "main";
        restoreError = "";
        await refresh();
        return;
      }

      case "free": await claimFreeSeed(); return;

      case "buy-small":
      case "buy": {
        const res = await api("/api/seeds/buy", { ...creds(), size: act === "buy" ? "large" : "small", packets: 1 });
        vault = res.vault;
        render();
        return;
      }

      case "plant": {
        const streamId = currentStreamId();
        if (!streamId) return;
        const res = await api("/api/seeds/move", { ...creds(), seeds: numberIn("es-seed-plant", 5), stream_id: streamId });
        vault = res.vault;
        await refresh();
        return;
      }

      case "gift": {
        const streamId = currentStreamId();
        if (!streamId) return;
        const res = await api("/api/seeds/gift", { ...creds(), seeds: numberIn("es-seed-gift", 1), stream_id: streamId });
        vault = res.vault;
        await refresh();
        return;
      }

      case "quote": {
        // The endpoint reads `earned_micro` alone and takes no amount — it quotes the whole
        // cash-outable balance. Passing a seed count would imply a choice that does not exist.
        quote = await api(`/api/seeds/quote?pubkey=${encodeURIComponent(stored.pubkey)}`);
        render();
        return;
      }

      case "copykey": await navigator.clipboard?.writeText(stored.pubkey); return;
      case "copyphrase": await navigator.clipboard?.writeText(stored.phrase ?? ""); return;
      default: return;
    }
  } catch (e) {
    restoreError = String(e?.message || e);
    render();
  }
}

/* ── attaching a broadcast ────────────────────────────────────────────────────────────────── */

/**
 * Tell the Worker which vault this broadcast burns from.
 *
 * Only while broadcasting, and only once the share link exists — before that there is no id to
 * attach. Without a row here a stream burns nothing, which is why every broadcast made before
 * anyone opened this panel is completely unaffected.
 */
async function syncStream() {
  if (!isBroadcasting() || !stored) return;
  const streamId = currentStreamId();
  if (!streamId || streamId === attachedStream) return;
  try {
    await api("/api/seeds/attach", { pubkey: stored.pubkey, secret: stored.secret, stream_id: streamId });
    attachedStream = streamId;
    render();
  } catch {
    /* the broadcast is not ours to attach, or the demo is off server-side */
  }
}

/* ── entry point ──────────────────────────────────────────────────────────────────────────── */

/**
 * Reached from ONE line in earthseed.js.
 *
 * Returns before touching anything when the demo is off, so the blast radius of a money-shaped
 * widget on a live site is a single import. No vault is created until someone opens the panel:
 * the persistent pseudonym is opt-in, and opening the panel is the opt.
 */
export async function initSeeds() {
  try {
    const param = new URL(location.href).searchParams.get("seeds");
    if (param === "0") localStorage.setItem(OFF_KEY, "1");
    if (param === "1") localStorage.removeItem(OFF_KEY);
    if (localStorage.getItem(OFF_KEY) === "1") return;
  } catch {
    /* private mode: treat as on */
  }

  // Server-side off switch. A pill that opens onto an error is worse than no pill.
  //
  // 404 is the HEALTHY answer here — "no vault by that name" — and is what a working deployment
  // returns. Anything else (503, a 5xx, the route missing entirely) means the demo is not
  // available on this Worker and the right move is to render nothing at all.
  try {
    const probe = await fetch(new URL("/api/seeds/vault?pubkey=probe", location.href));
    if (probe.status !== 404) return;
  } catch {
    return; // no control plane reachable; say nothing rather than half-render
  }

  injectStyles();

  const pill = h("button", { id: "es-seed-pill", class: "es-seed-pill", type: "button", "aria-label": "Seeds (demo)" },
    h("span", { text: "🌻 …" }));
  const panel = h("div", { id: "es-seed-panel", class: "es-seed-panel", hidden: "" });

  pill.addEventListener("click", async () => {
    panelOpen = !panelOpen;
    panel.hidden = !panelOpen;
    if (panelOpen && !vault) {
      try {
        await ensureVault();
      } catch (e) {
        panel.replaceChildren(note(true, `Could not open a vault: ${String(e?.message || e)}`));
        return;
      }
    }
    if (panelOpen) await refresh();
  });
  panel.addEventListener("click", onPanelClick);

  document.body.append(pill, panel);

  // A vault already in this browser means the pill can show a real number immediately.
  if (loadStore()?.list?.length) {
    try {
      await ensureVault();
      await refresh();
    } catch {
      /* offline; the pill stays at its placeholder until the panel is opened */
    }
  }

  // Burn accrues per viewer heartbeat server-side, so the balance moves without anything here
  // doing something. Poll while the panel is open, and once a minute otherwise.
  setInterval(() => {
    if (vault && (panelOpen || isBroadcasting())) void refresh();
  }, 15000);

  // Attach as soon as the share link appears, and whenever it changes (a new link mid-stream).
  if (isBroadcasting()) {
    void syncStream();
    setInterval(() => void syncStream(), 4000);
  }
}
