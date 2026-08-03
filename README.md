# Earthseed

**Private live streaming, small enough to read.** Two short HTML pages load one
open-source client; your video is **encrypted in your browser** so the relay
network only ever carries ciphertext it can't read; discovery rides a public DHT
with **no accounts and no server-side list of streams**.

Live at **[earthseed.live](https://earthseed.live)**. Trust model:
**[earthseed.live/trust.html](https://earthseed.live/trust.html)**
(source in [`docs/trust-and-flows.md`](docs/trust-and-flows.md)).

> Real privacy, honestly bounded. This README — and the trust doc — describe both
> what the app protects and where the limits are.

## How it works

```
 Broadcaster browser ──ciphertext──▶ origin relay ──▶ edge relay ──ciphertext──▶ Viewer browser
   encrypts each frame                (content-blind, moves bytes it can't read)     decrypts locally
        │                                                                                 ▲
        ├─ asks the broker for a relay + a short-lived transport token                    │
        └─ signs "public key → relay" into a public DHT ──────────── viewer resolves it ──┘
```

- **End-to-end encryption.** Each broadcast's content key is derived in the browser
  (`HKDF-SHA256` over a random key that lives only in the `#…` fragment of the share
  link, plus public salts). Media is `AES-256-GCM` per encoded chunk — **audio and
  video**. No relay or broker ever sees the key.
- **Serverless discovery.** The broadcaster's Ed25519 public key is the stream's
  identity and its DHT key (pkarr / BitTorrent mainline DHT). There's no directory to
  browse — a stream is reachable only to someone who already has its key.
- **Content-blind relays.** Media rides plain WebTransport/QUIC through a relay fleet
  that only ever forwards ciphertext. A broker assigns a nearby relay and issues a
  short-lived, per-broadcast transport token; it never sees the content key.
- **No accounts.** No login, no chat, no stored IPs, no server-side stream list.

## The two files, and owning your copy

- **`send.html`** — open it to go live from your camera or screen; it generates the
  private share link.
- **`view.html`** — where share links open to watch.

Use them hosted (`earthseed.live/send.html`), or **download the self-contained bundle
and run it off your own computer** — unzip and double-click `send.html`, no server in
the middle. The client code is open source and hash-pinned so it can't be swapped
under you. See the trust doc's "Choose your path" for the full menu (Tor/VPN, your own
access key, your own relay).

A **pre-built, ready-to-run copy is checked in under [`self-contained/`](self-contained/)** —
every line of the client (JS + WebAssembly) with relative paths, nothing fetched from
another server. Open `self-contained/send.html` directly (no build step), or host the
folder anywhere. Rebuild it yourself with `npm run build:own`.

## Build & run

Requires a recent Node and a browser with native WebCodecs + WebTransport
(Chrome/Edge, Firefox, Safari 17+).

```bash
npm install
npm run dev            # local dev server (Vite)

npm run build:app      # hosted client build (assets served from the CDN)
npm run build:own      # self-contained "own your copy" bundle → own.zip
npm run build:min      # TCB-minimal build (drops the libav Opus polyfill; native WebCodecs only)
npm run build:static   # assemble dist/ (landing + send/view + trust doc)
npm run deploy         # build + deploy to Cloudflare Workers (wrangler)
```

Key source:

- `src/` — the client: crypto (`src/crypto/{media-crypto,dht,node-id,link-keys}.ts`),
  the broker client (`src/broker.ts`), routing, and the worker.
- `index.html` — the app template that becomes `send.html` / `view.html`.
- `landing.html` — the earthseed.live landing page.
- `vite.*.config.ts` — hosted / self-contained / TCB-minimal builds.
- `scripts/` — build assemblers (`build-static.mjs`, `build-own.mjs`).
- `docs/trust-and-flows.md` — the trust & privacy model.

## Privacy, honestly

The design makes every party in the path either **content-blind**, **swappable**, or
**removable** — but it doesn't pretend the limits away:

- Any relay you connect to sees your **IP** (true of any website). It isn't stored;
  put a **VPN or Tor** in front to hide it — encryption and discovery are unchanged.
- A share link is only as private as **how you share it** — the `#…` key never reaches
  a server, but whoever carries your message (and your browser history) sees the link.
- "Read exactly what runs" is a goal, not yet a proof: a **reproducible build**
  (verifying the shipped bytes against this source) is on the roadmap.

Full, itemized detail — including what each hop can and cannot see — is in
[`docs/trust-and-flows.md`](docs/trust-and-flows.md).

## License

MIT — see [LICENSE](LICENSE).
