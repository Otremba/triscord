import { useLayoutEffect, useState } from 'preact/hooks';

// Discord's Popout entry animation (web bundle: Popout.Animation NONE "1" / TRANSLATE "2" (the default) / SCALE "3" /
// FADE "4"; component `p` adds didRender 10ms after mount and clears data-popout-animating after 200ms; CSS module
// _faf9c0, 964940.62a0e9d626b739d9.css, sha256 5da78af4…): TRANSLATE starts 10px towards the popout's side
// (top -10px, bottom +10px, left -10px, right +10px, center -10px vertically) and slides back with transform .2s
// ease-out, opacity untouched; FADE goes 0 -> 1 with opacity .08s ease-out (the audio popover filmed in
// ANIMATIONS.md: ~65ms to 93%). Closing has no animation (filmed: one frame). styles/base.css has the rules.
export type PopoutAnimation = 'translate' | 'fade';
export type PopoutSide = 'top' | 'bottom' | 'left' | 'right' | 'center';
export function usePopoutAnimation(type: PopoutAnimation, side: PopoutSide) {
  const [rendered, setRendered] = useState(false);
  const [animating, setAnimating] = useState(true);
  useLayoutEffect(() => {
    const start = setTimeout(() => setRendered(true), 10);
    const end = setTimeout(() => setAnimating(false), 200);
    return () => { clearTimeout(start); clearTimeout(end); };
  }, []);
  return {
    className: `tri-popout-anim tri-popout-anim--${type} tri-popout-anim--${side}${rendered ? ' is-rendered' : ''}`,
    'data-popout-animating': animating ? 'true' : 'false',
  };
}
