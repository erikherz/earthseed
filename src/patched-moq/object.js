// Patched object.js with debug logging and Cloudflare compatibility

const SUBGROUP_ID = 0x0;
const STREAM_TYPE = 0x04;
const GROUP_END = 0x03;

export class Group {
    static id = STREAM_TYPE;
    requestId;
    groupId;
    flags;

    constructor(requestId, groupId, flags) {
        if (flags.hasSubgroup && flags.hasSubgroupObject) {
            throw new Error("hasSubgroup and hasSubgroupObject cannot be true at the same time");
        }
        this.requestId = requestId;
        this.groupId = groupId;
        this.flags = flags;
    }

    async encode(w) {
        let id = 0x10;
        if (this.flags.hasExtensions) id |= 0x01;
        if (this.flags.hasSubgroup) id |= 0x02;
        if (this.flags.hasSubgroupObject) id |= 0x04;
        if (this.flags.hasEnd) id |= 0x08;
        await w.u53(id);
        await w.u53(this.requestId);
        await w.u53(this.groupId);
        if (this.flags.hasSubgroup) {
            await w.u8(SUBGROUP_ID);
        }
        await w.u8(0); // publisher priority
    }

    static async decode(r) {
        const id = await r.u53();
        console.log("[MOQ CF OBJ] Group.decode - id:", id, "hex:", "0x" + id.toString(16));
        if (id < 0x10 || id > 0x1f) {
            throw new Error(`Unsupported group type: ${id}`);
        }
        const flags = {
            hasExtensions: (id & 0x01) !== 0,
            hasSubgroup: (id & 0x02) !== 0,
            hasSubgroupObject: (id & 0x04) !== 0,
            hasEnd: (id & 0x08) !== 0,
        };
        console.log("[MOQ CF OBJ] Group.decode - flags:", JSON.stringify(flags));
        const requestId = await r.u53();
        const groupId = await r.u53();
        console.log("[MOQ CF OBJ] Group.decode - requestId:", requestId, "groupId:", groupId);
        // PATCHED: Read Subgroup ID when EITHER hasSubgroup OR hasSubgroupObject is set
        // For OBJECT_WITH_SUBGROUP_OBJECT streams (0x14-0x17), Subgroup ID is always present
        if (flags.hasSubgroup || flags.hasSubgroupObject) {
            const subgroupId = await r.u53();
            console.log("[MOQ CF OBJ] Group.decode - subgroupId:", subgroupId);
            // Don't enforce subgroupId==0 for now, just log it
        }
        const priority = await r.u8();
        console.log("[MOQ CF OBJ] Group.decode - priority:", priority);
        return new Group(requestId, groupId, flags);
    }
}

export class Frame {
    payload;

    constructor(payload) {
        this.payload = payload;
    }

    async encode(w, flags) {
        await w.u8(0); // id_delta = 0
        if (flags.hasExtensions) {
            await w.u53(0); // extensions length = 0
        }
        if (this.payload !== undefined) {
            await w.u53(this.payload.byteLength);
            if (this.payload.byteLength === 0) {
                await w.u8(0); // status = normal
            } else {
                await w.write(this.payload);
            }
        } else {
            await w.u8(0); // length = 0
            await w.u8(GROUP_END);
        }
    }

    static async decode(r, flags) {
        console.log("[MOQ CF OBJ] Frame.decode - flags:", JSON.stringify(flags));

        const delta = await r.u53();
        console.log("[MOQ CF OBJ] Frame.decode - delta:", delta);
        if (delta !== 0) {
            throw new Error(`Unsupported delta: ${delta}`);
        }

        if (flags.hasExtensions) {
            const extensionsLength = await r.u53();
            console.log("[MOQ CF OBJ] Frame.decode - extensionsLength:", extensionsLength);
            if (extensionsLength > 0) {
                // PATCHED: Skip extensions instead of throwing
                console.log("[MOQ CF OBJ] Frame.decode - skipping", extensionsLength, "bytes of extensions");
                await r.read(extensionsLength);
            }
        }

        const payloadLength = await r.u53();
        console.log("[MOQ CF OBJ] Frame.decode - payloadLength:", payloadLength);

        if (payloadLength > 0) {
            const payload = await r.read(payloadLength);
            console.log("[MOQ CF OBJ] Frame.decode - read payload of", payload.byteLength, "bytes");
            return new Frame(payload);
        }

        const status = await r.u53();
        console.log("[MOQ CF OBJ] Frame.decode - status:", status);

        if (flags.hasEnd) {
            if (status === 0) return new Frame(new Uint8Array(0));
        } else if (status === 0 || status === GROUP_END) {
            return new Frame();
        }

        throw new Error(`Unsupported object status: ${status}`);
    }
}
