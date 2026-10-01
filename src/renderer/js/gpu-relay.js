/**
 * GPU encoding for screen shares.
 *
 * Chromium never hands a screen capture track to the hardware video encoder:
 * measured on a Radeon RX 7600 (Electron 33), a screen track sent as H.264
 * always used OpenH264 on the CPU, while the same frames coming from a canvas
 * used the GPU (MediaFoundationVideoEncodeAccelerator). Sending to 3 viewers
 * at 1080p, the GPU path held 57 fps at ~16% CPU; the CPU path did not keep
 * up (VP8 sat near 70% CPU at a few fps).
 *
 * So the share is relayed: the capture's frames are copied, in a worker, onto
 * GPU-backed frames of a MediaStreamTrackGenerator, and that track is what the
 * peers receive. webrtc.js prefers H.264 on the screen m-line (the codec GPUs
 * encode), checks with getStats() that the GPU is actually in use, and sends
 * the capture directly again if it is not.
 */
class GpuScreenRelay {
  static isSupported() {
    return typeof MediaStreamTrackProcessor === 'function' &&
      typeof MediaStreamTrackGenerator === 'function' &&
      typeof OffscreenCanvas === 'function' &&
      typeof VideoFrame === 'function' &&
      typeof Worker === 'function';
  }

  /**
   * @param track the screen capture track; the relay works on a clone, so
   *   stopping it never ends the capture
   */
  constructor(track) {
    this.source = track.clone();
    const processor = new MediaStreamTrackProcessor({ track: this.source });
    this.track = new MediaStreamTrackGenerator({ kind: 'video' });
    this.worker = new Worker('js/gpu-relay-worker.js');
    this.worker.onmessage = ({ data }) => {
      if (data && data.error) console.warn('[GpuRelay] Frame copy stopped:', data.error);
    };
    this.worker.onerror = (e) => console.warn('[GpuRelay] Worker error:', e.message);
    this.worker.postMessage(
      { readable: processor.readable, writable: this.track.writable },
      [processor.readable, this.track.writable]
    );
  }

  stop() {
    this.worker.terminate();
    this.track.stop();
    this.source.stop();
  }
}

window.GpuScreenRelay = GpuScreenRelay;
