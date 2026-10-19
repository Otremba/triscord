import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import type { Session, VoiceUser } from '../protocol';
import { ModalLayer, useModalClose } from './ModalLayer';
import { PeerAudioControls, peerInCall } from './PeerAudio';
import { Icon } from './Icon';

type Open = { socketId: string; anchor: HTMLElement };
export function openParticipantProfile(socketId: string, anchor: HTMLElement) {
  dispatchEvent(new CustomEvent<Open>('tri-open-participant-profile', { detail: { socketId, anchor } }));
}
export function ParticipantProfileHost({ session, bridge }: { session: Session; bridge: Bridge }) {
  const [open, setOpen] = useState<Open | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const user = session.categories.flatMap(c => c.channels).flatMap(c => c.users).find(u => u.id === open?.socketId);
  useEffect(() => {
    const listener = (e: Event) => setOpen((e as CustomEvent<Open>).detail);
    addEventListener('tri-open-participant-profile', listener);
    return () => removeEventListener('tri-open-participant-profile', listener);
  }, []);
  useEffect(close, [session.selectedServerId]);
  useEffect(() => { if (open && !user) close(); }, [open, user, close]);
  return open && user ? <ParticipantProfile key={open.socketId} {...open} user={user} session={session} bridge={bridge} onClose={close} /> : null;
}

function ParticipantProfile({ socketId, anchor, user, session, bridge, onClose }: Open & {
  user: VoiceUser; session: Session; bridge: Bridge; onClose: () => void;
}) {
  const { closing, close } = useModalClose(onClose);
  const root = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(!!user.profileAvailable), [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const profile = session.participantProfile?.socketId === socketId ? session.participantProfile : undefined;
  useEffect(() => {
    let active = true;
    if (user.profileAvailable) {
      setLoading(true); setError('');
      bridge.request({ name: 'getParticipantProfile', socketId }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    }
    return () => { active = false; bridge.send({ name: 'closeParticipantProfile' }); };
  }, [bridge, socketId, user.profileAvailable, attempt]);
  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const buttons = [...root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') ?? []];
      if (!buttons.length) return;
      e.preventDefault(); const current = buttons.indexOf(document.activeElement as HTMLElement);
      buttons[(current + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
    };
    addEventListener('keydown', key);
    return () => { removeEventListener('keydown', key); if (anchor.isConnected) anchor.focus(); };
  }, [anchor]);
  const display = profile?.displayName || user.name;
  const created = profile?.created_at ? new Date(profile.created_at) : null;
  const color = profile?.profile_theme_start, end = profile?.profile_theme_end;
  return <ModalLayer closing={closing} onRequestClose={close}>
    <div ref={root} class={`tri-participant-profile ${color && end ? 'has-custom-theme' : ''}`} role="dialog" aria-modal="true" aria-label={`Perfil de ${user.name}`}
      style={color && end ? { background: `linear-gradient(#0009,#0009),linear-gradient(${color},${end})` } : undefined}>
      <div class="tri-participant-profile__banner" style={{ backgroundColor: profile?.banner_color || 'var(--background-brand)' }}>
        {profile?.bannerDataUrl && <img src={profile.bannerDataUrl} alt="" />}
      </div>
      <button class="tri-participant-profile__close" aria-label="Fechar perfil" onClick={close}><Icon name="Close" size={24}/></button>
      <div class="tri-participant-profile__avatar">{(profile?.avatarDataUrl || user.avatarUrl) ? <img src={profile?.avatarDataUrl || user.avatarUrl} alt="" /> : display.slice(0,1).toUpperCase()}</div>
      <div class="tri-participant-profile__body">
        <h1>{display}</h1><p class="tri-participant-profile__username">{profile?.username || user.name}{profile?.pronouns ? ` · ${profile.pronouns}` : ''}</p>
        {user.customStatus && <p class="tri-participant-profile__status">{user.customStatus}</p>}
        <div class="tri-participant-profile__voice">{user.deafened ? 'Áudio desativado' : user.muted ? 'Microfone silenciado' : 'Microfone ativo'}{user.camera ? ' · Câmera ligada' : ''}{user.live ? ' · Compartilhando tela' : ''}</div>
        {loading && <p role="status">Carregando perfil…</p>}
        {error && <div role="alert"><p>{error}</p><button onClick={() => setAttempt(x => x + 1)}>Tentar novamente</button></div>}
        {!user.profileAvailable && <p>Este participante não possui um perfil autenticado.</p>}
        {profile?.bio && <section><h2>Sobre mim</h2><p>{profile.bio}</p></section>}
        {peerInCall(session,socketId) && <PeerAudioControls user={user} bridge={bridge}/>}
        {created && Number.isFinite(created.getTime()) && <section><h2>Membro desde</h2><p>{created.toLocaleDateString('pt-BR', { day:'numeric', month:'long', year:'numeric' })}</p></section>}
      </div>
    </div>
  </ModalLayer>;
}
