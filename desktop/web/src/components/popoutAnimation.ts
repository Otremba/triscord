import { useLayoutEffect, useState } from 'preact/hooks';

// Popout entry transition animation hook.
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
