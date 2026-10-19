import type { Bridge } from '../bridge';
import type { Session, VoiceUser } from '../protocol';
import { callChannelOf } from '../protocol';
import { openContextMenu, type MenuEntry } from './ContextMenu';
import { openParticipantProfile } from './ParticipantProfile';
import { openPeerAudio, peerInCall } from './PeerAudio';

// `anchor`: element the profile card opens next to (default: the element that got the event).
export function openParticipantMenu(event: MouseEvent, user: VoiceUser, session: Session, bridge: Bridge, anchor = event.currentTarget as HTMLElement) {
  // Discord's user menu (audit 18/10): "Perfil" first; for yourself, "Silenciar" and "Desativar áudio" checkboxes (your
  // own mute/deafen) in the next group.
  const entries: MenuEntry[] = [{ kind: 'item', label: 'Perfil', action: () => {
    if (user.self) dispatchEvent(new Event('tri-open-profile')); else openParticipantProfile(user.id, anchor);
  } }];
  if (user.self) {
    entries.push({ kind: 'separator' });
    entries.push({ kind: 'item', label: 'Silenciar', checked: !!session.muted, action: () => bridge.send({ name: 'setMuted', muted: !session.muted }) });
    entries.push({ kind: 'item', label: 'Desativar áudio', checked: !!session.deafened, action: () => bridge.send({ name: 'setDeafened', deafened: !session.deafened }) });
  }
  // Volumes right in the menu, as Discord: "Volume do usuário" (0-200%) and, while they stream, "Volume da transmissão"
  // (18/10: the stream volume was only reachable inside the profile card).
  if (peerInCall(session, user.id) && !user.self) {
    entries.push({ kind: 'separator' });
    entries.push({ kind: 'slider', label: 'Volume do usuário', value: user.volume ?? 100, max: 200,
      onChange: volume => bridge.send({ name: 'setPeerAudio', socketId: user.id, volume }) });
    if (user.live) entries.push({ kind: 'slider', label: 'Volume da transmissão', value: user.streamVolume ?? 100, max: 200,
      onChange: streamVolume => bridge.send({ name: 'setPeerAudio', socketId: user.id, streamVolume }) });
  }
  if (peerInCall(session, user.id)) entries.push({ kind: 'item', label: 'Áudio do participante', icon: 'Headphones', action: () => openPeerAudio(user.id, anchor) });
  if (peerInCall(session, user.id) && user.live) entries.push({ kind: 'item', label: 'Silenciar transmissão', checked: !!user.streamMuted,
    action: () => bridge.send({ name: 'setPeerAudio', socketId: user.id, streamMuted: !user.streamMuted }) });
  for (const stream of session.streams ?? []) if (stream.ownerId === user.id) {
    const noun = stream.kind === 'screen' ? 'transmissão' : 'vídeo';
    entries.push({kind:'item',label:stream.hidden ? `Mostrar ${noun}` : `Ocultar ${noun} para mim`,
      action:()=>bridge.send({name:'setStreamHidden',streamId:stream.id,hidden:!stream.hidden})});
  }
  // Moderation group (Discord's useAdminActionItems, module 291247, the last group of "user-context"): "Silenciar voz
  // no servidor" (checkbox, danger, also for yourself) and "Desconectar" (danger, not for yourself). triscord's hub
  // gives them to the room owner, per room, under Discord's label. Its "Desativar áudio no servidor" has no hub equivalent.
  const call = callChannelOf(session);
  const self = call?.users.find(u => u.self);
  if (call && self && call.ownerId === self.id && call.users.some(u => u.id === user.id)) {
    entries.push({ kind: 'separator' });
    entries.push({ kind: 'item', label: 'Silenciar voz no servidor', danger: true, checked: !!user.serverMuted,
      action: () => bridge.send({ name: 'setServerMuted', socketId: user.id, muted: !user.serverMuted }) });
    if (!user.self) entries.push({ kind: 'item', label: 'Desconectar', danger: true,
      action: () => bridge.send({ name: 'disconnectParticipant', socketId: user.id }) });
  }
  openContextMenu(event, entries, { label: user.name });
}
