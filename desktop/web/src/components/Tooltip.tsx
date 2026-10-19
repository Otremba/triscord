import type { ComponentChildren, VNode } from 'preact';
import { cloneElement } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useRef, useState } from 'preact/hooks';

// Discord's design-system tooltip, recovered with REA:
// - CSS module _c36707: box 1px --border-subtle, radius 8, --shadow-high, primary = --background-surface-high,
//   content padding 8px 12px, 14px medium 16px line-height, 5px pointer; transform-origin on the target side.
// - module 900002: spring {tension 2400, friction 52} on opacity 0 -> 1 and scale .95 -> 1, back on leave
//   (--tri-spring-tooltip in motion.generated.css); placed `spacing` px from the target, centred on it.
// - guild list tooltip (GuildTooltip, CSS module _b1f768): position "right", spacing 12, text-md/semibold in
//   --text-default, max-width 196. Measured on Discord (motion/rail-hover): body 12px right of the tile, pointer
//   on the vertical centre, 36px tall for one line (so an 18px line box, not the 20px of text-md: measured).
type Position = 'right' | 'top' | 'bottom';
export function Tooltip({ text, position = 'top', spacing = 8, guild = false, children }: {
  text: ComponentChildren; position?: Position; spacing?: number; guild?: boolean; children: VNode<any>;
}) {
  const [target, setTarget] = useState<DOMRect | null>(null);
  const [leaving, setLeaving] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const timer = useRef<number>();
  const show = () => { clearTimeout(timer.current); setLeaving(false); if (ref.current) setTarget(ref.current.getBoundingClientRect()); };
  const hide = () => {
    setLeaving(true);
    const ms = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tri-spring-tooltip-duration')) || 0;
    timer.current = window.setTimeout(() => setTarget(null), ms);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const child = cloneElement(children, {
    ref,
    onMouseEnter: (e: MouseEvent) => { show(); children.props.onMouseEnter?.(e); },
    onMouseLeave: (e: MouseEvent) => { hide(); children.props.onMouseLeave?.(e); },
    onClick: (e: MouseEvent) => { if (guild) hide(); children.props.onClick?.(e); },   // hideOnClick
  });
  const style = target && (position === 'right'
    ? { left: `${target.right + spacing}px`, top: `${target.top + target.height / 2}px` }
    : position === 'bottom' ? { left: `${target.left + target.width / 2}px`, top: `${target.bottom + spacing}px` }
    : { left: `${target.left + target.width / 2}px`, top: `${target.top - spacing}px` });
  return (
    <>
      {child}
      {target && createPortal(
        <div class={`tri-tooltip-anchor tri-tooltip-anchor--${position}`} style={style ?? undefined}>
          <div class={`tri-tooltip tri-tooltip--${position} ${leaving ? 'is-leaving' : ''}`} role="tooltip">
            <div class="tri-tooltip__pointer" />
            <div class={`tri-tooltip__content ${guild ? 'tri-tooltip__content--guild' : ''}`}>{text}</div>
          </div>
        </div>, document.body)}
    </>
  );
}
