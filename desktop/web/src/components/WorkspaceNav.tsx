import type { Bridge } from '../bridge';
import type { Session } from '../protocol';
import { Icon } from './Icon';
import { openContextMenu, type MenuEntry } from './ContextMenu';
import { ServerIcon, serverMenuEntries } from './ServerRail';

export function workspaceMenuEntries(session: Session, bridge: Bridge): MenuEntry[] {
  const current = session.servers.find(server => server.id === session.selectedServerId);
  const select = (serverId: string) => bridge.send({ name: 'selectServer', serverId });
  const entries: MenuEntry[] = [
    {
      kind: 'item',
      label: 'Início',
      icon: 'Friends',
      checked: !current,
      action: () => select('@me'),
    },
    { kind: 'separator' },
    ...session.servers.map(s => ({
      kind: 'item' as const,
      label: s.name,
      checked: current?.id === s.id,
      action: () => select(s.id),
    })),
    { kind: 'separator' },
    {
      kind: 'item',
      label: 'Adicionar servidor...',
      icon: 'PlusSmall',
      action: () => dispatchEvent(new Event('tri-open-server-modal')),
    },
  ];

  if (current) {
    entries.push({ kind: 'separator' });
    if (current.owned && current.id) {
      entries.push({
        kind: 'item',
        label: 'Convidar para o servidor',
        icon: 'UserPlus',
        action: () => dispatchEvent(new CustomEvent('tri-open-modal', {
          detail: { kind: 'invite', serverId: current.id, serverName: current.name },
        })),
      });
    }
    entries.push({
      kind: 'item',
      label: 'Criar canal',
      icon: 'CirclePlus',
      action: () => dispatchEvent(new CustomEvent('tri-open-modal', {
        detail: { kind: 'createChannel', categoryName: 'Canais de Voz' },
      })),
    });
    if (current.id) {
      entries.push({
        kind: 'item',
        label: current.owned ? 'Excluir servidor' : 'Sair do servidor',
        icon: 'DoorExit',
        danger: true,
        action: () => dispatchEvent(new CustomEvent('tri-open-modal', {
          detail: {
            kind: current.owned ? 'deleteServer' : 'leaveServer',
            serverId: current.id,
            serverName: current.name,
          },
        })),
      });
    }
  }
  return entries;
}

/** Integrated workspace navigation. All actions use existing account/server contracts. */
export function WorkspaceNav({ session, bridge }: { session: Session; bridge: Bridge }) {
  const current = session.servers.find(server => server.id === session.selectedServerId);
  const recent = session.servers.filter(server => server.id !== current?.id).slice(0, 3);
  const select = (serverId: string) => bridge.send({ name: 'selectServer', serverId });

  const openDropdown = (e: MouseEvent) => {
    const el = (e.currentTarget as HTMLElement).closest('.tri-workspace-current') as HTMLElement | null;
    const r = el ? el.getBoundingClientRect() : { left: 16, bottom: 60 };
    openContextMenu(e, workspaceMenuEntries(session, bridge), {
      width: 'flexible',
      label: current?.name ?? 'Espaços',
      at: { x: r.left, y: r.bottom + 6 },
    });
  };

  return (
    <nav class="tri-workspace-nav" aria-label="Espaços">
      <div class="tri-workspace-current">
        <button
          type="button"
          class="tri-workspace-switch"
          aria-haspopup="menu"
          aria-label={`Espaço atual: ${current?.name ?? 'Início'}. Clique para trocar de servidor.`}
          onClick={openDropdown}
        >
          <span class="tri-workspace-current__icon" aria-hidden="true">
            {current ? <ServerIcon server={current} size={36} /> : <Icon name="Friends" size={24} />}
          </span>
          <span class="tri-workspace-current__info">
            <span class="tri-workspace-current__name">{current?.name ?? 'Início'}</span>
            <Icon name="ChevronSmallDown" size={18} className="tri-workspace-current__chevron" />
          </span>
        </button>
        <select
          id="tri-workspace-select"
          class="tri-sr-only"
          aria-label="Servidor"
          tabIndex={-1}
          value={current?.id ?? '@me'}
          onChange={event => select(event.currentTarget.value)}
        >
          <option value="@me">Início</option>
          {session.servers.map(server => (
            <option key={server.id} value={server.id}>{server.name}</option>
          ))}
        </select>
        {current && (
          <button
            type="button"
            class="tri-icon-button"
            aria-label={`Opções de ${current.name}`}
            aria-haspopup="menu"
            onClick={event => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              openContextMenu(event, serverMenuEntries(current, true), {
                label: current.name,
                at: { x: rect.left, y: rect.bottom + 6 },
              });
            }}
          >
            <Icon name="MoreHorizontal" size={18} />
          </button>
        )}
      </div>
      <div class="tri-workspace-shortcuts" aria-label="Atalhos de espaços">
        <button
          type="button"
          aria-label="Ir para o início"
          aria-current={!current ? 'page' : undefined}
          onClick={() => select('@me')}
        >
          Início
        </button>
        {recent.map(server => (
          <button
            type="button"
            key={server.id}
            title={server.name}
            onClick={() => select(server.id)}
            onContextMenu={event => openContextMenu(event, serverMenuEntries(server, false), { label: server.name })}
          >
            {server.name}
          </button>
        ))}
        <button
          type="button"
          class="tri-workspace-add"
          aria-label="Adicionar servidor ou aceitar convite"
          onClick={() => dispatchEvent(new Event('tri-open-server-modal'))}
        >
          <Icon name="PlusSmall" size={18} />
        </button>
      </div>
    </nav>
  );
}
