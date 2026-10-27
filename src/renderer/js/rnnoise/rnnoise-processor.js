/**
 * AudioWorklet processor that runs RNNoise (WebAssembly) on the microphone.
 *
 * The worklet hands us 128-sample render quanta, but RNNoise only accepts
 * 480-sample frames (10 ms at 48 kHz). Input is accumulated into frames, each
 * frame is denoised in place in the WASM heap, and the result is drained from
 * an output FIFO.
 */

import createRNNWasmModuleSync from './rnnoise-sync.js';

const FRAME_SIZE = 480;
const QUANTUM = 128;
// RNNoise works on float samples in 16-bit PCM range, not [-1, 1]
const PCM_SCALE = 32768;
// 128 and 480 share a factor of 32, so a frame can end up to 448 samples after
// the quantum that needs it. Starting the FIFO 512 samples deep (4 quanta,
// ~10.7 ms) guarantees it never runs dry.
const PRIMING = 4 * QUANTUM;
const FIFO_SIZE = 2048;

class RNNoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    try {
      this.wasm = createRNNWasmModuleSync();
      this.denoiseState = this.wasm._rnnoise_create();
      this.framePtr = this.wasm._malloc(FRAME_SIZE * Float32Array.BYTES_PER_ELEMENT);
      this.frameIndex = this.framePtr / Float32Array.BYTES_PER_ELEMENT;
    } catch (err) {
      this.port.postMessage({ type: 'error', message: String(err && err.message || err) });
      throw err;
    }

    this.frameFill = 0;

    this.fifo = new Float32Array(FIFO_SIZE);
    this.fifoRead = 0;
    this.fifoWrite = PRIMING;
    this.fifoCount = PRIMING;

    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'destroy') this.destroy();
    };

    this.port.postMessage({ type: 'ready' });
  }

  destroy() {
    if (!this.wasm) return;
    this.wasm._rnnoise_destroy(this.denoiseState);
    this.wasm._free(this.framePtr);
    this.wasm = null;
  }

  denoiseFrame() {
    // HEAPF32 is re-read every frame: it is replaced if the WASM memory grows
    const heap = this.wasm.HEAPF32;
    this.wasm._rnnoise_process_frame(this.denoiseState, this.framePtr, this.framePtr);

    for (let i = 0; i < FRAME_SIZE; i++) {
      this.fifo[this.fifoWrite] = heap[this.frameIndex + i] / PCM_SCALE;
      this.fifoWrite = (this.fifoWrite + 1) % FIFO_SIZE;
    }
    this.fifoCount += FRAME_SIZE;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const outChannel = output[0];
    if (!outChannel) return true;

    const input = inputs[0];
    const inChannel = input && input[0];

    if (!this.wasm) {
      outChannel.fill(0);
      return false;
    }

    // A disconnected input still counts as silence so input and output keep
    // advancing in lockstep and the FIFO stays primed
    const inputLength = inChannel ? inChannel.length : outChannel.length;
    let heap = this.wasm.HEAPF32;
    for (let i = 0; i < inputLength; i++) {
      heap[this.frameIndex + this.frameFill] = inChannel ? inChannel[i] * PCM_SCALE : 0;
      this.frameFill++;

      if (this.frameFill === FRAME_SIZE) {
        this.denoiseFrame();
        this.frameFill = 0;
        heap = this.wasm.HEAPF32;
      }
    }

    for (let i = 0; i < outChannel.length; i++) {
      if (this.fifoCount > 0) {
        outChannel[i] = this.fifo[this.fifoRead];
        this.fifoRead = (this.fifoRead + 1) % FIFO_SIZE;
        this.fifoCount--;
      } else {
        outChannel[i] = 0;
      }
    }

    for (let c = 1; c < output.length; c++) {
      output[c].set(outChannel);
    }

    return true;
  }
}

registerProcessor('rnnoise-processor', RNNoiseProcessor);
