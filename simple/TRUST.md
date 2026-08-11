# Trust & flows — what a reviewer sees

This app is deliberately small so you can read all of it before trusting it with a live stream.
This document states exactly what each party can and cannot see, the cryptography, and the honest
limits. The interactive version of this map is on the home page (https://earthseed.live).

## The parties

| Party | Role | Runs our code? |
|---|---|---|
| **Broadcaster browser** | Captures, encodes, **encrypts**, publishes | Yes — `earthseed.js` |
| **Viewer browser** | Subscribes, **decrypts**, decodes, plays | Yes — `earthseed.js` |
| **Broker** (`tinymoq.com`) | Assigns a gated relay + short-lived token; serves public salts | No (it's a server API) |
| **Relay fleet** | Moves media between browsers over QUIC | No |

## The values exchanged

| Value | Secret? | What it is |
|---|---|---|
| `pk_…` | No | Publishable key. Identifies a tenant for quota/limits; can mint relay tokens, **can't decrypt**. Ships in the page. |
| `node id` | No | An Ed25519 public key (base32). The stream identity and the relay track name. |
| `origin EID` | No | Which relay holds the origin, so a viewer's edge can pull from it. Routing only. |
| `salts` + `epoch` | No | Public HKDF inputs: a global (operator kill-switch) salt ‖ a per-stream salt. Rotating one re-keys the stream. |
| `JWT` | Short-lived | A per-broadcast relay token authorizing the **connection** (publish or subscribe scope). Not a content key. |
| `#k=` → `CK` | **YES** | 32 random bytes in the link fragment → the `AES-256-GCM` key via HKDF. Held only by the two browsers. |
| `passcode` | **YES** | Optional. 8 characters, **never in the link and never sent anywhere** — spoken or texted to the viewer, typed into the watch page, stretched into the same `CK`. |

## The cryptography

```
CK = HKDF-SHA256(
       IKM  = fragmentKey [‖ PW],          // the 32 bytes in the #k= link fragment
       salt = globalSalt ‖ streamSalt,     // public; served by the broker
       info = "earthseed-media-v1|" + nodeId + "|" + epoch )

with a passcode (opt-in per broadcast), PW joins the IKM and the version becomes v2:
       PW = PBKDF2-SHA256(passcode, "earthseed-pc-v1|" + nodeId, 5,000,000 iterations)
       CK = HKDF-SHA256(fragmentKey ‖ PW, globalSalt ‖ streamSalt,
                        "earthseed-media-v2|" + nodeId + "|" + epoch )

per encoded chunk (audio and video):
       wire = [varint timestamp][12-byte random nonce][AES-256-GCM ciphertext + 16-byte tag]
```

- The **timestamp stays in the clear** (the decoder needs it) and is bound as GCM
  additional-authenticated-data, so a tampering or injecting relay fails decryption.
- Only the codec **payload** is encrypted. The **catalog** (codec, resolution) is sent in the
  clear on a separate track by design — it leaks format metadata, never content.
- A **fresh random 96-bit nonce per chunk**; the publisher is the sole encryptor (the relay fans
  out identical ciphertext to every viewer), so nonce uniqueness is a single-writer problem.
- **Rotation / kill-switch:** bumping the per-stream salt (a "reset key") or the global salt yields
  a fresh `CK`; viewers re-derive on the epoch change. The old link stops decrypting new frames.

## The passcode (optional second lock)

A share link is stable on purpose — the same `node=`, `o=` and `#k=` come back after a reload, so a
link you hand out keeps working. The consequence is that **anyone who ever receives a link can watch
every later broadcast from that browser profile.** Rotating salts does not change this: salts are
public and any viewer re-fetches them.

Turning on "Require a passcode to watch" adds a second secret that is deliberately **kept out of the
link**. You read it to your viewer over a different channel — a phone call, a text, in person — so
the link and the passcode never travel together.

**Nothing in the middle is ever told the passcode.** It is not stored on a server, not sent to one,
and not checked by one. No hash or verifier of it is published anywhere. It is stretched with
PBKDF2 and mixed into `CK`, so a wrong passcode simply produces a wrong AES key and the GCM tag
fails **in the viewer's own browser**. The broker's view of the world is byte-for-byte identical
whether the passcode typed was right or wrong — including whether a stream has one at all, which is
why the watch page discovers it by trying rather than by asking.

- **Why PBKDF2, and why 5,000,000 iterations.** The attacker this defends against is someone who
  *already has your link* — so they hold the fragment key and can fetch the public salts, and the
  passcode is their only unknown. They can grind guesses offline with nothing to rate-limit them.
  Stretching makes each guess cost ~0.4s of work instead of microseconds. Your viewer pays that
  once, on connect.
- **Revocation — the point of the feature.** *Regenerate* locks out everyone holding the old
  passcode **without changing your link and without burning your node identity**. It takes effect
  the **next time you go live**: the key is not re-derived mid-broadcast, so nobody currently
  watching is cut off. To revoke someone now: regenerate, stop, go live again.
- **Opt-in, and nothing else changes.** With the toggle off, derivation is byte-identical to what it
  was before the feature existed, so **no existing link breaks.**

## Who can see what

- **Broker** sees: `node id`, tenant `pk_`, public `salts`, coarse geo (from the request); it
  mints tokens. It **never** sees `#k=`, `CK`, your `passcode`, or your media — nor whether a
  broadcast has a passcode at all.
- **Relay fleet** sees: a connection `JWT`, ciphertext frames, and the cleartext catalog. It
  **never** sees `#k=`, `CK`, your `passcode`, or your media. (Hermit unikernel relays keep no
  persistent disk.)
- **Someone with the link** can watch (decrypt your video and audio) — the link carries `#k=`. Share
  it carefully. If you set a passcode they need that too, from your other channel. They still
  **can't publish as you or rotate your key**.
- **Someone without the link** gets at most opaque ciphertext — plus the cleartext catalog
  (codec/resolution) and traffic size/timing. Never anything decryptable.

## The trusted computing base (what you must trust)

1. **`earthseed.js`** — our client. It's one readable file; read it.
2. **`@moq/net`** — the transport, loaded from its published package at a pinned version
   (`0.1.5`). We don't modify it; you can diff the pinned version against upstream.
3. **The browser** — WebCrypto, WebCodecs, WebTransport.
4. **However you host the pages** — whoever serves `earthseed.js` could serve different code. If
   that's a concern, host it yourself (it's static) or run open-relay mode.

You do **not** have to trust the broker or the relay with your content — that's the point.

## Honest limits

- **Any relay you connect to sees your IP** (true of any website). It isn't stored, but if you
  need to hide it, put a **VPN or Tor** in front — encryption and discovery are unchanged.
- **A share link is only as private as how you share it.** The `#k=` never reaches a server, but
  whoever you send it to — and your own browser history — has it. A passcode is what keeps a leaked
  link from being enough on its own; it only helps if you send it by a *different* route.
- **A passcode gates decryption, not connection.** Someone with your link can still get a subscribe
  token and pull ciphertext, then attack the passcode offline. Closing that would mean the broker
  verifying passcode knowledge — which would give the broker an offline-guessing oracle and destroy
  the property the passcode exists for. We take the trade: the slow KDF is what makes it safe.
- **A passcode expires long before it breaks.** Eight characters is 40 bits: years of GPU time for
  one attacker, but only weeks-to-months for a well-funded one grinding offline. It is not built to
  hold forever — it is built to outlast itself. Regenerate periodically and the window never
  closes; leave one in place for a year and it is a weaker claim.
- **Not DRM.** An authorized viewer can still capture decoded frames. E2E protects the content
  *in transit and from the infrastructure*, not from the people you invite.
- **"Read exactly what runs" is a goal, not a proof.** The client ships unminified and unbundled
  so it's readable, but verifying the *hosted* bytes against this repo is on you (or self-host).
- **Broker availability / trust for tokens.** In broker mode the broker can refuse to mint a token
  (deny service) — but it still can't read content. Open-relay mode removes it entirely.
- **Metadata.** The broker learns that *some* stream (by node id) exists and coarse geo; the relay
  learns traffic timing/volume. The content stays encrypted.

## Browser support

- **Broadcast & watch:** recent Chrome/Edge, and Safari on **iOS 18+ / macOS** (needs WebTransport
  + WebCodecs). Capture avoids the Chromium-only `MediaStreamTrackProcessor` so Safari/iOS works.
- No WebSocket/WASM fallback is shipped (keeping the review surface tiny), so very old browsers
  are out of scope.
