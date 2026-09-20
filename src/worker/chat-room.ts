// Per-stream live chat, backed by a Durable Object using the WebSocket Hibernation API (no
// duration charges while idle). One instance per stream id. Every connected socket —
// broadcaster and viewers — receives every message; the last N are kept so late joiners see
// recent context.
//
// ── END-TO-END ENCRYPTED ────────────────────────────────────────────────────────────────────
//
// This object relays and stores ONE OPAQUE BLOB per message and cannot read any of it. Both the
// display name and the text are sealed client-side under a key derived from the share link's
// `#k=` fragment — the same secret that decrypts the video, through a different HKDF info — so
// chat is exactly as private as the stream it accompanies. Anyone with the link can read it;
// the operator cannot.
//
// This replaced a plaintext version on 20 Sep 2026. That one stored `{name, text}` in durable
// storage and broadcast it in the clear, which would have made chat the single least private
// thing on a site whose whole argument is that it cannot see your stream: an operator could not
// watch a broadcast but could read every word said about it, and so could anyone who ever
// compelled this storage. The DO had been bound since August with no client attached, so
// nothing was migrated and nothing was lost — the shape was simply wrong before anyone used it.
//
// ── THE CONSEQUENCE, STATED PLAINLY ─────────────────────────────────────────────────────────
//
// There is no server-side moderation of chat, because there is nothing here to moderate.
// Rotating a stream's salt re-keys chat along with the video, which is the only lever that
// applies — and the kill switch stops the broadcast this chat is attached to.
//
// ── WHAT THIS OBJECT STILL SEES ─────────────────────────────────────────────────────────────
//
// How many messages, how large, and when. Not who, and not what. Worth naming rather than
// leaving someone to work out: traffic analysis of a chat is a real signal even when the
// contents are sealed.

interface ChatMsg {
  id: string;
  /** Sealed "<nonce>.<ciphertext>". The name and the text are both inside it. */
  ct: string;
  ts: number;
}

const MAX_HISTORY = 50;
/** Generous because the payload is ciphertext of a name plus up to 500 characters, base64'd. */
const MAX_CT = 2048;
const MIN_INTERVAL_MS = 250; // light per-connection anti-flood throttle

export class ChatRoom {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    // Hibernatable: the DO can be evicted between messages and revived on the next one.
    this.state.acceptWebSocket(server);
    const history = (await this.state.storage.get<ChatMsg[]>("history")) ?? [];
    server.send(JSON.stringify({ type: "history", messages: history }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    let data: { ct?: unknown };
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    // Anti-flood: drop messages arriving faster than MIN_INTERVAL_MS on one socket.
    // serializeAttachment survives hibernation, so the throttle persists across eviction.
    const now = Date.now();
    const last = (ws.deserializeAttachment() as { t?: number } | null)?.t ?? 0;
    if (now - last < MIN_INTERVAL_MS) return;

    // The ONLY validation possible here, and the only one wanted: a length bound. The contents
    // are ciphertext, so there is nothing to inspect, sanitise or judge — which is the point.
    // Without the bound this is a free write-anything-sized blob store.
    const ct = String(data.ct ?? "");
    if (!ct || ct.length > MAX_CT) return;

    ws.serializeAttachment({ t: now });

    const msg: ChatMsg = { id: crypto.randomUUID(), ct, ts: now };
    let history = (await this.state.storage.get<ChatMsg[]>("history")) ?? [];
    history.push(msg);
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
    await this.state.storage.put("history", history);

    const payload = JSON.stringify({ type: "msg", ...msg });
    for (const sock of this.state.getWebSockets()) {
      try {
        sock.send(payload);
      } catch {
        // socket going away; ignore
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code);
    } catch {
      // already closing
    }
  }
}
