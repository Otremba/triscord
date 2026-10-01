/**
 * Copies screen capture frames onto GPU-backed frames (see gpu-relay.js).
 *
 * Receives the capture's frames as a ReadableStream and writes the copies to
 * a MediaStreamTrackGenerator's WritableStream. Runs in a worker so the copy
 * never waits on the page: a minimized Triscord window stops rendering, and a
 * copy tied to rendering would freeze the stream while the game is in front.
 */
self.onmessage = async ({ data }) => {
  const { readable, writable } = data;
  const reader = readable.getReader();
  const writer = writable.getWriter();
  let canvas = null;
  let context = null;

  try {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done) break;

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
    }
  } catch (err) {
    self.postMessage({ error: String(err && err.message ? err.message : err) });
  } finally {
    writer.close().catch(() => {});
  }
};
