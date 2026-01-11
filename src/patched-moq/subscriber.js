// Patched subscriber.js with debug logging

import { Announced } from "../announced.js";
import { Broadcast } from "../broadcast.js";
import { Group } from "../group.js";
import * as Path from "../path.js";
import { error } from "../util/error.js";
// PATCHED: Use patched object.js with debug logging
import { Frame } from "./object.js";
// Use patched subscribe.js
import { Subscribe, Unsubscribe } from "./subscribe.js";
import { SubscribeNamespace, UnsubscribeNamespace } from "../ietf/subscribe_namespace.js";

export class Subscriber {
    #control;
    #announced = new Set();
    #announcedConsumers = new Set();
    #subscribes = new Map();
    #subscribeCallbacks = new Map();

    constructor(control) {
        this.#control = control;
    }

    announced(prefix = Path.empty()) {
        const announced = new Announced(prefix);
        for (const active of this.#announced) {
            if (!active.startsWith(prefix)) continue;
            announced.append({ path: active, active: true });
        }
        const requestId = this.#control.requestId();
        this.#control.write(new SubscribeNamespace(prefix, requestId));
        this.#announcedConsumers.add(announced);
        announced.closed.finally(() => {
            this.#announcedConsumers.delete(announced);
            this.#control.write(new UnsubscribeNamespace(requestId));
        });
        return announced;
    }

    consume(path) {
        const broadcast = new Broadcast();
        (async () => {
            for (;;) {
                const request = await broadcast.requested();
                if (!request) break;
                this.#runSubscribe(path, request);
            }
        })();
        return broadcast;
    }

    async #runSubscribe(broadcast, request) {
        const requestId = this.#control.requestId();
        console.log("[MOQ CF SUB] Subscribing - requestId:", requestId, "track:", request.track.name);
        this.#subscribes.set(requestId, request.track);
        const msg = new Subscribe(requestId, broadcast, request.track.name, request.priority);
        const responsePromise = new Promise((resolve, reject) => {
            this.#subscribeCallbacks.set(requestId, { resolve, reject });
        });
        await this.#control.write(msg);
        try {
            await responsePromise;
            console.log("[MOQ CF SUB] Subscribe OK for requestId:", requestId);
            await request.track.closed;
            const msg = new Unsubscribe(requestId);
            await this.#control.write(msg);
        } catch (err) {
            const e = error(err);
            request.track.close(e);
        } finally {
            this.#subscribes.delete(requestId);
            this.#subscribeCallbacks.delete(requestId);
        }
    }

    async handleSubscribeOk(msg) {
        console.log("[MOQ CF SUB] handleSubscribeOk - requestId:", msg.requestId);
        const callback = this.#subscribeCallbacks.get(msg.requestId);
        if (callback) {
            callback.resolve(msg);
        } else {
            console.warn("[MOQ CF SUB] No callback for requestId:", msg.requestId);
        }
    }

    async handleSubscribeError(msg) {
        console.log("[MOQ CF SUB] handleSubscribeError - requestId:", msg.requestId, "code:", msg.errorCode);
        const callback = this.#subscribeCallbacks.get(msg.requestId);
        if (callback) {
            callback.reject(new Error(`SUBSCRIBE_ERROR: code=${msg.errorCode} reason=${msg.reasonPhrase}`));
        }
    }

    async handleGroup(group, stream) {
        console.log("[MOQ CF SUB] handleGroup - requestId:", group.requestId, "groupId:", group.groupId);
        console.log("[MOQ CF SUB] Active subscriptions:", [...this.#subscribes.keys()]);

        const producer = new Group(group.groupId);
        try {
            const track = this.#subscribes.get(group.requestId);
            if (!track) {
                console.error("[MOQ CF SUB] Unknown track for requestId:", group.requestId);
                throw new Error(`unknown track: requestId=${group.requestId}`);
            }
            console.log("[MOQ CF SUB] Found track:", track.name);
            track.writeGroup(producer);

            for (;;) {
                const done = await Promise.race([stream.done(), producer.closed, track.closed]);
                if (done !== false) break;
                console.log("[MOQ CF SUB] Reading frame...");
                const frame = await Frame.decode(stream, group.flags);
                if (frame.payload === undefined) break;
                console.log("[MOQ CF SUB] Frame received, size:", frame.payload.byteLength);
                producer.writeFrame(frame.payload);
            }
            console.log("[MOQ CF SUB] Group complete");
            producer.close();
        } catch (err) {
            console.error("[MOQ CF SUB] Error in handleGroup:", err);
            const e = error(err);
            producer.close(e);
            stream.stop(e);
        }
    }

    async handlePublishDone(msg) {
        const callback = this.#subscribeCallbacks.get(msg.requestId);
        if (callback) {
            callback.reject(new Error(`PUBLISH_DONE: code=${msg.statusCode} reason=${msg.reasonPhrase}`));
        }
    }

    async handlePublishNamespace(msg) {
        if (this.#announced.has(msg.trackNamespace)) {
            console.warn("duplicate PUBLISH_NAMESPACE message");
            return;
        }
        this.#announced.add(msg.trackNamespace);
        for (const consumer of this.#announcedConsumers) {
            consumer.append({ path: msg.trackNamespace, active: true });
        }
    }

    async handlePublishNamespaceDone(msg) {
        if (!this.#announced.has(msg.trackNamespace)) {
            console.warn("unknown PUBLISH_NAMESPACE_DONE message");
            return;
        }
        this.#announced.delete(msg.trackNamespace);
        for (const consumer of this.#announcedConsumers) {
            consumer.append({ path: msg.trackNamespace, active: false });
        }
    }

    async handleSubscribeNamespaceOk(_msg) {}

    async handleSubscribeNamespaceError(_msg) {
        throw new Error("SUBSCRIBE_NAMESPACE_ERROR messages are not supported");
    }

    async handleTrackStatus(_msg) {
        throw new Error("TRACK_STATUS messages are not supported");
    }
}
