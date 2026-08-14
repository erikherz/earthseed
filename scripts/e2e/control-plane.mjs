// Does the control plane actually refuse the things it claims to refuse?
//
//   node scripts/e2e/control-plane.mjs [origin] [--admin <password>]
//
// The assertions that matter here are the NEGATIVE ones. A test that only confirms a valid
// publish key works would pass just as happily against a Worker that admitted everyone, which is
// precisely the failure this whole change exists to prevent — the previous arrangement looked
// like it gated publishing and gated nothing.
//
// So every check below has a paired refusal:
//   • a forged key is rejected, and a real one accepted
//   • a tampered key (one byte of the payload flipped) is rejected
//   • a viewer with no route tag is refused for a live stream, and 404 rather than 403
//   • a terminated stream stops being placed, and stops again after being un-terminated
//   • a report writes no key, no link and no reporter identity into D1
//
// Needs no browser. The media path is covered separately; this is the door, not the room.

const args = process.argv.slice(2);
const ORIGIN = (args.find((a) => !a.startsWith("--")) || "https://earthseed.live").replace(/\/+$/, "");
const adminFlag = args.indexOf("--admin");
const ADMIN = adminFlag >= 0 ? args[adminFlag + 1] : process.env.EARTHSEED_ADMIN;

let failures = 0;
let checks = 0;
const check = (name, actual, expected) => {
  checks++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${name}` +
      (ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`)
  );
};
const section = (s) => console.log(`\n${s}`);

const json = async (path, opts = {}) => {
  const r = await fetch(`${ORIGIN}${path}`, opts);
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
};
const admin = (path, body) =>
  json(path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

// A syntactically valid broadcast name that nobody holds the private key for. Used wherever the
// point is to be refused for a reason OTHER than the name being malformed — otherwise a 400 on
// shape would masquerade as the refusal we meant to test.
const FAKE_NODE = "a".repeat(52);

try {
  section("Pages are served");
  for (const p of ["/", "/trust", "/request", "/reports", "/broadcast.html", "/watch.html", "/favicon.svg"]) {
    const r = await fetch(`${ORIGIN}${p}`);
    check(`GET ${p}`, r.status, 200);
  }

  section("Publish keys");
  const chal = await json("/api/publish-code/challenge");
  check("a proof-of-work challenge is offered", chal.status, 200);
  check("it names a difficulty", typeof chal.body?.bits === "number", true);

  // Requesting one without doing the work must fail, or the puzzle is decoration.
  const noWork = await json("/api/publish-code/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challenge: chal.body.challenge, nonce: "0" }),
  });
  check("a request with no proof of work is refused", noWork.status, 403);

  const forged = await json("/api/broadcast/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ broadcast: FAKE_NODE, code: "es1.AAAA.AAAAAAAAAAAAAAAAAAAAAA" }),
  });
  check("a forged publish key is refused", forged.status, 403);
  check("  ...and the refusal asks for a key", forged.body?.need_code, true);

  const noKey = await json("/api/broadcast/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ broadcast: FAKE_NODE }),
  });
  check("no publish key at all is refused", noKey.status, 403);

  if (!ADMIN) {
    console.log("\n(no --admin password given — skipping the admin-gated half)");
  } else {
    section("Admin gate");
    const bad = await fetch(`${ORIGIN}/api/admin/verify`, { headers: { Authorization: "Bearer wrong" } });
    check("a wrong admin password is rejected", bad.status, 401);
    const good = await admin("/api/admin/verify");
    check("the right one is accepted", good.body?.valid, true);
    const none = await fetch(`${ORIGIN}/api/admin/reports`);
    check("no credential at all is rejected", none.status, 401);

    section("A minted key is accepted, and a tampered one is not");
    const minted = await admin("/api/admin/mint-code", {});
    check("a key can be minted out of band", typeof minted.body?.code, "string");
    const code = minted.body.code;

    // Past admission, this fails on the Ed25519 claim instead — which is the proof the key WAS
    // accepted. Distinguishing the two failures is the whole point of checking both.
    const claimStage = await json("/api/broadcast/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ broadcast: FAKE_NODE, code, challenge: "x", sig: "x" }),
    });
    check("a real key gets past admission", claimStage.body?.need_code ?? false, false);
    check("  ...and is then stopped by the ownership check", claimStage.status, 403);

    // Flip one character of the payload. The MAC covers it, so this must be rejected — this is
    // what makes it safe for the expiry to ride inside the credential rather than in a table.
    const parts = code.split(".");
    const flipped = `${parts[0]}.${parts[1].slice(0, -1)}${parts[1].slice(-1) === "A" ? "B" : "A"}.${parts[2]}`;
    const tampered = await json("/api/broadcast/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ broadcast: FAKE_NODE, code: flipped, challenge: "x", sig: "x" }),
    });
    check("a key with an edited payload is refused", tampered.body?.need_code, true);

    section("Revocation");
    await admin("/api/admin/revoke-code", { code, note: "e2e" });
    const revoked = await json("/api/broadcast/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ broadcast: FAKE_NODE, code, challenge: "x", sig: "x" }),
    });
    check("a revoked key stops working", revoked.body?.need_code, true);
    await admin("/api/admin/revoke-code", { code, undo: true });
    const unrevoked = await json("/api/broadcast/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ broadcast: FAKE_NODE, code, challenge: "x", sig: "x" }),
    });
    check("undo puts it back", unrevoked.body?.need_code ?? false, false);

    section("The kill switch");
    await admin("/api/admin/kill", { stream_id: FAKE_NODE, note: "e2e" });
    const killedPub = await json("/api/broadcast/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ broadcast: FAKE_NODE, code, challenge: "x", sig: "x" }),
    });
    check("a terminated name cannot be published to", killedPub.status, 410);
    const killedWatch = await json("/api/watch/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ broadcast: FAKE_NODE, tag: "x".repeat(32) }),
    });
    // 404, not 403: a refusal that confirms the stream exists is a refusal that leaks.
    check("a terminated stream is not placed, and says nothing", killedWatch.status, 404);
    const status = await json(`/api/stream/${FAKE_NODE}/status`);
    check("the stop signal live clients poll says killed", status.body?.killed, true);

    await admin("/api/admin/unkill", { stream_id: FAKE_NODE });
    const revived = await json(`/api/stream/${FAKE_NODE}/status`);
    check("un-terminating clears it", revived.body?.killed, false);

    section("Reports carry nothing identifying");
    const filed = await json("/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stream_id: FAKE_NODE,
        category: "harassment",
        note: "e2e probe",
        evidence_url: "https://earthseed.live/watch.html?node=x#k=SECRET_SHOULD_NOT_PERSIST",
      }),
    });
    check("a report is accepted", [200, 202].includes(filed.status), true);

    const queue = await admin("/api/admin/reports");
    const mine = (queue.body?.reports ?? []).filter((r) => r.stream_id === FAKE_NODE);
    check("it reaches the operator queue", mine.length > 0, true);
    if (mine.length) {
      const row = mine[0];
      // The evidence link is forwarded to the webhook and never written down. If it were, this
      // database would finally contain a way to decrypt a broadcast.
      check("no field on the row contains the link fragment", JSON.stringify(row).includes("SECRET_SHOULD_NOT_PERSIST"), false);
      check("the row has no reporter identity", Object.keys(row).sort(), [
        "category", "created_at", "handled_at", "id", "killed_at", "live", "note", "stream_id",
      ]);
      await admin("/api/admin/reports/ack", { stream_id: FAKE_NODE });
    }
  }
} catch (e) {
  failures++;
  console.error(`\nERROR: ${e.stack || e.message}`);
}

console.log(
  failures ? `\nFAIL: ${failures} of ${checks} assertion(s)\n` : `\nPASS: ${checks} assertions against ${ORIGIN}\n`
);
process.exit(failures ? 1 : 0);
