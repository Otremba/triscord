/**
 * System audio for screen sharing, captured by the native loopback helper
 * with this app's own audio excluded (no call voices echoed back).
 * Only available in the Electron desktop app on Windows.
 */

class SystemAudioCapture {
  static isSupported() {
    return !!(window.electronAPI && window.electronAPI.startSystemAudio);
  }

  static async start() {
    const context = new AudioContext({ sampleRate: 48000 });
    let unsubscribe = null;

    try {
      const moduleUrl = new URL('js/system-audio-processor.js', document.baseURI).href;
      await context.audioWorklet.addModule(moduleUrl);

      const node = new AudioWorkletNode(context, 'system-audio-processor', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      });
      const destination = context.createMediaStreamDestination();
      node.connect(destination);

      unsubscribe = window.electronAPI.onSystemAudioData((chunk) => {
        // Copy into a fresh, aligned buffer we can transfer to the worklet
        const bytes = new Uint8Array(chunk.byteLength & ~1);
        bytes.set(new Uint8Array(chunk.buffer, chunk.byteOffset, bytes.byteLength));
        node.port.postMessage(bytes.buffer, [bytes.buffer]);
      });

      const result = await window.electronAPI.startSystemAudio();
      if (!result || !result.ok) {
        throw new Error((result && result.error) || 'system audio capture failed');
      }

      context.resume().catch(() => {});
      return new SystemAudioCapture(context, destination, unsubscribe);
    } catch (err) {
      if (unsubscribe) unsubscribe();
      window.electronAPI.stopSystemAudio().catch(() => {});
      context.close().catch(() => {});
      throw err;
    }
  }

  constructor(context, destination, unsubscribe) {
    this.context = context;
    this.stream = destination.stream;
    this.unsubscribe = unsubscribe;
  }

  stop() {
    this.unsubscribe();
    window.electronAPI.stopSystemAudio().catch(() => {});
    this.stream.getTracks().forEach(t => t.stop());
    if (this.context.state !== 'closed') this.context.close().catch(() => {});
  }
}

window.SystemAudioCapture = SystemAudioCapture;
