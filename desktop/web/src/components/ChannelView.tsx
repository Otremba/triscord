import type { Bridge } from '../bridge';
import type { Session } from '../protocol';
import { callChannelOf } from '../protocol';
import { CallView, callTiles, useCallIdle, type CallFocus } from './CallView';
import type { SessionStore } from '../store';
import { ChannelHeader } from './ChannelHeader';
import { ChatPanel } from './ChatPanel';
import { MemberList } from './MemberList';
import { FriendsView } from './FriendsView';
import { StatePanel } from './ui/StatePanel';
import { WorkspaceHome } from './WorkspaceHome';
import { callStatus } from '../call-status';
import { useEffect, useState } from 'preact/hooks';

// Channel header layout.
type ChannelViewProps={ session: Session; bridge: Bridge; store: SessionStore; popout?: boolean; workspace?:boolean; sidebarOpen?: boolean; onToggleSidebar?: () => void };
export function ChannelView(props:ChannelViewProps) {
  const {session,bridge,popout}=props;
  const isHome = !popout && (!session.selectedServerId || session.selectedServerId === '@me');
  return isHome ? <FriendsView session={session} bridge={bridge}/> : <ChannelContent {...props}/>;
}
// Keeping the room view mounted as its own component gives its hooks/listeners a real unmount on Home.
function ChannelContent({ session, bridge, store, popout = false, workspace=false, sidebarOpen, onToggleSidebar }:ChannelViewProps) {
  const allChannels = session.categories.flatMap(c => c.channels);
  const channel = popout ? callChannelOf(session) : (allChannels.find(c => c.id === session.selectedChannelId) ?? allChannels[0]);
  const inRoom = !!channel && channel.id === session.connectedChannelId && (popout || session.selectedServerId === (session.callServerId ?? session.selectedServerId));
  const [chatOpen, setChatOpen] = useState(workspace);
  const [membersOpen, setMembersOpen] = useState(() => matchMedia('(min-width: 1200px)').matches);
  const isText = channel ? (channel.kind === 'text') : false;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'u' || e.key === ']')) {
        e.preventDefault();
        setMembersOpen(open => !open);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  // The core keeps the focus so the popout opens on the same card (observed); it clears it when the call changes.
  const [localFocus, setLocalFocus] = useState<CallFocus>(() => ({
    key: session.callFocus?.key ?? null,
    filmOpen: session.callFocus?.filmOpen ?? true,
  }));
  useEffect(() => {
    if (session.callFocus !== undefined) {
      setLocalFocus({
        key: session.callFocus?.key ?? null,
        filmOpen: session.callFocus?.filmOpen ?? true,
      });
    }
  }, [session.callFocus]);
  const focus: CallFocus = {
    key: session.callFocus !== undefined ? (session.callFocus?.key ?? null) : localFocus.key,
    filmOpen: session.callFocus !== undefined ? (session.callFocus?.filmOpen ?? true) : localFocus.filmOpen,
  };
  const setFocus = (next: CallFocus) => {
    setLocalFocus(next);
    bridge.send({ name: 'setCallFocus', key: next.key, filmOpen: next.filmOpen });
  };
  const focused = inRoom && !(session.callPopout && !popout) ? callTiles(session).find(t => t.key === focus.key) : undefined;
  const settings = session.settings;
  const voiceStatus=callStatus(session);
  const quality = focused?.kind === 'stream' && focused.stream
    ? focused.user?.self && settings ? `${settings.shareHd ? 1080 : 720}p ${settings.shareMode === 'screen' ? 15 : settings.shareHd ? 60 : 30}FPS` : `${focused.stream.height}p`
    : '';
  const { idle: inactive, active, leave } = useCallIdle();
  const idle = inactive && (!workspace || !!session.callFullscreen);
  useEffect(()=>{if(!inRoom)return;addEventListener('tri-call-activity',active);return()=>removeEventListener('tri-call-activity',active);},[inRoom,active]);
  useEffect(() => { if (!session.connectedChannelId) setChatOpen(false);else if(workspace)setChatOpen(true); }, [session.connectedChannelId,workspace]);
  useEffect(() => {
    const open = () => setChatOpen(true);
    addEventListener('tri-open-chat', open);
    return () => removeEventListener('tri-open-chat', open);
  }, []);
  return (
    <main class="tri-page tri-page--row">
      <div class={`tri-page__main ${inRoom ? 'tri-page__main--call' : ''} ${workspace&&inRoom&&chatOpen?'tri-page__main--conversation':''} ${focused ? 'tri-page__main--focused' : ''} ${inRoom && idle ? 'is-idle' : ''}`}
        onFocusCapture={inRoom ? active : undefined} onKeyDown={inRoom ? active : undefined} onMouseMove={inRoom ? active : undefined} onMouseLeave={inRoom ? leave : undefined}>
      <ChannelHeader channel={channel} focused={focused} quality={quality}
        showChat={inRoom && (!chatOpen || workspace)} chatOpen={chatOpen}
        showMembers={!popout} membersOpen={membersOpen}
        sidebarOpen={sidebarOpen} onToggleSidebar={onToggleSidebar}
        onToggleChat={() => setChatOpen(open => !open)} onToggleMembers={() => setMembersOpen(open => !open)}/>
      {workspace&&inRoom&&voiceStatus.state!=='connected'&&<section class="tri-connection-note" data-tone={voiceStatus.tone}>
        <span role={voiceStatus.state==='error'?'alert':'status'}>{voiceStatus.label}</span>
        {voiceStatus.state==='error'&&channel&&<button type="button" onClick={()=>bridge.send({name:'joinVoice',channelId:channel.id})}>Reconectar voz</button>}
      </section>}
      {inRoom ? (
        <CallView session={session} bridge={bridge} store={store} idle={idle} inPopout={popout} focus={focus} onFocus={setFocus} />
      ) : channel ? (
        <ChatPanel key={`${session.selectedServerId}:${channel.id}`} channelName={channel.name} messages={session.chat ?? []} avatars={session.avatars} bridge={bridge} full />
      ) : workspace?<StatePanel title="Escolha uma conversa" description={session.connection==='connected'?'Selecione um canal na lateral ou crie o primeiro canal deste espaço.':'Aguardando a conexão com o servidor para carregar os canais.'} busy={session.connection!=='connected'}>
        {session.connection==='connected'&&<button type="button" onClick={()=>dispatchEvent(new CustomEvent('tri-open-modal',{detail:{kind:'createChannel',categoryName:'Canais de Voz'}}))}>Criar canal</button>}
      </StatePanel>:<div class="tri-chat" />}
      {workspace&&inRoom&&chatOpen&&channel&&<ChatPanel key={`${session.selectedServerId}:${channel.id}`} channelName={channel.name} messages={session.chat??[]} avatars={session.avatars} bridge={bridge} full conversation/>}
      </div>
      {!workspace&&inRoom && chatOpen && channel && (
        <ChatPanel key={`${session.selectedServerId}:${channel.id}`} channelName={channel.name} messages={session.chat ?? []} avatars={session.avatars} bridge={bridge} onClose={() => setChatOpen(false)} />
      )}
      {!popout && membersOpen && (
        <MemberList session={session} bridge={bridge} onClose={() => setMembersOpen(false)} />
      )}
    </main>
  );
}
