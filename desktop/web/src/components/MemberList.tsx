import type { Bridge } from '../bridge';
import type { Session, VoiceUser } from '../protocol';
import { openParticipantProfile } from './ParticipantProfile';
import { Tooltip } from './Tooltip';
import '../styles/member-list.css';

export function MemberList({ session, bridge, onClose }: { session: Session; bridge: Bridge; onClose?: () => void }) {
  const server = session.servers.find(s => s.id === session.selectedServerId);
  if (!server) return null;

  // Gather unique members from all server channels + self
  const membersMap = new Map<string, { id: string; name: string; avatarUrl?: string; status: string; role?: string; self?: boolean }>();

  // Self account
  if (session.account) {
    membersMap.set(session.account.id, {
      id: session.account.id,
      name: session.account.displayName || session.account.username,
      avatarUrl: session.account.avatarUrl,
      status: session.account.status || 'online',
      role: server.owned ? 'Dono' : 'Membro',
      self: true,
    });
  }

  // Channel voice users
  for (const cat of session.categories) {
    for (const ch of cat.channels) {
      for (const u of ch.users) {
        // Account and socket ids are different; a voice connection is not a second member.
        const identity = u.self ? session.account.id : u.accountId ?? u.id;
        if (!membersMap.has(identity)) {
          membersMap.set(identity, {
            id: u.id,
            name: u.name,
            avatarUrl: u.avatarUrl,
            status: 'online',
            role: 'Membro',
            self: u.self,
          });
        }
      }
    }
  }

  const members = Array.from(membersMap.values());
  const onlineMembers = members.filter(m => m.status !== 'offline' && m.status !== 'invisible');
  const offlineMembers = members.filter(m => m.status === 'offline' || m.status === 'invisible');

  const onMemberClick = (m: { id: string; self?: boolean }, anchor: HTMLElement) => {
    if (m.self) {
      dispatchEvent(new Event('tri-open-profile'));
    } else {
      openParticipantProfile(m.id, anchor);
    }
  };

  return (
    <aside class="tri-members-sidebar" aria-label="Membros do servidor">
      <div class="tri-members-header">
        <span class="tri-members-header__title">Membros</span>
        {onClose && (
          <Tooltip text="Recolher (Ctrl+U)" position="bottom">
            <button
              type="button"
              class="tri-icon-button tri-members-header__close"
              aria-label="Recolher lista de membros"
              onClick={onClose}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          </Tooltip>
        )}
      </div>
      <div class="tri-members-scroller">
        {onlineMembers.length > 0 && (
          <div class="tri-members-group">
            <h3 class="tri-members-group__title">
              Disponíveis <span class="tri-members-group__count">{onlineMembers.length}</span>
            </h3>
            <ul class="tri-members-list">
              {onlineMembers.map(m => (
                <li key={m.id} class="tri-member-item">
                  <button type="button" class="tri-member-item__layout" aria-label={`Abrir perfil de ${m.name}`}
                    onClick={e => onMemberClick(m, e.currentTarget as HTMLElement)}>
                    <span class="tri-avatar tri-avatar--32">
                      {m.avatarUrl ? (
                        <img src={m.avatarUrl} alt="" />
                      ) : (
                        <span class="tri-avatar__letter">{m.name.slice(0, 1).toUpperCase()}</span>
                      )}
                      <span class={`tri-avatar__status tri-avatar__status--${m.status}`} />
                    </span>
                    <span class="tri-member-item__content">
                      <span class="tri-member-item__name">{m.name}</span>
                      {m.role && <span class="tri-member-item__activity">{m.role}</span>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {offlineMembers.length > 0 && (
          <div class="tri-members-group">
            <h3 class="tri-members-group__title">
              Offline <span class="tri-members-group__count">{offlineMembers.length}</span>
            </h3>
            <ul class="tri-members-list">
              {offlineMembers.map(m => (
                <li key={m.id} class="tri-member-item is-offline">
                  <button type="button" class="tri-member-item__layout" aria-label={`Abrir perfil de ${m.name}`}
                    onClick={e => onMemberClick(m, e.currentTarget as HTMLElement)}>
                    <span class="tri-avatar tri-avatar--32">
                      {m.avatarUrl ? (
                        <img src={m.avatarUrl} alt="" />
                      ) : (
                        <span class="tri-avatar__letter">{m.name.slice(0, 1).toUpperCase()}</span>
                      )}
                      <span class="tri-avatar__status tri-avatar__status--offline" />
                    </span>
                    <span class="tri-member-item__content">
                      <span class="tri-member-item__name">{m.name}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </aside>
  );
}
