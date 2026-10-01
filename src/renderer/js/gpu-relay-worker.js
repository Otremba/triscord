/**
 * Copies screen capture frames onto GPU-backed frames (see gpu-relay.js).
 *
 * Receives the capture's frames as a ReadableStream and writes the copies to
 * a MediaStreamTrackGenerator's WritableStream. Runs in a worker so the copy
 * never waits on the page: a minimized Triscord window stops rendering, and a
 * copy tied to rendering would freeze the stream while the game is in front.
 *
 * It also measures how much the picture moves, since every frame passes here:
 * at most every 100 ms the frame is shrunk to 64x36 and compared with the last
 * sample. A game changes most of those pixels; an IDE or a document changes
 * a few (a typed line, the cursor). Once a second it posts
 * { stats: { motion, fps } }: the average share of pixels that changed (0-1)
 * and how many frames the capture delivered.
 */
const MOTION_SAMPLE_MS = 100;
const MOTION_WIDTH = 64;
const MOTION_HEIGHT = 36;
// A pixel counts as changed when its brightness moved by more than this (0-255)
const MOTION_PIXEL_DELTA = 16;

let thumb = null;
let thumbContext = null;
let previousLuma = null;
let lastSampleAt = 0;
let motionSum = 0;
let motionSamples = 0;
let framesThisSecond = 0;
let secondStartedAt = performance.now();

// Share of the 64x36 picture that changed since the last sample
function sampleMotion(frame) {
  if (!thumb) {
    thumb = new OffscreenCanvas(MOTION_WIDTH, MOTION_HEIGHT);
    thumbContext = thumb.getContext('2d', { alpha: false, willReadFrequently: true });
  }
  thumbContext.drawImage(frame, 0, 0, MOTION_WIDTH, MOTION_HEIGHT);
  const pixels = thumbContext.getImageData(0, 0, MOTION_WIDTH, MOTION_HEIGHT).data;
  const luma = new Uint8Array(MOTION_WIDTH * MOTION_HEIGHT);
  let changed = 0;
  for (let i = 0, p = 0; i < luma.length; i++, p += 4) {
    luma[i] = (pixels[p] * 77 + pixels[p + 1] * 150 + pixels[p + 2] * 29) >> 8;
    if (previousLuma && Math.abs(luma[i] - previousLuma[i]) > MOTION_PIXEL_DELTA) changed++;
  }
  const hadPrevious = !!previousLuma;
  previousLuma = luma;
  return hadPrevious ? changed / luma.length : null;
}

function report(now) {
  if (now - secondStartedAt < 1000) return;
  const seconds = (now - secondStartedAt) / 1000;
  // No sample in the last second: nothing changed on screen
  const motion = motionSamples ? motionSum / motionSamples : 0;
  self.postMessage({ stats: { motion: Math.round(motion * 1000) / 1000, fps: Math.round(framesThisSecond / seconds) } });
  motionSum = 0;
  motionSamples = 0;
  framesThisSecond = 0;
  secondStartedAt = now;
}

self.onmessage = async ({ data }) => {
  const { readable, writable } = data;
  const reader = readable.getReader();
  const writer = writable.getWriter();
  let canvas = null;
  let context = null;
  // A still screen sends few frames: stats still go out every second
  const ticker = setInterval(() => report(performance.now()), 1000);

  try {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done) break;

      const now = performance.now();
      framesThisSecond++;
      if (now - lastSampleAt >= MOTION_SAMPLE_MS) {
        lastSampleAt = now;
        const motion = sampleMotion(frame);
        if (motion !== null) {
          motionSum += motion;
          motionSamples++;
        }
      }

      const width = frame.displayWidth;
      const height = frame.displayHeight;
      // A shared window can change size mid-share
      if (!canvas || canvas.width !== width || canvas.height !== height) {
        canvas = new OffscreenCanvas(width, height);
        context = canvas.getContext('2d', { alpha: false, desynchronized: true });
      }
      context.drawImage(frame, 0, 0);
      const copy = new VideoFrame(canvas, { timestamp: frame.timestamp, alpha: 'discard' });
      frame.close();
      // The generator takes ownership of the frame and closes it
      await writer.write(copy);
      report(performance.now());
    }
  } catch (err) {
    self.postMessage({ error: String(err && err.message ? err.message : err) });
  } finally {
    clearInterval(ticker);
    writer.close().catch(() => {});
  }
};
