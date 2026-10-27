/**
 * RNNoise noise suppression for a microphone stream.
 *
 *   raw mic -> AudioContext (48 kHz) -> RNNoise AudioWorklet -> MediaStream
 *
 * The raw stream must be captured with the browser's own noiseSuppression off,
 * otherwise RNNoise receives audio that was already filtered.
 */

const RNNOISE_SAMPLE_RATE = 48000;
const RNNOISE_READY_TIMEOUT_MS = 5000;

class RNNoiseSuppressor {
  static isSupported() {
    return typeof AudioWorkletNode !== 'undefined' && typeof WebAssembly === 'object';
  }

  static async create(rawStream) {
    const context = new AudioContext({ sampleRate: RNNOISE_SAMPLE_RATE });

    try {
      const moduleUrl = new URL('js/rnnoise/rnnoise-processor.js', document.baseURI).href;
      await context.audioWorklet.addModule(moduleUrl);

      const node = new AudioWorkletNode(context, 'rnnoise-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers'
      });

      const source = context.createMediaStreamSource(rawStream);
      const destination = context.createMediaStreamDestination();
      destination.channelCount = 1;

      source.connect(node);
      node.connect(destination);

      // Not awaited: resume() never settles if autoplay policy blocks it
      context.resume().catch(() => {});
      await waitForProcessorReady(node);

      if (context.state !== 'running') {
        throw new Error(`AudioContext is ${context.state}`);
      }

      return new RNNoiseSuppressor(context, source, node, destination);
    } catch (err) {
      context.close().catch(() => {});
      throw err;
    }
  }

  constructor(context, source, node, destination) {
    this.context = context;
    this.source = source;
    this.node = node;
    this.destination = destination;
    this.stream = destination.stream;
  }

  destroy() {
    try { this.node.port.postMessage({ type: 'destroy' }); } catch (e) {}
    try { this.source.disconnect(); } catch (e) {}
    try { this.node.disconnect(); } catch (e) {}
    this.stream.getTracks().forEach(t => t.stop());
    if (this.context.state !== 'closed') {
      this.context.close().catch(() => {});
    }
  }
}

function waitForProcessorReady(node) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('RNNoise worklet did not start in time'));
    }, RNNOISE_READY_TIMEOUT_MS);

    node.onprocessorerror = () => {
      clearTimeout(timer);
      reject(new Error('RNNoise worklet failed to start'));
    };

    node.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === 'ready') {
        clearTimeout(timer);
        resolve();
      } else if (data.type === 'error') {
        clearTimeout(timer);
        reject(new Error(data.message));
      }
    };
  });
}

function sanitizeAudioConstraints(constraints = {}) {
  const clean = { ...constraints };
  if (clean.deviceId) {
    const devId = typeof clean.deviceId === 'object' ? clean.deviceId.exact : clean.deviceId;
    if (!devId || devId === 'default' || devId === 'communications') {
      delete clean.deviceId;
    } else {
      clean.deviceId = { exact: devId };
    }
  }
  return clean;
}

/**
 * Capture a microphone with noise suppression, preferring RNNoise and falling
 * back to the browser's built-in suppressor if RNNoise cannot start.
 * Resolves to { stream, mode, release } — mode is 'rnnoise', 'native' or 'off'.
 */
async function captureMicrophone(audioConstraints = {}, noiseSuppression = true) {
  const cleanConstraints = sanitizeAudioConstraints(audioConstraints);
  const useRnnoise = noiseSuppression && RNNoiseSuppressor.isSupported();

  let raw;
  try {
    raw = await navigator.mediaDevices.getUserMedia({
      audio: { ...cleanConstraints, noiseSuppression: noiseSuppression && !useRnnoise },
      video: false
    });
  } catch (err) {
    // If constrained capture failed on mobile, retry with pure audio: true
    console.warn('[Microphone] Initial capture failed, retrying with standard constraints:', err);
    raw = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  }

  const stopRaw = () => raw.getTracks().forEach(t => t.stop());

  if (!useRnnoise) {
    return { stream: raw, mode: noiseSuppression ? 'native' : 'off', release: stopRaw };
  }

  try {
    const suppressor = await RNNoiseSuppressor.create(raw);
    return {
      stream: suppressor.stream,
      mode: 'rnnoise',
      release: () => {
        suppressor.destroy();
        stopRaw();
      }
    };
  } catch (err) {
    console.warn('[RNNoise] Unavailable, falling back to native noise suppression:', err);
    stopRaw();
    try {
      const native = await navigator.mediaDevices.getUserMedia({
        audio: { ...cleanConstraints, noiseSuppression: true },
        video: false
      });
      return {
        stream: native,
        mode: 'native',
        release: () => native.getTracks().forEach(t => t.stop())
      };
    } catch (e2) {
      const basic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      return {
        stream: basic,
        mode: 'native',
        release: () => basic.getTracks().forEach(t => t.stop())
      };
    }
  }
}

window.RNNoiseSuppressor = RNNoiseSuppressor;
window.captureMicrophone = captureMicrophone;
window.sanitizeAudioConstraints = sanitizeAudioConstraints;

