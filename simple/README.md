# Earthseed — the client

End-to-end-encrypted live streaming with **no build step and no runtime dependency of our own**.
Your video and audio are encrypted in your browser; the CDN that carries them only ever moves
ciphertext it cannot read. There is no sign-in, and no analytics.

**Live:** https://earthseed.live · **Trust model:** [`TRUST.md`](TRUST.md) · **Hashes:**
[`../INTEGRITY.md`](../INTEGRITY.md)

## The files

It used to be one. It is now thirteen and about 7,500 lines — every one unminified, and each
reached by a dynamic import, so a page only fetches what it uses.

| File | Lines | What it is |
|---|---|---|
| [`earthseed.js`](earthseed.js) | 3,207 | capture, encode, **encrypt**, publish, subscribe, **decrypt**, decode, render, and every page controller |
| [`compositor.js`](compositor.js) | 1,098 | camera + screen + mic into one canvas and one audio mix; the burn-ins are drawn here |
| [`seeds.js`](seeds.js) · [`seeds-recovery.js`](seeds-recovery.js) | 1,102 | the seeds demo and its 256-word recovery phrase |
| [`qr.js`](qr.js) | 533 | a QR encoder, so a link on screen is encoded here and not by a third party |
| [`overlay.js`](overlay.js) · [`overlay-editor.js`](overlay-editor.js) | 547 | the broadcaster's panel: typed blocks built as DOM, never parsed from markup |
| [`chat.js`](chat.js) | 251 | end-to-end encrypted chat |
| [`geo-stamp.js`](geo-stamp.js) · [`edge-clock.js`](edge-clock.js) · [`nearest-city.js`](nearest-city.js) | 644 | the optional location and time burn-in, and the clock it trusts instead of yours |
| [`offline-notice.js`](offline-notice.js) · [`audio-capture-worklet.js`](audio-capture-worklet.js) | 182 | the shutter notice; Safari's PCM capture path |
| `*.html` | — | thin pages that load `earthseed.js` and call `runBroadcast()` / `runWatch()` |

"Small enough to read in an afternoon" was a real property of this directory and it has been spent.
[`../INTEGRITY.md`](../INTEGRITY.md) is what stands in its place: a SHA-256 for every file above,
committed to git rather than only to the site being checked. `npm run verify` compares the two.

The only third-party runtime code is the transport, [`@moq/net`](https://www.npmjs.com/package/@moq/net/v/0.1.5)
(Media over QUIC) by [Luke Curley](https://github.com/kixelated). It is **unmodified**, but it is
**vendored** — built once from exact npm versions into [`vendor/moq-net-0.1.5.mjs`](vendor/moq-net-0.1.5.mjs)
and served from this origin rather than fetched from a CDN at runtime, because code loaded onto
these pages sits next to the content key. [`vendor/README.md`](vendor/README.md) explains the
reasoning and gives a reproducible build you can hash-check against the file we ship.

## Use it

1. Open **`broadcast.html`**, switch on **Camera**, **Mic** and **Screen** in any combination,
   press **Go live**.
2. Press **Copy viewer link** and send it to whoever should watch.
3. They open the link in **`watch.html`** — no account, no password.

The share link looks like `watch.html?node=<id>#k=<key>`. The part after `#` is the
content key; browsers never send a URL fragment to a server, so **only someone with the whole
link can decrypt the stream.**

Optionally tick **Require a passcode to watch** before going live. That mints a short second secret
that is *not* in the link — read it to your viewer over a different channel and they type it into
the watch page. It never reaches any server; it is mixed into the key, so a wrong one just fails to
decrypt. **Regenerate** locks out everyone holding the old passcode, without changing your link; it
applies the next time you go live. See [TRUST.md](./TRUST.md).

Works on recent **Chrome/Edge** and **Safari on iOS 18+ / macOS**. Audio starts muted — tap to unmute.

## Host it yourself

It's static — `npm run bundle` packages everything listed above plus `vendor/` and the HTML files
for any HTTPS host — but since August 2026 this client asks **its own origin** for placement
(`POST /api/broadcast/start`, `POST /api/watch/start`) rather than reaching a relay broker
directly. A full self-host therefore also means running the Worker in `../src/worker/`, which holds
the CDN signing key, checks the publish key, verifies the broadcast name is yours and enforces the
kill switch.

It used to need no server at all, and that is exactly what made a stream impossible to stop:
with the credential printed in the page there was no moment at which anyone could decline. The
encryption is untouched by the change — the Worker only ever sees names, tags and capabilities, and
the `#k=` fragment still never reaches any server.

Note that self-hosting the client doesn't come with the security headers this repo ships in
`_headers` — that file is a Cloudflare asset-server mechanism and is inert elsewhere. Copy the
policy out of `_headers` onto your own host, or at minimum set
`Content-Security-Policy: frame-ancestors 'none'; base-uri 'none'; object-src 'none'`,
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

### If you edit a page, regenerate the CSP hashes

`script-src` pins every inline `<script>` block in these pages by SHA-256, so changing one —
including its indentation — invalidates the hash. This does **not** fail loudly: the browser
refuses the script and the page quietly does nothing. After editing any HTML in `simple/`:

```sh
node scripts/csp-hashes.mjs --write   # regenerate
node scripts/csp-hashes.mjs           # check; non-zero exit if _headers has drifted
```

The policy is **enforced** as of 12 Aug 2026 — a bad hash now blocks the script rather than merely
reporting it, which is why the drift check matters. `report-uri` is kept on the enforced policy, so
anything blocked still shows up at `/api/csp-report` (`npx wrangler tail`). To roll back, set
`ENFORCE = false` in that script, re-run with `--write`, and deploy.

There used to be an "open-relay" mode that skipped placement entirely and used any public MoQ
endpoint. It was removed: with nothing to authorize a publisher, anyone could publish to anyone's
broadcast name. Keeping an unauthorized second path would have meant keeping that hole
open, and the narrow use case this is built for values that gate more than it values flexibility.

## How it works (short version)

```
 Broadcaster browser ─────────────ciphertext─────────────▶ cdn.moq.pro ─────▶ Viewer browser
   composite, encode, encrypt                    (content-blind: moves bytes        decrypt locally
        │  CK = HKDF(#k=, salts)                  it cannot read)            CK = HKDF(#k=, salts) │
        └── our Worker: admits the publisher, mints a CDN token (never sees #k=) ─────────────────┘
```

- **End-to-end encryption** — each broadcast's key is derived in the browser from a random value
  that lives only in the `#…` fragment of the share link, plus public salts. `AES-256-GCM` per
  encoded chunk, audio and video. Chat rides the same link under a sibling key. Nothing in the
  middle ever sees any of them.
- **Content-blind path** — media rides plain WebTransport/QUIC through a CDN that only forwards
  ciphertext; the catalog (codec/resolution) is cleartext by design.
- **No sign-in** — a broadcast's identity is an Ed25519 public key and publishing is admitted by a
  capability, not an account. There IS a server-side record of *which names* went live and when,
  which is the price of being able to stop one; there is none of *who*. An accounts tier exists in
  the Worker and is switched off — `GET /api/config` reports `"accounts"` so you can check rather
  than take our word.

## Develop

No bundler. Everything here is plain JS with JSDoc types, so you can typecheck it:

```bash
npx tsc --noEmit -p simple/tsconfig.json
```

`tsconfig.json` and `env.d.ts` are dev-only (not shipped). See [`TRUST.md`](TRUST.md) for the full
threat model, the crypto spec, and the honest limits.

## License

MIT.
