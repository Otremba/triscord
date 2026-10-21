import { useEffect, useId, useRef, useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import type { Channel, Server, Session } from '../protocol';
import { Icon } from './Icon';
import { soundEngine } from '../sound-engine';

interface QuickSwitcherProps {
  session: Session;
  bridge: Bridge;
  onClose: () => void;
}

interface SearchItem {
  id: string;
  title: string;
  subtitle: string;
  kind: 'voice' | 'text' | 'server';
  serverId: string;
  channelId?: string;
  connected?: boolean;
}

export function QuickSwitcher({ session, bridge, onClose }: QuickSwitcherProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchId = useId();

  // Aggregate searchable items from all available servers and channels.
  const items: SearchItem[] = [];

  // Home / Direct Messages item
  items.push({
    id: 'server-@me',
    title: 'Início & Amigos',
    subtitle: 'Navegação direta',
    kind: 'server',
    serverId: '@me',
  });

  // Current server channels first, then other servers
  for (const server of session.servers) {
    if (server.id && server.id !== '@me') {
      items.push({
        id: `server-${server.id}`,
        title: server.name,
        subtitle: 'Servidor',
        kind: 'server',
        serverId: server.id,
      });
    }
  }

  // Add channels from current categories
  const currentServer = session.servers.find(s => s.id === session.selectedServerId);
  if (session.categories) {
    for (const cat of session.categories) {
      for (const ch of cat.channels) {
        items.push({
          id: `channel-${ch.id}`,
          title: ch.name,
          subtitle: `${currentServer?.name ?? 'Servidor'} · ${cat.name}`,
          kind: ch.kind === 'text' ? 'text' : 'voice',
          serverId: currentServer?.id ?? '@me',
          channelId: ch.id,
          connected: ch.id === session.connectedChannelId,
        });
      }
    }
  }

  // Filter items based on query
  const trimmed = query.trim().toLowerCase();
  const filtered = trimmed
    ? items.filter(
        item =>
          item.title.toLowerCase().includes(trimmed) ||
          item.subtitle.toLowerCase().includes(trimmed)
      )
    : items;

  // Keep selected index bounded
  const activeIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, filtered.length - 1)));

  // Auto-focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Keyboard navigation
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => (prev + 1) % Math.max(1, filtered.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => (prev - 1 + filtered.length) % Math.max(1, filtered.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = filtered[activeIndex];
      if (target) {
        selectItem(target);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  const selectItem = (item: SearchItem) => {
    soundEngine.play('channelSwitch');
    if (item.kind === 'server') {
      bridge.send({ name: 'selectServer', serverId: item.serverId });
    } else if (item.channelId) {
      if (session.selectedServerId !== item.serverId) {
        bridge.send({ name: 'selectServer', serverId: item.serverId });
      }
      bridge.send({ name: 'openTextRoom', channelId: item.channelId });
    }
    onClose();
  };

  return (
    <div
      class="tri-quick-switcher-backdrop"
      role="presentation"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        class="tri-quick-switcher"
        role="dialog"
        aria-modal="true"
        aria-labelledby={searchId}
      >
        <div class="tri-quick-switcher__search">
          <Icon name="MagnifyingGlass" size={18} className="tri-quick-switcher__search-icon" />
          <input
            ref={inputRef}
            id={searchId}
            type="text"
            class="tri-quick-switcher__input"
            placeholder="Para onde deseja ir? (digite um canal ou servidor)"
            value={query}
            onInput={e => {
              setQuery(e.currentTarget.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            aria-autocomplete="list"
            aria-controls="tri-quick-switcher-list"
          />
          <kbd class="tri-quick-switcher__esc" onClick={onClose}>ESC</kbd>
        </div>

        <ul
          id="tri-quick-switcher-list"
          ref={listRef}
          class="tri-quick-switcher__results"
          role="listbox"
        >
          {filtered.length === 0 ? (
            <li class="tri-quick-switcher__empty" role="presentation">
              Nenhum canal ou servidor encontrado para "{query}"
            </li>
          ) : (
            filtered.map((item, idx) => {
              const isSelected = idx === activeIndex;
              return (
                <li
                  key={item.id}
                  class={`tri-quick-switcher__item ${isSelected ? 'is-selected' : ''}`}
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => selectItem(item)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  <span class="tri-quick-switcher__item-icon">
                    {item.kind === 'server' ? (
                      <Icon name="Friends" size={18} />
                    ) : item.kind === 'voice' ? (
                      <Icon name="VoiceSpeaker" size={18} />
                    ) : (
                      <Icon name="TextChannel" size={18} />
                    )}
                  </span>
                  <div class="tri-quick-switcher__item-info">
                    <span class="tri-quick-switcher__item-title">{item.title}</span>
                    <span class="tri-quick-switcher__item-subtitle">{item.subtitle}</span>
                  </div>
                  {item.connected && (
                    <span class="tri-quick-switcher__item-connected">Conectado</span>
                  )}
                  {isSelected && (
                    <span class="tri-quick-switcher__item-hint" aria-hidden="true">
                      Pressione Enter
                    </span>
                  )}
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
