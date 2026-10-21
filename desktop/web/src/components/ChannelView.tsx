import type { Bridge } from '../bridge';
import type { Session } from '../protocol';
import { callChannelOf } from '../protocol';
import { VideoTile } from './VideoTile';
import { CallView, callTiles, useCallIdle, type CallFocus } from './CallView';
import type { SessionStore } from '../store';
import { Icon } from './Icon';
import { Tooltip } from './Tooltip';
import { ChatPanel } from './ChatPanel';
import { MemberList } from './MemberList';
import { FriendsView } from './FriendsView';
import { StatePanel } from './ui/StatePanel';
import { WorkspaceHome } from './WorkspaceHome';
import { callStatus } from '../call-status';
import { useEffect, useState } from 'preact/hooks';

// Channel header: module __9293f — 49px (--custom-channel-header-height) with a 1px --border-subtle bottom
// border, 8px padding, 16px text, --text-default.
type ChannelViewProps={ session: Session; bridge: Bridge; store: SessionStore; popout?: boolean; workspace?:boolean };
export function ChannelView(props:ChannelViewProps) {
  const {session,bridge,popout}=props;
  const isHome = !popout && (!session.selectedServerId || session.selectedServerId === '@me');
  return isHome?(props.workspace?<WorkspaceHome session={session} bridge={bridge}/>:<FriendsView session={session} bridge={bridge}/>):<ChannelContent {...props}/>;
}
// Keeping the room view mounted as its own component gives its hooks/listeners a real unmount on Home.
function ChannelContent({ session, bridge, store, popout = false, workspace=false }:ChannelViewProps) {
  const allChannels = session.categories.flatMap(c => c.channels);
  const channel = popout ? callChannelOf(session) : (allChannels.find(c => c.id === session.selectedChannelId) ?? allChannels[0]);
  const inRoom = !!channel && channel.id === session.connectedChannelId && (popout || session.selectedServerId === (session.callServerId ?? session.selectedServerId));
  const [chatOpen, setChatOpen] = useState(workspace);
  const [membersOpen, setMembersOpen] = useState(true);
  const isText = channel ? (channel.kind === 'text' || channel.name.startsWith('#') || channel.name.toLowerCase().includes('chat') || channel.name.toLowerCase().includes('geral') || !channel.name.toLowerCase().includes('jogos')) : false;

  // The core keeps the focus so the popout opens on the same card (observed); it clears it when the call changes.
  const focus: CallFocus = { key: session.callFocus?.key ?? null, filmOpen: session.callFocus?.filmOpen ?? true };
  const setFocus = (next: CallFocus) => bridge.send({ name: 'setCallFocus', key: next.key, filmOpen: next.filmOpen });
  const focused = inRoom && !(session.callPopout && !popout) ? callTiles(session).find(t => t.key === focus.key) : undefined;
  const settings = session.settings;
  const voiceStatus=callStatus(session);
  const quality = focused?.kind === 'stream' && focused.stream
    ? focused.user?.self && settings ? `${settings.shareHd ? 1080 : 720}p ${settings.shareMode === 'screen' ? 15 : settings.shareHd ? 60 : 30}FPS` : `${focused.stream.height}p`
    : '';
  const { idle, active, leave } = useCallIdle();
  useEffect(()=>{if(!inRoom)return;addEventListener('tri-call-activity',active);return()=>removeEventListener('tri-call-activity',active);},[inRoom,active]);
  useEffect(() => { if (!session.connectedChannelId) setChatOpen(false);else if(workspace)setChatOpen(true); }, [session.connectedChannelId,workspace]);
  useEffect(() => {
    const open = () => setChatOpen(true);
    addEventListener('tri-open-chat', open);
    return () => removeEventListener('tri-open-chat', open);
  }, []);
  return (
    <main class="tri-page tri-page--row">
      <div class={`tri-page__main ${inRoom ? 'tri-page__main--call' : ''} ${workspace&&inRoom&&chatOpen?'tri-page__main--conversation':''} ${inRoom && idle ? 'is-idle' : ''}`}
        onFocusCapture={inRoom ? active : undefined} onKeyDown={inRoom ? active : undefined} onMouseMove={inRoom ? active : undefined} onMouseLeave={inRoom ? leave : undefined}>
      <header class="tri-channel-header">
        {channel && <Icon name={isText ? 'TextChannel' : 'VoiceSpeaker'} size={24} className="tri-channel-header__icon" />}
        <h1 class="tri-channel-header__title">{channel?.name ?? ''}</h1>
        {focused && <>
          <span class="tri-channel-header__dot" aria-hidden="true" />
          {focused.user && <span class="tri-avatar tri-avatar--24">{focused.user.avatarUrl ? <img src={focused.user.avatarUrl} alt="" />
            : <span class="tri-avatar__letter">{focused.user.name.slice(0, 1).toUpperCase()}</span>}</span>}
          <span class="tri-channel-header__focus">{focused.kind === 'stream' ? `Tela de ${focused.user?.name ?? focused.stream?.title}` : focused.user?.name}</span>
        </>}
        {focused?.kind === 'stream' && <div class="tri-channel-header__pills">
          {quality && <span class="tri-header-pill tri-header-pill--quality">{quality}</span>}
          <span class="tri-header-pill tri-header-pill--live">AO VIVO</span>
        </div>}
        <div class="tri-channel-header__toolbar">
          {inRoom && (!chatOpen||workspace) && (
            <Tooltip text={chatOpen?'Ocultar chat':'Mostrar chat'} position="bottom">
              <button class="tri-icon-button" aria-label={chatOpen?'Ocultar chat':'Mostrar chat'} aria-expanded={chatOpen} onClick={() => setChatOpen(!chatOpen)}><Icon name="Chat" size={24} /></button>
            </Tooltip>
          )}
          <Tooltip text="Sino de notificações" position="bottom">
            <button class="tri-icon-button" aria-label="Notificações" onClick={() => dispatchEvent(new CustomEvent('tri-preview-notice', { detail: 'Configurações de notificação em desenvolvimento.' }))}><Icon name="Bell" size={20} /></button>
          </Tooltip>
          <Tooltip text="Mensagens fixadas" position="bottom">
            <button class="tri-icon-button" aria-label="Mensagens fixadas" onClick={() => dispatchEvent(new CustomEvent('tri-preview-notice', { detail: 'Mensagens fixadas em desenvolvimento.' }))}><Icon name="Pin" size={20} /></button>
          </Tooltip>
          {!popout && (
            <Tooltip text={membersOpen ? 'Ocultar lista de membros' : 'Mostrar lista de membros'} position="bottom">
              <button class={`tri-icon-button ${membersOpen ? 'is-active' : ''}`} aria-label="Lista de membros" onClick={() => setMembersOpen(!membersOpen)}><Icon name="Group" size={20} /></button>
            </Tooltip>
          )}
          <div class="tri-channel-header__search">
            <input type="text" placeholder="Buscar" aria-label="Buscar no canal" />
            <Icon name="MagnifyingGlass" size={16} className="tri-channel-header__search-icon" />
          </div>
        </div>
      </header>
      {workspace&&inRoom&&voiceStatus.state!=='connected'&&<section class="tri-connection-note" data-tone={voiceStatus.tone}>
        <span role={voiceStatus.state==='error'?'alert':'status'}>{voiceStatus.label}</span>
        {voiceStatus.state==='error'&&channel&&<button type="button" onClick={()=>bridge.send({name:'joinVoice',channelId:channel.id})}>Reconectar voz</button>}
      </section>}
      {inRoom ? (
        <CallView session={session} bridge={bridge} store={store} idle={idle} inPopout={popout} focus={focus} onFocus={setFocus} />
      ) : isText && channel ? (
        <ChatPanel channelName={channel.name} messages={session.chat ?? []} avatars={session.avatars} bridge={bridge} full />
      ) : channel ? (
        <div class="tri-prejoin">
          <h2 class="tri-prejoin__title">{channel.name}</h2>
          <p class="tri-prejoin__subtitle">{channel.users.length ? channel.users.map(u => u.name).join(', ') : 'Ninguém está em voz'}</p>
          <button class="tri-prejoin__join" onClick={() => bridge.send({ name: 'joinVoice', channelId: channel.id })}>Entrar na chamada de voz</button>
        </div>
      ) : workspace?<StatePanel title="Escolha uma conversa" description={session.connection==='connected'?'Selecione um canal na lateral ou crie o primeiro canal deste espaço.':'Aguardando a conexão com o servidor para carregar os canais.'} busy={session.connection!=='connected'}>
        {session.connection==='connected'&&<button type="button" onClick={()=>dispatchEvent(new CustomEvent('tri-open-modal',{detail:{kind:'createChannel',categoryName:'Canais de Voz'}}))}>Criar canal</button>}
      </StatePanel>:<div class="tri-chat" />}
      {workspace&&inRoom&&chatOpen&&channel&&<ChatPanel channelName={channel.name} messages={session.chat??[]} avatars={session.avatars} bridge={bridge} full/>}
      </div>
      {!workspace&&inRoom && chatOpen && channel && (
        <ChatPanel channelName={channel.name} messages={session.chat ?? []} avatars={session.avatars} bridge={bridge} onClose={() => setChatOpen(false)} />
      )}
      {!popout && membersOpen && (
        <MemberList session={session} bridge={bridge} />
      )}
    </main>
  );
}
