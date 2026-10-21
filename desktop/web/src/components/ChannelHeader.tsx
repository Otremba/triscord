import type { Channel } from '../protocol';
import type { callTiles } from './CallView';
import { Icon } from './Icon';
import { Tooltip } from './Tooltip';

export function ChannelHeader({ channel, focused, quality, showChat, chatOpen, showMembers, membersOpen, onToggleChat, onToggleMembers }: {
  channel?: Channel;
  focused?: ReturnType<typeof callTiles>[number];
  quality: string;
  showChat: boolean; chatOpen: boolean;
  showMembers: boolean; membersOpen: boolean;
  onToggleChat: () => void; onToggleMembers: () => void;
}) {
  const count = channel?.users.length ?? 0;
  return <header class="tri-channel-header">
    <span class="tri-channel-header__symbol" aria-hidden="true"><Icon name={channel?.kind === 'text' ? 'TextChannel' : 'VoiceSpeaker'} size={20}/></span>
    <div class="tri-channel-header__identity">
      <h1 class="tri-channel-header__title">{channel?.name ?? 'Conversa'}</h1>
      <span class="tri-channel-header__description">{channel?.kind === 'text' ? 'Canal de texto' : count ? `${count} ${count === 1 ? 'pessoa na chamada' : 'pessoas na chamada'}` : 'Conversa e chamada'}</span>
    </div>
    {focused && <span class="tri-channel-header__focus">{focused.kind === 'stream' ? `Tela de ${focused.user?.name ?? focused.stream?.title}` : focused.user?.name}</span>}
    {focused?.kind === 'stream' && <div class="tri-channel-header__pills">
      {quality && <span class="tri-header-pill tri-header-pill--quality">{quality}</span>}
      <span class="tri-header-pill tri-header-pill--live">AO VIVO</span>
    </div>}
    <div class="tri-channel-header__toolbar">
      {showChat && <Tooltip text={chatOpen ? 'Ocultar chat' : 'Mostrar chat'} position="bottom">
        <button type="button" class={`tri-icon-button ${chatOpen ? 'is-active' : ''}`} aria-label={chatOpen ? 'Ocultar chat' : 'Mostrar chat'} aria-expanded={chatOpen} onClick={onToggleChat}><Icon name="Chat" size={20}/></button>
      </Tooltip>}
      {showMembers && <Tooltip text={membersOpen ? 'Ocultar lista de membros' : 'Mostrar lista de membros'} position="bottom">
        <button type="button" class={`tri-icon-button ${membersOpen ? 'is-active' : ''}`} aria-label="Lista de membros" aria-expanded={membersOpen} onClick={onToggleMembers}><Icon name="Group" size={20}/></button>
      </Tooltip>}
    </div>
  </header>;
}
