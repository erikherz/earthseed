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
| `/broadcast.html` | `f98b95c7507e7843113a7d35a4a198dc6e88f3eacbb30dab0cb4053a1bc64181` |
| `/watch.html` | `9d16070eee57daaa6477eadbd7b3c761d1a599e090a7877150115a2f90ec3b37` |
| `/request.html` | `45dcb5f7658babd584450570a445e37148488f5545bc3e70c27132a186201796` |
| `/trust.html` | `a4ba2ddec362338408854b8ed8a76bfbba298105d15dca1eb3635b8cb1a5abb0` |
| `/theme.css` | `30a9355fa3ae4037c6fe4bb091d8578c791728ed34f9e37131cc466f88c8b4ad` |
| `/custom.css` | `06ad2a5d03f2ddd43f0a742503c3f323f11445d5531664aa044e1d5eaa7b2efd` |
| `/favicon.svg` | `adc7808e817a00c804778b8e962ba3e7f6c601fcc98be0937a053b1a19beb721` |
| `/earthseed.js` | `efb82de12f969944565db3cb50ef8caa0f60172334905e909e887d1ee5720fd3` |
| `/offline-notice.js` | `2feb7125de2d2b8c98abd26c704da241a55f04f9ec3b78772d3adf19fa7fb62e` |
| `/audio-capture-worklet.js` | `07ab2a238f16a842bb04d31cd54e015991f9c23493763df3fe6f32ca6372c50b` |
| `/overlay.js` | `9d564d158bc39ec73364d40b9b97d68e28f7c353d41d708ba330ac382b6e0713` |
| `/chat.js` | `11e3f6ef838da953f0460f5d2abc75de2a9083abc7c9f37c69b0915576b0cb85` |
| `/qr.js` | `d1c755ddd3358f98fdca2d027573017237b6ff4fc67ee85bbf5c56b962180c9b` |
| `/compositor.js` | `91555956dfb6b30b327c604dab4ea89f8e8bb93e3750de54b7a88f892a8b2435` |
| `/edge-clock.js` | `6b397f9c34715b6383fe98b416e67773b9192cc4743ae8e45b257886f527a296` |
| `/geo-stamp.js` | `ba00c3f6b7f7b4458662dda529d99de5a79d923e54d54d9d4fbd8b46401304ee` |
| `/nearest-city.js` | `fb99a85252f0c193b8bf48221587e5c069e2c29f7894a07264c7823acd921cf6` |
| `/seeds.js` | `b6251ef6770be1c6c44a627f237e22b7a56829c798e3b84bbd2c6f132383cc62` |
| `/seeds-recovery.js` | `bf3c36f14cb5068fa74e6ef1b93f4b21b758fbecbfa1f9921e82faccdaeb4650` |
| `/vendor/moq-net-0.1.5.mjs` | `d38b3f603d6b8491184a56115ebbb76ebe4c374e3abec5431686c3aa427dd5ff` |

_Regenerate with `npm run integrity`; `npm run check` fails if this file is stale._
