import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { suspendOverlays } from '../video';

// Discord's modal layer motion, recovered with REA (motion.generated.css has the springs):
// - scrim (module 943320, CSS __40128: --background-scrim, fixed): opacity 0 -> 1 with spring hP
//   {mass 1, tension 1000, friction 48}, and back to 0 on leave with the same spring;
// - modal (module 150591 kS): opacity 0 -> 1 with the same spring after 64ms; on close opacity 0 and scale(0.9)
//   with {mass 1, tension 1200, friction 80}; the modal is removed when that spring rests.
// Measured on Discord (out/claude-observations/motion/modal-create-channel): scrim darkens ~70ms after the click
// is handled, the modal finishes fading in ~160ms later.
export function useModalClose(onClose: () => void) {
  const [closing, setClosing] = useState(false);
  const close = useCallback(() => setClosing(true), []);
  useEffect(() => {
    if (!closing) return;
    const ms = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tri-spring-modal-out-duration')) || 0;
    const timer = setTimeout(onClose, ms);
    return () => clearTimeout(timer);
  }, [closing, onClose]);
  return { closing, close };
}

export function ModalLayer({ closing, onRequestClose, children }: { closing: boolean; onRequestClose: () => void; children: ComponentChildren }) {
  const layer = useRef<HTMLDivElement>(null);
  // Layout effect: Escape works as soon as the modal is in the DOM (a plain effect runs after paint, and an Escape in
  // that gap was lost; found by the call view test).
  useLayoutEffect(() => {
    suspendOverlays(true);   // native video windows would cover the modal
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const layers = document.querySelectorAll('.tri-modal-backdrop');
      if (layers[layers.length-1] !== layer.current) return;
      if (layer.current?.querySelector('[role="menu"]')) return;   // a menu inside the modal (share picker's mode menu) closes first
      e.stopImmediatePropagation(); onRequestClose();
    };
    addEventListener('keydown', onKey);
    return () => { removeEventListener('keydown', onKey); suspendOverlays(false); };
  }, [onRequestClose]);
  return (
    <div ref={layer} class={`tri-modal-backdrop ${closing ? 'is-closing' : ''}`} onClick={e => { if (e.target === e.currentTarget) onRequestClose(); }}>
      {children}
    </div>
  );
}
