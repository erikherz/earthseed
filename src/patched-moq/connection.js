// Patched connection.js for Cloudflare compatibility
// Key difference: Does NOT send MaxRequestId after handshake (moq-rs doesn't support it)

import * as Path from "../path.js";
import { Readers } from "../stream.js";
import { unreachable } from "../util/index.js";
// PATCHED: Use patched control.js that uses patched subscribe.js
import * as Control from "./control.js";
import { Fetch, FetchCancel, FetchError, FetchOk } from "../ietf/fetch.js";
import { GoAway } from "../ietf/goaway.js";
// PATCHED: Use patched object.js with debug logging
import { Group } from "./object.js";
import { Publish, PublishError, PublishOk } from "../ietf/publish.js";
import { PublishNamespace, PublishNamespaceCancel, PublishNamespaceDone, PublishNamespaceError, PublishNamespaceOk } from "../ietf/publish_namespace.js";
import { Publisher } from "../ietf/publisher.js";
import { MaxRequestId, RequestsBlocked } from "../ietf/request.js";
import * as Setup from "../ietf/setup.js";
// PATCHED: Use patched subscribe.js that accepts filter types 1 and 2
import { PublishDone, Subscribe, SubscribeError, SubscribeOk, Unsubscribe } from "./subscribe.js";
import { SubscribeNamespace, SubscribeNamespaceError, SubscribeNamespaceOk, UnsubscribeNamespace } from "../ietf/subscribe_namespace.js";
// PATCHED: Use patched subscriber.js with debug logging
import { Subscriber } from "./subscriber.js";
import { TrackStatus, TrackStatusRequest } from "../ietf/track.js";

/**
 * Cloudflare-compatible Connection that doesn't send MaxRequestId
 * (moq-rs doesn't support the MAX_REQUEST_ID control message - it's sent as a setup parameter instead)
 */
export class Connection {
    url;
    #quic;
    #control;
    #publisher;
    #subscriber;

    constructor(url, quic, control) {
        this.url = url;
        this.#quic = quic;
        this.#control = new Control.Stream(control);
        this.#publisher = new Publisher(this.#quic, this.#control);
        this.#subscriber = new Subscriber(this.#control);
        void this.#run();
    }

    close() {
        try {
            this.#quic.close();
        } catch {
            // ignore
        }
    }

    async #run() {
        // PATCHED: Do NOT send MaxRequestId - moq-rs doesn't support it as a control message
        // Cloudflare already sends MAX_REQUEST_ID as setup param (id=2)
        console.log("[MOQ CF] Skipping MaxRequestId message (not supported by moq-rs)");

        const controlMessages = this.#runControlStream();
        const objectStreams = this.#runObjectStreams();
        try {
            await Promise.all([controlMessages, objectStreams]);
        } catch (err) {
            console.error("fatal error running connection", err);
        } finally {
            this.close();
        }
    }

    publish(path, broadcast) {
        console.log("[MOQ CF] publish() called with path:", path);
        this.#publisher.publish(path, broadcast);
    }

    announced(prefix = Path.empty()) {
        console.log("[MOQ CF] announced() called with prefix:", prefix);
        return this.#subscriber.announced(prefix);
    }

    consume(broadcast) {
        console.log("[MOQ CF] consume() called with broadcast:", broadcast);
        return this.#subscriber.consume(broadcast);
    }

    async #runControlStream() {
        for (;;) {
            try {
                const msg = await this.#control.read();
                if (msg instanceof Subscribe) {
                    await this.#publisher.handleSubscribe(msg);
                } else if (msg instanceof Unsubscribe) {
                    await this.#publisher.handleUnsubscribe(msg);
                } else if (msg instanceof TrackStatusRequest) {
                    await this.#publisher.handleTrackStatusRequest(msg);
                } else if (msg instanceof PublishNamespaceOk) {
                    await this.#publisher.handlePublishNamespaceOk(msg);
                } else if (msg instanceof PublishNamespaceError) {
                    await this.#publisher.handlePublishNamespaceError(msg);
                } else if (msg instanceof PublishNamespaceCancel) {
                    await this.#publisher.handlePublishNamespaceCancel(msg);
                } else if (msg instanceof PublishNamespace) {
                    await this.#subscriber.handlePublishNamespace(msg);
                } else if (msg instanceof PublishNamespaceDone) {
                    await this.#subscriber.handlePublishNamespaceDone(msg);
                } else if (msg instanceof SubscribeOk) {
                    await this.#subscriber.handleSubscribeOk(msg);
                } else if (msg instanceof SubscribeError) {
                    await this.#subscriber.handleSubscribeError(msg);
                } else if (msg instanceof PublishDone) {
                    await this.#subscriber.handlePublishDone(msg);
                } else if (msg instanceof TrackStatus) {
                    await this.#subscriber.handleTrackStatus(msg);
                } else if (msg instanceof GoAway) {
                    await this.#handleGoAway(msg);
                } else if (msg instanceof Setup.ClientSetup) {
                    await this.#handleClientSetup(msg);
                } else if (msg instanceof Setup.ServerSetup) {
                    await this.#handleServerSetup(msg);
                } else if (msg instanceof SubscribeNamespace) {
                    await this.#publisher.handleSubscribeNamespace(msg);
                } else if (msg instanceof SubscribeNamespaceOk) {
                    await this.#subscriber.handleSubscribeNamespaceOk(msg);
                } else if (msg instanceof SubscribeNamespaceError) {
                    await this.#subscriber.handleSubscribeNamespaceError(msg);
                } else if (msg instanceof UnsubscribeNamespace) {
                    await this.#publisher.handleUnsubscribeNamespace(msg);
                } else if (msg instanceof Publish) {
                    throw new Error("PUBLISH messages are not supported");
                } else if (msg instanceof PublishOk) {
                    throw new Error("PUBLISH_OK messages are not supported");
                } else if (msg instanceof PublishError) {
                    throw new Error("PUBLISH_ERROR messages are not supported");
                } else if (msg instanceof Fetch) {
                    throw new Error("FETCH messages are not supported");
                } else if (msg instanceof FetchOk) {
                    throw new Error("FETCH_OK messages are not supported");
                } else if (msg instanceof FetchError) {
                    throw new Error("FETCH_ERROR messages are not supported");
                } else if (msg instanceof FetchCancel) {
                    throw new Error("FETCH_CANCEL messages are not supported");
                } else if (msg instanceof MaxRequestId) {
                    console.warn("ignoring MAX_REQUEST_ID message");
                } else if (msg instanceof RequestsBlocked) {
                    console.warn("ignoring REQUESTS_BLOCKED message");
                } else {
                    unreachable(msg);
                }
            } catch (err) {
                console.error("error processing control message", err);
                break;
            }
        }
        console.warn("control stream closed");
    }

    async #handleGoAway(msg) {
        console.warn(`Received GOAWAY with redirect URI: ${msg.newSessionUri}`);
        this.close();
    }

    async #handleClientSetup(_msg) {
        console.error("Unexpected CLIENT_SETUP message received after connection established");
        this.close();
    }

    async #handleServerSetup(_msg) {
        console.error("Unexpected SERVER_SETUP message received after connection established");
        this.close();
    }

    async #runObjectStreams() {
        console.log("[MOQ CF] Starting object stream reader");
        const readers = new Readers(this.#quic);
        for (;;) {
            const stream = await readers.next();
            if (!stream) {
                console.log("[MOQ CF] Object stream reader ended");
                break;
            }
            console.log("[MOQ CF] Received new object stream");
            this.#runObjectStream(stream)
                .then(() => {
                    stream.stop(new Error("cancel"));
                })
                .catch((err) => {
                    stream.stop(err);
                });
        }
    }

    async #runObjectStream(stream) {
        try {
            console.log("[MOQ CF] Decoding object stream header...");
            const header = await Group.decode(stream);
            console.log("[MOQ CF] Object stream header - requestId:", header.requestId, "groupId:", header.groupId, "flags:", header.flags);
            console.log("[MOQ CF] Calling subscriber.handleGroup...");
            await this.#subscriber.handleGroup(header, stream);
            console.log("[MOQ CF] handleGroup completed");
        } catch (err) {
            console.error("[MOQ CF] error processing object stream", err);
        }
    }

    get closed() {
        return this.#quic.closed.then(() => undefined);
    }
}
