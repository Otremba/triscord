import { useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import type { Server } from '../protocol';
import type { MenuEntry } from './ContextMenu';
import { Icon } from './Icon';
import { Tooltip } from './Tooltip';
import { openContextMenu } from './ContextMenu';

// Discord's guild acronym (bundle f_0000d3 offset 11891250), same as HubApi::serverAcronym in C++.
export function acronym(name: string): string {
  return name.replace(/'s /g, ' ').replace(/\w+/g, w => w[0]).replace(/\s/g, '');
}

// Guild tile: module __6e9f8 (40x40 --guildbar-avatar-size, acronym in --text-default on
// --background-mod-subtle, brand background + white on hover/selected) and __0d706/__2dbe1 acronym weight.
// Font size for a long acronym. Discord's own rule was not recovered (REA_CLAUDE_20261016.md, open gap):
// INFERRED — 16px (observed for the 3-letter "Sdc") shrunk until it fits the tile with 4px each side.
const measure = (() => { let ctx: CanvasRenderingContext2D | null = null; return (text: string, px: number) => {
  ctx ??= document.createElement('canvas').getContext('2d');
  if (!ctx) return 0;
  ctx.font = `500 ${px}px ${getComputedStyle(document.body).fontFamily}`;
  return ctx.measureText(text).width;
}; })();
function acronymSize(text: string, tile: number): number {
  let px = Math.round(tile * 0.4);
  while (px > 8 && measure(text, px) > tile - 8) px--;
  return px;
}

export function ServerIcon({ server, size = 40 }: { server: Server; size?: number }) {
  if (server.iconUrl) return <img class="tri-server-icon" src={server.iconUrl} width={size} height={size} alt="" />;
  const text = acronym(server.name);
  return <span class="tri-server-acronym" style={{ width: `${size}px`, height: `${size}px`, fontSize: `${acronymSize(text, size)}px` }}>{text}</span>;
}

// Indicator: module __58105 — 8px wide white pill, height 8 (unread) / 20 (hover) / 40 (selected),
// 0.2s ease-out transitions on height, opacity and transform.
// Server context menu (observed, motion/ctx-server: 220px "fixed" menu): Discord lists "Marcar como lida",
// "Convidar para o servidor", mute/notification settings, server settings, privacy, per-server profile, "Criar
// canal", "Criar categoria", "Criar evento", "Mover para...". triscord keeps the items it can do: the invite for
// owners and "Criar canal" (in the server you are viewing: rooms are created there). "Sair do servidor" closes
// Discord's menu for members (red, J2TBi3); the owner, who cannot leave, gets "Excluir servidor" there instead
// (Discord keeps deletion in the server settings, which triscord does not have).
const openRemoval = (kind: 'deleteServer' | 'leaveServer', server: Server) =>
  dispatchEvent(new CustomEvent('tri-open-modal', { detail: { kind, serverId: server.id, serverName: server.name } }));
function serverMenu(server: Server, selected: boolean): MenuEntry[] {
  return [
    ...(server.owned && server.id ? [{ kind: 'item' as const, label: 'Convidar para o servidor',
      action: () => dispatchEvent(new CustomEvent('tri-open-modal', { detail: { kind: 'invite', serverId: server.id, serverName: server.name } })) }] : []),
    { kind: 'separator' as const },
    ...(selected ? [{ kind: 'item' as const, label: 'Criar canal',
      action: () => dispatchEvent(new CustomEvent('tri-open-modal', { detail: { kind: 'createChannel', categoryName: 'Canais de Voz' } })) }] : []),
    ...(server.id ? [{ kind: 'separator' as const },
      server.owned ? { kind: 'item' as const, label: 'Excluir servidor', danger: true, action: () => openRemoval('deleteServer', server) }
                   : { kind: 'item' as const, label: 'Sair do servidor', danger: true, action: () => openRemoval('leaveServer', server) }] : []),
  ];
}

// Voice badge (observed, motion/voice-join): 16px circle at the tile's top-right corner (1px above it), cut out
// of the tile by a 2px ring of the rail colour, white 12px speaker (screen while sharing); colour measured
// #3d9e60 = --icon-voice-speaking (module __650eb names --status-positive for isCurrentUserConnected).
function RailItem({ server, selected, onSelect, voice }: { server: Server; selected: boolean; onSelect: () => void; voice?: 'voice' | 'screen' }) {
  const [hovered, setHovered] = useState(false);
  const pill = selected ? 'selected' : hovered ? 'hovered' : server.unread ? 'unread' : '';
  return (
    <div class="tri-rail__item">
      <div class="tri-rail__pill-wrapper"><span class={`tri-rail__pill ${pill ? `tri-rail__pill--${pill}` : ''}`} /></div>
      <Tooltip text={server.name} position="right" spacing={12} guild>
        <button class={`tri-rail__button ${selected ? 'is-selected' : ''}`} aria-label={server.name} aria-current={selected}
          onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onClick={onSelect}
          onContextMenu={e => openContextMenu(e, serverMenu(server, selected), { width: 'fixed', label: server.name })}>
          <ServerIcon server={server} />
        </button>
      </Tooltip>
      {voice && <span class="tri-rail__voice-badge" aria-hidden="true"><Icon name={voice === 'screen' ? 'ScreenArrow' : 'VoiceSpeaker'} size={12} /></span>}
    </div>
  );
}

export function ServerRail({ servers, selectedId, callServerId, bridge, voice }: { servers: Server[]; selectedId: string; callServerId?: string; bridge: Bridge; voice?: 'voice' | 'screen' }) {
  const [homeHovered, setHomeHovered] = useState(false);
  const homeSelected = !selectedId || selectedId === '@me';
  return (
    <nav class="tri-rail" aria-label="Servidores">
      <div class="tri-rail__item">
        <div class="tri-rail__pill-wrapper">
          <span class={`tri-rail__pill ${homeSelected ? 'tri-rail__pill--selected' : homeHovered ? 'tri-rail__pill--hovered' : ''}`} />
        </div>
        <Tooltip text="Mensagens diretas" position="right" spacing={12} guild>
          <button class={`tri-rail__button tri-rail__home-button ${homeSelected ? 'is-selected' : ''}`} aria-label="Mensagens diretas"
            onMouseEnter={() => setHomeHovered(true)} onMouseLeave={() => setHomeHovered(false)}
            onClick={() => bridge.send({ name: 'selectServer', serverId: '' })}>
            <Icon name="DiscordLogo" size={26} />
          </button>
        </Tooltip>
      </div>
      <div class="tri-rail__separator" role="separator" />

      {servers.map(server => (
        <RailItem key={server.id} server={server} selected={server.id === selectedId} voice={server.id === (callServerId ?? selectedId) ? voice : undefined}
          onSelect={() => bridge.send({ name: 'selectServer', serverId: server.id })} />
      ))}
      {/* Module __5bc7e circleIconButton: 40x40, --background-mod-subtle, brand on hover; 20px CirclePlus. */}
      <div class="tri-rail__item">
        <div class="tri-rail__pill-wrapper" />
        <Tooltip text="Adicionar um servidor" position="right" spacing={12} guild>
        <button class="tri-rail__circle" aria-label="Adicionar um servidor" onClick={() => dispatchEvent(new Event('tri-open-server-modal'))}>
          <Icon name="CirclePlus" size={20} />
        </button>
        </Tooltip>
      </div>
      <div class="tri-rail__item">
        <div class="tri-rail__pill-wrapper" />
        <Tooltip text="Explorar servidores detectáveis" position="right" spacing={12} guild>
        <button class="tri-rail__circle" aria-label="Explorar servidores detectáveis" onClick={() => dispatchEvent(new CustomEvent('tri-preview-notice', { detail: 'Exploração de servidores públicos em desenvolvimento.' }))}>
          <Icon name="Compass" size={20} />
        </button>
        </Tooltip>
      </div>
    </nav>
  );
}
