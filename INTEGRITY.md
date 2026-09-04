# Integrity

SHA-256 of every file the client runs, as served by earthseed.live.

**Why this file exists.** The security of a web client rests on the browser running the code you
think it is running, and the party serving it can always serve something else. That cannot be
prevented. It can be made *detectable*: these hashes are committed here, so the record lives in git
history — a different place, under a different party — rather than on the site being checked.

**Check the site against it yourself:**

```sh
node scripts/integrity.mjs --verify
```

or by hand, for any one file:

```sh
curl -s https://earthseed.live/earthseed.js | shasum -a 256
```

**What this does not prove.** That the published client is honest — only that what you were served
matches what was published. It also cannot catch an origin that serves clean bytes to whoever is
checking and modified bytes to a target. It turns silent substitution into something a motivated
reviewer can catch, which is the honest ceiling for code delivered over the web. Self-hosting is
the answer for anyone who cannot accept that; the client is static and the repository is public.

| File | SHA-256 |
|---|---|
| `/index.html` | `973a64ad9e2a98505f68ca27af4a133a7584b85e2a2a76d394abca15f82574a4` |
| `/broadcast.html` | `a5e175ce06f3ed6815e4adcc1b5c736ec845b8c77adb0748748654081e5805cb` |
| `/watch.html` | `b9058fe6f2ec76e0e8fe814ebb909818f7e8db11d29edd5199ee154704cf4424` |
| `/request.html` | `45dcb5f7658babd584450570a445e37148488f5545bc3e70c27132a186201796` |
| `/trust.html` | `a4ba2ddec362338408854b8ed8a76bfbba298105d15dca1eb3635b8cb1a5abb0` |
| `/theme.css` | `2e7e8c1a545eb8d14c49f13c84acf47306316f227660a30222cc1ad062582f8b` |
| `/custom.css` | `06ad2a5d03f2ddd43f0a742503c3f323f11445d5531664aa044e1d5eaa7b2efd` |
| `/favicon.svg` | `adc7808e817a00c804778b8e962ba3e7f6c601fcc98be0937a053b1a19beb721` |
| `/earthseed.js` | `dc22409c530a9f5c93413554759de70cb014fd99a3b758fc723740d7de293c3c` |
| `/offline-notice.js` | `2feb7125de2d2b8c98abd26c704da241a55f04f9ec3b78772d3adf19fa7fb62e` |
| `/audio-capture-worklet.js` | `07ab2a238f16a842bb04d31cd54e015991f9c23493763df3fe6f32ca6372c50b` |
| `/vendor/moq-net-0.1.5.mjs` | `d38b3f603d6b8491184a56115ebbb76ebe4c374e3abec5431686c3aa427dd5ff` |

_Regenerate with `npm run integrity`; `npm run check` fails if this file is stale._
