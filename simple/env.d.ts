// Dev-only ambient types (NOT shipped) so `tsc --checkJs` is clean; the runtime types are the browser's.

// MediaStreamTrackProcessor is a real, shipping Chromium API but not yet in TS's DOM lib.
declare class MediaStreamTrackProcessor<T = VideoFrame> {
  constructor(init: { track: MediaStreamTrack; maxBufferSize?: number });
  readonly readable: ReadableStream<T>;
}
