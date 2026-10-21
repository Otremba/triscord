import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { setOccluders } from '../video';
import type { IconName } from '../icons.generated';
import { Icon } from './Icon';

// Context menu entry definitions.
export type MenuEntry =
  | { kind: 'item'; label: string; subtext?: string; icon?: IconName; danger?: boolean; disabled?: boolean; action: (event: MouseEvent | KeyboardEvent) => void; submenu?: MenuEntry[];
      checked?: boolean }
  | { kind: 'separator' }
  | { kind: 'reactions'; emojis: string[]; onPick: (emoji: string) => void }
  | { kind: 'slider'; label: string; value: number; max: number; onChange: (value: number) => void };

export interface MenuRequest { x: number; y: number; entries: MenuEntry[]; width?: 'fixed' | 'flexible'; label?: string }

// One menu at a time, opened from anywhere with openContextMenu.
export function openContextMenu(event: MouseEvent, entries: MenuEntry[], options: { width?: 'fixed' | 'flexible'; label?: string; at?: { x: number; y: number } } = {}) {
  event.preventDefault();
  event.stopPropagation();
  const visible = entries.filter((e, i, all) => e.kind !== 'separator' || (i > 0 && i < all.length - 1 && all[i - 1].kind !== 'separator'));
  if (!visible.some(e => e.kind !== 'separator')) return;
  const { at, ...rest } = options;
  dispatchEvent(new CustomEvent<MenuRequest>('tri-context-menu', { detail: { x: at?.x ?? event.clientX, y: at?.y ?? event.clientY, entries: visible, ...rest } }));
}

function MenuList({ entries, onClose, width, label, style, focus, onBack }: {
  entries: MenuEntry[]; onClose: () => void; width?: 'fixed' | 'flexible'; label?: string; style?: Record<string, string>; focus?: boolean; onBack?: () => void;
}) {
  const [focused, setFocused] = useState(() => onBack ? entries.findIndex(e => e.kind === 'item' && !e.disabled) : -1);
  const [open, setOpen] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);
  const items = entries.map((e, i) => (e.kind === 'item' && !e.disabled ? i : -1)).filter(i => i >= 0);
  useLayoutEffect(() => {
    if (!focus) return;
    if (onBack) { ref.current?.focus(); return; }
    // The root is measured while hidden, then placed by ContextMenuHost in this frame.
    const frame = requestAnimationFrame(() => ref.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focus]);
  const onKey = (e: KeyboardEvent) => {
      // Nested menus own their keys; the parent keeps its selected item for the return trip.
      if ((e.target as Element)?.closest('.tri-menu') !== ref.current) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const at = items.indexOf(focused), step = e.key === 'ArrowDown' ? 1 : -1;
        setOpen(-1);
        setFocused(items[at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length] ?? -1);
      } else if ((e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') && focused >= 0) {
        const entry = entries[focused];
        if (entry.kind === 'item' && !entry.disabled) {
          e.preventDefault();
          if (entry.submenu) setOpen(focused);
          else if (e.key !== 'ArrowRight') { entry.action(e); onClose(); }
        }
      } else if ((e.key === 'ArrowLeft' || e.key === 'Escape') && onBack) {
        e.preventDefault(); e.stopPropagation(); onBack();
      } else if (e.key === 'Escape') {
        e.preventDefault(); onClose();
      }
  };
  return (
    <div ref={ref} class={`tri-menu ${width ? `tri-menu--${width}` : ''}`} role="menu" tabIndex={-1} aria-label={label} style={style}
      onKeyDown={onKey} onContextMenu={e => e.preventDefault()}>
      <div class="tri-menu__scroller">
        {entries.map((entry, i) => {
          if (entry.kind === 'separator') return <div key={`s${i}`} class="tri-menu__separator" role="separator" />;
          if (entry.kind === 'slider') return <MenuSlider key={`v${i}`} entry={entry} />;
          if (entry.kind === 'reactions') {
            return (
              <div key={`r${i}`} class="tri-menu__reactions" role="group" aria-label="Reações rápidas">
                {entry.emojis.map(emoji => (
                  <button key={emoji} class="tri-menu__reaction" role="menuitem" aria-label={`Reagir com ${emoji}`}
                    onClick={() => { entry.onPick(emoji); onClose(); }}>{emoji}</button>
                ))}
              </div>
            );
          }
          const isFocused = focused === i;
          return (
            <div key={`i${i}`} class={`tri-menu__item ${entry.danger ? 'is-danger' : ''} ${isFocused ? 'is-focused' : ''} ${entry.disabled ? 'is-disabled' : ''}`}
              role={entry.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={entry.checked} aria-disabled={entry.disabled} aria-haspopup={entry.submenu ? 'true' : undefined} aria-expanded={entry.submenu ? open === i : undefined} tabIndex={-1}
              onMouseEnter={() => { if (entry.disabled) return; setFocused(i); setOpen(entry.submenu ? i : -1); }}
              onMouseLeave={() => setFocused(-1)}
              onClick={e => { e.stopPropagation(); if (entry.disabled) return; if (entry.submenu) setOpen(i); else { entry.action(e); onClose(); } }}>
              <div class="tri-menu__label-container">
                {entry.icon && <span class="tri-menu__icon tri-menu__icon--left"><Icon name={entry.icon} size={20} /></span>}
                <span class="tri-menu__label">{entry.label}{entry.subtext && <span class="tri-menu__subtext">{entry.subtext}</span>}</span>
                {entry.submenu && <Icon name="ChevronSmallRight" size={20} className="tri-menu__caret" />}
                {entry.checked !== undefined && (
                  <span class={`tri-menu__checkbox ${entry.checked ? 'is-checked' : ''}`} aria-hidden="true">
                    {entry.checked && <svg viewBox="0 0 20 20" width="20" height="20"><path d="M5 10.5 8.5 14 15 6.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>}
                  </span>
                )}
              </div>
              {entry.submenu && open === i && (
                <div class="tri-menu__submenu-anchor">
                  <MenuList entries={entry.submenu} onClose={onClose} width="flexible" focus onBack={() => { setOpen(-1); ref.current?.focus(); }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ContextMenuHost() {
  const [menu, setMenu] = useState<MenuRequest | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  // Openers that track their own state (the server header's chevron) learn when the menu goes away.
  useEffect(() => { if (!menu) dispatchEvent(new Event('tri-context-menu-closed')); }, [menu]);
  useEffect(() => {
    const open = (e: Event) => { setPos(null); setMenu((e as CustomEvent<MenuRequest>).detail); };
    const closeRequest = () => setMenu(null);
    addEventListener('tri-context-menu-close', closeRequest);
    addEventListener('tri-context-menu', open);
    return () => { removeEventListener('tri-context-menu-close', closeRequest); removeEventListener('tri-context-menu', open); };
  }, []);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.stopPropagation(); close(); } };
    const onDown = (e: MouseEvent) => { if (!layer.current?.contains(e.target as Node)) close(); };
    addEventListener('keydown', onKey);
    addEventListener('mousedown', onDown, true);
    addEventListener('blur', close);
    addEventListener('resize', close);
    addEventListener('wheel', onDown, true);
    return () => {
      removeEventListener('keydown', onKey); removeEventListener('mousedown', onDown, true);
      removeEventListener('blur', close); removeEventListener('resize', close); removeEventListener('wheel', onDown, true);
    };
  }, [menu]);
  const [flipped, setFlipped] = useState(false);
  // Place at the pointer, then keep 16px inside the window (flip up/left when it would overflow).
  useLayoutEffect(() => {
    const el = layer.current?.firstElementChild as HTMLElement | null;
    if (!menu || !el) return;
    const pad = 16, w = el.offsetWidth, h = el.offsetHeight;
    let left = menu.x, top = menu.y;
    let isFlippedX = false;
    if (left + w > innerWidth - pad) {
      left = Math.max(pad, menu.x - w);
      isFlippedX = true;
    }
    if (top + h > innerHeight - pad) top = Math.max(pad, innerHeight - pad - h);
    setPos({ left, top });
    setFlipped(isFlippedX);
  }, [menu]);
  // Native video windows sit above the page: cut the menu (and an open submenu) out of them while it shows.
  useEffect(() => {
    const el = layer.current;
    if (!menu || !pos || !el) { setOccluders('context-menu', []); return; }
    const report = () => setOccluders('context-menu', [...el.querySelectorAll<HTMLElement>('.tri-menu')].map(m => m.getBoundingClientRect()));
    report();
    const observer = new MutationObserver(report);
    observer.observe(el, { childList: true, subtree: true });
    return () => { observer.disconnect(); setOccluders('context-menu', []); };
  }, [menu, pos]);
  if (!menu) return null;
  const style: Record<string, string> = pos ? { left: `${pos.left}px`, top: `${pos.top}px` } : { left: `${menu.x}px`, top: `${menu.y}px`, visibility: 'hidden' };
  return (
    <div class={`tri-menu-layer ${flipped ? 'tri-menu-layer--flip-x' : ''}`} ref={layer} style={style}>
      <MenuList entries={menu.entries} onClose={() => setMenu(null)} width={menu.width} label={menu.label} focus />
    </div>
  );
}


function MenuSlider({ entry }: { entry: Extract<MenuEntry, { kind: 'slider' }> }) {
  const [value, setValue] = useState(entry.value);
  return (
    <div class="tri-menu__control" role="group" aria-label={entry.label} onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
      <span class="tri-menu__control-label">{entry.label}</span>
      <input class="tri-slider tri-menu__slider" type="range" min={0} max={entry.max} value={value} aria-label={entry.label}
        aria-valuetext={`${value}%`} style={{ '--tri-fill': `${(100 * value) / entry.max}%` } as Record<string, string>}
        onInput={e => { const v = +e.currentTarget.value; setValue(v); entry.onChange(v); }} />
      <output class="tri-menu__control-value">{value}%</output>
    </div>
  );
}
