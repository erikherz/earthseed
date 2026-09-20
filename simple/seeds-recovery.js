// Vault recovery phrases. DEMO ONLY, alongside the rest of the seeds economy.
//
// Ported from Wallflower's src/seeds/recovery.ts. Plain JavaScript with JSDoc types, because
// this client has no build step: what is in this file is what the browser runs and what
// `npm run integrity` hashes.
//
// A vault used to be two unrelated random strings in localStorage, which meant clearing site
// data destroyed it with no way back — no email, no reset, nothing. That is survivable while a
// vault holds one free seed and indefensible the moment it holds value someone earned.
//
// Here both halves are DERIVED from a phrase the holder can write down:
//
//   phrase -> PBKDF2 -> 64 bytes -> [ 32 = vault id ][ 32 = secret ]
//
// so the phrase alone reconstructs the whole identity on any machine. Nothing about the server
// changes: it still sees an id and a secret exactly as before.
//
// NOT called a "seed phrase", deliberately. The currency here is seeds; "you have 12 seeds and
// a 12-word seed phrase" is a support nightmare waiting to happen.
//
// WHAT THIS IS NOT. The id is not a public key and the secret is not a signature — the demo
// still authorises writes with a shared secret, and the server still stores its hash. The
// intended end state is an Ed25519 keypair derived from this same phrase, with the server
// verifying a signature over a challenge and storing no secret material at all. That change is
// invisible to the holder: the phrase is the phrase either way, which is exactly why it is safe
// to ship the phrase first and harden the mechanism afterwards.

/**
 * 256 words: short, common, and picked to be distinct when spoken aloud or half-remembered.
 * 256 keeps the arithmetic honest — exactly one byte per word, no bit-packing across word
 * boundaries, so a phrase maps to bytes in a way anybody can check by hand.
 *
 * 11 words of entropy (88 bits) plus a 12th checksum word. 88 bits is far beyond what a demo
 * vault warrants, and the checksum is the part that actually earns its place: it turns a
 * mistyped word into "check word 7" instead of "no vault found", which is the difference
 * between a typo and despair.
 *
 * THE LIST IS FROZEN. Changing any entry, including its position, invalidates every phrase ever
 * written down. Copied from Wallflower's list byte-for-byte and verified on the way across: 256
 * entries, no duplicates, order preserved.
 *
 * @type {readonly string[]}
 */
export const WORDS = [
  "able", "acid", "acre", "actor", "adapt", "admit", "adopt", "adult",
  "after", "agent", "agree", "ahead", "alarm", "album", "alert", "alien",
  "alive", "allow", "alone", "alpha", "amber", "amuse", "among", "ample",
  "anchor", "angel", "antler", "anvil", "ankle", "apple", "apron", "arbor",
  "arcade", "arena", "argue", "arise", "armor", "arrow", "aside", "asset",
  "atlas", "attic", "audio", "autumn", "avoid", "awake", "award", "bacon",
  "badge", "bagel", "baker", "balmy", "banjo", "barge", "basil", "basket",
  "batch", "beach", "beaver", "beard", "beast", "bench", "berry", "birch",
  "bison", "blade", "blaze", "blend", "bliss", "block", "bloom", "blush",
  "board", "bonus", "boost", "booth", "borrow", "bottle", "bounce", "brave",
  "bread", "brick", "bridge", "brief", "bring", "broom", "brush", "bubble",
  "bucket", "buddy", "budget", "buffer", "bundle", "butter", "cabin", "cable",
  "cactus", "camel", "candle", "canvas", "canyon", "carbon", "cargo", "carpet",
  "carrot", "castle", "cattle", "cedar", "cement", "census", "chalk", "charm",
  "cheese", "cherry", "chess", "chief", "chorus", "cider", "cinema", "circle",
  "citrus", "civic", "clamp", "clever", "cliff", "cloud", "clover", "cobalt",
  "cocoa", "coffee", "comet", "coral", "cotton", "county", "cousin", "cover",
  "coyote", "crane", "crate", "cream", "credit", "cricket", "crisp", "crown",
  "crumb", "crystal", "cube", "curve", "cycle", "dagger", "dance", "daisy",
  "dawn", "dazzle", "debate", "decade", "decoy", "delta", "denim", "depot",
  "desert", "detail", "device", "diamond", "diary", "digit", "dinner", "direct",
  "dizzy", "dolphin", "domain", "donkey", "donor", "double", "dragon", "drama",
  "dream", "drift", "drum", "eagle", "early", "earth", "easel", "echo",
  "eclipse", "elbow", "elder", "ember", "emerald", "empty", "enact", "energy",
  "engine", "enjoy", "enter", "equal", "error", "escape", "estate", "ethic",
  "evolve", "event", "exact", "exile", "expand", "expert", "extra", "fabric",
  "fable", "falcon", "family", "fancy", "feast", "fence", "fern", "fever",
  "fiber", "fiction", "fiddle", "figure", "final", "finch", "fire", "flame",
  "flask", "flint", "float", "flock", "fleet", "flower", "fluid", "focus",
  "foggy", "forest", "forge", "fossil", "fox", "frame", "fresh", "friend",
  "frost", "fruit", "fudge", "funnel", "future", "gadget", "galaxy", "gallery",
  "garden", "garlic", "gather", "gentle", "ginger", "giraffe", "glacier", "glass",
];

// Domain separation from Wallflower, and the one value here that is deliberately NOT shared.
//
// The word list and the derivation are identical, so the same phrase on both sites would
// produce the same vault id and the same secret — in two different databases. That is not a
// feature: it would mean a leak of either site's seed_vaults table exposed the other's vaults
// too, for anyone who had reused a phrase. Separate salts make the two identities unrelatable
// even when somebody writes one phrase on one piece of paper.
//
// Frozen for the same reason as the word list: changing it invalidates every phrase.
const SALT = "earthseed-vault-v1";
const ITERATIONS = 210_000;

/** Words per phrase: 11 of entropy plus one checksum. */
export const PHRASE_LENGTH = 12;

const b64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The checksum word index: the first byte of SHA-256 over the entropy. */
async function checksumIndex(entropy) {
  const digest = await crypto.subtle.digest("SHA-256", entropy);
  return new Uint8Array(digest)[0];
}

/** A fresh phrase. 11 random bytes, one word each, plus the checksum word. */
export async function newPhrase() {
  const entropy = crypto.getRandomValues(new Uint8Array(PHRASE_LENGTH - 1));
  const words = Array.from(entropy, (b) => WORDS[b]);
  words.push(WORDS[await checksumIndex(entropy)]);
  return words.join(" ");
}

/**
 * Validate a phrase, naming the position of the first bad word.
 *
 * Returning WHERE the problem is, rather than just that there is one, is the whole point of
 * having a checksum. "Check word 7" sends someone back to their piece of paper; "that phrase is
 * wrong" sends them nowhere.
 *
 * @param {string} input
 * @returns {Promise<{kind:"length",got:number}|{kind:"word",position:number,word:string}|{kind:"checksum"}|null>}
 */
export async function checkPhrase(input) {
  const words = normalise(input).split(" ").filter(Boolean);
  if (words.length !== PHRASE_LENGTH) return { kind: "length", got: words.length };

  const entropy = new Uint8Array(PHRASE_LENGTH - 1);
  for (let i = 0; i < PHRASE_LENGTH - 1; i++) {
    const idx = WORDS.indexOf(words[i]);
    if (idx < 0) return { kind: "word", position: i + 1, word: words[i] };
    entropy[i] = idx;
  }
  const lastIdx = WORDS.indexOf(words[PHRASE_LENGTH - 1]);
  if (lastIdx < 0) {
    return { kind: "word", position: PHRASE_LENGTH, word: words[PHRASE_LENGTH - 1] };
  }
  // Every individual word is real, so what is wrong is the combination: one of them is a valid
  // word in the wrong place. That is the case a per-word check cannot catch.
  return lastIdx === (await checksumIndex(entropy)) ? null : { kind: "checksum" };
}

/** Human-readable form of a problem, for the restore screen. @param {{kind:string,got?:number,position?:number,word?:string}} p */
export function describeProblem(p) {
  switch (p.kind) {
    case "length":
      return `A phrase is ${PHRASE_LENGTH} words — you have ${p.got}.`;
    case "word":
      return `Word ${p.position} ("${p.word}") isn't one of the words we use.`;
    default:
      return "Every word is valid but the phrase doesn't add up — one is probably in the wrong place, or two are swapped.";
  }
}

/** Lowercase, trim, collapse runs of whitespace. What people type is never this tidy. */
export const normalise = (input) => input.toLowerCase().trim().replace(/\s+/g, " ");

/** Suggestions for a partly-typed word, for autocomplete. */
export function suggest(prefix, limit = 5) {
  const p = prefix.toLowerCase();
  if (!p) return [];
  return WORDS.filter((w) => w.startsWith(p)).slice(0, limit);
}

/**
 * Phrase -> the identity the API already understands.
 *
 * PBKDF2 with a high iteration count because a phrase is the ONLY thing standing between a
 * guesser and someone's seeds, and 88 bits of entropy deserves to be expensive to grind.
 *
 * @param {string} phrase
 * @returns {Promise<{pubkey:string, secret:string}>}
 */
export async function deriveVault(phrase) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(normalise(phrase)),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: new TextEncoder().encode(SALT),
        iterations: ITERATIONS,
      },
      material,
      512
    )
  );
  // Two independent halves: knowing the id must never reveal the secret. The id is public — it
  // is what a fan looks up to see a streamer's runway.
  return { pubkey: b64url(bits.slice(0, 32)), secret: b64url(bits.slice(32, 64)) };
}
