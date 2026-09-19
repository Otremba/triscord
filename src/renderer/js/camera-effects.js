/**
 * Camera background effects (blur / custom image), Google Meet style.
 *
 *   camera track -> MediaStreamTrackProcessor -> per-frame compose -> MediaStreamTrackGenerator
 *
 * Each frame is segmented by MediaPipe Selfie Segmentation on a 256x144 copy
 * (fast, ~5 ms on GPU), the person mask is smoothed over time to avoid
 * flicker, and the person is drawn over a blurred copy of the frame or an
 * image. Frames are driven by the camera itself, so processing keeps going
 * when the window is minimized (requestAnimationFrame would stall).
 *
 * Effects: { type: 'none' } | { type: 'blur-light' } | { type: 'blur-strong' }
 *          | { type: 'image', image: <data URL> }
 */

const MEDIAPIPE_DIR = 'js/vendor/mediapipe/';
const MASK_WIDTH = 256;
const MASK_HEIGHT = 144;
// Background blur is rendered at 1/4 resolution then scaled up: same look, far cheaper
const BLUR_DOWNSCALE = 4;
const BLUR_RADIUS = { 'blur-light': 2.5, 'blur-strong': 7 };
// Temporal smoothing of the mask: higher keeps more of the previous frame
const MASK_SMOOTHING = 0.4;
// Confidence ramp that becomes the person's alpha: below LOW is background,
// above HIGH is person, in between is a soft edge
const MASK_LOW = 0.3;
const MASK_HIGH = 0.7;
// Edge feather as a fraction of the frame width (~3 px at 1280)
const MASK_FEATHER = 0.0025;

let segmenterPromise = null;
let lastSegmentTimestamp = 0;

function loadSegmenter() {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const base = new URL(MEDIAPIPE_DIR, document.baseURI).href;
      const vision = await import(base + 'vision_bundle.mjs');
      const fileset = {
        wasmLoaderPath: base + 'vision_wasm_internal.js',
        wasmBinaryPath: base + 'vision_wasm_internal.wasm'
      };
      const options = (delegate) => ({
        baseOptions: { modelAssetPath: base + 'selfie_segmenter_landscape.tflite', delegate },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false
      });

      try {
        return await vision.ImageSegmenter.createFromOptions(fileset, options('GPU'));
      } catch (err) {
        console.warn('[CameraEffects] GPU segmentation unavailable, using CPU:', err);
        return vision.ImageSegmenter.createFromOptions(fileset, options('CPU'));
      }
    })();
    // Allow a retry after a failed load
    segmenterPromise.catch(() => { segmenterPromise = null; });
  }
  return segmenterPromise;
}

// VIDEO mode requires strictly increasing timestamps across every call
function nextSegmentTimestamp() {
  lastSegmentTimestamp = Math.max(performance.now(), lastSegmentTimestamp + 1);
  return lastSegmentTimestamp;
}

async function loadBackgroundImage(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

class CameraEffectsProcessor {
  static isSupported() {
    return typeof MediaStreamTrackProcessor === 'function' &&
      typeof MediaStreamTrackGenerator === 'function' &&
      typeof OffscreenCanvas === 'function';
  }

  static async create(sourceTrack, effect) {
    if (!CameraEffectsProcessor.isSupported()) {
      throw new Error('camera effects are not supported in this browser');
    }
    const segmenter = await loadSegmenter();
    const processor = new CameraEffectsProcessor(sourceTrack, segmenter);
    await processor.setEffect(effect);
    processor.start();
    return processor;
  }

  constructor(sourceTrack, segmenter) {
    this.sourceTrack = sourceTrack;
    this.segmenter = segmenter;
    this.effect = { type: 'none' };
    this.effectVersion = 0;
    this.backgroundImage = null;

    this.generator = new MediaStreamTrackGenerator({ kind: 'video' });
    this.generator.contentHint = 'motion';
    this.stream = new MediaStream([this.generator]);

    this.segCanvas = new OffscreenCanvas(MASK_WIDTH, MASK_HEIGHT);
    this.segCtx = this.segCanvas.getContext('2d', { willReadFrequently: false });

    this.maskCanvas = new OffscreenCanvas(MASK_WIDTH, MASK_HEIGHT);
    this.maskCtx = this.maskCanvas.getContext('2d');
    this.maskImage = this.maskCtx.createImageData(MASK_WIDTH, MASK_HEIGHT);
    this.smoothedMask = null;

    this.paddedMaskCanvas = new OffscreenCanvas(MASK_WIDTH + 2, MASK_HEIGHT + 2);
    this.paddedMaskCtx = this.paddedMaskCanvas.getContext('2d');

    this.outCanvas = null;
    this.outCtx = null;
    this.blurCanvas = null;
    this.blurCtx = null;
  }

  async setEffect(effect) {
    const version = ++this.effectVersion;
    let image = null;
    if (effect.type === 'image') image = await loadBackgroundImage(effect.image);

    // A newer call finished first: keep its result
    if (version !== this.effectVersion) {
      if (image) image.close();
      return;
    }

    if (this.backgroundImage) this.backgroundImage.close();
    this.backgroundImage = image;
    this.effect = effect;
  }

  start() {
    this.abortController = new AbortController();
    const { signal } = this.abortController;
    const reader = new MediaStreamTrackProcessor({ track: this.sourceTrack }).readable;

    const transformer = new TransformStream({
      transform: (frame, controller) => {
        if (this.effect.type === 'none') {
          controller.enqueue(frame);
          return;
        }
        let output = null;
        try {
          output = this.render(frame);
        } catch (err) {
          console.error('[CameraEffects] Frame processing failed:', err);
        }
        if (output) {
          frame.close();
          controller.enqueue(output);
        } else {
          controller.enqueue(frame);
        }
      }
    });

    reader.pipeThrough(transformer, { signal })
      .pipeTo(this.generator.writable, { signal })
      .catch(() => {}); // aborted on stop() or the camera track ended
  }

  ensureCanvases(width, height) {
    if (this.outCanvas && this.outCanvas.width === width && this.outCanvas.height === height) return;

    this.outCanvas = new OffscreenCanvas(width, height);
    this.outCtx = this.outCanvas.getContext('2d', { alpha: true });
    this.blurCanvas = new OffscreenCanvas(
      Math.max(1, Math.round(width / BLUR_DOWNSCALE)),
      Math.max(1, Math.round(height / BLUR_DOWNSCALE))
    );
    this.blurCtx = this.blurCanvas.getContext('2d');
  }

  updateMask(frame) {
    this.segCtx.drawImage(frame, 0, 0, MASK_WIDTH, MASK_HEIGHT);
    const result = this.segmenter.segmentForVideo(this.segCanvas, nextSegmentTimestamp());

    try {
      const confidence = result.confidenceMasks[0].getAsFloat32Array();
      if (!this.smoothedMask) this.smoothedMask = Float32Array.from(confidence);

      const smoothed = this.smoothedMask;
      const pixels = this.maskImage.data;
      const range = MASK_HIGH - MASK_LOW;

      for (let i = 0; i < confidence.length; i++) {
        const value = smoothed[i] * MASK_SMOOTHING + confidence[i] * (1 - MASK_SMOOTHING);
        smoothed[i] = value;

        let alpha = (value - MASK_LOW) / range;
        alpha = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;

        const p = i * 4;
        pixels[p] = 255;
        pixels[p + 1] = 255;
        pixels[p + 2] = 255;
        pixels[p + 3] = alpha * 255;
      }
    } finally {
      result.close();
    }

    this.maskCtx.putImageData(this.maskImage, 0, 0);

    // Same mask with its edge pixels repeated one pixel outward
    const pad = this.paddedMaskCtx;
    pad.globalCompositeOperation = 'copy';
    pad.drawImage(this.maskCanvas, 0, 0, MASK_WIDTH + 2, MASK_HEIGHT + 2);
    pad.globalCompositeOperation = 'source-over';
    pad.clearRect(1, 1, MASK_WIDTH, MASK_HEIGHT);
    pad.drawImage(this.maskCanvas, 1, 1);
  }

  drawBackground(frame, width, height) {
    const ctx = this.outCtx;

    if (this.effect.type === 'image' && this.backgroundImage) {
      // object-fit: cover
      const img = this.backgroundImage;
      const scale = Math.max(width / img.width, height / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (width - w) / 2, (height - h) / 2, w, h);
      return;
    }

    const radius = BLUR_RADIUS[this.effect.type] || BLUR_RADIUS['blur-light'];
    const bw = this.blurCanvas.width;
    const bh = this.blurCanvas.height;
    // Overdraw past the edges so the blur doesn't fade into a dark border
    const pad = radius * 3;
    this.blurCtx.filter = `blur(${radius}px)`;
    this.blurCtx.drawImage(frame, -pad, -pad, bw + pad * 2, bh + pad * 2);
    this.blurCtx.filter = 'none';

    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.blurCanvas, 0, 0, width, height);
  }

  render(frame) {
    const width = frame.displayWidth;
    const height = frame.displayHeight;
    this.ensureCanvases(width, height);
    this.updateMask(frame);

    const ctx = this.outCtx;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 1. Person alpha from the mask. It is ~5x upscaled, so feather it to hide
    // the stair-steps. The padded mask's 1-pixel border lands just outside the
    // frame, so the feather never fades the person where they touch the edge.
    const cellX = width / MASK_WIDTH;
    const cellY = height / MASK_HEIGHT;
    ctx.globalCompositeOperation = 'copy';
    ctx.filter = `blur(${Math.max(1, width * MASK_FEATHER)}px)`;
    ctx.drawImage(this.paddedMaskCanvas, -cellX, -cellY, width + cellX * 2, height + cellY * 2);
    ctx.filter = 'none';

    // 2. Keep the camera image only where the person is
    ctx.globalCompositeOperation = 'source-in';
    ctx.drawImage(frame, 0, 0, width, height);

    // 3. Background behind the person
    ctx.globalCompositeOperation = 'destination-over';
    this.drawBackground(frame, width, height);

    ctx.globalCompositeOperation = 'source-over';

    return new VideoFrame(this.outCanvas, {
      timestamp: frame.timestamp,
      alpha: 'discard'
    });
  }

  stop() {
    if (this.abortController) this.abortController.abort();
    this.generator.stop();
    if (this.backgroundImage) {
      this.backgroundImage.close();
      this.backgroundImage = null;
    }
  }
}

window.CameraEffectsProcessor = CameraEffectsProcessor;
