// Live chat, end-to-end encrypted, for whoever holds the link.
//
// Ported from Wallflower's src/chat/chat-client.ts. The Durable Object on the other end relays a
// blob it cannot read (src/worker/chat-room.ts), so chat is exactly as private as the stream it
// accompanies: anyone with the link can read it, and the operator cannot.
//
// ── THE KEY ─────────────────────────────────────────────────────────────────────────────────
//
// Derived from the same `#k=` fragment and the same rotating salts as the video, through a
// DIFFERENT HKDF info string. That separation is the whole of the argument:
//
//   media   info "earthseed-media-v1|<id>|<epoch>"   (or v2 with a passcode)
//   chat    info "earthseed-chat-v1|<id>|<epoch>"    (or v2 with a passcode)
//
// Same inputs, independent outputs. Holding every chat key ever derived decrypts no video and
// vice versa, so a compromise of one is not a compromise of the other — and a passcode protects
// both, because it is mixed into the input material for both.
//
// Derived through a GETTER rather than handed in as a value, and that is not fussiness: a
// broadcaster only learns the stream salt at go-live, which may be after this panel opens, and
// regenerating a passcode re-keys mid-session. Deriving per use means chat always follows the
// same inputs as the video instead of pinning stale ones.
//
// ── RENDERING ───────────────────────────────────────────────────────────────────────────────
//
// Every string goes in through textContent. Names and messages are written by other people, and
// this origin enforces `trusted-types 'none'` so there is no innerHTML path available anyway —
// but the rule would stand regardless. A name is the obvious injection vector in a chat and it
// is the one this cannot have.

const NAME_KEY = "es:chat:name";
const MAX_TEXT = 500;
const MAX_NAME = 32;
/** Keep the rendered list bounded; the DO only ever sends 50 of history in any case. */
const MAX_RENDERED = 200;

const b64 = (b) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

/** Encrypt a UTF-8 string to `<b64url nonce>.<b64url ciphertext>`. */
async function sealText(key, plaintext) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, new TextEncoder().encode(plaintext))
  );
  return `${b64(nonce)}.${b64(ct)}`;
}

/** Reverse of sealText. Returns null on any failure — a wrong key must not throw. */
async function openText(key, sealed) {
  try {
    const [n, c] = String(sealed).split(".");
    if (!n || !c) return null;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(n) }, key, unb64(c));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

function loadName() {
  try {
    const saved = localStorage.getItem(NAME_KEY);
    if (saved?.trim()) return saved.trim().slice(0, MAX_NAME);
  } catch {
    /* private mode */
  }
  // Not an identity — a label, so two people in one room can be told apart. It is sealed along
  // with the text, so it never reaches the relay in the clear either.
  return `Guest-${Math.random().toString(16).slice(2, 6)}`;
}

const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k) n.appendChild(typeof k === "string" ? document.createTextNode(k) : k);
  return n;
};

const clockOf = (ts) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Mount the chat panel and connect.
 *
 * @param {{
 *   nodeId: string,
 *   tag: string,
 *   container: HTMLElement,
 *   chatKey: () => Promise<CryptoKey|null>,
 * }} opts
 * @returns {{ destroy: () => void }}
 */
export function initChat(opts) {
  let socket = null;
  let closed = false;
  let retry = 0;
  /** Messages we have rendered, by id, so history replay after a reconnect does not duplicate. */
  const seen = new Set();

  const log = el("div", { className: "es-chat-log", role: "log", "aria-live": "polite" });
  const nameInput = el("input", {
    className: "es-chat-name", type: "text", value: loadName(),
    maxLength: MAX_NAME, "aria-label": "Your display name", placeholder: "name",
  });
  const textInput = el("input", {
    className: "es-chat-text", type: "text", maxLength: MAX_TEXT,
    "aria-label": "Message", placeholder: "Say something…", autocomplete: "off",
  });
  const sendBtn = el("button", { className: "es-chat-send", type: "button", textContent: "Send" });
  const status = el("div", { className: "es-chat-status" });

  nameInput.addEventListener("change", () => {
    try {
      localStorage.setItem(NAME_KEY, nameInput.value.trim().slice(0, MAX_NAME));
    } catch {
      /* private mode: the name lasts this session */
    }
  });

  const say = (m) => {
    status.textContent = m;
  };

  function append(name, text, ts) {
    const line = el(
      "div",
      { className: "es-chat-msg" },
      el("span", { className: "es-chat-when", textContent: clockOf(ts) }),
      el("b", { className: "es-chat-who", textContent: name }),
      el("span", { className: "es-chat-said", textContent: text })
    );
    log.appendChild(line);
    while (log.childElementCount > MAX_RENDERED) log.removeChild(log.firstChild);
    // Only follow if the reader is already at the bottom. Yanking someone away from something
    // they scrolled up to read is the most annoying thing a chat panel can do.
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  /** Open one envelope and render it, or say plainly that it could not be opened. */
  async function show(msg) {
    if (!msg?.id || seen.has(msg.id)) return;
    seen.add(msg.id);

    const key = await opts.chatKey();
    const plain = key ? await openText(key, msg.ct) : null;
    if (plain === null) {
      // A message sealed under a different key — sent before a salt rotation, or by someone
      // holding a different passcode. Shown as a gap rather than hidden: a chat that silently
      // drops messages looks like a chat where nobody is talking.
      append("—", "(can't decrypt this message)", msg.ts);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(plain);
    } catch {
      return;
    }
    append(String(parsed.name ?? "Guest").slice(0, MAX_NAME), String(parsed.text ?? "").slice(0, MAX_TEXT), msg.ts);
  }

  async function send() {
    const text = textInput.value.trim().slice(0, MAX_TEXT);
    if (!text || !socket || socket.readyState !== WebSocket.OPEN) return;

    const key = await opts.chatKey();
    if (!key) {
      say("waiting for the stream key…");
      return;
    }
    // Name and text sealed TOGETHER, in one envelope. Sealing them separately would leak which
    // messages came from the same person by letting an observer match repeated name ciphertexts.
    const ct = await sealText(key, JSON.stringify({ name: nameInput.value.trim().slice(0, MAX_NAME) || "Guest", text }));
    socket.send(JSON.stringify({ ct }));
    textInput.value = "";
    say("");
  }

  sendBtn.addEventListener("click", () => void send());
  textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void send();
    }
  });

  function connect() {
    if (closed) return;
    const url = new URL(`/api/stream/${encodeURIComponent(opts.nodeId)}/chat`, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("tag", opts.tag);

    let ws;
    try {
      ws = new WebSocket(url);
    } catch {
      say("chat unavailable");
      return;
    }
    socket = ws;

    ws.addEventListener("open", () => {
      retry = 0;
      say("");
    });

    ws.addEventListener("message", async (ev) => {
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (data.type === "history") for (const m of data.messages ?? []) await show(m);
      else if (data.type === "msg") await show(data);
    });

    ws.addEventListener("close", () => {
      if (closed) return;
      // Backs off to 30s. A stream that ended leaves every viewer's socket closing at once, and
      // a tight retry loop from all of them is a self-inflicted thundering herd.
      const wait = Math.min(30000, 1000 * 2 ** retry++);
      say("reconnecting…");
      setTimeout(connect, wait);
    });

    ws.addEventListener("error", () => {
      /* close fires next; nothing to add */
    });
  }

  opts.container.append(
    log,
    el("div", { className: "es-chat-compose" }, nameInput, textInput, sendBtn),
    status
  );
  connect();

  return {
    destroy() {
      closed = true;
      try {
        socket?.close();
      } catch {
        /* already gone */
      }
      opts.container.replaceChildren();
    },
  };
}
