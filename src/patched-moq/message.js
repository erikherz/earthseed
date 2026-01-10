// These relative imports will be resolved by the Vite plugin to moq package
import { Reader, Writer } from "../stream.js";
// Encodes a message with a u16 (16-bit) size prefix as per draft-14.
export async function encode(writer, f) {
    let scratch = new Uint8Array();
    const temp = new Writer(new WritableStream({
        write(chunk) {
            const needed = scratch.byteLength + chunk.byteLength;
            if (needed > scratch.buffer.byteLength) {
                // Resize the buffer to the needed size.
                const capacity = Math.max(needed, scratch.buffer.byteLength * 2);
                const newBuffer = new ArrayBuffer(capacity);
                const newScratch = new Uint8Array(newBuffer, 0, needed);
                // Copy the old data into the new buffer.
                newScratch.set(scratch);
                // Copy the new chunk into the new buffer.
                newScratch.set(chunk, scratch.byteLength);
                scratch = newScratch;
            }
            else {
                // Copy chunk data into buffer
                scratch = new Uint8Array(scratch.buffer, 0, needed);
                scratch.set(chunk, needed - chunk.byteLength);
            }
        },
    }));
    try {
        await f(temp);
    }
    finally {
        temp.close();
    }
    await temp.closed;
    // PATCHED: Use u16 for message length - moq-rs uses this for drafts 11+
    if (scratch.byteLength > 65535) {
        throw new Error(`Message too large: ${scratch.byteLength} bytes (max 65535)`);
    }
    await writer.u16(scratch.byteLength);
    await writer.write(scratch);
}
// PATCHED: Reads a message with u16 size prefix - moq-rs uses this for drafts 11+.
export async function decode(reader, f) {
    console.log("[MOQ MESSAGE] decode: reading u16 size...");
    const size = await reader.u16();
    console.log("[MOQ MESSAGE] decode: size =", size, "bytes, reading data...");
    const data = await reader.read(size);
    console.log("[MOQ MESSAGE] decode: read", data.byteLength, "bytes, parsing...");
    const limit = new Reader(undefined, data);
    const msg = await f(limit);
    // Check that we consumed exactly the right number of bytes
    if (!(await limit.done())) {
        throw new Error("Message decoding consumed too few bytes");
    }
    console.log("[MOQ MESSAGE] decode: success");
    return msg;
}
//# sourceMappingURL=message.js.map