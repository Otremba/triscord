import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import type { Session, VoiceUser } from '../protocol';
import { callChannelOf } from '../protocol';
import { Modal } from './Modal';
import { useModalClose } from './ModalLayer';

type Open = { socketId: string; anchor: HTMLElement };
export function openPeerAudio(socketId: string, anchor: HTMLElement) {
  dispatchEvent(new CustomEvent<Open>('tri-open-peer-audio', { detail: { socketId, anchor } }));
}
export function peerInCall(session: Session, socketId: string) {
  return callChannelOf(session)?.users.find(u => u.id === socketId && !u.self);
}
export function PeerAudioHost({ session, bridge }: { session: Session; bridge: Bridge }) {
  const [open, setOpen] = useState<Open | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const user = open ? peerInCall(session, open.socketId) : undefined;
  useEffect(() => {
    const listener = (e: Event) => setOpen((e as CustomEvent<Open>).detail);
    addEventListener('tri-open-peer-audio', listener);
    return () => removeEventListener('tri-open-peer-audio', listener);
  }, []);
  useEffect(() => { if (open && !user) close(); }, [open, user, close]);
  return open && user ? <PeerAudioDialog key={user.id} {...open} user={user} bridge={bridge} onClose={close}/> : null;
}
function PeerAudioDialog({ user, bridge, anchor, onClose }: Open & { user: VoiceUser; bridge: Bridge; onClose: () => void }) {
  const { closing, close } = useModalClose(onClose);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dialog = body.current?.closest('[role=dialog]');
    body.current?.querySelector<HTMLInputElement>('input')?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const controls = [...dialog?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') ?? []];
      if (!controls.length) return;
      e.preventDefault(); const current = controls.indexOf(document.activeElement as HTMLElement);
      controls[(current + (e.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
    };
    addEventListener('keydown', key);
    return () => { removeEventListener('keydown', key); if (anchor.isConnected) anchor.focus(); };
  }, [anchor]);
  return <Modal title={`Áudio de ${user.name}`} subtitle="Ajustes de voz locais, válidos enquanto vocês estiverem nesta sala."
    closing={closing} onClose={close}>
    <div ref={body}><PeerAudioControls user={user} bridge={bridge}/></div>
  </Modal>;
}
export function PeerAudioControls({ user, bridge }: { user: VoiceUser; bridge: Bridge }) {
  const [error, setError] = useState('');
  const volume = user.volume ?? 100, pan = user.pan ?? 0, muted = !!user.localMuted;
  const streamVolume = user.streamVolume ?? 100, streamMuted = !!user.streamMuted;
  const change = (fields: { volume?: number; pan?: number; muted?: boolean; streamVolume?: number; streamMuted?: boolean }) => {
    setError(''); bridge.request({ name: 'setPeerAudio', socketId: user.id, ...fields }).catch(e => setError(e.message));
  };
  return <fieldset class="tri-peer-audio" aria-label={`Áudio local de ${user.name}`}>
    <legend>Voz para você</legend>
    <label>Volume do usuário <output>{volume}%</output>
      <input class="tri-slider" aria-label="Volume do usuário" type="range" min={0} max={200} value={volume}
        style={{ '--tri-fill': `${volume / 2}%` }} onInput={e => change({ volume: +e.currentTarget.value })}/>
    </label>
    <label>Posição do áudio <output>{pan === 0 ? 'Centro' : `${Math.abs(pan)}% à ${pan < 0 ? 'esquerda' : 'direita'}`}</output>
      <input class="tri-slider" aria-label="Posição do áudio" type="range" min={-100} max={100} value={pan}
        style={{ '--tri-fill': `${(pan + 100) / 2}%` }} onInput={e => change({ pan: +e.currentTarget.value })}/>
    </label>
    <small>A posição depende de uma saída estéreo.</small>
    <label class="tri-peer-audio__mute"><input type="checkbox" checked={muted} onChange={e => change({ muted: e.currentTarget.checked })}/>Silenciar somente para mim</label>
    {/* Their screen share's audio (Discord's user menu while they stream: "Volume da transmissão" 0-200 and
        "Silenciar transmissão"; the Qt client has both). */}
    {user.live && <>
      <label>Volume da transmissão <output>{streamVolume}%</output>
        <input class="tri-slider" aria-label="Volume da transmissão" type="range" min={0} max={200} value={streamVolume}
          style={{ '--tri-fill': `${streamVolume / 2}%` }} onInput={e => change({ streamVolume: +e.currentTarget.value })}/>
      </label>
      <label class="tri-peer-audio__mute"><input type="checkbox" checked={streamMuted} onChange={e => change({ streamMuted: e.currentTarget.checked })}/>Silenciar transmissão</label>
    </>}
    <button class="tri-peer-audio__reset" disabled={volume === 100 && pan === 0 && !muted && streamVolume === 100 && !streamMuted}
      onClick={() => change({ volume: 100, pan: 0, muted: false, streamVolume: 100, streamMuted: false })}>Redefinir áudio</button>
    {error && <p role="alert">{error}</p>}
  </fieldset>;
}
