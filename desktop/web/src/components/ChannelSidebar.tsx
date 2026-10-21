import { useEffect, useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import type { Category, Server, Session, VoiceUser } from '../protocol';
import { openParticipantMenu } from './ParticipantMenu';
import { openParticipantProfile } from './ParticipantProfile';
import { Icon } from './Icon';
import { Tooltip } from './Tooltip';
import { openContextMenu, type MenuEntry } from './ContextMenu';
import { AudioRipple } from './ui/AudioRipple';

// Server header: module _f37cb1 — --custom-channel-header-height (49px incl. the 1px --border-subtle bottom
// border), 8px padding, medium weight, --text-strong. The invite button (UserPlus) only for owners.
// Server header dropdown (Discord, audit 18/10: the header is a button with a chevron that turns up while open; a 220px
// menu centred under the header, 4px below, items with 20px icons on the left): Discord lists Impulso de servidor,
// Convidar para o servidor, Config. do servidor, Criar canal/categoria/evento, Diretório de Apps, notification and privacy
// settings, Editar perfil por servidor and "Sair do servidor" for members. triscord keeps what it can do.
function serverDropdown(server: Server): MenuEntry[] {
  const invite = () => dispatchEvent(new CustomEvent('tri-open-modal', { detail: { kind: 'invite', serverId: server.id, serverName: server.name } }));
  return [
    ...(server.owned ? [{ kind: 'item' as const, label: 'Convidar para o servidor', icon: 'UserPlus' as const, action: invite }] : []),
    { kind: 'item' as const, label: 'Criar canal', icon: 'CirclePlus' as const,
      action: () => dispatchEvent(new CustomEvent('tri-open-modal', { detail: { kind: 'createChannel', categoryName: 'Canais de Voz' } })) },
    ...(!server.owned ? [{ kind: 'separator' as const }, { kind: 'item' as const, label: 'Sair do servidor', icon: 'DoorExit' as const, danger: true,
      action: () => dispatchEvent(new CustomEvent('tri-open-modal', { detail: { kind: 'leaveServer', serverId: server.id, serverName: server.name } })) }] : []),
  ];
}

function ServerHeader({ server, bridge }: { server: Server; bridge: Bridge }) {
  const [open, setOpen] = useState(false);
  useEffect(() => { const closed = () => setOpen(false); addEventListener('tri-context-menu-closed', closed); return () => removeEventListener('tri-context-menu-closed', closed); }, []);
  const toggle = (e: MouseEvent) => {
    if (open) { dispatchEvent(new Event('tri-context-menu-close')); return; }
    const r = (e.currentTarget as HTMLElement).closest('header')!.getBoundingClientRect();
    setOpen(true);
    openContextMenu(e, serverDropdown(server), { width: 'fixed', label: server.name, at: { x: r.left + (r.width - 220) / 2, y: r.bottom + 4 } });
  };
  return (
    <header class={`tri-server-header ${open ? 'is-open' : ''}`}>
      <button class="tri-server-header__button" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        <span class="tri-server-header__name">{server.name}</span>
        <Icon name="ChevronSmallDown" size={18} className="tri-server-header__chevron" />
      </button>
      {server.owned && server.id && (
        <button class="tri-icon-button" aria-label="Convidar pessoas" onClick={() => dispatchEvent(new CustomEvent('tri-open-modal', { detail: { kind: 'invite', serverId: server.id, serverName: server.name } }))}>
          <Icon name="UserPlus" size={18} />
        </button>
      )}
    </header>
  );
}

// Category: module __29444 — 24px row, padding-inline 16 / 8, 12px chevron rotating -90deg when collapsed
// (0.1s linear), "+" only on hover; 16px before the category (--custom-category-channel-space-before-category).
// Channel row: module __2ea32 — 8px left margin, 1px vertical padding, link radius 8 with 4/8 padding,
// 20px icon --channel-icon, name --channels-default, hover --interactive-background-hover, selected
// --interactive-background-selected with --interactive-text-active.
// Participant under a voice channel (CALLS.md / SIDEBAR.md, observed): 24px avatar at +36 of the row box,
// 14px name 8px after it, 16px muted/deafened icons with 4px gaps ending 8px from the right edge.
// Speaking: green ring on the avatar (--status-positive). "AO VIVO" badge when sharing (SHARE.md).
function VoiceUserRow({ user, session, bridge }: { user: VoiceUser; session: Session; bridge: Bridge }) {
  const open=(anchor:HTMLElement)=>user.self ? dispatchEvent(new Event('tri-open-profile')) : openParticipantProfile(user.id,anchor);
  return (
    <li class={`tri-voice-user ${user.speaking ? 'is-speaking' : ''}`} title={user.customStatus || undefined} role="button" tabIndex={0} aria-label={`Ver perfil de ${user.name}`}
      onClick={e=>open(e.currentTarget)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open(e.currentTarget);}}}
      onContextMenu={e=>openParticipantMenu(e,user,session,bridge)}>
      <AudioRipple speaking={!!user.speaking}>
        <span class="tri-avatar tri-avatar--24">{user.avatarUrl ? <img src={user.avatarUrl} alt=""/> : <span class="tri-avatar__letter">{user.name.slice(0, 1).toUpperCase()}</span>}</span>
      </AudioRipple>
      <span class="tri-voice-user__name">{user.name}</span>
      {user.live && <span class="tri-live-badge">AO VIVO</span>}
      <span class="tri-voice-user__icons">
        {user.camera && <Icon name="Video" size={16} />}
        {user.localMuted && !user.serverMuted && <span title="Silenciado para você" aria-label="Silenciado para você"><Icon name="MicrophoneMuted" size={16} className="tri-voice-user__muted"/></span>}
        {/* Server mute before the others (Discord's voice user status order: serverDeaf, deaf, serverMute, localMute,
            mute; "Servidor silenciado" colorized). triscord: muted by the room owner. */}
        {user.serverMuted && <span title="Silenciado na sala" aria-label="Silenciado na sala"><Icon name="MicrophoneMuted" size={16} className="tri-voice-user__muted is-server"/></span>}
        {user.muted && !user.serverMuted && !user.localMuted && <Icon name="MicrophoneMuted" size={16} className="tri-voice-user__muted" />}
        {user.deafened && <Icon name="HeadphonesDeafened" size={16} className="tri-voice-user__muted" />}
      </span>
    </li>
  );
}

// Hover actions of a voice channel row: module _c69b6d (iconItem: hidden until the row is hovered, 4px apart;
// actionIcon 16px --icon-muted, --interactive-text-hover on hover), tooltips above. Discord shows "Abrir chat",
// "Criar convite" and "Editar canal" (observed, motion/channel-hover); triscord keeps the ones it can do:
// the chat of the room you are in and the invite for owners. "Editar canal" has no triscord function.
function ChannelActions({ server, channelId, connected }: { server?: Server; channelId: string; connected: boolean }) {
  return (
    <span class="tri-channel__actions">
      {connected && (
        <Tooltip text="Abrir chat">
          <button class="tri-channel__action" aria-label="Abrir chat" onClick={e => { e.stopPropagation(); dispatchEvent(new CustomEvent('tri-open-chat', { detail: channelId })); }}>
            <Icon name="Chat" size={16} />
          </button>
        </Tooltip>
      )}
      {server?.owned && server.id && (
        <Tooltip text="Criar convite">
          <button class="tri-channel__action" aria-label="Criar convite"
            onClick={e => { e.stopPropagation(); dispatchEvent(new CustomEvent('tri-open-modal', { detail: { kind: 'invite', serverId: server.id, serverName: server.name } })); }}>
            <Icon name="UserPlus" size={16} />
          </button>
        </Tooltip>
      )}
    </span>
  );
}

// Call timer of the connected channel row (observed, motion/camera-toggle, share-start): m:ss (h:mm:ss after an
// hour) in --text-feedback-positive at the row's right; hovering the row shows the action icons instead
// (module _c69b6d: iconVisibility:hover hides channelInfo). INFERRED: 12px --font-code (glyphs 8px tall).
function CallTimer({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const s = Math.max(0, Math.floor((now - since) / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = String(s % 60).padStart(2, '0');
  return <span class="tri-channel__timer">{h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`}</span>;
}

// Voice channel context menu (observed, motion/ctx-channel: menu fitted to its content): Discord lists "Marcar
// como lida", "Convidar para voz", "Fixe o Canal no Topo", "Copiar link", "Abrir chat", "Ocultar nomes", "Silenciar
// canal", "Mover para...", "Editar canal", "Duplicar canal", "Criar canal de voz", "Excluir canal". triscord keeps
// "Convidar para voz" (owners), "Abrir chat" (the room you are in) and "Criar canal de voz".
function channelMenu(bridge: Bridge, server: Server | undefined, channelId: string, channelName: string, connected: boolean, categoryName: string): MenuEntry[] {
  return [
    ...(server?.owned && server.id ? [{ kind: 'item' as const, label: 'Convidar para voz',
      action: () => dispatchEvent(new CustomEvent('tri-open-modal', { detail: { kind: 'invite', serverId: server.id, serverName: server.name } })) }] : []),
    { kind: 'separator' as const },
    ...(connected ? [{ kind: 'item' as const, label: 'Abrir chat', action: () => dispatchEvent(new CustomEvent('tri-open-chat', { detail: channelId })) }] : []),
    { kind: 'separator' as const },
    // Discord's last group: Editar canal, Duplicar canal, Criar canal de voz, Excluir canal (audit 18/10); the hub has no
    // rename/delete for rooms, so triscord offers the other two.
    { kind: 'item' as const, label: 'Duplicar canal', action: () => bridge.send({ name: 'createChannel', channelName }) },
    { kind: 'item' as const, label: 'Criar canal de voz', action: () => dispatchEvent(new CustomEvent('tri-open-modal', { detail: { kind: 'createChannel', categoryName } })) },
  ];
}

function CategoryList({ category, session, bridge }: { category: Category; session: Session; bridge: Bridge }) {
  const server = session.servers.find(s => s.id === session.selectedServerId);
  const [collapsed, setCollapsed] = useState(false);
  return (
    <li class="tri-category">
      <div class="tri-category__header">
        <button class="tri-category__toggle" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
          <span class="tri-category__name">{category.name}</span>
          <Icon name="ChevronSmallDown" size={12} className={`tri-category__chevron ${collapsed ? 'is-collapsed' : ''}`} />
        </button>
        <button class="tri-category__add" aria-label="Criar canal" title="Criar canal"
          onClick={() => dispatchEvent(new CustomEvent('tri-open-modal', { detail: { kind: 'createChannel', categoryName: category.name } }))}>
          <Icon name="PlusSmall" size={16} />
        </button>
      </div>
      {!collapsed && (
        <ul class="tri-channels">
          {category.channels.map(channel => {
            const selected = channel.id === session.selectedChannelId;
            // Room ids can repeat across servers: only the call's server marks its channel as connected.
            const connected = channel.id === session.connectedChannelId && session.selectedServerId === (session.callServerId ?? session.selectedServerId);
            return (
              <li key={channel.id} class={`tri-channel ${selected ? 'is-selected' : ''} ${connected ? 'is-connected' : ''}`}>
                <div class="tri-channel__link"
                  onContextMenu={e => openContextMenu(e, channelMenu(bridge, server, channel.id, channel.name, connected, category.name), { label: channel.name })}>
                  <button type="button" class="tri-channel__select" aria-current={selected?'page':undefined} aria-label={channel.name}
                    onClick={() => { bridge.send({ name: 'openTextRoom', channelId: channel.id }); bridge.send({ name: 'selectChannel', channelId: channel.id }); }}>
                  {(() => {
                    const isText = channel.kind === 'text' || channel.name.startsWith('#') || channel.name.toLowerCase().includes('chat') || channel.name.toLowerCase().includes('geral') || !channel.name.toLowerCase().includes('jogos');
                    return <Icon name={isText ? 'TextChannel' : 'VoiceSpeaker'} size={20} className="tri-channel__icon" />;
                  })()}
                  <span class="tri-channel__name">{channel.name}</span>
                  {connected && session.connectedAt && <CallTimer since={session.connectedAt} />}
                  </button>
                  <ChannelActions server={server} channelId={channel.id} connected={connected} />
                </div>
                {channel.users.length > 0 && (
                  <ul class="tri-voice-users">{channel.users.map(user => <VoiceUserRow key={user.id} user={user} session={session} bridge={bridge} />)}</ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

export function ChannelSidebar({ session, bridge, workspace=false }: { session: Session; bridge: Bridge; workspace?:boolean }) {
  const isHome = !session.selectedServerId || session.selectedServerId === '@me';
  if(isHome&&workspace)return <section class="tri-sidebar-list tri-sidebar-list--home" aria-label="Navegação do início"><div class="tri-workspace-home-nav">
    <span class="tri-workspace-label">Organize seu espaço</span>
    <button type="button" aria-current="page"><Icon name="Friends" size={20}/>Visão geral</button>
    <button type="button" onClick={()=>dispatchEvent(new Event('tri-open-profile'))}><Icon name="User" size={20}/>Meu perfil</button>
    <button type="button" onClick={()=>dispatchEvent(new Event('tri-open-settings'))}><Icon name="Settings" size={20}/>Configurações</button>
  </div></section>;
  if (isHome) {
    return (
      <section class="tri-sidebar-list tri-sidebar-list--home" aria-label="Mensagens Diretas">
        <header class="tri-dm-header">
          <button class="tri-dm-search-button" onClick={() => dispatchEvent(new CustomEvent('tri-preview-notice', { detail: 'Busca rápida em desenvolvimento.' }))}>
            Encontre ou comece uma conversa
          </button>
        </header>
        <div class="tri-dm-nav">
          <button class="tri-dm-nav__item is-selected">
            <Icon name="Friends" size={20} className="tri-dm-nav__icon" />
            <span class="tri-dm-nav__name">Amigos</span>
          </button>
          <button class="tri-dm-nav__item" onClick={() => dispatchEvent(new CustomEvent('tri-preview-notice', { detail: 'Página do Nitro em desenvolvimento.' }))}>
            <Icon name="Nitro" size={20} className="tri-dm-nav__icon" />
            <span class="tri-dm-nav__name">Nitro</span>
          </button>
          <button class="tri-dm-nav__item" onClick={() => dispatchEvent(new CustomEvent('tri-preview-notice', { detail: 'Loja de itens em desenvolvimento.' }))}>
            <Icon name="Shop" size={20} className="tri-dm-nav__icon" />
            <span class="tri-dm-nav__name">Loja</span>
          </button>
        </div>
        <div class="tri-dm-list-header">
          <span class="tri-dm-list-header__title">MENSAGENS DIRETAS</span>
          <Tooltip text="Criar DM" position="top">
            <button class="tri-dm-list-header__add" aria-label="Criar DM" onClick={() => dispatchEvent(new CustomEvent('tri-preview-notice', { detail: 'Criação de mensagens diretas em desenvolvimento.' }))}>
              <Icon name="PlusSmall" size={16} />
            </button>
          </Tooltip>
        </div>
        <div class="tri-dm-empty">
          <p>Nenhuma conversa recente</p>
        </div>
      </section>
    );
  }
  const server = session.servers.find(s => s.id === session.selectedServerId) ?? session.servers[0];
  return (
    <section class="tri-sidebar-list" aria-label="Canais">
      {server && <ServerHeader server={server} bridge={bridge} />}
      <ul class="tri-categories">
        {session.categories.map(category => <CategoryList key={category.id} category={category} session={session} bridge={bridge} />)}
      </ul>
    </section>
  );
}
