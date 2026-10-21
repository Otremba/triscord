import type { ComponentChildren, VNode } from 'preact';
import { cloneElement } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useId, useRef, useState } from 'preact/hooks';

// Tooltip component with portal positioning and spring animation.
type Position = 'right' | 'top' | 'bottom';
export function Tooltip({ text, position = 'top', spacing = 8, guild = false, children }: {
  text: ComponentChildren; position?: Position; spacing?: number; guild?: boolean; children: VNode<any>;
}) {
  const [target, setTarget] = useState<DOMRect | null>(null);
  const [leaving, setLeaving] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const id=useId();
  const focused=useRef(false), hovered=useRef(false);
  const timer = useRef<number>();
  const show = () => { clearTimeout(timer.current); setLeaving(false); if (ref.current) setTarget(ref.current.getBoundingClientRect()); };
  const hide = () => {
    setLeaving(true);
    const ms = matchMedia('(prefers-reduced-motion: reduce)').matches?0:parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--tri-spring-tooltip-duration')) || 0;
    timer.current = window.setTimeout(() => setTarget(null), ms);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const child = cloneElement(children, {
    ref,
    'aria-describedby':target?[children.props['aria-describedby'],id].filter(Boolean).join(' '):children.props['aria-describedby'],
    onMouseEnter: (e: MouseEvent) => { hovered.current=true;show(); children.props.onMouseEnter?.(e); },
    onMouseLeave: (e: MouseEvent) => { hovered.current=false;if(!focused.current)hide(); children.props.onMouseLeave?.(e); },
    onFocus:(e:FocusEvent)=>{focused.current=true;show();children.props.onFocus?.(e);},
    onBlur:(e:FocusEvent)=>{focused.current=false;if(!hovered.current)hide();children.props.onBlur?.(e);},
    onKeyDown:(e:KeyboardEvent)=>{children.props.onKeyDown?.(e);if(e.key==='Escape'&&target&&!e.defaultPrevented){clearTimeout(timer.current);setTarget(null);setLeaving(false);e.preventDefault();e.stopPropagation();}},
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
          <div id={id} class={`tri-tooltip tri-tooltip--${position} ${leaving ? 'is-leaving' : ''}`} role="tooltip">
            <div class="tri-tooltip__pointer" />
            <div class={`tri-tooltip__content ${guild ? 'tri-tooltip__content--guild' : ''}`}>{text}</div>
          </div>
        </div>, document.body)}
    </>
  );
}
