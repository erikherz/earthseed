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
| `/index.html` | `3ca3d3672c022393ef1b3520744ce25860afdfb8f7ae6477acb1a18b65478cf8` |
| `/broadcast.html` | `a5054d96f40598f9096325acf11d81480f58a4d4b4f88dd5eea3d770e0be4e6e` |
| `/watch.html` | `413bd286c5b237de49ed34ad081d393459177a997066b6ef42919cb927f38cd8` |
| `/request.html` | `45dcb5f7658babd584450570a445e37148488f5545bc3e70c27132a186201796` |
| `/trust.html` | `a4ba2ddec362338408854b8ed8a76bfbba298105d15dca1eb3635b8cb1a5abb0` |
| `/theme.css` | `416a7ae26fe6df2342165bac5e44e45b50c78853c75aaf55ab4702dbc7b343e7` |
| `/custom.css` | `06ad2a5d03f2ddd43f0a742503c3f323f11445d5531664aa044e1d5eaa7b2efd` |
| `/favicon.svg` | `adc7808e817a00c804778b8e962ba3e7f6c601fcc98be0937a053b1a19beb721` |
| `/earthseed.js` | `8e0db10a3cc3585e69fb75415ee5e80f1d778e0651380132e4987f5334104d12` |
| `/audio-capture-worklet.js` | `07ab2a238f16a842bb04d31cd54e015991f9c23493763df3fe6f32ca6372c50b` |
| `/vendor/moq-net-0.1.5.mjs` | `d38b3f603d6b8491184a56115ebbb76ebe4c374e3abec5431686c3aa427dd5ff` |

_Regenerate with `npm run integrity`; `npm run check` fails if this file is stale._
