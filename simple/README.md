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
(Media over QUIC) by [Luke Curley](https://github.com/kixelated). It is **unmodified**, but it is
**vendored** — built once from exact npm versions into [`vendor/moq-net-0.1.5.mjs`](vendor/moq-net-0.1.5.mjs)
and served from this origin rather than fetched from a CDN at runtime, because code loaded onto
these pages sits next to the content key. [`vendor/README.md`](vendor/README.md) explains the
reasoning and gives a reproducible build you can hash-check against the file we ship.

## Use it

1. Open **`broadcast.html`**, allow the camera + mic, press **Go live**.
2. Press **Copy viewer link** and send it to whoever should watch.
3. They open the link in **`watch.html`** — no account, no password.

The share link looks like `watch.html?node=<id>&o=<origin>#k=<key>`. The part after `#` is the
content key; browsers never send a URL fragment to a server, so **only someone with the whole
link can decrypt the stream.**

Optionally tick **Require a passcode to watch** before going live. That mints a short second secret
that is *not* in the link — read it to your viewer over a different channel and they type it into
the watch page. It never reaches any server; it is mixed into the key, so a wrong one just fails to
decrypt. **Regenerate** locks out everyone holding the old passcode, without changing your link; it
applies the next time you go live. See [TRUST.md](./TRUST.md).

Works on recent **Chrome/Edge** and **Safari on iOS 18+ / macOS**. Audio starts muted — tap to unmute.

## Host it yourself

It's static — put `earthseed.js`, `audio-capture-worklet.js`, `vendor/` and the two HTML files on
any HTTPS host. Set your own publishable key via `<meta name="earthseed-key" content="pk_…">`
(it's public — safe to ship). The broker handles relay assignment, per-broadcast tokens and public
salts; it never sees your content.

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

There used to be an "open-relay" mode that skipped the broker and used any public MoQ endpoint.
It was removed: with no broker there is nothing to authorize a publisher, so anyone could publish
to anyone's broadcast name. Keeping an unauthorized second path would have meant keeping that hole
open, and the narrow use case this is built for values that gate more than it values flexibility.

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
