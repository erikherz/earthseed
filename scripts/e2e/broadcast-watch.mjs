// A real broadcast, watched, with the pixels checked.
//
//   node scripts/e2e/broadcast-watch.mjs [origin] --admin <password>
//
// This is the test that the control-plane suite cannot be a substitute for. Every refusal in
// control-plane.mjs would still pass against a Worker that had broken publishing entirely — a
// door that refuses everyone refuses attackers too. This one drives the whole path: admission,
// the ownership signature, the broker, a Worker-minted relay token, capture, encrypt, relay,
// decrypt, decode, paint.
//
// It reads PIXELS rather than status text. "▶ playing" is written by our own code and would keep
// saying so if the frames were garbage; the canvas is the only witness that decryption produced
// something a decoder accepted. Two samples, seconds apart, so a single static frame — or a
// letterboxed black canvas — cannot pass for live video.
//
// Also asserted, because they are cheap here and expensive to discover in production:
//   • the viewer is refused when the route tag is wrong (proof of link actually binds)
//   • the report control is present on the watch page
//   • terminating the stream stops the viewer

import puppeteer from "puppeteer";

const args = process.argv.slice(2);
const ORIGIN = (args.find((a) => !a.startsWith("--")) || "https://earthseed.live").replace(/\/+$/, "");
const adminFlag = args.indexOf("--admin");
const ADMIN = adminFlag >= 0 ? args[adminFlag + 1] : process.env.EARTHSEED_ADMIN;

let failures = 0;
/** Sections that could not run here. Named in the summary so green never overstates itself. */
const skipped = [];
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const step = (m) => console.log(`\n${m}`);

// Is this canvas showing moving video, or a black rectangle with a hopeful status line?
//
// Passed to puppeteer as a function value, never stringified and rebuilt with `new Function` in
// the page: this site enforces `require-trusted-types-for 'script'`, so that throws and the
// sampler silently never runs — which reads as "no video" against a page that was playing fine.
const SAMPLER = () => {
  const c = document.getElementById("video");
  if (!c || !c.width || !c.height) return null;
  const ctx = c.getContext("2d");
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let sum = 0;
  let nonBlack = 0;
  for (let i = 0; i < d.length; i += 4) {
    const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
    sum += v;
    if (v > 12) nonBlack++;
  }
  const px = d.length / 4;
  return { w: c.width, h: c.height, mean: sum / px, litFraction: nonBlack / px };
};

/**
 * Get a publish key, by whichever door is open.
 *
 * With --admin (or EARTHSEED_ADMIN) this asks /api/admin/mint-code. Without one it walks the
 * PUBLIC path instead: request a challenge, burn the proof of work, exchange it for a code —
 * exactly what a stranger with a browser does.
 *
 * The fallback is worth having for a reason beyond convenience. A suite that can only run when
 * the operator's password is to hand is a suite that mostly does not run, and this is the only
 * test that drives capture → encrypt → relay → decrypt → paint. The PoW path also proves
 * something the admin path cannot: that the door an actual user knocks on still opens.
 *
 * The code is a LIVE CREDENTIAL. It is never printed, never passed on a command line, and only
 * ever travels in the URL handed to the headless browser.
 */
async function getPublishCode() {
  if (ADMIN) {
    const mint = await fetch(`${ORIGIN}/api/admin/mint-code`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN}` },
    }).then((r) => r.json());
    if (!mint?.code) throw new Error(`admin mint refused: ${JSON.stringify(mint)}`);
    console.log("  publish key minted via /api/admin/mint-code");
    return mint.code;
  }

  const ch = await fetch(`${ORIGIN}/api/publish-code/challenge`).then((r) => r.json());
  if (!ch?.challenge) throw new Error(`no proof-of-work challenge: ${JSON.stringify(ch)}`);

  // Same rule the Worker checks: SHA-256(`${challenge}|${nonce}`) must start with `bits` zero
  // bits. 18 bits is ~262k hashes — a second or two here, and the point is that it is not free
  // for someone farming codes.
  const { createHash } = await import("node:crypto");
  const leadingZeroBits = (buf) => {
    let seen = 0;
    for (const b of buf) {
      if (b === 0) { seen += 8; continue; }
      seen += Math.clz32(b) - 24;
      break;
    }
    return seen;
  };
  const started = Date.now();
  let nonce = 0;
  for (;;) {
    const d = createHash("sha256").update(`${ch.challenge}|${nonce}`).digest();
    if (leadingZeroBits(d) >= ch.bits) break;
    nonce++;
  }
  console.log(`  proof of work solved: ${ch.bits} bits, ${nonce} nonces, ${Date.now() - started}ms`);

  const got = await fetch(`${ORIGIN}/api/publish-code/request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge: ch.challenge, nonce: String(nonce) }),
  }).then((r) => r.json());
  if (!got?.code) throw new Error(`code request refused: ${JSON.stringify(got)}`);
  if (got.active_immediately === false) {
    throw new Error("this deployment delays new publish codes; pass --admin to mint an active one");
  }
  console.log("  publish key minted via the public proof-of-work path");
  return got.code;
}

const mint = { code: await getPublishCode() };

const browser = await puppeteer.launch({
  headless: "new",
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

let streamId = null;
try {
  // Separate contexts: the broadcaster's identity and publish key live in storage, and a viewer
  // sharing them would let this test pass for the wrong reason.
  const bctx = await browser.createBrowserContext();
  const bpage = await bctx.newPage();
  bpage.on("console", (m) => {
    if (m.type() === "error") console.log(`    [broadcast console] ${m.text()}`);
  });

  step("Broadcaster goes live");
  await bpage.goto(`${ORIGIN}/broadcast.html?code=${encodeURIComponent(mint.code)}`, {
    waitUntil: "networkidle2",
    timeout: 60000,
  });
  await bpage.waitForSelector("#go", { timeout: 30000 });

  // Switch live chat on BEFORE going live. The toggle writes a signed per-stream setting, and a
  // viewer's page reads that setting to decide whether to mount anything — so doing it after
  // would leave the viewer already loaded without chat.
  await bpage.click("#usechat");
  await bpage
    .waitForFunction(() => document.getElementById("usechat")?.disabled === false,
      { timeout: 20000, polling: 200 })
    .catch(() => {});

  await bpage.click("#go");

  await bpage
    .waitForFunction(() => {
      const v = document.getElementById("share")?.value || "";
      return v.includes("#k=");
    }, { timeout: 90000 })
    .catch(async () => {
      const s = await bpage.$eval("#status", (e) => e.textContent);
      throw new Error(`never went live — status says: ${s}`);
    });

  const share = await bpage.$eval("#share", (e) => e.value);
  streamId = new URL(share).searchParams.get("node");
  check("a share link was produced", share.includes("#k="), true);
  check("  ...naming a 52-character stream id", streamId?.length, 52);
  console.log(`    ${share.replace(/#k=.*/, "#k=<redacted>")}`);

  // Waited for, not sampled. The share link appears as soon as the relay is connected, but "● live"
  // is only written when the encoder emits its first frame — reading the line at the same instant
  // catches "connecting…" and fails for no reason.
  const live = await bpage
    .waitForFunction(() => /live|playing/i.test(document.getElementById("status")?.textContent || ""), {
      timeout: 30000,
      polling: 500,
    })
    .then(() => true)
    .catch(() => false);
  check("the broadcaster reports being live", live, true);

  step("Viewer with the whole link");
  const vctx = await browser.createBrowserContext();
  const vpage = await vctx.newPage();
  vpage.on("console", (m) => {
    if (m.type() === "error") console.log(`    [watch console] ${m.text()}`);
  });
  await vpage.goto(share, { waitUntil: "networkidle2", timeout: 60000 });

  await vpage
    .waitForFunction(
      () => {
        const c = document.getElementById("video");
        if (!c || !c.width || !c.height) return false;
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let lit = 0;
        for (let i = 0; i < d.length; i += 4) {
          if ((d[i] + d[i + 1] + d[i + 2]) / 3 > 12) lit++;
        }
        return lit / (d.length / 4) > 0.05;
      },
      { timeout: 120000, polling: 1000 }
    )
    .catch(async () => {
      const s = await vpage.$eval("#status", (e) => e.textContent);
      throw new Error(`no decoded video appeared — status says: ${s}`);
    });

  const first = await vpage.evaluate(SAMPLER);
  check("the canvas has real dimensions", first.w > 100 && first.h > 100, true);
  check("it is painting lit pixels, not black", first.litFraction > 0.05, true);
  console.log(`    ${first.w}x${first.h}, mean luma ${first.mean.toFixed(1)}, lit ${(first.litFraction * 100).toFixed(0)}%`);

  await new Promise((r) => setTimeout(r, 6000));
  const second = await vpage.evaluate(SAMPLER);
  // A frozen frame would give an identical mean. Fake-device video moves continuously.
  check("the picture is still moving six seconds later", Math.abs(second.mean - first.mean) > 0.01, true);

  check("the report control is offered", await vpage.$eval("body", (b) => /Report this stream/.test(b.textContent)), true);

  step("A viewer without the link is refused");
  // Same stream, same origin parameter, a route tag that is not derived from the real key. This
  // is the check that makes the broadcast name stop being a credential.
  const refused = await vpage.evaluate(async (id) => {
    const r = await fetch("/api/watch/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ broadcast: id, origin: "", tag: "z".repeat(43) }),
    });
    return r.status;
  }, streamId);
  check("a wrong route tag gets 404 (not 403, which would confirm it exists)", refused, 404);

  step("The viewing is counted, and the broadcaster is told");
  //
  // The Worker's /api/stats/* endpoints existed for a day with nothing calling them — a surface
  // that looks like a feature and measures nothing. This is what makes them real, so it asserts
  // the whole loop: a row opened for THIS viewer, and the number reaching the broadcaster's own
  // pill. Both are gated on the proof-of-link tag, so this also proves the viewer could produce
  // one and the broadcaster could produce the same one.
  const pillCount = () =>
    bpage.$eval("#live-pill", (e) => {
      const m = /(\d+) watching/.exec(e.textContent || "");
      return m ? Number(m[1]) : 0;
    });

  const sawOne = await bpage
    .waitForFunction(() => /1 watching/.test(document.getElementById("live-pill")?.textContent || ""),
      { timeout: 45000, polling: 1000 })
    .then(() => true, () => false);
  check("the broadcaster's pill shows one watcher", sawOne, true);

  // A SECOND viewer, so this measures counting rather than mere presence — and so the first
  // viewer's page survives for the kill-switch section below.
  const v2ctx = await browser.createBrowserContext();
  const v2 = await v2ctx.newPage();
  await v2.goto(share, { waitUntil: "networkidle2", timeout: 60000 });
  const sawTwo = await bpage
    .waitForFunction(() => /2 watching/.test(document.getElementById("live-pill")?.textContent || ""),
      { timeout: 45000, polling: 1000 })
    .then(() => true, () => false);
  check("a second viewer makes it two", sawTwo, true);

  // Closing a tab must close the session, not leave it to the 150s reaper. pagehide fires on
  // close and the end goes out by sendBeacon; if that were broken the count would stay up until
  // the cron caught it — exactly the ghost-row problem the heartbeat replaced.
  await v2.close();
  await v2ctx.close();
  const backToOne = await bpage
    .waitForFunction(() => /1 watching/.test(document.getElementById("live-pill")?.textContent || ""),
      { timeout: 45000, polling: 1000 })
    .then(() => true, () => false);
  check("closing that tab takes it back to one", backToOne, true);
  console.log(`    pill: ${JSON.stringify(await bpage.$eval("#live-pill", (e) => e.textContent.trim()))}`);

  // The route tag, re-derived here the way the client does:
  //   HKDF-SHA256(fragment key, salt "es-route|<id>", info "earthseed-route-auth-v1")
  // Re-deriving rather than scraping it out of the page independently confirms the tag contract,
  // so a change to either side shows up here instead of as viewers being silently turned away.
  // Used by the chat probe and the CDN check below.
  const fragmentKey = new URL(share).hash.replace(/^#k=/, "");
  const { subtle } = await import("node:crypto").then((m) => m.webcrypto);
  const ikm = await subtle.importKey(
    "raw",
    Buffer.from(fragmentKey.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
    "HKDF", false, ["deriveBits"]
  );
  const tag = Buffer.from(
    await subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256",
        salt: Buffer.from(`es-route|${streamId}`),
        info: Buffer.from("earthseed-route-auth-v1") },
      ikm, 256
    )
  ).toString("base64url");

  step("Chat, end to end");
  //
  // The broadcaster switched chat on before going live (the toggle writes a signed setting), so
  // the viewer's page mounted it. Three things, in order: a message crosses between two separate
  // browsers, the RELAY holds something it cannot read, and a socket without the tag is refused.
  const chatUp = await vpage
    .waitForFunction(() => !document.getElementById("chat-mount")?.hidden, { timeout: 30000, polling: 500 })
    .then(() => true, () => false);
  check("the viewer got a chat panel", chatUp, true);

  if (chatUp) {
    const SECRET = `open-sesame-${Date.now().toString(36)}`;
    await bpage.waitForSelector(".es-chat-text", { timeout: 20000 });
    await bpage.type(".es-chat-text", SECRET);
    await bpage.click(".es-chat-send");

    const arrived = await vpage
      .waitForFunction((n) => (document.querySelector(".es-chat-log")?.textContent || "").includes(n),
        { timeout: 30000, polling: 500 }, SECRET)
      .then(() => true, () => false);
    check("a message crosses from broadcaster to viewer", arrived, true);

    // THE POINT OF THE WHOLE FEATURE, and the assertion worth having above all the others here.
    //
    // Join the room from Node with the tag but NO key — which is exactly the position the
    // operator is in — and read the history the Durable Object hands out. The plaintext must not
    // be in it. If this ever fails, chat has quietly become the least private thing on a site
    // whose entire argument is that it cannot see your stream.
    const wireUrl = `${ORIGIN.replace(/^http/, "ws")}/api/stream/${streamId}/chat?tag=${encodeURIComponent(tag)}`;
    const history = await new Promise((resolve) => {
      const ws = new WebSocket(wireUrl);
      const done = (v) => { try { ws.close(); } catch {} resolve(v); };
      ws.addEventListener("message", (ev) => {
        try {
          const d = JSON.parse(ev.data);
          if (d.type === "history") done(d.messages ?? []);
        } catch { /* keep waiting */ }
      });
      ws.addEventListener("error", () => done(null));
      setTimeout(() => done(null), 20000);
    });

    check("  an operator can join the room with only the tag", Array.isArray(history), true);
    if (Array.isArray(history)) {
      const raw = JSON.stringify(history);
      console.log(`    relay holds ${history.length} message(s), ${raw.length} bytes of envelope`);
      check("  and what it stores does NOT contain the plaintext", raw.includes(SECRET), false);
      check("  nor the sender's display name in the clear", /Guest-|es-chat/.test(raw), false);
      check("  each message is a sealed <nonce>.<ciphertext>",
        history.every((m) => typeof m.ct === "string" && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(m.ct)), true);
      check("  and carries no name or text field at all",
        history.every((m) => !("name" in m) && !("text" in m)), true);
    }

    // A WebSocket, not fetch(): Node forbids setting `Upgrade` and `Connection` by hand, so a
    // fetch-based probe throws before it reaches the Worker and reports its own failure as the
    // server's answer. The first version of this check did exactly that and "passed" a 0.
    const refused = await new Promise((resolve) => {
      const ws = new WebSocket(`${ORIGIN.replace(/^http/, "ws")}/api/stream/${streamId}/chat?tag=${"z".repeat(43)}`);
      const done = (v) => { try { ws.close(); } catch {} resolve(v); };
      ws.addEventListener("open", () => done("connected"));
      ws.addEventListener("error", () => done("refused"));
      setTimeout(() => done("timeout"), 15000);
    });
    check("  a socket with the wrong tag is refused", refused, "refused");
  }

  step("Which CDN actually carried it");
  //
  // Neither wrangler.jsonc nor the Worker source can answer this. The FLEET_* vars stay populated
  // for the dormant backend on purpose, and the choice is made by whether a SECRET is set — so
  // the only honest answer comes from asking for a placement and reading what comes back.
  //
  // That needs a valid route tag, which means deriving it the way the client does:
  //   HKDF-SHA256(fragment key, salt="es-route|<id>", info="earthseed-route-auth-v1")
  // Re-deriving it here rather than scraping it out of the page is worth the dozen lines: it
  // independently confirms the tag contract, so a change to either side shows up as a failure
  // here instead of as viewers being silently turned away.
  const placement = await fetch(`${ORIGIN}/api/watch/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ broadcast: streamId, origin: "", tag }),
  }).then((r) => r.json());

  check("a correctly derived route tag is accepted", !!placement.relay_url, true);
  console.log(`    relay_url ${placement.relay_url}   path ${placement.path ?? "(none — fleet backend)"}`);
  check("the viewer is placed on cdn.moq.pro", placement.relay_url, "https://cdn.moq.pro/");
  check("  under the account root", (placement.path || "").startsWith("erik/"), true);
  check("  naming this broadcast and no other", placement.path, `erik/${streamId}`);

  if (!ADMIN) {
    step("Terminating stops the viewer — SKIPPED");
    console.log("  no --admin password, so the kill switch cannot be exercised.");
    skipped.push("the kill switch (needs --admin)");
    throw { skipRest: true };
  }

  step("Terminating stops the viewer");
  await fetch(`${ORIGIN}/api/admin/kill`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ stream_id: streamId, note: "e2e" }),
  });
  const stopped = await vpage
    .waitForFunction(() => /terminated/i.test(document.getElementById("status")?.textContent || ""), {
      timeout: 30000,
      polling: 500,
    })
    .then(() => true)
    .catch(() => false);
  check("the viewer is told, within 30s", stopped, true);

  const afterKill = await vpage.evaluate(SAMPLER);
  check("and the canvas is cleared rather than left frozen", afterKill.litFraction < 0.02, true);
} catch (e) {
  // A deliberate early exit from an un-runnable section is not a failure, and must not be
  // reported as a pass either — the summary line says what was skipped.
  if (!e?.skipRest) {
    failures++;
    console.error(`\nERROR: ${e.message}`);
  }
} finally {
  if (streamId && ADMIN) {
    // Leave nothing terminated behind: this id belongs to a throwaway identity, but a stale kill
    // row is exactly the sort of thing that makes a later test fail for an unrelated reason.
    await fetch(`${ORIGIN}/api/admin/unkill`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ stream_id: streamId }),
    }).catch(() => {});
  }
  await browser.close();
}

// A bare "PASS" after a section was skipped is the failure this whole suite exists to avoid —
// green that means less than it appears to. Say what did not run, every time, in the line people
// actually read.
if (failures) {
  console.log(`\nFAIL: ${failures} assertion(s)\n`);
} else if (skipped.length) {
  console.log(`\nPASS (INCOMPLETE): broadcast → watch works end to end.`);
  console.log(`  NOT RUN: ${skipped.join("; ")}\n`);
} else {
  console.log("\nPASS: broadcast → watch works end to end\n");
}
process.exit(failures ? 1 : 0);
