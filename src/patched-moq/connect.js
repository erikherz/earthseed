import WebTransportWs from "@kixelated/web-transport-ws";
// These relative imports will be resolved by the Vite plugin to moq package
import * as Ietf from "../ietf/index.js";
import * as Lite from "../lite/index.js";
import { Stream, Reader } from "../stream.js";
import * as Hex from "../util/hex.js";
import { Parameters } from "../ietf/parameters.js";

// Detect if URL is for Cloudflare relay
function isCloudflareRelay(url) {
    const urlStr = url.toString().toLowerCase();
    return urlStr.includes("cloudflare");
}

// Save if WebSocket won the last race, so we won't give QUIC a head start next time.
const websocketWon = new Set();

/**
 * Establishes a connection to a MOQ server.
 * Handles both Luke's relay (moq-lite) and Cloudflare's relay (draft-14).
 */
export async function connect(url, props) {
    const isCloudflare = isCloudflareRelay(url);
    console.log("[MOQ] connect() URL:", url.toString(), "isCloudflare:", isCloudflare);

    // Create a cancel promise to kill whichever is still connecting.
    let done;
    const cancel = new Promise((resolve) => {
        done = resolve;
    });
    const webtransport = globalThis.WebTransport ? connectWebTransport(url, cancel, props?.webtransport) : undefined;

    // Give QUIC a 200ms head start to connect before trying WebSocket, unless WebSocket has won in the past.
    const headstart = !webtransport || websocketWon.has(url.toString()) ? 0 : (props?.websocket?.delay ?? 200);
    const websocket = props?.websocket?.enabled !== false
        ? connectWebSocket(props?.websocket?.url ?? url, headstart, cancel)
        : undefined;

    if (!websocket && !webtransport) {
        throw new Error("no transport available; WebTransport not supported and WebSocket is disabled");
    }

    // Race them
    const quic = await Promise.any(webtransport ? (websocket ? [websocket, webtransport] : [webtransport]) : [websocket]);
    if (done) done();
    if (!quic) throw new Error("no transport available");

    if (quic instanceof WebTransportWs) {
        console.warn(url.toString(), "using WebSocket fallback");
        websocketWon.add(url.toString());
    }

    const stream = await Stream.open(quic);

    if (isCloudflare) {
        // Cloudflare draft-14 handshake
        return await cloudflareHandshake(url, quic, stream);
    } else {
        // Luke's relay - original handshake
        return await lukeHandshake(url, quic, stream);
    }
}

/**
 * Handshake for Luke's relay (cdn.moq.dev) - uses original library behavior
 */
async function lukeHandshake(url, quic, stream) {
    console.log("[MOQ] Luke relay handshake - sending CLIENT_SETUP with both versions");

    // Send 0x20 (ClientCompat)
    await stream.writer.u53(0x20);

    const encoder = new TextEncoder();
    const params = new Ietf.Parameters();
    params.set(2n, new Uint8Array([63])); // MAX_REQUEST_ID
    params.set(5n, encoder.encode("earthseed")); // Implementation name

    // Send BOTH versions - let server pick
    const msg = new Ietf.ClientSetup([Lite.CURRENT_VERSION, Ietf.CURRENT_VERSION], params);
    await msg.encode(stream.writer);

    // Expect 0x21 (ServerCompat)
    const serverCompat = await stream.reader.u53();
    console.log("[MOQ] Luke relay - received message type: 0x" + serverCompat.toString(16));
    if (serverCompat !== 0x21) {
        throw new Error(`unsupported server message type: ${serverCompat.toString()}`);
    }

    // Use original ServerSetup decode (all params are bytes)
    const server = await Ietf.ServerSetup.decode(stream.reader);
    console.log("[MOQ] Luke relay - server version: 0x" + server.version.toString(16));

    if (server.version === Lite.CURRENT_VERSION) {
        console.log("[MOQ] Luke relay - moq-lite session established");
        return new Lite.Connection(url, quic, stream);
    } else if (server.version === Ietf.CURRENT_VERSION) {
        console.log("[MOQ] Luke relay - moq-ietf session established");
        return new Ietf.Connection(url, quic, stream);
    } else {
        throw new Error(`unsupported server version: ${server.version.toString()}`);
    }
}

/**
 * Handshake for Cloudflare relay - draft-14 with int params
 */
async function cloudflareHandshake(url, quic, stream) {
    console.log("[MOQ] Cloudflare relay handshake - sending CLIENT_SETUP with DRAFT_14 only");

    // Send 0x20 (CLIENT_SETUP)
    await stream.writer.u53(0x20);

    const params = new Ietf.Parameters();
    // Cloudflare uses int params (even keys = int value)
    // We'll send empty params for now

    const DRAFT_14 = 0xff00000e;
    const msg = new Ietf.ClientSetup([DRAFT_14], params);

    // Use u16 length encoding for message
    await encodeClientSetupCF(stream.writer, msg);

    // Expect 0x21 (SERVER_SETUP)
    const serverSetup = await stream.reader.u53();
    console.log("[MOQ] Cloudflare relay - received message type: 0x" + serverSetup.toString(16));
    if (serverSetup !== 0x21) {
        throw new Error(`unsupported server message type: 0x${serverSetup.toString(16)}, expected 0x21`);
    }

    // Decode SERVER_SETUP with Cloudflare's int-param format
    const server = await decodeServerSetupCF(stream.reader);
    console.log("[MOQ] Cloudflare relay - server version: 0x" + server.version.toString(16));

    if (server.version === Lite.CURRENT_VERSION) {
        console.log("[MOQ] Cloudflare relay - moq-lite session established");
        return new Lite.Connection(url, quic, stream);
    } else if (server.version === Ietf.CURRENT_VERSION || server.version === 0xff00000e) {
        console.log("[MOQ] Cloudflare relay - moq-ietf/draft-14 session established");
        return new Ietf.Connection(url, quic, stream);
    } else {
        throw new Error(`unsupported server version: ${server.version.toString()}`);
    }
}

/**
 * Encode ClientSetup with u16 length (Cloudflare format)
 */
async function encodeClientSetupCF(writer, setup) {
    // Build message body in scratch buffer
    let scratch = new Uint8Array();
    const temp = new (await import("../stream.js")).Writer(new WritableStream({
        write(chunk) {
            const needed = scratch.byteLength + chunk.byteLength;
            if (needed > scratch.buffer.byteLength) {
                const capacity = Math.max(needed, scratch.buffer.byteLength * 2);
                const newBuffer = new ArrayBuffer(capacity);
                const newScratch = new Uint8Array(newBuffer, 0, needed);
                newScratch.set(scratch);
                newScratch.set(chunk, scratch.byteLength);
                scratch = newScratch;
            } else {
                scratch = new Uint8Array(scratch.buffer, 0, needed);
                scratch.set(chunk, needed - chunk.byteLength);
            }
        },
    }));

    // Encode versions
    await temp.u53(setup.versions.length);
    for (const v of setup.versions) {
        await temp.u53(v);
    }
    // Encode params count
    await temp.u53(setup.parameters.size);
    // Encode params (using Cloudflare format - but we send 0 params)
    for (const [id, data] of setup.parameters.entries) {
        await temp.u62(id);
        await temp.u53(data.length);
        await temp.write(data);
    }

    temp.close();
    await temp.closed;

    // Write u16 length + body
    await writer.u16(scratch.byteLength);
    await writer.write(scratch);
}

/**
 * Decode ServerSetup with Cloudflare's int-param format
 */
async function decodeServerSetupCF(reader) {
    // Read u16 length
    const size = await reader.u16();
    console.log("[MOQ CF] ServerSetup size:", size, "bytes");

    const data = await reader.read(size);
    const limit = new Reader(undefined, data);

    // Decode version
    const version = await limit.u53();
    console.log("[MOQ CF] ServerSetup version: 0x" + version.toString(16));

    // Decode params count
    const numParams = await limit.u53();
    console.log("[MOQ CF] ServerSetup numParams:", numParams);

    const parameters = new Parameters();
    for (let i = 0; i < numParams; i++) {
        const id = await limit.u62();

        // Cloudflare uses key parity: even = int, odd = bytes
        if (id % 2n === 0n) {
            const intValue = await limit.u53();
            console.log("[MOQ CF] param id=" + id + " intValue=" + intValue);
            // Store as 8-byte big-endian for compatibility
            const bytes = new Uint8Array(8);
            const view = new DataView(bytes.buffer);
            view.setBigUint64(0, BigInt(intValue));
            parameters.set(id, bytes);
        } else {
            const size = await limit.u53();
            const value = await limit.read(size);
            console.log("[MOQ CF] param id=" + id + " bytes=" + size);
            parameters.set(id, value);
        }
    }

    // Check we consumed all bytes
    if (!(await limit.done())) {
        console.warn("[MOQ CF] ServerSetup had extra bytes");
    }

    return { version, parameters };
}

async function connectWebTransport(url, cancel, options) {
    let finalUrl = url;
    const finalOptions = {
        allowPooling: false,
        congestionControl: "low-latency",
        ...options,
    };

    if (url.protocol === "http:") {
        const fingerprintUrl = new URL(url);
        fingerprintUrl.pathname = "/certificate.sha256";
        fingerprintUrl.search = "";
        console.warn(fingerprintUrl.toString(), "performing an insecure fingerprint fetch");

        const fingerprint = await Promise.race([fetch(fingerprintUrl), cancel]);
        if (!fingerprint) return undefined;
        const fingerprintText = await Promise.race([fingerprint.text(), cancel]);
        if (fingerprintText === undefined) return undefined;

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
    const loaded = await Promise.race([quic.ready.then(() => true), cancel]);
    if (!loaded) {
        quic.close();
        return undefined;
    }
    return quic;
}

async function connectWebSocket(url, delay, cancel) {
    const timer = new Promise((resolve) => setTimeout(resolve, delay));
    const active = await Promise.race([cancel, timer.then(() => true)]);
    if (!active) return undefined;

    if (delay) {
        console.debug(url.toString(), `no WebTransport after ${delay}ms, attempting WebSocket fallback`);
    }

    const quic = new WebTransportWs(url);
    const loaded = await Promise.race([quic.ready.then(() => true), cancel]);
    if (!loaded) {
        quic.close();
        return undefined;
    }
    return quic;
}
