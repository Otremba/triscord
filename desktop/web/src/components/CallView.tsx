import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import type { Session, VideoStream, VoiceUser } from '../protocol';
import { callChannelOf } from '../protocol';
import type { SessionStore } from '../store';
import { openParticipantMenu } from './ParticipantMenu';
import { openParticipantProfile } from './ParticipantProfile';
import { Icon } from './Icon';
import { openContextMenu } from './ContextMenu';
import { SharePicker } from './SharePicker';
import { VideoTile } from './VideoTile';
import { setOccluders, setStageOccluders } from '../video';
import { Tooltip } from './Tooltip';
import { openSoundboard } from './Soundboard';
import { openAudioMenu } from './AudioMenu';

// Call view of the connected voice channel (CALLS.md, discord-call-view-client.png):
//   black stage; 16:9 cards (radius 8) with an 80px avatar in the middle; a 32px pill with the name in the
//   bottom-left corner (12px inset), a muted/deafened badge on it; a speaking card gets a green outline.
//   Video (camera/screen) cards are VideoTile: a native window draws the frames over them (path A).
// Grid: INFERRED — the most columns that keep 16:9 cards as large as possible, 8px gaps (only a single
// card was observed in Discord).
function ParticipantCard({ user, session, bridge, role = 'grid', style, onFocus }: { user: VoiceUser; session: Session; bridge: Bridge;
  role?: 'grid' | 'stage' | 'film'; style?: Record<string, string>; onFocus?: () => void }) {
  // The core keeps a small PNG for account/sidebar thumbnails. In the call,
  // reuse the validated original GIF already present in our profile so the
  // browser can animate it without sending individual frames over the bridge.
  const avatar = user.self
    ? session.profile?.avatarDataUrl?.startsWith('data:image/gif;base64,')
      ? session.profile.avatarDataUrl : session.account.avatarUrl
    : (user.accountId && session.avatars?.[user.accountId]?.animated) || user.avatarUrl;
  return (
    <div class={`tri-call-card tri-call-card--${role} ${user.speaking ? 'is-speaking' : ''}`} style={style} aria-label={user.name} role="button" tabIndex={0} onContextMenu={e=>openParticipantMenu(e,user,session,bridge)}
      onClick={e=>onFocus ? onFocus() : user.self ? dispatchEvent(new Event('tri-open-profile')) : openParticipantProfile(user.id,e.currentTarget)}
      onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();e.currentTarget.click();}}}>
      <span class="tri-avatar tri-avatar--80">{avatar ? <img src={avatar} alt=""/> : <span class="tri-avatar__letter">{user.name.slice(0, 1).toUpperCase()}</span>}</span>
      <span class="tri-call-card__pill">
        {user.deafened ? <Icon name="HeadphonesDeafened" size={20} /> : user.serverMuted || user.muted || user.localMuted ? <Icon name="MicrophoneMuted" size={20} className={user.serverMuted ? 'is-server' : undefined} /> : null}
        <span>{user.name}</span>
      </span>
    </div>
  );
}

// Controls bar (CALLS.md + module _f1ceac): centred 16px above the bottom; 50px capsules with a 1px border;
// 40px buttons, 20px icons, radius 8; microphone = 36px button + 1px gap + 16px caret ("attached"),
// red glow when muted (--opacity-red-12 / --red-400); camera and share green when active; 64x50 red
// "Desconectar" (--control-critical-primary-*).
// Observed (motion/call-controls-show, share-start): two capsules — [microphone, camera] and [share, activities,
// soundboard, "Mais opções"] — then "Desconectar"; "Convidar para voz" icon at the bottom-left, pop-out and
// "Tela cheia" at the bottom-right. Camera shows VideoSlash while off. triscord keeps what it can do: no camera
// caret (no device menu yet), activities, "Mais opções" or pop-out. Fullscreen uses the native window.
// Bottom-right (module 540462 renderBottomRight): [participant volume], "Mostrar sempre"/"Remover do topo" (only in
// the popout window, module 619344), the popout button (module 128286: "Nova Janela", or "Voltar para o Discord" with
// the icon turned 180deg while the popout is open; offered in a call with video), then "Tela cheia" (not while the
// main window while the call is popped out; the popout window has its own). triscord: "Voltar para o Triscord".
// Audit 18/10 (Discord today, alone without video): the pop-out button is there without video too; the camera has a
// caret opening "Câmera" (device submenu), "Prévia da câmera" and "Configurações de vídeo"; the second capsule ends with
// "Mais opções" (…): "Convidar para voz", checkboxes "Exibição em grade", "Mostrar Minha Própria Câmera", "Mostrar
// participantes sem vídeo", "Mostrar prévia de novas mensagens", then "Configurações de voz e vídeo". triscord offers the
// ones it can do (local camera preview; no grid toggle, own-camera toggle or message previews yet).
function cameraMenu(event: MouseEvent, session: Session, bridge: Bridge) {
  const devices = session.settings?.cameraDevices ?? [], selected = session.settings?.cameraDevice ?? '';
  const name = (id: string) => id ? devices.find(d => d.id === id)?.name ?? 'Dispositivo Indisponível' : 'Padrão do Windows';
  const r = (event.currentTarget as HTMLElement).getBoundingClientRect();
  openContextMenu(event, [
    { kind: 'item', label: 'Câmera', subtext: name(selected), submenu: [{ id: '', name: 'Padrão do Windows' }, ...devices].map(d => ({
      kind: 'item' as const, label: d.name, checked: d.id === selected, action: () => bridge.send({ name: 'setSetting', key: 'cameraDevice', value: d.id }) })), action: () => {} },
    { kind: 'separator' },
    { kind: 'item', label: 'Prévia da câmera', action: () => dispatchEvent(new Event('tri-open-camera-preview')) },
    { kind: 'item', label: 'Configurações de vídeo', icon: 'Settings', action: () => dispatchEvent(new Event('tri-open-settings')) },
  ], { label: 'Opções de vídeo', at: { x: r.left, y: r.top - 8 - 144 } });
}
function moreMenu(event: MouseEvent, invite: (() => void) | undefined, showNonVideo: boolean, setShowNonVideo: (on: boolean) => void) {
  const r = (event.currentTarget as HTMLElement).getBoundingClientRect();
  openContextMenu(event, [
    ...(invite ? [{ kind: 'item' as const, label: 'Convidar para voz', icon: 'UserPlus' as const, action: invite }, { kind: 'separator' as const }] : []),
    { kind: 'item', label: 'Mostrar participantes sem vídeo', checked: showNonVideo, action: () => setShowNonVideo(!showNonVideo) },
    { kind: 'separator' },
    { kind: 'item', label: 'Configurações de voz e vídeo', icon: 'Settings', action: () => dispatchEvent(new Event('tri-open-settings')) },
  ], { label: 'Mais opções', at: { x: r.left - 100, y: r.top - 8 - (invite ? 150 : 104) } });
}
function ControlsBar({ session, bridge, onShare, invite, inPopout, showNonVideo, setShowNonVideo }: { session: Session; bridge: Bridge; onShare: () => void; invite?: () => void;
  inPopout: boolean; showNonVideo: boolean; setShowNonVideo: (on: boolean) => void }) {
  const popoutOpen = !!session.callPopout, onTop = !!session.callPopoutOnTop;
  const canPopout = true;
  const fullscreen = inPopout ? !!session.callPopoutFullscreen : !!session.callFullscreen;
  return (
    <div class="tri-call-bottom">
      <div class="tri-call-bottom__left">
        {invite && (
          <Tooltip text="Convidar para voz">
            <button class="tri-call-icon-button" aria-label="Convidar para voz" onClick={invite}><Icon name="UserPlus" size={24} /></button>
          </Tooltip>
        )}
      </div>
    <div class="tri-call-controls" role="toolbar" aria-label="Controles da chamada">
      <div class="tri-call-capsule">
        <div class="tri-call-attached">
          <button class={`tri-call-button tri-call-button--mic ${session.muted ? 'is-red' : ''}`}
            aria-label={session.muted ? 'Dessilenciar' : 'Silenciar'} aria-pressed={session.muted}
            onClick={() => bridge.send({ name: 'setMuted', muted: !session.muted })}>
            <Icon name={session.muted ? 'MicrophoneMuted' : 'Microphone'} size={20} />
          </button>
          <button class={`tri-call-button tri-call-button--caret ${session.muted ? 'is-red' : ''}`} aria-label="Opções de entrada"
            onClick={e => openAudioMenu(e.currentTarget,'input')}>
            <Icon name="ChevronSmallDown" size={16} />
          </button>
        </div>
        <Tooltip text={session.cameraPending ? 'Cancelar ativação da câmera' : session.camera ? 'Desativar câmera' : 'Ativar câmera'}>
          <button class={`tri-call-button ${session.camera ? 'is-green' : ''}`} aria-label={session.cameraPending ? 'Cancelar ativação da câmera' : session.camera ? 'Desativar câmera' : 'Ativar câmera'}
            aria-pressed={!!session.camera} onClick={() => bridge.send({ name: 'setCamera', on: !(session.camera || session.cameraPending) })}>
            <Icon name={session.camera ? 'Video' : 'VideoSlash'} size={20} />
          </button>
        </Tooltip>
        <button class="tri-call-button tri-call-button--caret" aria-label="Opções de vídeo" onClick={e => cameraMenu(e, session, bridge)}>
          <Icon name="ChevronSmallDown" size={16} />
        </button>
      </div>
      <div class="tri-call-capsule">
        <Tooltip text={session.sharing ? 'Parar de transmitir' : 'Compartilhar tela'}>
          <button class={`tri-call-button ${session.sharing ? 'is-green' : ''}`} aria-label={session.sharing ? 'Parar de transmitir' : 'Compartilhar tela'}
            aria-pressed={!!session.sharing} onClick={() => (session.sharing ? bridge.send({ name: 'stopScreenShare' }) : onShare())}>
            <Icon name={session.sharing ? 'ScreenX' : 'ScreenArrow'} size={20} />
          </button>
        </Tooltip>
        <Tooltip text="Abrir efeitos sonoros"><button class="tri-call-button" aria-label="Abrir efeitos sonoros" onClick={e => openSoundboard(e.currentTarget)}><Icon name="Soundboard" size={20} /></button></Tooltip>
        <Tooltip text="Mais opções"><button class="tri-call-button" aria-label="Mais opções" aria-haspopup="menu"
          onClick={e => moreMenu(e, invite, showNonVideo, setShowNonVideo)}><Icon name="MoreHorizontal" size={20} /></button></Tooltip>
      </div>
      <Tooltip text="Desconectar">
        <button class="tri-call-disconnect" aria-label="Desconectar" onClick={() => bridge.send({ name: 'leaveVoice' })}>
          <Icon name="Disconnect" size={20} />
        </button>
      </Tooltip>
    </div>
      <div class="tri-call-bottom__right">
        {inPopout && (
          <Tooltip text={onTop ? 'Remover do topo' : 'Mostrar sempre'}>
            <button class="tri-call-icon-button" aria-label={onTop ? 'Remover do topo' : 'Mostrar sempre'} aria-pressed={onTop}
              onClick={() => bridge.send({ name: 'setCallPopoutOnTop', on: !onTop })}><Icon name={onTop ? 'PinSlash' : 'Pin'} size={24} /></button>
          </Tooltip>
        )}
        {canPopout && (
          <Tooltip text={popoutOpen ? 'Voltar para o Triscord' : 'Nova Janela'}>
            <button class={`tri-call-icon-button ${popoutOpen ? 'is-pop-in' : ''}`} aria-label={popoutOpen ? 'Voltar para o Triscord' : 'Nova Janela'}
              onClick={() => bridge.send({ name: 'setCallPopout', on: !popoutOpen })}><Icon name="WindowLaunch" size={24} /></button>
          </Tooltip>
        )}
        {(inPopout || !popoutOpen) && (
        <Tooltip text={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'}>
          <button class="tri-call-icon-button" aria-label={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'} aria-pressed={fullscreen}
            onClick={()=>bridge.send({name:'setCallFullscreen',on:!fullscreen})}><Icon name="Fullscreen" size={24}/></button>
        </Tooltip>
        )}
      </div>
    </div>
  );
}

// Idle: Discord hides the call header and controls after 2s without pointer movement (IdleProvider timeout:2e3 in
// the call/PiP views) and shows them again on movement; measured fade ~200ms (motion/call-controls-show).
export function useCallIdle(ms = 2000) {
  const [idle, setIdle] = useState(false);
  const timer = useRef<number>();
  const active = useCallback(() => { setIdle(false); clearTimeout(timer.current); timer.current = window.setTimeout(() => setIdle(true), ms); }, [ms]);
  useEffect(() => { active(); return () => clearTimeout(timer.current); }, [active]);
  return { idle, active, leave: () => { clearTimeout(timer.current); setIdle(true); } };
}

// Largest 16:9 card size that fits `count` cards in the stage, and the column count that achieves it.
function layoutFor(count: number, width: number, height: number): { columns: number; cardWidth: number } {
  let best = { columns: 1, cardWidth: 0 };
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const cardWidth = Math.floor(Math.min((width - (columns - 1) * 8) / columns, ((height - (rows - 1) * 8) / rows) * 16 / 9));
    if (cardWidth > best.cardWidth) best = { columns, cardWidth };
  }
  return best;
}

// Visão ampliada (SHARE.md vid-7/vid-9, geometry of the Qt ParticipantPane measured on Discord at 1264x892): the call
// area runs from the header's bottom to 50px above the page bottom; the focused card fills it (aspect kept, centred)
// minus 119px while the filmstrip is open; filmstrip thumbnails 195x112, 8px apart, centred, their top 182px (popout: 141px) above the
// area's end, with every card (the focused one included); a 62x32 toggle (radius 16, black 57%) with a chevron and the
// group icon at filmstrip top + 8, or 170px (popout: 129px) above the area's end when collapsed, where the user's own camera becomes a
// 162x92 preview 16px from the right and 20px from the bottom. Clicking the stage goes back to the grid; clicking a
// thumbnail focuses it. Esc did not leave it in Discord (observed). Left out: the zoom button (no viewer behind it).
export type CallFocus = { key: string | null; filmOpen: boolean };
type Tile = { key: string; kind: 'stream' | 'camera' | 'user'; stream?: VideoStream; user?: VoiceUser };
export function callTiles(session: Session): Tile[] {
  const channel = callChannelOf(session);
  const streams = session.streams ?? [], users = channel?.users ?? [];
  return [
    ...streams.filter(s => s.kind !== 'camera').map(s => ({ key: s.id, kind: 'stream' as const, stream: s, user: users.find(u => u.id === s.ownerId) })),
    ...users.map(u => {
      const camera = streams.find(s => s.kind === 'camera' && s.ownerId === u.id);
      return camera ? { key: camera.id, kind: 'camera' as const, stream: camera, user: u } : { key: u.id, kind: 'user' as const, user: u };
    }),
  ];
}
const px = (x: number, y: number, w: number, h: number) => ({ left: `${Math.round(x)}px`, top: `${Math.round(y)}px`, width: `${Math.round(w)}px`, height: `${Math.round(h)}px` });

export function CallView({ session, bridge, store, idle = false, inPopout = false, focus = { key: null, filmOpen: true }, onFocus }: { session: Session; bridge: Bridge;
  store: SessionStore; idle?: boolean; inPopout?: boolean; focus?: CallFocus; onFocus?: (focus: CallFocus) => void }) {
  // Each opening has its own id: a picker still closing (animation) must not close one opened right after it.
  const [picking, setPickingId] = useState(0);
  const pickerCount = useRef(0);
  const openPicker = () => setPickingId(++pickerCount.current);
  // "Mostrar participantes sem vídeo" (… menu): a viewer preference, kept on this computer.
  const [showNonVideo, setShowNonVideoState] = useState(() => { try { return localStorage.getItem('tri-call-show-nonvideo') !== '0'; } catch { return true; } });
  const setShowNonVideo = (on: boolean) => { setShowNonVideoState(on); try { localStorage.setItem('tri-call-show-nonvideo', on ? '1' : '0'); } catch { /* storage unavailable */ } };
  const stage = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 880, height: 600 });
  const [area, setArea] = useState({ w: 912, h: 754, top: 48 });
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    // Grid area inside the stage: 16px on the sides, 64px on top (the header floats over it), 90px for the controls.
    const observer = new ResizeObserver(() => {
      setSize({ width: element.clientWidth - 32, height: element.clientHeight - 64 - 90 });
      const header = element.parentElement?.querySelector<HTMLElement>('.tri-channel-header');
      setArea({ w: element.clientWidth, h: element.clientHeight, top: header ? Math.max(0, header.getBoundingClientRect().bottom - element.getBoundingClientRect().top) : 48 });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // The account panel's share button asks for the same picker.
  useEffect(() => { const open = () => openPicker(); addEventListener('tri-open-share-picker', open); return () => removeEventListener('tri-open-share-picker', open); }, []);
  const channel = callChannelOf(session);
  const streams = session.streams ?? [];
  const allUsers = channel?.users ?? [];
  const users = allUsers.filter(u => showNonVideo || streams.some(st => st.kind === 'camera' && st.ownerId === u.id));
  const count = streams.filter(stream => stream.kind !== 'camera').length + users.length;
  const server = session.servers.find(s => s.id === session.selectedServerId);
  const invite = server?.owned && server.id
    ? () => dispatchEvent(new CustomEvent('tri-open-modal', { detail: { kind: 'invite', serverId: server.id, serverName: server.name } }))
    : undefined;
  // Participant menu on video cards, as on the other cards (Discord: onContextMenuParticipant, module 540462). Over the
  // native video the click reaches the core's window, which sends videoContextMenu with the point; elsewhere on the
  // card (its control bar, a hidden video) the page gets it directly.
  const menuFor = (stream: { ownerId?: string }) => allUsers.find(u => u.id === stream.ownerId);
  useEffect(() => store.onEvent(event => {
    if (event.name !== 'videoContextMenu') return;
    const stream = streams.find(s => s.id === event.streamId), user = stream && menuFor(stream);
    const tile = document.querySelector<HTMLElement>(`.tri-video-tile[data-stream="${CSS.escape(event.streamId)}"]`);
    if (!user || !tile) return;
    openParticipantMenu(new MouseEvent('contextmenu', { clientX: event.x, clientY: event.y }), user, session, bridge, tile);
  }), [store, streams, allUsers, session, bridge]);
  const { columns, cardWidth } = layoutFor(Math.max(1, count), Math.max(160, size.width), Math.max(90, size.height));
  const tiles = callTiles(session).filter(t => showNonVideo || t.kind !== 'user');
  const focused = tiles.find(t => t.key === focus.key);
  const setFocus = (key: string | null) => onFocus?.({ ...focus, key });
  // A native window cannot be seen by the page: its left click comes back as videoClick.
  useEffect(() => store.onEvent(event => {
    if (event.name !== 'videoClick') return;
    onFocus?.({ ...focus, key: focus.key === event.streamId ? null : event.streamId });
  }), [store, focus, onFocus]);
  useEffect(() => { if (focus.key && !focused) onFocus?.({ ...focus, key: null }); }, [focus, focused, onFocus]);
  // Tiles report their rectangle on resize only; a tile can also move without resizing (a card added or removed before
  // it, the popout page settling), which would leave its native video window at the old place. Ask every tile to
  // report again whenever the grid's composition changes.
  const composition = [columns, cardWidth, !!session.callPopout, focus.key, focus.filmOpen, area.w, area.h, ...streams.map(s => s.id + (s.hidden ? '-' : '') + s.width + 'x' + s.height), ...users.map(u => u.id)].join('|');
  useLayoutEffect(() => { dispatchEvent(new Event('tri-layout-changed')); }, [composition]);
  // The filmstrip toggle sits over a thumbnail, whose native video window would cover it: cut it out of the windows.
  useLayoutEffect(() => {
    const toggle = stage.current?.querySelector<HTMLElement>('.tri-call-film-toggle');
    setOccluders('film-toggle', toggle && !idle ? [toggle.getBoundingClientRect()] : []);
  }, [composition, idle]);
  // Idle (observed 17/10): names, zoom and the filmstrip toggle disappear; the native windows drop their name pill.
  useEffect(() => { bridge.send({ name: 'videoIdle', idle }); }, [idle, bridge]);
  useEffect(() => () => bridge.send({ name: 'videoIdle', idle: false }), [bridge]);
  useEffect(() => () => setOccluders('film-toggle', []), []);
  useLayoutEffect(() => {
    const film = [...(stage.current?.querySelectorAll<HTMLElement>('.tri-call-focus > [class*="--film"], .tri-call-film-toggle') ?? [])]
      .filter(el => !(idle && el.classList.contains('tri-call-film-toggle'))).map(el => el.getBoundingClientRect());
    setStageOccluders(film);
  }, [composition, idle]);
  useEffect(() => () => setStageOccluders([]), []);
  return (
    <div class={`tri-call ${idle ? 'is-idle' : ''}`} ref={stage}>
      {/* Call in the popout window: the main window keeps the header and controls; the content gives way to Discord's
          screen message J5bXZU over a 60% black layer (modules 156652/919706/200749, root_e605a1, header_c6e099). */}
      {session.callPopout && !inPopout ? (
        <div class="tri-call-popped-out" role="status">
          <div class="tri-call-popped-out__message"><span class="tri-call-popped-out__header">Você abriu uma janela separada para esta reprodução</span></div>
        </div>
      ) : focused ? (() => {
        const others = tiles.length > 1, bottom = area.h - 50, areaHeight = Math.max(1, bottom - area.top);
        const room = { w: area.w, h: Math.max(1, areaHeight - (others && focus.filmOpen ? 119 : 0)) };
        const aspect = focused.stream && focused.stream.width > 0 && focused.stream.height > 0 ? focused.stream.width / focused.stream.height : 16 / 9;
        const sw = Math.min(room.w, room.h * aspect), sh = sw / aspect;
        const stageStyle = px((room.w - sw) / 2, area.top + (room.h - sh) / 2, sw, sh);
        // Filmstrip top above the area's end, measured on Discord 17/10: 182px in the main window (1264x892; the older
        // 201px came from an earlier build) and 141px in the 854x480 popout; the collapsed toggle 170 / 129px.
        const filmFromEnd = inPopout ? 141 : 182, toggleFromEnd = inPopout ? 129 : 170;
        const filmTop = bottom - filmFromEnd, fit = Math.max(1, Math.floor((area.w + 8) / 203)), film = tiles.slice(0, fit);
        const filmLeft = (area.w - (film.length * 195 + (film.length - 1) * 8)) / 2;
        const toggle = px(area.w / 2 - 31, focus.filmOpen ? filmTop + 8 : bottom - toggleFromEnd, 62, 32);
        const ownCamera = tiles.find(t => t.kind === 'camera' && t.user?.self && t.key !== focused.key);
        const place = (tile: Tile, role: 'stage' | 'film', style: Record<string, string>) => {
          // The focused card's video is on the stage (one native window per stream): its thumbnail is a placeholder.
          if (tile.stream && !(role === 'film' && tile.key === focused.key))
            return <VideoTile key={`${role}-${tile.key}`} stream={tile.stream} bridge={bridge} role={role} style={style} user={tile.user}
              label={tile.kind === 'camera' ? tile.user?.name : undefined} speaking={tile.kind === 'camera' && tile.user?.speaking}
              onClick={() => setFocus(role === 'stage' ? null : tile.key)}
              onContextMenu={e => { if (tile.user) openParticipantMenu(e, tile.user, session, bridge); }} />;
          if (tile.user && tile.kind !== 'stream')
            return <ParticipantCard key={`${role}-${tile.key}`} user={tile.user} session={session} bridge={bridge} role={role} style={style}
              onFocus={() => setFocus(role === 'stage' ? null : tile.key)} />;
          return <button key={`${role}-${tile.key}`} class="tri-call-card tri-call-card--film tri-call-card--placeholder" style={style} aria-label={tile.stream?.title}
            onClick={() => setFocus(tile.key)}>
            {tile.kind === 'stream' && <Icon name="ScreenShare" size={28} />}
            <span class="tri-call-card__pill">{tile.kind === 'stream' && <Icon name="ScreenShare" size={16} />}<span>{tile.kind === 'stream' ? tile.user?.name ?? tile.stream?.title : tile.user?.name}</span></span>
          </button>;
        };
        return <div class="tri-call-focus" data-focus={focused.key}>
          {place(focused, 'stage', stageStyle)}
          {others && focus.filmOpen && film.map((tile, i) => place(tile, 'film', px(filmLeft + i * 203, filmTop, 195, 112)))}
          {others && !focus.filmOpen && ownCamera && place(ownCamera, 'film', px(area.w - 16 - 162, area.top + areaHeight - 20 - 92, 162, 92))}
          {others && <button class="tri-call-film-toggle" style={toggle} aria-expanded={focus.filmOpen}
            aria-label={focus.filmOpen ? 'Ocultar participantes' : 'Mostrar participantes'} onClick={() => onFocus?.({ ...focus, filmOpen: !focus.filmOpen })}>
            <Icon name={focus.filmOpen ? 'ChevronSmallDown' : 'ChevronSmallUp'} size={20} /><Icon name="Group" size={20} />
          </button>}
        </div>;
      })() : (
      <div class="tri-call-grid" style={{ gridTemplateColumns: `repeat(${columns}, ${cardWidth}px)` }}>
        {/* A camera replaces its owner's card (as in Discord); screen shares get their own cards. */}
        {streams.filter(stream => stream.kind !== 'camera').map(stream => <VideoTile key={stream.id} stream={stream} bridge={bridge} user={menuFor(stream)}
          onClick={() => setFocus(stream.id)} onContextMenu={e => { const u = menuFor(stream); if (u) openParticipantMenu(e, u, session, bridge); }} />)}
        {users.map(user => {
          const camera = streams.find(stream => stream.kind === 'camera' && stream.ownerId === user.id);
          return camera
            ? <VideoTile key={camera.id} stream={camera} bridge={bridge} label={user.name} speaking={user.speaking} user={user}
                onClick={() => setFocus(camera.id)} onContextMenu={e => openParticipantMenu(e, user, session, bridge)} />
            : <ParticipantCard key={user.id} user={user} session={session} bridge={bridge} />;
        })}
      </div>
      )}
      <ControlsBar session={session} bridge={bridge} onShare={openPicker} invite={invite} inPopout={inPopout} showNonVideo={showNonVideo} setShowNonVideo={setShowNonVideo} />
      {picking > 0 && <SharePicker key={picking} bridge={bridge} store={store} onClose={() => setPickingId(id => (id === picking ? 0 : id))} />}
    </div>
  );
}
