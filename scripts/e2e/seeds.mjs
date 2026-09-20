// Does the seeds demo actually work in a browser — and under THIS site's CSP?
//
// Two things make this worth a suite of its own rather than a source review.
//
// 1. RENDERING. Wallflower's version builds HTML strings and assigns innerHTML in eight places.
//    Under `require-trusted-types-for 'script'; trusted-types 'none'` every one of those throws,
//    so the port rebuilds the whole render layer with createElement/textContent. That is the
//    kind of change that looks right and silently renders nothing, so this asserts on what is
//    actually in the DOM, against a deployed origin where the CSP is real.
//
// 2. MONEY-SHAPED SURFACES. The panel says "$10.59" and "cash out". Nothing charges a card and
//    nothing sends a payout, and the interface is supposed to say so in the interface — not
//    only in a commit message. This checks the word "demo" is actually on screen, because a
//    money-shaped widget that loses its context is the one that ends up in a screenshot.
//
//   node scripts/e2e/seeds.mjs [origin]
//
// Self-serving with no argument, like overlay.mjs — but the run that COUNTS is against a
// deployment, where Trusted Types is enforced. Cleans up the vault it creates.
//
// Exit 0 = the panel renders, the economy moves, and the refusals refuse.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../simple");
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json",
};

let passed = 0;
const failures = [];
const check = (name, ok, detail = "") => {
  if (ok) { passed++; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

let server = null;
let origin = process.argv[2]?.replace(/\/+$/, "") || "";
if (!origin) {
  server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
    const file = path.join(ROOT, rel || "index.html");
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
  console.log(`  serving simple/ at ${origin}`);
  console.log("  NOTE: no _headers here, and /api/seeds is not served. Deployed runs are the real ones.\n");
}

const browser = await puppeteer.launch({ headless: "new" });
let vaultKey = null;

try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(`${origin}/watch.html`, { waitUntil: "networkidle2", timeout: 60000 });

  const tt = await page.evaluate(() => {
    try { document.createElement("div").innerHTML = "<b>x</b>"; return false; } catch { return true; }
  });
  console.log(tt
    ? "  --   Trusted Types IS enforced here. This is the run that counts.\n"
    : "  --   Trusted Types not enforced (local harness).\n");

  console.log("── the pill appears ────────────────────────────────────────────────────────");
  const pill = await page.waitForSelector("#es-seed-pill", { timeout: 20000 }).catch(() => null);
  check("a seeds pill is injected", !!pill);
  if (!pill) throw new Error("no pill — nothing else can be checked");
  check("no uncaught error so far", errors.length === 0, errors.join(" | ").slice(0, 200));

  console.log("\n── opening it creates a vault and RENDERS ──────────────────────────────────");
  await page.click("#es-seed-pill");
  const rendered = await page
    .waitForFunction(() => (document.getElementById("es-seed-panel")?.childElementCount ?? 0) > 0,
      { timeout: 30000, polling: 300 })
    .then(() => true, () => false);
  check("the panel renders something", rendered);
  if (!rendered) {
    const dump = await page.evaluate(() => document.getElementById("es-seed-panel")?.textContent ?? "(missing)");
    throw new Error(`panel stayed empty: ${dump.slice(0, 200)}`);
  }

  /**
   * The headline seed balance, as a number. The one figure worth asserting against.
   *
   * parseFloat, not Number: the element reads "11.000 seeds", and Number() of that is NaN — which
   * coerced to 0 and made every balance assertion compare 0 against 0. LAST of the matches,
   * because when you are watching someone else's stream THEIR runway renders first and yours is
   * the one that moves when you buy.
   */
  const balance = () =>
    page.evaluate(() => {
      const els = [...document.querySelectorAll(".es-seed-big")];
      return parseFloat(els.pop()?.textContent ?? "") || 0;
    });

  const panel = () => page.evaluate(() => {
    const p = document.getElementById("es-seed-panel");
    return {
      text: p.textContent,
      acts: [...p.querySelectorAll("[data-act]")].map((n) => n.dataset.act),
      nodes: p.querySelectorAll("*").length,
      key: p.querySelector(".es-seed-key")?.textContent ?? null,
    };
  });

  const main = await panel();
  console.log(`    ${main.nodes} elements, actions: ${main.acts.join(", ")}`);
  check("it built real elements, not one text blob", main.nodes > 20, String(main.nodes));
  check("the vault id is shown", !!main.key && main.key.length > 20, main.key);
  vaultKey = main.key;

  console.log("\n── it says DEMO where it talks about money ─────────────────────────────────");
  check("the word 'demo' is on screen", /demo/i.test(main.text));
  check("and it says no card is charged",
    /charges a card|no payout|nothing here charges/i.test(main.text), main.text.slice(0, 120));
  check("the headline economics are stated", /1 seed = \$1/.test(main.text));

  console.log("\n── the free seed, through the gate ─────────────────────────────────────────");
  check("a free-seed button is offered", main.acts.includes("free"));
  await page.click('[data-act="free"]');
  const gameShown = await page.waitForSelector(".es-seed-ttt button", { timeout: 15000 }).then(() => true, () => false);
  check("the tic-tac-toe gate appears", gameShown);

  if (gameShown) {
    // Play until the game resolves. The flower is deliberately beatable and the seed is granted
    // either way, so this just needs to reach an end state.
    for (let i = 0; i < 9; i++) {
      const clicked = await page.evaluate(() => {
        const free = [...document.querySelectorAll(".es-seed-ttt button")].find((b) => !b.disabled && !b.textContent);
        if (!free) return false;
        free.click();
        return true;
      });
      if (!clicked) break;
      await new Promise((r) => setTimeout(r, 120));
    }
    const granted = await page
      .waitForFunction(() => !document.querySelector(".es-seed-modal"), { timeout: 20000, polling: 300 })
      .then(() => true, () => false);
    check("the game closes", granted);

    const after = await page
      .waitForFunction(() => {
        const els = [...document.querySelectorAll(".es-seed-big")];
        return (parseFloat(els.pop()?.textContent ?? "") || 0) >= 1;
      }, { timeout: 20000, polling: 500 })
      .then(() => true, () => false);
    check("a seed lands in the vault", after, `balance ${await balance()}`);
  }

  console.log("\n── buying, and what purchased seeds may NOT do ─────────────────────────────");
  //
  // Read the BALANCE, not the panel text. The first version of this matched /1[01]\./ against
  // everything on screen — which includes the button reading "Top up — 10 seeds for $10.59", so
  // it passed whether or not the purchase landed, and then raced ahead to take a cash-out quote
  // against the pre-purchase balance. It reported 22/22 with the buy silently untested.
  const beforeBuy = await balance();
  await page.click('[data-act="buy-small"]');
  const bought = await page
    .waitForFunction((b) => {
      const els = [...document.querySelectorAll(".es-seed-big")];
      return (parseFloat(els.pop()?.textContent ?? "") || 0) >= b + 9.5;
    }, { timeout: 20000, polling: 500 }, beforeBuy)
    .then(() => true, () => false);
  const afterBuy = await balance();
  check("a mock top-up credits ten seeds", bought, `${beforeBuy} -> ${afterBuy}`);
  console.log(`    balance ${beforeBuy} -> ${afterBuy}`);

  await page.click('[data-act="quote"]');
  const quoted = await page
    .waitForFunction(() => (document.getElementById("es-seed-quote")?.childElementCount ?? 0) > 0,
      { timeout: 20000, polling: 300 })
    .then(() => true, () => false);
  check("the cash-out quote renders", quoted);
  const quote = await page.evaluate(() => document.getElementById("es-seed-quote")?.textContent ?? "");
  console.log(`    ${quote.replace(/\s+/g, " ").slice(0, 140)}`);

  // THE QUOTE MUST SURVIVE A REFRESH, and this is why the assertion exists.
  //
  // The balance moves on its own — burn accrues server-side on every viewer heartbeat — so the
  // panel re-renders on a 15s timer, replacing its whole subtree. The first version of this
  // client wrote the quote straight into the box, so it vanished mid-read on a timer with
  // nothing to explain why. It showed up here as a flake: the suite failed only when the game
  // above had taken long enough to put the tick near the click. A flake is a bug that has not
  // been read yet.
  // Waits out the real 15s tick rather than simulating one. Slow, and the only version of this
  // check that tests the mechanism that actually broke.
  await new Promise((r) => setTimeout(r, 17000));
  const survived = await page.evaluate(() => {
    const box = document.getElementById("es-seed-quote");
    return { text: box?.textContent ?? "", kids: box?.childElementCount ?? -1 };
  });
  check("  it survives the 15s auto-refresh", survived.kids > 0 && survived.text === quote,
    JSON.stringify(survived).slice(0, 160));
  // This is the pool split, seen from the interface: 11 purchased seeds, 0 cash-outable.
  check("purchased seeds are NOT cash-outable", /Not yet|0 of 10|cash-outable seeds/i.test(quote), quote.slice(0, 120));
  check("  and it explains why rather than just refusing",
    /burned on streaming but not cashed out|can be burned/i.test(quote), quote.slice(0, 160));

  console.log("\n── the recovery phrase ─────────────────────────────────────────────────────");
  const acts = (await panel()).acts;
  check("a backup prompt appears once there is something to lose", acts.includes("show-phrase"), acts.join(","));
  if (acts.includes("show-phrase")) {
    await page.click('[data-act="show-phrase"]');
    await new Promise((r) => setTimeout(r, 300));
    const p = await page.evaluate(() => document.querySelector(".es-seed-phrase")?.textContent ?? "");
    check("twelve words are shown", p.trim().split(/\s+/).length === 12, `${p.trim().split(/\s+/).length} words`);
    check("  and it says paper, not screenshot", /paper/i.test((await panel()).text));
  }

  console.log("\n── restore rejects a bad phrase, and says where ────────────────────────────");
  await page.click('[data-act="back"]');
  await new Promise((r) => setTimeout(r, 200));
  await page.click('[data-act="switch"]');
  await new Promise((r) => setTimeout(r, 200));
  await page.click('[data-act="restore"]');
  await new Promise((r) => setTimeout(r, 200));
  await page.type("#es-seed-phrase-in", "able acid acre actor adapt admit adopt adult after agent agree zzzz");
  await page.click('[data-act="do-restore"]');
  await new Promise((r) => setTimeout(r, 600));
  const restoreText = (await panel()).text;
  check("a bad word is named by position", /Word 12|isn't one of the words/i.test(restoreText), restoreText.slice(0, 160));

  check("no uncaught page errors throughout", errors.length === 0, errors.join(" | ").slice(0, 250));
} catch (e) {
  failures.push("threw");
  console.error(`\nERROR: ${e.message}`);
} finally {
  await browser.close();
  server?.close();

  // Leave no vault behind. Only possible against a deployment we can reach with wrangler.
  if (vaultKey && origin.includes("earthseed.live")) {
    for (const sql of [
      `DELETE FROM seed_ledger WHERE to_key = '${vaultKey}' OR from_key = '${vaultKey}'`,
      `DELETE FROM seed_streams WHERE pubkey = '${vaultKey}'`,
      `DELETE FROM seed_vaults WHERE pubkey = '${vaultKey}'`,
    ]) {
      try {
        execFileSync("npx", ["wrangler", "d1", "execute", "earthseed-db", "--remote", `--command=${sql}`],
          { stdio: "ignore" });
      } catch { /* best effort */ }
    }
    console.log("\n  cleaned up the probe vault");
  }
}

console.log(`\n${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
