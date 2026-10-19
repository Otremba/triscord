// Path B receiver: frames arrive as read-only shared buffers ("sharedbufferreceived" from
// ICoreWebView2_17::PostSharedBufferToScript) with {stream, seq, width, height, format, index}.
// At most one frame per stream is kept; it is drawn on the next animation frame and every buffer is handed
// back (releaseBuffer + videoAck) as soon as it is drawn or superseded, so the core never stalls on us.
import type { Bridge } from './bridge';

interface FrameMeta { stream: string; seq: number; width: number; height: number; format: 'BGRA'; index: number }
interface Pending { meta: FrameMeta; buffer: ArrayBuffer }
interface WebViewShared {
  addEventListener(type: 'sharedbufferreceived', listener: (event: { additionalData: FrameMeta; getBuffer(): ArrayBuffer }) => void): void;
  releaseBuffer(buffer: ArrayBuffer): void;
}

const canvases = new Map<string, HTMLCanvasElement>();
const pending = new Map<string, Pending>();
const stats = new Map<string, { presented: number; dropped: number }>();
let scheduled = false;
let bridge: Bridge | null = null;
let webview: WebViewShared | null = null;

function counters(stream: string) {
  let value = stats.get(stream);
  if (!value) { value = { presented: 0, dropped: 0 }; stats.set(stream, value); }
  return value;
}

function giveBack(item: Pending) {
  webview?.releaseBuffer(item.buffer);
  bridge?.send({ name: 'videoAck', index: item.meta.index, seq: item.meta.seq });
}

function draw() {
  scheduled = false;
  for (const [stream, item] of pending) {
    pending.delete(stream);
    const canvas = canvases.get(stream);
    if (canvas) {
      const frame = new VideoFrame(new Uint8Array(item.buffer, 0, item.meta.width * item.meta.height * 4), {
        format: item.meta.format, codedWidth: item.meta.width, codedHeight: item.meta.height, timestamp: item.meta.seq,
      });
      canvas.getContext('2d')?.drawImage(frame, 0, 0, canvas.width, canvas.height);
      frame.close();
      counters(stream).presented++;
    }
    giveBack(item);
  }
}

export function startVideo(b: Bridge) {
  bridge = b;
  webview = (window as unknown as { chrome?: { webview?: WebViewShared } }).chrome?.webview ?? null;
  if (!webview) return;
  webview.addEventListener('sharedbufferreceived', event => {
    const meta = event.additionalData;
    const item = { meta, buffer: event.getBuffer() };
    // A hidden or occluded page gets no animation frames: hand the buffer straight back instead of holding
    // it, or the core would run out of buffers and the video would freeze (found at 60 fps in the spike).
    if (document.hidden) { counters(meta.stream).dropped++; giveBack(item); return; }
    const previous = pending.get(meta.stream);
    if (previous) { counters(meta.stream).dropped++; giveBack(previous); } // superseded before drawn
    pending.set(meta.stream, item);
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(draw);
      // Safety net: if no animation frame comes (occluded window, busy renderer), never keep a buffer
      // longer than 250 ms; dropping is always preferred to stalling the core's pool.
      setTimeout(() => {
        for (const [stream, item] of pending) {
          if (item !== pending.get(stream) || item.meta.seq !== meta.seq) continue;
          pending.delete(stream); counters(stream).dropped++; giveBack(item);
        }
        scheduled = false;
      }, 250);
    }
  });
  setInterval(() => {
    for (const [streamId, s] of stats) bridge?.send({ name: 'videoStats', streamId, presented: s.presented, dropped: s.dropped });
  }, 5000);
}

export function attachCanvas(stream: string, canvas: HTMLCanvasElement | null) {
  if (canvas) canvases.set(stream, canvas); else canvases.delete(stream);
}

// Floating page layers (menus) report their rectangles instead of hiding every video: the core cuts them out of the
// native windows' masks, so the video stays visible around them (as in Discord). Keyed per layer.
const occluders = new Map<string, DOMRect[]>();
export function setOccluders(key: string, rects: DOMRect[]) {
  if (rects.length) occluders.set(key, rects); else if (!occluders.delete(key)) return;
  const all = [...occluders.values()].flat().slice(0, 8).map(r => ({
    x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.right) - Math.floor(r.x), height: Math.ceil(r.bottom) - Math.floor(r.y) }));
  bridge?.send({ name: 'videoOccluders', rects: all });
}

// The filmstrip (and its toggle) float over the bottom of the focused card's area: cut them out of the stage window only.
export function setStageOccluders(rects: DOMRect[]) {
  bridge?.send({ name: 'videoStageOccluders', rects: rects.slice(0, 8).map(r => ({
    x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.right) - Math.floor(r.x), height: Math.ceil(r.bottom) - Math.floor(r.y) })) });
}

// Path A windows are native and always sit above the page, so anything drawn over a video card in HTML
// (modals) would be hidden behind them. While a modal is open the cards report an empty rectangle
// (the core hides the windows) and report their real one again when it closes.
let suspended = 0;
export function suspendOverlays(on: boolean) {
  suspended = Math.max(0, suspended + (on ? 1 : -1));
  dispatchEvent(new Event('tri-overlays-changed'));
}
export function overlaysSuspended() { return suspended > 0; }
