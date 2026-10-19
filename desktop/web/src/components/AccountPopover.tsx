import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import type { Session } from '../protocol';
import { SignOutModal } from './Settings';
import { suspendOverlays } from '../video';
import { usePopoutAnimation } from './popoutAnimation';
import { Icon } from './Icon';

export function openAccountPopover(anchor: HTMLElement) {
  dispatchEvent(new CustomEvent('tri-open-account-popover', { detail: anchor }));
}
export function AccountPopoverHost({ session, bridge }: { session: Session; bridge: Bridge }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [signOut, setSignOut] = useState(false);
  const close = useCallback(() => setAnchor(null), []);
  useEffect(() => {
    const open = (e: Event) => setAnchor(current => current ? null : (e as CustomEvent<HTMLElement>).detail);
    addEventListener('tri-open-account-popover', open);
    return () => removeEventListener('tri-open-account-popover', open);
  }, []);
  return <>
    {anchor && <AccountPopover anchor={anchor} session={session} bridge={bridge} close={close} signOut={() => { close(); setSignOut(true); }} />}
    {signOut && <SignOutModal bridge={bridge} onClose={() => setSignOut(false)} />}
  </>;
}

// Discord's account popover, compared side by side on 18/10 (1264x892, same state): 300px wide, left-aligned with the
// panels (8px) just above the user row; 104px banner; 80px avatar in a 6px ring with the status dot; a speech bubble
// right of the avatar with a "+" and "Qual a sua obsessão atualmente?" (one of Discord's rotating prompts, as seen);
// name 20/bold and username; then the actions in rounded cards (--background-mod-subtle, radius 8) of 48px rows with
// 20px icons: "Editar perfil" (Discord's card also has the presence status and Orbs, no triscord function), and a second
// card where Discord has "Mudar de conta": triscord's "Sair da conta". Status editing uses Triscord's local status API.
function AccountPopover({ anchor, session, bridge, close, signOut }: {
  anchor: HTMLElement; session: Session; bridge: Bridge; close: () => void; signOut: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const [text, setText] = useState(session.account.customStatus ?? '');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [editingStatus, setEditingStatus] = useState(false);
  const account = session.account, profile = session.profile;
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.getBoundingClientRect(), height = root.current?.offsetHeight ?? 400;
      const width = root.current?.offsetWidth ?? 300;
      const panels = anchor.closest('.tri-panels')?.getBoundingClientRect();
      setPosition({ left: Math.max(8, Math.min(panels ? panels.left : r.left, innerWidth - width - 8)), top: Math.max(8, r.top - height - 8) });
    };
    place(); const observer = new ResizeObserver(place); if (root.current) observer.observe(root.current);
    addEventListener('resize', place);
    return () => { observer.disconnect(); removeEventListener('resize', place); };
  }, [anchor]);
  useEffect(() => {
    suspendOverlays(true); anchor.setAttribute('aria-expanded', 'true');
    // Focus the first control for keyboard users, without the ring Discord never shows on open.
    root.current?.querySelector<HTMLButtonElement>('button')?.focus({ focusVisible: false } as FocusOptions);
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
      if (e.key !== 'Tab') return;
      const items = [...root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') ?? []];
      const current = items.indexOf(document.activeElement as HTMLElement);
      if (!items.length) return;
      e.preventDefault(); items[(current + (e.shiftKey ? -1 : 1) + items.length) % items.length].focus();
    };
    addEventListener('pointerdown', outside); addEventListener('keydown', key, true);
    return () => {
      removeEventListener('pointerdown', outside); removeEventListener('keydown', key, true);
      suspendOverlays(false); anchor.setAttribute('aria-expanded', 'false'); if (anchor.isConnected) anchor.focus();
    };
  }, [anchor, close]);
  const update = async (value: string) => {
    setBusy(true); setError(''); setSaved('');
    try { await bridge.request({ name: 'setCustomStatus', text: value }); setText(value.trim()); setSaved(value.trim() ? 'Status salvo.' : 'Status removido.'); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  const anim = usePopoutAnimation('translate', 'top');   // Discord Popout: TRANSLATE (default), above its button
  return <div ref={root} role="dialog" aria-modal="true" aria-label="Sua conta" class={`tri-account-popover ${anim.className}`} data-popout-animating={anim['data-popout-animating']} style={position}>
    <div class="tri-account-popover__banner" style={{ background: profile?.banner_color || 'var(--background-brand)' }}>
      {profile?.bannerDataUrl && <img src={profile.bannerDataUrl} alt="" />}
    </div>
    <div class="tri-account-popover__body">
      <div class="tri-account-popover__identity">
        <span class="tri-account-popover__avatar">{(profile?.avatarDataUrl || account.avatarUrl) ? <img src={profile?.avatarDataUrl || account.avatarUrl} alt="" /> : account.displayName.slice(0, 1).toUpperCase()}
          <span class={`tri-account-popover__presence is-${account.status}`} aria-hidden="true" /></span>
        <button class="tri-account-popover__status" aria-label="Editar status personalizado" aria-expanded={editingStatus}
          onClick={() => setEditingStatus(!editingStatus)}>
          {!account.customStatus && <span class="tri-account-popover__status-add" aria-hidden="true"><Icon name="CirclePlus" size={16} /></span>}
          <span>{account.customStatus || 'Qual a sua obsessão atualmente?'}</span>
        </button>
        <div><strong>{account.displayName}</strong><small>{account.username}{profile?.pronouns ? ` · ${profile.pronouns}` : ''}</small></div>
      </div>
      {profile?.bio && <p class="tri-account-popover__bio">{profile.bio}</p>}
      <div class="tri-account-popover__card">
        <button class="tri-account-popover__action" onClick={() => { close(); dispatchEvent(new Event('tri-open-profile')); }}>
          <Icon name="Pencil" size={20} /><span>Editar perfil</span></button>
      </div>
      {editingStatus && <form onSubmit={e => { e.preventDefault(); if (!busy) void update(text); }}>
        <label htmlFor="account-custom-status">Status personalizado</label>
        <input id="account-custom-status" maxLength={64} placeholder="O que você está fazendo?" value={text} disabled={busy}
          onInput={e => { setText(e.currentTarget.value); setSaved(''); }} />
        <small>Visível para as pessoas na sala. Salvo neste computador.</small>
        <div class="tri-account-popover__actions">
          <button type="button" disabled={busy || !account.customStatus} onClick={() => void update('')}>Limpar</button>
          <button type="submit" disabled={busy || text.trim() === (account.customStatus ?? '')}>{busy ? 'Salvando…' : 'Salvar status'}</button>
        </div>
        {error && <p role="alert">{error}</p>}{saved && <p role="status">{saved}</p>}
      </form>}
      <div class="tri-account-popover__card">
        <button class="tri-account-popover__action is-danger" onClick={signOut}><Icon name="DoorExit" size={20} /><span>Sair da conta</span></button>
      </div>
    </div>
  </div>;
}
