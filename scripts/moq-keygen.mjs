#!/usr/bin/env node
// Earthseed relay signing keypair — generate if absent, store the PRIVATE half, print the PUBLIC.
//
//   npm run keygen                                        # tinymoq fleet: store private as the
//                                                         #   MOQ_AUTH_PRIVATE_JWK secret
//   npm run keygen -- --secret MOQ_PRO_JWK                # moq.pro: the key whose PUBLIC half
//                                                         #   goes in "Import Asymmetric"
//   npm run keygen -- --out-env /etc/earthseed/relay.env  # self-host: write into an env file
//   npm run keygen -- --force                             # rotate even if a key already exists
//
// REGISTER THE PUBLIC HALF FIRST, THEN SET THE SECRET. A CDN that does not know the key does not
// refuse the connection — the WebTransport session opens normally and then dies the moment it
// speaks MoQ, which looks like a transport bug and is not one.
//
// Idempotent: if a key is already present it does nothing (unless --force). The PRIVATE half
// is NEVER printed or transmitted — only written to the secret store / env file. The PUBLIC
// verify JWK is printed to stdout as plain JSON for the operator to paste as verify_jwk.
//
// Diagnostics go to stderr; stdout carries ONLY the public JWK, so it's safe to pipe/capture.

import { webcrypto as c } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";

const args = process.argv.slice(2);
const force = args.includes("--force");
const envFileIdx = args.indexOf("--out-env");
const envFile = envFileIdx >= 0 ? args[envFileIdx + 1] : null;

// Which secret to write. Two relay backends want a key of exactly this shape but store it under
// different names, and generating one under the wrong name is a mistake you find out about at
// go-live rather than here:
//
//   MOQ_AUTH_PRIVATE_JWK  the tinymoq fleet (BYOK). Its PUBLIC half goes in the fleet's
//                         verify_jwk.
//   MOQ_PRO_JWK           moq.pro. Its PUBLIC half is uploaded through "Import Asymmetric".
const secretIdx = args.indexOf("--secret");
const SECRET = secretIdx >= 0 ? args[secretIdx + 1] : "MOQ_AUTH_PRIVATE_JWK";
if (!/^[A-Z][A-Z0-9_]*$/.test(SECRET)) {
  console.error(`--secret must be an env-var name, got ${JSON.stringify(SECRET)}`);
  process.exit(2);
}

const log = (...m) => console.error(...m); // stderr — keep stdout clean for the public JWK
const b64url = (b) => Buffer.from(b).toString("base64url");

function privateKeyPresent() {
  if (envFile) {
    return existsSync(envFile) && new RegExp(`^\\s*${SECRET}\\s*=`, "m").test(readFileSync(envFile, "utf8"));
  }
  try {
    const out = execFileSync("npx", ["wrangler", "secret", "list"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(out).some((s) => s.name === SECRET);
  } catch {
    return false; // can't tell (e.g. Worker not deployed yet) — treat as absent
  }
}

function writeEnv(file, name, value) {
  let body = existsSync(file) ? readFileSync(file, "utf8") : "";
  const line = `${name}=${value}`;
  const re = new RegExp(`^\\s*${name}\\s*=.*$`, "m");
  body = re.test(body) ? body.replace(re, line) : body + (body && !body.endsWith("\n") ? "\n" : "") + line + "\n";
  writeFileSync(file, body);
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
}

if (privateKeyPresent() && !force) {
  log(`✓ ${SECRET} already set — nothing to do.`);
  log(`  Print the public verify JWK anytime from the running Worker at /api/pubkey,`);
  log(`  or re-run with --force to ROTATE the key (you must re-register the new public key).`);
  process.exit(0);
}

// --- generate a fresh Ed25519 keypair ---
const { publicKey, privateKey } = await c.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const pub = await c.subtle.exportKey("jwk", publicKey);
const priv = await c.subtle.exportKey("jwk", privateKey);

// RFC 7638 JWK thumbprint — the kid the relay selects the verify key by.
const thumb = JSON.stringify({ crv: pub.crv, kty: pub.kty, x: pub.x });
const kid = b64url(new Uint8Array(await c.subtle.digest("SHA-256", new TextEncoder().encode(thumb))));
pub.kid = kid;
priv.kid = kid;

// RFC 8037 §3.1: the JWA algorithm name for Ed25519 is "EdDSA". Node's WebCrypto exports
// `alg: "Ed25519"` — the CURVE name — and workerd's crypto.subtle.importKey refuses it outright.
//
// This one word is worth the paragraph. The key generates fine, registers fine, and the failure
// arrives much later as a bare 500 from importKey at token-minting time, with nothing in it that
// names the cause. It reads as a broken CDN. Stamped correctly at rest here; the Worker also
// strips a wrong `alg` on the way in (parsePrivateOkpJwk), so keys generated before this fix
// keep working rather than needing a rotation.
priv.alg = "EdDSA";
// Node's `ext` and `key_ops` describe the key it just exported, not the one workerd will import,
// and workerd validates key_ops against the usages requested at import. Dropped for the same
// reason: they can only be wrong on the other side.
delete priv.ext;
delete priv.key_ops;

const privateJwk = JSON.stringify(priv); // contains `d` — never printed
const publicJwk = { kty: "OKP", crv: "Ed25519", x: pub.x, alg: "EdDSA", use: "sig", key_ops: ["verify"], kid };

// --- store the PRIVATE half (never to stdout) ---
if (envFile) {
  writeEnv(envFile, SECRET, privateJwk);
  log(`✓ wrote ${SECRET} to ${envFile} (chmod 600)`);
} else {
  const r = spawnSync("npx", ["wrangler", "secret", "put", SECRET], {
    input: privateJwk,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (r.status !== 0) {
    log(`✗ could not set the ${SECRET} secret via wrangler.`);
    log(`  Make sure the Worker is deployed and you're logged in (npx wrangler login), then re-run.`);
    process.exit(1);
  }
  log(`✓ set ${SECRET} as a Cloudflare secret`);
}

// --- print ONLY the public verify JWK (stdout, plain JSON) ---
log("\nPublic verify JWK — paste into your CDN console / relay verify_jwk:\n");
console.log(JSON.stringify(publicJwk, null, 2));
log(`\nkid: ${kid}`);
