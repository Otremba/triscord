import type { Bridge } from '@/bridge';
import type { Session } from '@/protocol';
import { cn } from '@/lib/utils';
import { emit } from '@/events';

export interface Member {
    id: string;
    name: string;
    avatarUrl?: string;
    status: string;
    role?: string;
    self?: boolean;
}

export function MemberList({ session }: { session: Session; bridge: Bridge }) {
    const server = session.servers?.find(s => s.id === session.selectedServerId);
    if (!server) return null;

    // Gather unique members from server channels + self
    const membersMap = new Map<string, Member>();

    // Current user account
    if (session.account) {
        const inVoice = !!session.connectedChannelId;
        const status = inVoice ? 'online' : (session.account.status || 'online');
        membersMap.set(session.account.id, {
            id: session.account.id,
            name: session.account.displayName || session.account.username,
            avatarUrl: session.account.avatarUrl,
            status,
            role: server.owned ? 'Dono' : 'Membro',
            self: true,
        });
    }

    // Participants in voice channels of this server
    if (session.categories) {
        for (const cat of session.categories) {
            for (const ch of cat.channels) {
                if (ch.users) {
                    for (const u of ch.users) {
                        const identity = u.self ? session.account?.id ?? u.id : u.accountId || u.id;
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
        }
    }

    const members = Array.from(membersMap.values());
    const onlineMembers = members.filter(m => m.status !== 'offline' && m.status !== 'invisible');
    const offlineMembers = members.filter(m => m.status === 'offline' || m.status === 'invisible');

    const handleMemberClick = (m: Member) => {
        if (m.self) {
            emit('tri-open-profile');
        }
    };

    return (
        <aside
            aria-label="Membros do servidor"
            className="flex w-60 shrink-0 flex-col border-l border-ink-800 bg-ink-900 select-none overflow-y-auto px-2 py-3"
        >
            {onlineMembers.length > 0 && (
                <div className="mb-4">
                    <h3 className="px-2 pb-1 text-xs font-bold uppercase tracking-wider text-ink-400">
                        Disponíveis — {onlineMembers.length}
                    </h3>
                    <div className="mt-1 space-y-0.5">
                        {onlineMembers.map(m => (
                            <button
                                key={m.id}
                                type="button"
                                onClick={() => handleMemberClick(m)}
                                aria-label={`Perfil de ${m.name}`}
                                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-ink-800/80 group"
                            >
                                <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink-700 text-xs font-semibold text-ink-200">
                                    {m.avatarUrl ? (
                                        <img src={m.avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
                                    ) : (
                                        m.name.slice(0, 1).toUpperCase()
                                    )}
                                    <span
                                        className={cn(
                                            'absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-ink-900',
                                            m.status === 'idle' ? 'bg-amber-500' : 'bg-positive'
                                        )}
                                    />
                                </span>
                                <div className="flex flex-col min-w-0">
                                    <span className="truncate text-sm font-medium text-ink-200 group-hover:text-ink-100">
                                        {m.name}
                                    </span>
                                    {m.role && (
                                        <span className="text-[11px] text-ink-500 leading-none">
                                            {m.role}
                                        </span>
                                    )}
                                </div>
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {offlineMembers.length > 0 && (
                <div>
                    <h3 className="px-2 pb-1 text-xs font-bold uppercase tracking-wider text-ink-500">
                        Offline — {offlineMembers.length}
                    </h3>
                    <div className="mt-1 space-y-0.5 opacity-60">
                        {offlineMembers.map(m => (
                            <button
                                key={m.id}
                                type="button"
                                onClick={() => handleMemberClick(m)}
                                aria-label={`Perfil de ${m.name}`}
                                className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-ink-800/80 group"
                            >
                                <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink-800 text-xs font-semibold text-ink-400">
                                    {m.avatarUrl ? (
                                        <img src={m.avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover grayscale" />
                                    ) : (
                                        m.name.slice(0, 1).toUpperCase()
                                    )}
                                    <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-ink-900 bg-ink-600" />
                                </span>
                                <div className="flex flex-col min-w-0">
                                    <span className="truncate text-sm font-medium text-ink-400 group-hover:text-ink-200">
                                        {m.name}
                                    </span>
                                    {m.role && (
                                        <span className="text-[11px] text-ink-500 leading-none">
                                            {m.role}
                                        </span>
                                    )}
                                </div>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </aside>
    );
}
