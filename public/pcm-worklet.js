// AudioWorklet: convert each Float32 audio frame into Int16 PCM and ship
// the underlying buffer to the main thread (zero-copy via transfer).
class PCM16Worklet extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    const pcm = new Int16Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      let s = ch[i];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      pcm[i] = s < 0 ? (s * 0x8000) | 0 : (s * 0x7fff) | 0;
    }
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
    return true;
  }
}
registerProcessor('pcm16', PCM16Worklet);
