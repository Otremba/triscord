// Native video overlays (Path A). The Rust/Tauri core draws each stream in its own native window over the
// tile's rect; the page only reports geometry and occlusion. Frames never travel through this page.
import type { Bridge } from './bridge';

let bridge: Bridge | null = null;

export function startVideo(b: Bridge) {
  bridge = b;
}

// Floating page layers (menus) report their rectangles instead of hiding every video: the core cuts them out of the
// native windows' masks, so the video stays visible around them (as in Discord). Keyed per layer.
const occluders = new Map<string, DOMRect[]>();
export function setOccluders(key: string, rects: DOMRect[]) {
  if (rects.length) occluders.set(key, rects); else if (!occluders.delete(key)) return;
  const all = [...occluders.values()].flat().slice(0, 8).map(r => ({
    x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.right) - Math.floor(r.x), height: Math.ceil(r.bottom) - Math.floor(r.y)
  }));
  bridge?.send({ name: 'videoOccluders', rects: all });
}

// The filmstrip (and its toggle) float over the bottom of the focused card's area: cut them out of the stage window only.
export function setStageOccluders(rects: DOMRect[]) {
  bridge?.send({
    name: 'videoStageOccluders', rects: rects.slice(0, 8).map(r => ({
      x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.right) - Math.floor(r.x), height: Math.ceil(r.bottom) - Math.floor(r.y)
    }))
  });
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
