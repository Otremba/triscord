import type { Bridge } from './bridge';
import { type SessionStore, useSession } from './store';
import { PopoutBar, ResizeEdges, TitleBar } from './components/TitleBar';
import { ServerRail } from './components/ServerRail';
import { ChannelSidebar } from './components/ChannelSidebar';
import { AccountPopoverHost } from './components/AccountPopover';
import { PeerAudioHost } from './components/PeerAudio';
import { ParticipantProfileHost } from './components/ParticipantProfile';
import { AccountPanel } from './components/AccountPanel';
import { ChannelView } from './components/ChannelView';
import { LoginScreen } from './components/LoginScreen';
import { ServerModal } from './components/ServerModal';
import { CreateChannelModal } from './components/CreateChannelModal';
import { InviteModal } from './components/InviteModal';
import { ContextMenuHost } from './components/ContextMenu';
import { Settings } from './components/Settings';
import { CameraPreviewModal } from './components/CameraPreview';
import { SoundboardHost } from './components/Soundboard';
import { ProfileEditor } from './components/ProfileEditor';
import { AudioMenuHost } from './components/AudioMenu';
import { ServerRemovalModal } from './components/ServerRemovalModal';
import { DeleteMessageModal } from './components/DeleteMessageModal';
import type { ChatMessage } from './protocol';
import { useEffect, useLayoutEffect, useState } from 'preact/hooks';

// The call popout window loads this page with ?popout=call: title bar and the call only (Discord's
// PopoutWindowChannelCall), with the menus and cards the call opens.
const POPOUT = new URLSearchParams(location.search).get('popout') === 'call';

type OpenModal = { kind: 'createChannel'; categoryName: string } | { kind: 'invite'; serverId: string; serverName: string }
  | { kind: 'deleteMessage'; message: ChatMessage } | { kind: 'deleteServer' | 'leaveServer'; serverId: string; serverName: string };

// Grid from Discord's app layout (module __5e434): title bar across the top; guild list and channel list
// inside the sidebar (the account panel floats over both); the page fills the rest.
export function App({ store, bridge }: { store: SessionStore; bridge: Bridge }) {
  const session = useSession(store);
  const [serverModal, setServerModal] = useState(false);
  useEffect(() => { const open = () => setServerModal(true); addEventListener('tri-open-server-modal', open); return () => removeEventListener('tri-open-server-modal', open); }, []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [cameraPreviewOpen, setCameraPreviewOpen] = useState(false);
  useEffect(() => { const open = () => setCameraPreviewOpen(true); addEventListener('tri-open-camera-preview',open); return () => removeEventListener('tri-open-camera-preview',open); }, []);
  const [profileOpen,setProfileOpen]=useState(false);
  useEffect(()=>{const open=()=>setProfileOpen(true);addEventListener('tri-open-profile',open);return()=>removeEventListener('tri-open-profile',open);},[]);
  useEffect(() => { const open = () => setSettingsOpen(true); addEventListener('tri-open-settings', open); return () => removeEventListener('tri-open-settings', open); }, []);
  // Each window has its own fullscreen: the main one (callFullscreen) and the call popout (callPopoutFullscreen).
  const fullscreen = POPOUT ? session?.callPopoutFullscreen : session?.callFullscreen;
  useLayoutEffect(()=>{dispatchEvent(new Event('tri-layout-changed'));},[fullscreen]);
  useEffect(()=>{
    if(!fullscreen)return;
    const escape=(e:KeyboardEvent)=>{
      if(e.key!=='Escape'||document.querySelector('.tri-modal-backdrop,.tri-menu,.tri-audio-menu,.tri-soundboard,.tri-account-popover'))return;
      e.preventDefault();bridge.send({name:'setCallFullscreen',on:false});
    };
    addEventListener('keydown',escape);return()=>removeEventListener('keydown',escape);
  },[fullscreen,bridge]);
  // Theme chosen in Aparência (core setting); the URL may still force one for fixtures and comparisons.
  const theme = session?.settings?.theme;
  useEffect(() => { if (theme && !new URLSearchParams(location.search).has('theme')) document.documentElement.dataset.theme = theme; }, [theme]);
  // Core events the components listen to as DOM events.
  useEffect(() => store.onEvent(event => { if (event.name === 'chatRateLimited') dispatchEvent(new Event('tri-chat-rate-limited')); if(event.name==='callActivity')dispatchEvent(new Event('tri-call-activity')); }), [store]);
  // Modals opened from the sidebar ("+" of a category, invite button of the server header).
  const [modal, setModal] = useState<OpenModal | null>(null);
  useEffect(()=>{if(session?.auth?.state==='signedOut'){setCameraPreviewOpen(false);setSettingsOpen(false);setProfileOpen(false);setServerModal(false);setModal(null);}},[session?.auth?.state]);
  useEffect(() => {
    const open = (e: Event) => setModal((e as CustomEvent<OpenModal>).detail);
    addEventListener('tri-open-modal', open);
    return () => removeEventListener('tri-open-modal', open);
  }, []);
  if (!session) return <div class="tri-app tri-app--loading"><PopoutBar bridge={bridge} className="tri-titlebar--overlay" /><ResizeEdges bridge={bridge} /></div>;
  if (session.auth && session.auth.state !== 'signedIn') return <>
    <LoginScreen auth={session.auth} bridge={bridge} />
    <PopoutBar bridge={bridge} className="tri-titlebar--overlay" /><ResizeEdges bridge={bridge} />
  </>;
  const server = session.servers.find(s => s.id === session.selectedServerId);
  if (POPOUT) return (
    <div class={`tri-app tri-app--popout ${fullscreen ? 'tri-app--call-fullscreen' : ''}`}>
      {fullscreen && <div class="tri-fullscreen-hint" role="status">Pressione Esc para sair da tela cheia</div>}
      <PopoutBar bridge={bridge} />
      {!fullscreen && <ResizeEdges bridge={bridge} />}
      <div class="tri-content">{session.connectedChannelId && <ChannelView session={session} bridge={bridge} store={store} popout />}</div>
      <ContextMenuHost />
      {cameraPreviewOpen && <CameraPreviewModal bridge={bridge} store={store} onClose={()=>setCameraPreviewOpen(false)}/>}
      {settingsOpen && <Settings session={session} bridge={bridge} store={store} onClose={() => setSettingsOpen(false)} />}
      {profileOpen && <ProfileEditor session={session} bridge={bridge} onClose={()=>setProfileOpen(false)}/>}
      <SoundboardHost session={session} bridge={bridge} />
      <AudioMenuHost session={session} bridge={bridge}/>
      <ParticipantProfileHost session={session} bridge={bridge}/>
      <PeerAudioHost session={session} bridge={bridge}/>
    </div>
  );
  return (
    <div class={`tri-app ${session.callFullscreen ? 'tri-app--call-fullscreen' : ''}`}>
      {session.callFullscreen && <div class="tri-fullscreen-hint" role="status">Pressione Esc para sair da tela cheia</div>}
      <TitleBar server={server} bridge={bridge} />
      {!session.callFullscreen && <ResizeEdges bridge={bridge} />}
      <div class="tri-content">
        <aside class="tri-sidebar">
          <ServerRail servers={session.servers} selectedId={session.selectedServerId} callServerId={session.callServerId} bridge={bridge}
            voice={session.connectedChannelId ? (session.sharing ? 'screen' : 'voice') : undefined} />
          <ChannelSidebar session={session} bridge={bridge} />
          <AccountPanel session={session} bridge={bridge} />
        </aside>
        <ChannelView session={session} bridge={bridge} store={store} />
      </div>
      {modal?.kind === 'createChannel' && <CreateChannelModal bridge={bridge} categoryName={modal.categoryName} onClose={() => setModal(null)} />}
      {modal?.kind === 'deleteMessage' && <DeleteMessageModal bridge={bridge} message={modal.message} onClose={() => setModal(null)} />}
      {(modal?.kind === 'deleteServer' || modal?.kind === 'leaveServer') && <ServerRemovalModal bridge={bridge} serverId={modal.serverId} serverName={modal.serverName}
        mode={modal.kind === 'deleteServer' ? 'delete' : 'leave'} onClose={() => setModal(null)} />}
      {modal?.kind === 'invite' && <InviteModal bridge={bridge} serverId={modal.serverId} serverName={modal.serverName} onClose={() => setModal(null)} />}
      {settingsOpen && <Settings session={session} bridge={bridge} store={store} onClose={() => setSettingsOpen(false)} />}
      {cameraPreviewOpen && <CameraPreviewModal bridge={bridge} store={store} onClose={()=>setCameraPreviewOpen(false)}/>}
      <ContextMenuHost />
      {profileOpen && <ProfileEditor session={session} bridge={bridge} onClose={()=>setProfileOpen(false)}/>}
      <SoundboardHost session={session} bridge={bridge} />
      <AudioMenuHost session={session} bridge={bridge}/>
      <AccountPopoverHost session={session} bridge={bridge}/>
      <ParticipantProfileHost session={session} bridge={bridge}/>
      <PeerAudioHost session={session} bridge={bridge}/>
      {serverModal && <ServerModal bridge={bridge} displayName={session.account.displayName} onClose={() => setServerModal(false)} />}
    </div>
  );
}
