import * as Message from "./message.js";
import { Parameters } from "../ietf/parameters.js";
const MAX_VERSIONS = 128;
export class ClientSetup {
    static id = 0x20;
    versions;
    parameters;
    constructor(versions, parameters = new Parameters()) {
        this.versions = versions;
        this.parameters = parameters;
    }
    async #encode(w) {
        await w.u53(this.versions.length);
        for (const v of this.versions) {
            await w.u53(v);
        }
        // Number of parameters
        await w.u53(this.parameters.size);
        // Parameters
        for (const [id, data] of this.parameters.entries) {
            await w.u62(id);
            await w.u53(data.length);
            await w.write(data);
        }
    }
    async encode(w) {
        return Message.encode(w, this.#encode.bind(this));
    }
    static async #decode(r) {
        // Number of supported versions
        const numVersions = await r.u53();
        if (numVersions > MAX_VERSIONS) {
            throw new Error(`too many versions: ${numVersions}`);
        }
        const supportedVersions = [];
        for (let i = 0; i < numVersions; i++) {
            const version = await r.u53();
            supportedVersions.push(version);
        }
        // Number of parameters
        const numParams = await r.u53();
        const parameters = new Parameters();
        for (let i = 0; i < numParams; i++) {
            const id = await r.u62();
            const size = await r.u53();
            const value = await r.read(size);
            parameters.set(id, value);
        }
        return new ClientSetup(supportedVersions, parameters);
    }
    static async decode(r) {
        return Message.decode(r, ClientSetup.#decode);
    }
}
export class ServerSetup {
    static id = 0x21;
    version;
    parameters;
    constructor(version, parameters = new Parameters()) {
        this.version = version;
        this.parameters = parameters;
    }
    async #encode(w) {
        await w.u53(this.version);
        // Number of parameters
        await w.u53(this.parameters.size);
        // Parameters
        for (const [id, data] of this.parameters.entries) {
            await w.u62(id);
            await w.u53(data.length);
            await w.write(data);
        }
    }
    async encode(w) {
        return Message.encode(w, this.#encode.bind(this));
    }
    static async #decode(r) {
        console.log("[MOQ SETUP] ServerSetup.#decode: reading version...");
        // Selected version
        const selectedVersion = await r.u53();
        console.log("[MOQ SETUP] ServerSetup.#decode: version = 0x" + selectedVersion.toString(16));
        console.log("[MOQ SETUP] ServerSetup.#decode: reading numParams...");
        // Number of parameters
        const numParams = await r.u53();
        console.log("[MOQ SETUP] ServerSetup.#decode: numParams =", numParams);
        const parameters = new Parameters();
        for (let i = 0; i < numParams; i++) {
            console.log("[MOQ SETUP] ServerSetup.#decode: reading param", i + 1, "of", numParams);
            const id = await r.u62();
            console.log("[MOQ SETUP] param id =", id);

            // moq-rs uses key parity to determine value type:
            // - Even keys: IntValue (value is a varint)
            // - Odd keys: BytesValue (length + bytes)
            if (id % 2n === 0n) {
                // Even key: IntValue - just read the varint value
                const intValue = await r.u53();
                console.log("[MOQ SETUP] param intValue =", intValue);
                // Convert int to bytes for storage in Parameters
                const bytes = new Uint8Array(8);
                const view = new DataView(bytes.buffer);
                view.setBigUint64(0, BigInt(intValue));
                parameters.set(id, bytes);
            } else {
                // Odd key: BytesValue - read length then bytes
                const size = await r.u53();
                console.log("[MOQ SETUP] param size =", size);
                const value = await r.read(size);
                console.log("[MOQ SETUP] param value length =", value.byteLength);
                parameters.set(id, value);
            }
        }
        console.log("[MOQ SETUP] ServerSetup.#decode: complete");
        return new ServerSetup(selectedVersion, parameters);
    }
    static async decode(r) {
        return Message.decode(r, ServerSetup.#decode);
    }
}
