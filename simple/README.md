# Earthseed — private live streaming, small enough to read

End-to-end-encrypted live streaming with **no build step and almost no code**. Your video is
encrypted in your browser; the relay that carries it and the broker that connects you only ever
move ciphertext they can't read. No accounts, no analytics, no server-side list of streams.

**Live:** https://earthseed.live · **Trust model:** [`TRUST.md`](TRUST.md)

## The whole thing is two files

| File | What it is |
|---|---|
| [`earthseed.js`](earthseed.js) | **Our entire client** — one unminified, documented ES module. Capture, encode, **encrypt**, decrypt, decode, render. It runs in the browser as-is; what you read is what runs. |
| `broadcast.html` / `watch.html` | Thin pages that load `earthseed.js` and call `runBroadcast()` / `runWatch()`. |

The only third-party runtime code is the transport, [`@moq/net`](https://www.npmjs.com/package/@moq/net/v/0.1.5)
(Media over QUIC), loaded **directly from its published package at a pinned version** via an
`<script type="importmap">` entry — not vendored, not modified. You can verify it upstream.

## Use it

1. Open **`broadcast.html`**, allow the camera + mic, press **Go live**.
2. Press **Copy viewer link** and send it to whoever should watch.
3. They open the link in **`watch.html`** — no account, no password.

The share link looks like `watch.html?node=<id>&o=<origin>#k=<key>`. The part after `#` is the
content key; browsers never send a URL fragment to a server, so **only someone with the whole
link can decrypt the stream.**

Works on recent **Chrome/Edge** and **Safari on iOS 18+ / macOS**. Audio starts muted — tap to unmute.

## Host it yourself

It's static — put `earthseed.js` + the two HTML files on any HTTPS host. Two modes:

- **Broker mode (default):** uses the tinymoq broker for a gated relay + short-lived token and
  per-stream salts. Set your own publishable key via `<meta name="earthseed-key" content="pk_…">`
  (it's public — safe to ship).
- **Open-relay mode:** add `?relay=https://your.relay/` to `broadcast.html`. No broker; streams
  through any open MoQ relay you point at. Still end-to-end encrypted. Great for a zero-backend review.

## How it works (short version)

```
 Broadcaster browser ──ciphertext──▶ origin relay ──▶ edge relay ──ciphertext──▶ Viewer browser
   encrypt each frame                 (content-blind, moves bytes it can't read)      decrypt locally
        │  CK = HKDF(#k=, salts)                                                  CK = HKDF(#k=, salts) │
        └── broker: gated relay + token + salts (never sees #k=) ──────────────────────────────────────┘
```

- **End-to-end encryption** — each broadcast's key is derived in the browser from a random value
  that lives only in the `#…` fragment of the share link, plus public salts. `AES-256-GCM` per
  encoded chunk, audio and video. No relay or broker ever sees the key.
- **Content-blind path** — media rides plain WebTransport/QUIC through relays that only forward
  ciphertext; the catalog (codec/resolution) is cleartext by design.
- **No accounts, no directory** — the stream's identity is a public key; there's no login and no
  server-side list of streams.

## Develop

No bundler. `earthseed.js` is plain JS with `// @ts-check` + JSDoc, so you can typecheck it:

```bash
npx tsc --noEmit -p simple/tsconfig.json
```

`tsconfig.json` and `env.d.ts` are dev-only (not shipped). See [`TRUST.md`](TRUST.md) for the full
threat model, the crypto spec, and the honest limits.

## License

MIT.
