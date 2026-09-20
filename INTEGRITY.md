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
| `/broadcast.html` | `0249084100b8d5dda2c39baba34e813a706e2d7a1cfff77bbea201573101ccdb` |
| `/watch.html` | `9d16070eee57daaa6477eadbd7b3c761d1a599e090a7877150115a2f90ec3b37` |
| `/request.html` | `45dcb5f7658babd584450570a445e37148488f5545bc3e70c27132a186201796` |
| `/trust.html` | `a4ba2ddec362338408854b8ed8a76bfbba298105d15dca1eb3635b8cb1a5abb0` |
| `/theme.css` | `b121bae18ad220b9405f0583465452e028a7ea7865ce59cc2116818f07da24bd` |
| `/custom.css` | `06ad2a5d03f2ddd43f0a742503c3f323f11445d5531664aa044e1d5eaa7b2efd` |
| `/favicon.svg` | `adc7808e817a00c804778b8e962ba3e7f6c601fcc98be0937a053b1a19beb721` |
| `/earthseed.js` | `d27d9454b54bc1d15be1aace22b6510f452237cea721af05e1f04fee76d286bc` |
| `/offline-notice.js` | `2feb7125de2d2b8c98abd26c704da241a55f04f9ec3b78772d3adf19fa7fb62e` |
| `/audio-capture-worklet.js` | `07ab2a238f16a842bb04d31cd54e015991f9c23493763df3fe6f32ca6372c50b` |
| `/overlay.js` | `9d564d158bc39ec73364d40b9b97d68e28f7c353d41d708ba330ac382b6e0713` |
| `/chat.js` | `11e3f6ef838da953f0460f5d2abc75de2a9083abc7c9f37c69b0915576b0cb85` |
| `/qr.js` | `d1c755ddd3358f98fdca2d027573017237b6ff4fc67ee85bbf5c56b962180c9b` |
| `/seeds.js` | `b6251ef6770be1c6c44a627f237e22b7a56829c798e3b84bbd2c6f132383cc62` |
| `/seeds-recovery.js` | `bf3c36f14cb5068fa74e6ef1b93f4b21b758fbecbfa1f9921e82faccdaeb4650` |
| `/vendor/moq-net-0.1.5.mjs` | `d38b3f603d6b8491184a56115ebbb76ebe4c374e3abec5431686c3aa427dd5ff` |

_Regenerate with `npm run integrity`; `npm run check` fails if this file is stale._
