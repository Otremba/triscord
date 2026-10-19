import type { Bridge } from '../bridge';
import type { Session } from '../protocol';
import { callChannelOf } from '../protocol';
import { VideoTile } from './VideoTile';
import { CallView, callTiles, useCallIdle, type CallFocus } from './CallView';
import type { SessionStore } from '../store';
import { Icon } from './Icon';
import { Tooltip } from './Tooltip';
import { ChatPanel } from './ChatPanel';
import { useEffect, useState } from 'preact/hooks';

// Channel header: module __9293f — 49px (--custom-channel-header-height) with a 1px --border-subtle bottom
// border, 8px padding, 16px text, --text-default.
// A voice channel page has no composer of its own (observed, reference/discord-voicechat-*.png): its chat is the
// right panel opened by "Mostrar chat" in the header (tooltip below) or "Abrir chat" in the channel row.
// triscord rooms only have chat while you are in them, so the button shows in the room you are in.
// `popout`: the call popout window, which always shows the call it was opened for.
export function ChannelView({ session, bridge, store, popout = false }: { session: Session; bridge: Bridge; store: SessionStore; popout?: boolean }) {
  const channel = popout ? callChannelOf(session) : session.categories.flatMap(c => c.channels).find(c => c.id === session.selectedChannelId);
  const inRoom = !!channel && channel.id === session.connectedChannelId && (popout || session.selectedServerId === (session.callServerId ?? session.selectedServerId));
  const [chatOpen, setChatOpen] = useState(false);
  // The core keeps the focus so the popout opens on the same card (observed); it clears it when the call changes.
  const focus: CallFocus = { key: session.callFocus?.key ?? null, filmOpen: session.callFocus?.filmOpen ?? true };
  const setFocus = (next: CallFocus) => bridge.send({ name: 'setCallFocus', key: next.key, filmOpen: next.filmOpen });
  // Header of the visão ampliada (SHARE.md vid-7, Qt updateFocusHeader): a 4px dot, the owner's 24px avatar and
  // "Tela de <nome>" (or the name) after the channel; for a stream, "720p 30FPS" (p lower case; the frame rate is known
  // only for our own share) and "AO VIVO" at the right, before the chat button.
  const focused = inRoom && !(session.callPopout && !popout) ? callTiles(session).find(t => t.key === focus.key) : undefined;
  const settings = session.settings;
  const quality = focused?.kind === 'stream' && focused.stream
    ? focused.user?.self && settings ? `${settings.shareHd ? 1080 : 720}p ${settings.shareMode === 'screen' ? 15 : settings.shareHd ? 60 : 30}FPS` : `${focused.stream.height}p`
    : '';
  const { idle, active, leave } = useCallIdle();
  useEffect(()=>{if(!inRoom)return;addEventListener('tri-call-activity',active);return()=>removeEventListener('tri-call-activity',active);},[inRoom,active]);
  useEffect(() => { if (!session.connectedChannelId) setChatOpen(false); }, [session.connectedChannelId]);
  useEffect(() => {
    const open = () => setChatOpen(true);
    addEventListener('tri-open-chat', open);
    return () => removeEventListener('tri-open-chat', open);
  }, []);
  return (
    <main class="tri-page tri-page--row">
      <div class={`tri-page__main ${inRoom ? 'tri-page__main--call' : ''} ${inRoom && idle ? 'is-idle' : ''}`}
        onFocusCapture={inRoom ? active : undefined} onKeyDown={inRoom ? active : undefined} onMouseMove={inRoom ? active : undefined} onMouseLeave={inRoom ? leave : undefined}>
      <header class="tri-channel-header">
        {channel && <Icon name="VoiceSpeaker" size={20} className="tri-channel-header__icon" />}
        <h1 class="tri-channel-header__title">{channel?.name ?? ''}</h1>
        {focused && <>
          <span class="tri-channel-header__dot" aria-hidden="true" />
          {focused.user && <span class="tri-avatar tri-avatar--24">{focused.user.avatarUrl ? <img src={focused.user.avatarUrl} alt="" />
            : <span class="tri-avatar__letter">{focused.user.name.slice(0, 1).toUpperCase()}</span>}</span>}
          <span class="tri-channel-header__focus">{focused.kind === 'stream' ? `Tela de ${focused.user?.name ?? focused.stream?.title}` : focused.user?.name}</span>
        </>}
        {/* Observed (17/10): one 16px capsule, the grey quality half rounded at the left, the red half at the right. */}
        {focused?.kind === 'stream' && <div class="tri-channel-header__pills">
          {quality && <span class="tri-header-pill tri-header-pill--quality">{quality}</span>}
          <span class="tri-header-pill tri-header-pill--live">AO VIVO</span>
        </div>}
        {inRoom && !chatOpen && (
          <div class="tri-channel-header__toolbar">
            <Tooltip text="Mostrar chat" position="bottom">
              <button class="tri-icon-button" aria-label="Mostrar chat" onClick={() => setChatOpen(true)}><Icon name="Chat" size={24} /></button>
            </Tooltip>
          </div>
        )}
      </header>
      {inRoom ? <CallView session={session} bridge={bridge} store={store} idle={idle} inPopout={popout} focus={focus} onFocus={setFocus} /> : channel ? (
        // Voice channel before joining (observed, motion/share-stop-leave): gradient stage, the channel name as a
        // heading, "Ninguém está em voz" (zSqdrS) or the people in it, and a white "Entrar na chamada de voz"
        // (gpqgah). INFERRED: the gradient follows the measured corner colours; Discord's art is not reproduced.
        <div class="tri-prejoin">
          <h2 class="tri-prejoin__title">{channel.name}</h2>
          <p class="tri-prejoin__subtitle">{channel.users.length ? channel.users.map(u => u.name).join(', ') : 'Ninguém está em voz'}</p>
          <button class="tri-prejoin__join" onClick={() => bridge.send({ name: 'joinVoice', channelId: channel.id })}>Entrar na chamada de voz</button>
        </div>
      ) : <div class="tri-chat" />}
      </div>
      {inRoom && chatOpen && channel && (
        <ChatPanel channelName={channel.name} messages={session.chat ?? []} avatars={session.avatars} bridge={bridge} onClose={() => setChatOpen(false)} />
      )}
    </main>
  );
}
