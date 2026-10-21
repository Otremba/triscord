import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { suspendOverlays } from '../video';
import { modalTabTarget } from '../focus-policy';

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
    const ms = matchMedia('(prefers-reduced-motion: reduce)').matches?0:parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tri-spring-modal-out-duration')) || 0;
    const timer = setTimeout(onClose, ms);
    return () => clearTimeout(timer);
  }, [closing, onClose]);
  return { closing, close };
}

export function ModalLayer({ closing, onRequestClose, children }: { closing: boolean; onRequestClose: () => void; children: ComponentChildren }) {
  const layer = useRef<HTMLDivElement>(null);
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const closeRequest = useRef(onRequestClose);
  closeRequest.current = onRequestClose;
  // Layout effect: Escape works as soon as the modal is in the DOM (a plain effect runs after paint, and an Escape in
  // that gap was lost; found by the call view test).
  useLayoutEffect(() => {
    const root = layer.current;
    if (!root) return;
    const topmost = () => {
      const layers = document.querySelectorAll('.tri-modal-backdrop');
      return layers[layers.length - 1] === root;
    };
    const dialog = root.querySelector<HTMLElement>('[role="dialog"],[role="alertdialog"]') ?? root;
    if (!dialog.hasAttribute('tabindex')) dialog.tabIndex = -1;
    if (dialog !== root) dialog.setAttribute('aria-modal', 'true');
    const controls = () => [...root.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex],[contenteditable="true"]')]
      .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[hidden],[inert],[aria-hidden="true"]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden')
      .filter((element, _, all) => {
        // Native radio groups have one Tab stop; arrow keys select the other radios.
        if (!(element instanceof HTMLInputElement) || element.type !== 'radio' || !element.name) return true;
        const group = all.filter((other): other is HTMLInputElement => other instanceof HTMLInputElement && other.type === 'radio' && other.name === element.name && other.form === element.form);
        return element === (group.find(radio => radio.checked) ?? group[0]);
      });
    const focusFirst = () => (controls()[0] ?? dialog).focus({ preventScroll: true });
    if (topmost() && !root.contains(document.activeElement)) focusFirst();
    suspendOverlays(true);   // native video windows would cover the modal
    const onKey = (e: KeyboardEvent) => {
      if (!topmost() || e.defaultPrevented) return;
      if (e.key === 'Tab') {
        const target = modalTabTarget(controls(), document.activeElement as HTMLElement | null, e.shiftKey);
        if (target !== undefined) { e.preventDefault(); (target ?? dialog).focus({ preventScroll: true }); }
        return;
      }
      if (e.key !== 'Escape') return;
      if (root.querySelector('[role="menu"]')) return;   // the share picker's mode menu closes first
      e.stopImmediatePropagation(); closeRequest.current();
    };
    const onFocus = (e: FocusEvent) => {
      if (topmost() && e.target instanceof Node && !root.contains(e.target)) focusFirst();
    };
    addEventListener('keydown', onKey);
    addEventListener('focusin', onFocus);
    return () => {
      removeEventListener('keydown', onKey); removeEventListener('focusin', onFocus);
      suspendOverlays(false);
      if (opener.current?.isConnected && !root.contains(opener.current)) opener.current.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div ref={layer} class={`tri-modal-backdrop ${closing ? 'is-closing' : ''}`} onClick={e => { if (e.target === e.currentTarget) onRequestClose(); }}>
      {children}
    </div>
  );
}
