// Patched control.js for Cloudflare compatibility
// Uses patched subscribe.js that accepts filter types 1 and 2

import { Mutex } from "async-mutex";
import { Fetch, FetchCancel, FetchError, FetchOk } from "../ietf/fetch.js";
import { GoAway } from "../ietf/goaway.js";
import { Publish, PublishError, PublishOk } from "../ietf/publish.js";
import { PublishNamespace, PublishNamespaceCancel, PublishNamespaceDone, PublishNamespaceError, PublishNamespaceOk } from "../ietf/publish_namespace.js";
import { MaxRequestId, RequestsBlocked } from "../ietf/request.js";
import * as Setup from "../ietf/setup.js";
// PATCHED: Use patched subscribe.js that accepts filter types 1 and 2
import { PublishDone, Subscribe, SubscribeError, SubscribeOk, Unsubscribe } from "./subscribe.js";
import { SubscribeNamespace, SubscribeNamespaceError, SubscribeNamespaceOk, UnsubscribeNamespace } from "../ietf/subscribe_namespace.js";
import { TrackStatus, TrackStatusRequest } from "../ietf/track.js";

/**
 * Control message types as defined in moq-transport-14
 */
const Messages = {
    [Setup.ClientSetup.id]: Setup.ClientSetup,
    [Setup.ServerSetup.id]: Setup.ServerSetup,
    [Subscribe.id]: Subscribe,
    [SubscribeOk.id]: SubscribeOk,
    [SubscribeError.id]: SubscribeError,
    [PublishNamespace.id]: PublishNamespace,
    [PublishNamespaceOk.id]: PublishNamespaceOk,
    [PublishNamespaceError.id]: PublishNamespaceError,
    [PublishNamespaceDone.id]: PublishNamespaceDone,
    [Unsubscribe.id]: Unsubscribe,
    [PublishDone.id]: PublishDone,
    [PublishNamespaceCancel.id]: PublishNamespaceCancel,
    [TrackStatusRequest.id]: TrackStatusRequest,
    [TrackStatus.id]: TrackStatus,
    [GoAway.id]: GoAway,
    [Fetch.id]: Fetch,
    [FetchCancel.id]: FetchCancel,
    [FetchOk.id]: FetchOk,
    [FetchError.id]: FetchError,
    [SubscribeNamespace.id]: SubscribeNamespace,
    [SubscribeNamespaceOk.id]: SubscribeNamespaceOk,
    [SubscribeNamespaceError.id]: SubscribeNamespaceError,
    [UnsubscribeNamespace.id]: UnsubscribeNamespace,
    [Publish.id]: Publish,
    [PublishOk.id]: PublishOk,
    [PublishError.id]: PublishError,
    [MaxRequestId.id]: MaxRequestId,
    [RequestsBlocked.id]: RequestsBlocked,
};

export class Stream {
    stream;
    #requestId = 0;
    #writeLock = new Mutex();
    #readLock = new Mutex();

    constructor(stream) {
        this.stream = stream;
    }

    async write(message) {
        console.log("[MOQ CF CTRL] write:", message.constructor.name, "id=0x" + message.constructor.id.toString(16));
        await this.#writeLock.runExclusive(async () => {
            await this.stream.writer.u53(message.constructor.id);
            await message.encode(this.stream.writer);
        });
    }

    async read() {
        return await this.#readLock.runExclusive(async () => {
            const messageType = await this.stream.reader.u53();
            console.log("[MOQ CF CTRL] read: messageType=0x" + messageType.toString(16));
            if (!(messageType in Messages)) {
                throw new Error(`Unknown control message type: ${messageType}`);
            }
            try {
                const msg = await Messages[messageType].decode(this.stream.reader);
                console.log("[MOQ CF CTRL] decoded:", msg.constructor.name);
                return msg;
            } catch (err) {
                console.error("failed to decode message", messageType, err);
                throw err;
            }
        });
    }

    requestId() {
        const id = this.#requestId;
        this.#requestId += 2;
        return id;
    }
}
