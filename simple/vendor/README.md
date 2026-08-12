# Vendored transport

`moq-net-0.1.5.mjs` is [`@moq/net`](https://www.npmjs.com/package/@moq/net/v/0.1.5), Luke Curley's
Media-over-QUIC transport, bundled with its dependencies and served from this origin.

It is the only third-party code the client runs.

## Why it is vendored rather than fetched from a CDN

The pages used to load it from `https://esm.sh/@moq/net@0.1.5`. That was a single point of total
compromise: whoever serves the transport can replace it, and it runs on the same page as the
content key — it could read `location.hash`, the passcode field, or decoded frames, and send them
anywhere. Pinning the version did not fix this, for two reasons:

1. **The pin was shallower than it looked.** `esm.sh` served `@moq/net@0.1.5` as a shim importing
   `@moq/qmux@^0.0.6`, `@moq/signals@^0.1.9`, `async-mutex@^0.5.0` and `zod@^4.0.0` — *ranges*,
   resolved at request time. Only the top package was actually pinned; everything under it floated.
   (On 12 Aug 2026 `zod@^4.0.0` resolved to `4.4.3`.)
2. **A version pin is not an integrity check.** It says which version to serve, not which bytes.

Serving it ourselves means the bytes are fixed at deploy time, reviewable in this repo, and covered
by the same `Content-Security-Policy` as everything else.

## Reproducing the build

The bundle is byte-reproducible from public packages:

```sh
mkdir moq-verify && cd moq-verify
npm init -y
npm i --save-exact @moq/net@0.1.5
echo 'export * from "@moq/net";' > entry.js
npx esbuild@0.25.10 entry.js --bundle --format=esm --target=es2022 \
  --platform=browser --legal-comments=inline --outfile=moq-net.mjs
shasum -a 256 moq-net.mjs
```

Expected:

```
d38b3f603d6b8491184a56115ebbb76ebe4c374e3abec5431686c3aa427dd5ff  moq-net.mjs
```

That must equal `shasum -a 256 simple/vendor/moq-net-0.1.5.mjs`. The bundle is **not minified**, so
you can also read it, or diff it against the unbundled sources in the npm tarball
(`npm pack @moq/net@0.1.5`).

Resolved dependency versions at build time:

| Package | Version |
|---|---|
| `@moq/net` | 0.1.5 |
| `@moq/qmux` | 0.0.6 |
| `@moq/signals` | 0.1.10 |
| `async-mutex` | 0.5.0 |
| `tslib` | 2.8.1 |
| `zod` | 4.4.3 |

`@moq/signals` declares optional peer dependencies on `react` and `solid-js`; neither is installed
and neither is reachable from the entry point, so no framework code is in the bundle.

## Upgrading

Re-run the recipe with the new version, rename the file to match, update the `importmap` in
`broadcast.html` and `watch.html`, and update the hash and the version table above. Keep the
version in the filename so a stale cached copy can never shadow a new one.
