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
- **Rotation / kill-switch:** the per-stream salt is minted fresh at every go-live, and the operator
  can rotate the global salt to re-key every stream at once. Either changes `epoch`, and a viewer
  re-derives when it does. Both take effect at the next go-live — nothing rotates mid-broadcast, so
  a viewer's key is fixed for the session it joined.
- **The salts reach a viewer from the broadcaster, not from us.** They travel on the same cleartext
  catalog track that carries the codec description, so **a viewer never asks the broker for
  anything after being placed on a relay.** They are public HKDF inputs and decrypt nothing alone.

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
- **Revoking the link itself.** *New link* mints a fresh `#k=` fragment key, so **every link you
  have already shared stops decrypting** — use it when a link has gone somewhere it shouldn't. Same
  timing rule: it applies at your next go-live. A revoked viewer cannot be told apart from one who
  is missing a passcode — both simply hold the wrong key — so the watch page says the link *may* be
  out of date **or** a passcode *may* be needed, rather than guessing.
- **Revoking your identity.** *New link* leaves your `node id` unchanged, and that is not a
  detail: the id is in every link you ever sent, and asking to watch a broadcast requires no proof
  of anything. So **someone holding an old link can still tell when you are live**, indefinitely,
  even though they can no longer see or hear it. *New ID* is the answer to that — it mints a new
  keypair, so old links name an identity that never publishes again and reveal nothing at all.
  It cannot be undone (the private key is non-extractable and is discarded), it clears this
  stream's fragment key, passcode and rotate secret with it, and everyone you still want watching
  needs the new link.

  | Control | Old links can watch | Old links can see you're live |
  |---|---|---|
  | Regenerate passcode | no | **yes** |
  | New link | no | **yes** |
  | New ID | no | no |

  What *New ID* does not do is hide you from the broker: a new id appearing from the same address
  at the same hour is trivially linkable by whoever assigns your relay. It breaks the link between
  you and the people you handed links to — not between you and the infrastructure.
- **Opt-in, and nothing else changes.** With the toggle off, derivation is byte-identical to what it
  was before the feature existed, so **no existing link breaks.**

## Who can see what

- **Broker** sees: `node id`, tenant `pk_`, public `salts`, coarse geo (from the request); it
  mints tokens. It **never** sees `#k=`, `CK`, your `passcode`, or your media — nor whether a
  broadcast has a passcode at all.
  **A viewer contacts it exactly once**, to be placed on a relay. After that a viewer talks only to
  the relay, and the relay only ever carries ciphertext. So the broker sees that someone joined,
  not how long they stayed — it holds a connection record, not an attendance record.
- **Relay fleet** sees: a connection `JWT`, ciphertext frames, and the cleartext catalog. It
  **never** sees `#k=`, `CK`, your `passcode`, or your media. (Hermit unikernel relays keep no
  persistent disk — see [why they're unikernels](#why-the-relays-are-unikernels-and-not-containers).)
- **Someone with the link** can watch (decrypt your video and audio) — the link carries `#k=`. Share
  it carefully. If you set a passcode they need that too, from your other channel. They still
  **can't publish as you or rotate your key**: your `node id` *is* an Ed25519 public key, and the
  broker only issues a publish token for it against a signature — over a challenge it just issued —
  from the matching private key, which never leaves your browser. Rotating your stream salt is
  likewise gated on a secret only your browser holds.
- **Your identity key can't be copied out of your browser.** It is generated non-extractable and
  stored as a key *object* in IndexedDB, never as bytes — so there is no exportable copy for a
  malicious script or extension to steal and reuse later. The trade is that an identity cannot be
  backed up or moved between browsers: lose the browser profile and you mint a new one (and a new
  share link). See the limits below for what this does *not* cover.
- **Someone without the link** gets at most opaque ciphertext — plus the cleartext catalog
  (codec/resolution) and traffic size/timing. Never anything decryptable.

## Why the relays are unikernels and not containers

The relay never holds a key, so this is not what protects your video — encryption is. It matters
for everything *around* the media: how much an attacker gets if a relay falls, and how much has to
go right, continuously, for that to stay true.

The usual way to run something like this is containers on Kubernetes. Kubernetes can be hardened
well. The difficulty is that **its security is a set of policies someone must choose, apply, and
keep applying** — and each has an off switch:

| The exposure | In Kubernetes | In a Hermit unikernel |
|---|---|---|
| Interactive access to a running workload | `kubectl exec` gives a shell. Gated by RBAC — a grant someone can make | **No shell exists.** No `/bin`, no `sh`, nothing to exec into |
| Post-exploitation tooling | The image ships a userland: package manager, `curl`, shell utilities | The binary links what the relay needs. There is no second program to run |
| Escaping to the host | Containers share **one kernel**; a kernel privilege bug is an escape. `privileged`, `hostPath`, `hostPID` are blocked only if admission policy says so | Isolation is a **KVM boundary** (`uhyve`). Not namespaces on a shared kernel |
| Reaching other workloads | Default-allow: without a `NetworkPolicy` every pod can reach every pod | One application, one address space, no service-account token to steal |
| What persists after the fact | Container filesystems and logs sit on the node | **No persistent disk.** Idle relays are reaped and the machine ceases to exist |

The distinction is not that Kubernetes is badly built. It is that a hardened cluster is a state you
have to *achieve and maintain*, against configuration drift, a new operator with broad RBAC, or one
`hostPath` mount added under deadline. A unikernel's hardening is a property of the artifact: there
is no `kubectl exec` equivalent to disable because there is no shell to reach, and no policy anyone
can relax later to bring one back. **Security you cannot switch off beats security you must
remember to switch on.**

**One relay carries exactly one stream.** Many viewers of that stream share it — that is what a
relay is for — but two different broadcasts are never placed on the same machine, in any locality.
Verified rather than assumed: two streams taken live at the same moment were assigned separate
relays on separate ports, with distinct origin endpoints. So a relay compromise is scoped to one
broadcast by the machine boundary, not merely by policy. Token scope is a second, independent
barrier — a viewer's token names exactly one broadcast, so co-tenancy would grant nothing even if
it somehow occurred.

**The fleet cannot mint tokens for your stream.** Each relay is provisioned with the *public* half
of the signing key; the private key never leaves the token issuer. The relay can verify a token and
cannot forge one. (A different deployment mode gives each relay a fresh secret that is destroyed
when the relay is reaped — revocation by key destruction. That is not how this runs, and it is a
weaker property than the operator simply never holding a signing key.)

**The honest limits of that argument:**

- **The host is still an ordinary Linux box.** It runs the fleet manager as root, terminates TLS,
  and reads relay logs. Those logs carry broadcast names and viewer counts. "No disk to log to" is
  true of the guest, not of the system it runs on — and the host, not the guest, is the real target.
- **A small ecosystem cuts both ways.** Fewer eyes on the code than the Linux container stack, and
  slower to patch. And having no runtime policy layer means you cannot *add* a guardrail you failed
  to build in.
- **A bug in the relay is still a bug.** A unikernel bounds the blast radius. It does not make the
  program correct.

## The trusted computing base (what you must trust)

1. **`earthseed.js`** — our client. It's one readable file; read it.
2. **`@moq/net`** — the transport (version `0.1.5`), **vendored**: built once from the published
   package at exact dependency versions and served from our own origin, not a CDN. It is
   unminified, so you can read it; `simple/vendor/README.md` has the build command and the SHA-256
   so you can reproduce it byte-for-byte and confirm we didn't change anything.
3. **The browser** — WebCrypto, WebCodecs, WebTransport.
4. **However you host the pages** — whoever serves `earthseed.js` could serve different code. If
   that's a concern, host it yourself: the client is static, and it talks to the broker from
   whatever origin you put it on.

You do **not** have to trust the broker or the relay with your content — that's the point. You
*do* have to trust the broker to be **available**, and to gate publishing honestly; see the
honest limits below.

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
- **Hostile code on the page beats all of this.** If someone can run script in your tab — a
  compromised host, a malicious extension — they can read the content key straight out of the URL
  fragment and the passcode straight out of its input box, and they can ask your identity key to
  sign things while the page is open. A non-extractable key means they cannot *walk away with* your
  identity and keep publishing as you afterwards, and vendoring the transport removes the
  third-party host that could have injected such code. Neither makes the page itself safe to lose.
  This is why the browser and the host are in the trusted computing base above, and it is the real
  reason to prefer a browser profile you control.
- **The script policy is enforced, and it is not a complete answer.** The pages ship a
  `Content-Security-Policy` that permits only scripts from this origin, each inline block pinned by
  SHA-256, with `require-trusted-types-for 'script'` so the DOM sinks that enable XSS throw rather
  than being absent by convention. A script injected into the page is refused rather than reported.
  What it cannot help with is the case where the *legitimate* files are the problem: if the host
  serves a modified `earthseed.js`, that file is same-origin and the policy permits it. CSP narrows
  how code gets onto the page; it does not verify what the code does. That is still the trust in
  the host described above.
- **Network destinations are deliberately unrestricted, so anyone can run a fleet.** The policy
  does **not** pin which hosts the page may connect to. That is a requirement, not an omission:
  a partner running relays on their own domain, or an enterprise relay living inside a private
  network, must work without us shipping a new client. Restricting it would have quietly meant
  "only relays we operate". It costs little, because a relay only ever receives **ciphertext and a
  broadcast-scoped token** — your content key never goes there — so the identity of the host at the
  other end is not what protects your media. Pinning destinations would only bind an attacker who
  could run script here *without* controlling our response headers, and anyone who can serve a
  modified client controls both.
- **The broker is a required dependency, on purpose.** It can refuse to mint a token and deny you
  service — though it still can't read your content. There is deliberately no way to route around
  it. An earlier "open-relay" mode let a page skip the broker and use any public MoQ endpoint, and
  it was removed: with no broker there is nothing to authorize a publisher, so anyone could publish
  to anyone's broadcast name. That trade is the honest shape of this product — **availability
  depends on us; confidentiality does not.** If you need to remove that dependency, host the client
  yourself *and* run your own broker and relays; the client is static and the protocol is here.
- **Metadata.** The broker learns that *some* stream (by node id) exists and coarse geo; the relay
  learns traffic timing/volume. The content stays encrypted.

## Browser support

- **Broadcast & watch:** recent Chrome/Edge, and Safari on **iOS 18+ / macOS** (needs WebTransport
  + WebCodecs). Capture avoids the Chromium-only `MediaStreamTrackProcessor` so Safari/iOS works.
- No WebSocket/WASM fallback is shipped (keeping the review surface tiny), so very old browsers
  are out of scope. **WebTransport is required, not preferred.** If you read the vendored transport
  you will find WebSocket code in it — `@moq/net` implements qmux over WebSocket and will try it
  alongside WebTransport — but our relays do not serve WebSocket, so that attempt cannot succeed
  and nothing falls back to it. A network that blocks UDP blocks this app; it does not silently
  downgrade to a different transport.
