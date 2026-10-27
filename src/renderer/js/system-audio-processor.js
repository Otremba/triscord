/**
 * AudioWorklet that turns the loopback helper's PCM chunks (48 kHz, stereo,
 * interleaved int16) into a continuous audio stream.
 *
 * Chunks arrive in bursts over IPC and stop entirely while the PC is silent,
 * so this is a jitter buffer: it waits for TARGET frames before playing,
 * re-primes after running dry, and drops the oldest audio if it falls too far
 * behind (e.g. clock drift or a stalled tab catching up).
 */

const CAPACITY = 48000;        // 1 s
const TARGET = 48 * 40;        // 40 ms of buffering before playback
const MAX_BACKLOG = 48 * 200;  // above 200 ms, skip ahead to TARGET

class SystemAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.left = new Float32Array(CAPACITY);
    this.right = new Float32Array(CAPACITY);
    this.readIndex = 0;
    this.writeIndex = 0;
    this.available = 0;
    this.playing = false;

    this.port.onmessage = (event) => this.push(new Int16Array(event.data));
  }

  push(samples) {
    const frames = samples.length >> 1;
    for (let i = 0; i < frames; i++) {
      this.left[this.writeIndex] = samples[2 * i] / 32768;
      this.right[this.writeIndex] = samples[2 * i + 1] / 32768;
      this.writeIndex = (this.writeIndex + 1) % CAPACITY;
    }
    this.available += frames;

    if (this.available > MAX_BACKLOG) {
      const skip = this.available - TARGET;
      this.readIndex = (this.readIndex + skip) % CAPACITY;
      this.available = TARGET;
    }
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const outLeft = output[0];
    const outRight = output[1] || output[0];
    if (!outLeft) return true;

    if (!this.playing && this.available >= TARGET) this.playing = true;

    for (let i = 0; i < outLeft.length; i++) {
      if (this.playing && this.available > 0) {
        outLeft[i] = this.left[this.readIndex];
        outRight[i] = this.right[this.readIndex];
        this.readIndex = (this.readIndex + 1) % CAPACITY;
        this.available--;
      } else {
        outLeft[i] = 0;
        outRight[i] = 0;
        this.playing = false;
      }
    }

    return true;
  }
}

registerProcessor('system-audio-processor', SystemAudioProcessor);
