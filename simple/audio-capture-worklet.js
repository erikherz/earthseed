// Audio capture worklet — the Safari/iOS path.
//
// Safari has no MediaStreamTrackProcessor, so we pull PCM off the audio graph ourselves and
// hand each block back to earthseed.js, which wraps it in an AudioData and encodes it. The
// node is deliberately NOT connected to the destination, so there is no local echo.
//
// This lives in a real file rather than a blob: URL so that `script-src` can stay strict.
// Allowing blob: in script-src to accommodate one 130-byte worklet would hand back most of
// what the policy is there to prevent, since blob: is a favourite sink for injected code.
//
// It sends the channel data by copy (`slice(0)`): the buffer the worklet is given is reused
// on the next render quantum, so posting it directly would hand over memory that is about to
// be overwritten.

class Cap extends AudioWorkletProcessor {
  /** @param {Float32Array[][]} inputs */
  process(inputs) {
    const channels = inputs[0];
    if (channels && channels[0]) this.port.postMessage(channels[0].slice(0));
    return true;
  }
}

registerProcessor("es-cap", Cap);
