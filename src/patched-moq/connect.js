import WebTransportWs from "@kixelated/web-transport-ws";
// These relative imports will be resolved by the Vite plugin to moq package
import * as Ietf from "../ietf/index.js";
import * as Lite from "../lite/index.js";
import { Stream } from "../stream.js";
import * as Hex from "../util/hex.js";
// Save if WebSocket won the last race, so we won't give QUIC a head start next time.
const websocketWon = new Set();
/**
 * Establishes a connection to a MOQ server.
 *
 * @param url - The URL of the server to connect to
 * @returns A promise that resolves to a Connection instance
 */
export async function connect(url, props) {
    console.log("[MOQ PATCHED] connect() called with URL:", url.toString());
    // Create a cancel promise to kill whichever is still connecting.
    let done;
    const cancel = new Promise((resolve) => {
        done = resolve;
    });
    const webtransport = globalThis.WebTransport ? connectWebTransport(url, cancel, props?.webtransport) : undefined;
    // Give QUIC a 200ms head start to connect before trying WebSocket, unless WebSocket has won in the past.
    // NOTE that QUIC should be faster because it involves 1/2 fewer RTTs.
    const headstart = !webtransport || websocketWon.has(url.toString()) ? 0 : (props?.websocket?.delay ?? 200);
    const websocket = props?.websocket?.enabled !== false
        ? connectWebSocket(props?.websocket?.url ?? url, headstart, cancel)
        : undefined;
    if (!websocket && !webtransport) {
        throw new Error("no transport available; WebTransport not supported and WebSocket is disabled");
    }
    // Race them, using `.any` to ignore if one participant has a error.
    const quic = await Promise.any(webtransport ? (websocket ? [websocket, webtransport] : [webtransport]) : [websocket]);
    if (done)
        done();
    if (!quic)
        throw new Error("no transport available");
    // Save if WebSocket won the last race, so we won't give QUIC a head start next time.
    if (quic instanceof WebTransportWs) {
        console.warn(url.toString(), "using WebSocket fallback; the user experience may be degraded");
        websocketWon.add(url.toString());
    }
    // moq-rs currently requires the ROLE extension to be set.
    console.log("[MOQ] Opening bidirectional stream...");
    const stream = await Stream.open(quic);
    console.log("[MOQ] Stream opened, sending CLIENT_SETUP (0x20)");

    // PATCHED: Use 0x20 (CLIENT_SETUP) - moq-rs drafts 11+ use this
    await stream.writer.u53(0x20);

    const params = new Ietf.Parameters();
    // No ROLE parameter - moq-rs server doesn't require it based on source

    // PATCHED: Use DRAFT_14 (0xff00000e) - confirmed from moq-rs server code
    const DRAFT_14 = 0xff00000e;
    const msg = new Ietf.ClientSetup([DRAFT_14], params);
    console.log("[MOQ] Encoding CLIENT_SETUP: version=0x" + DRAFT_14.toString(16) + " params=none");
    await msg.encode(stream.writer);
    console.log("[MOQ] CLIENT_SETUP sent, waiting for SERVER_SETUP (0x21)...");

    // PATCHED: Expect 0x21 (SERVER_SETUP) response - moq-rs drafts 11+ use this
    const serverSetup = await stream.reader.u53();
    console.log("[MOQ] Received message type: 0x" + serverSetup.toString(16));
    if (serverSetup !== 0x21) {
        throw new Error(`unsupported server message type: 0x${serverSetup.toString(16)}, expected 0x21`);
    }
    const server = await Ietf.ServerSetup.decode(stream.reader);
    if (server.version === Lite.CURRENT_VERSION) {
        console.debug(url.toString(), "moq-lite session established");
        return new Lite.Connection(url, quic, stream);
    }
    else if (server.version === Ietf.CURRENT_VERSION) {
        console.debug(url.toString(), "moq-ietf session established");
        return new Ietf.Connection(url, quic, stream);
    }
    else {
        throw new Error(`unsupported server version: ${server.version.toString()}`);
    }
}
async function connectWebTransport(url, cancel, options) {
    let finalUrl = url;
    const finalOptions = {
        allowPooling: false,
        congestionControl: "low-latency",
        ...options,
    };
    // Only perform certificate fetch and URL rewrite when polyfill is not needed
    // This is needed because WebTransport is a butt to work with in local development.
    if (url.protocol === "http:") {
        const fingerprintUrl = new URL(url);
        fingerprintUrl.pathname = "/certificate.sha256";
        fingerprintUrl.search = "";
        console.warn(fingerprintUrl.toString(), "performing an insecure fingerprint fetch; use https:// in production");
        // Fetch the fingerprint from the server.
        // TODO cancel the request if the effect is cancelled.
        const fingerprint = await Promise.race([fetch(fingerprintUrl), cancel]);
        if (!fingerprint)
            return undefined;
        const fingerprintText = await Promise.race([fingerprint.text(), cancel]);
        if (fingerprintText === undefined)
            return undefined;
        finalOptions.serverCertificateHashes = (finalOptions.serverCertificateHashes || []).concat([
            {
                algorithm: "sha-256",
                value: Hex.toBytes(fingerprintText),
            },
        ]);
        finalUrl = new URL(url);
        finalUrl.protocol = "https:";
    }
    const quic = new WebTransport(finalUrl, finalOptions);
    // Wait for the WebTransport to connect, or for the cancel promise to resolve.
    // Close the connection if we lost the race.
    const loaded = await Promise.race([quic.ready.then(() => true), cancel]);
    if (!loaded) {
        quic.close();
        return undefined;
    }
    return quic;
}
// TODO accept arguments to control the port/path used.
async function connectWebSocket(url, delay, cancel) {
    const timer = new Promise((resolve) => setTimeout(resolve, delay));
    const active = await Promise.race([cancel, timer.then(() => true)]);
    if (!active)
        return undefined;
    if (delay) {
        console.debug(url.toString(), `no WebTransport after ${delay}ms, attempting WebSocket fallback`);
    }
    const quic = new WebTransportWs(url);
    // Wait for the WebSocket to connect, or for the cancel promise to resolve.
    // Close the connection if we lost the race.
    const loaded = await Promise.race([quic.ready.then(() => true), cancel]);
    if (!loaded) {
        quic.close();
        return undefined;
    }
    return quic;
}
//# sourceMappingURL=connect.js.map