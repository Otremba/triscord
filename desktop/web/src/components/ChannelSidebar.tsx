import { Hash, Volume2, Plus, Mic, MicOff, HeadphoneOff, Users } from 'lucide-react';
import type { Bridge } from '../bridge';
import type { Session, VoiceUser } from '../protocol';
import { cn } from '../lib/utils';
import { emit } from '../events';
import { useSpeakingHold } from '@/hooks/useSpeakingHold';

export function ChannelSidebar({ session, bridge }: { session: Session; bridge: Bridge }) {
    const isHome = !session.selectedServerId || session.selectedServerId === '@me';

    return (
        <div className="flex flex-1 min-h-0 flex-col bg-ink-900">
            {isHome && (
                <div className="flex h-12 shrink-0 items-center border-b border-ink-800 px-4">
                    <button
                        type="button"
                        onClick={() => emit('tri-open-quick-switcher')}
                        className="w-full rounded bg-ink-950 px-2 py-1 text-left text-xs text-ink-400 hover:text-ink-200"
                    >
                        Buscar ou iniciar conversa (Ctrl+K)
                    </button>
                </div>
            )}

            <div className="flex-1 overflow-y-auto px-2 py-3">
                {isHome ? (
                    <div className="space-y-1">
                        <button
                            type="button"
                            className="flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm font-medium text-ink-100 bg-ink-750"
                        >
                            <Users size={18} className="text-ink-300" />
                            <span>Amigos</span>
                        </button>
                        <div className="pt-4 pb-1 px-2 text-xs font-bold uppercase tracking-wider text-ink-500">
                            Mensagens Diretas
                        </div>
                        <div className="px-2 py-3 text-xs text-ink-500 text-center">
                            Nenhuma conversa recente
                        </div>
                    </div>
                ) : (
                    session.categories.map(category => (
                        <div key={category.id} className="mb-4">
                            <div className="flex items-center justify-between px-2 pt-2.5 pb-2 text-xs font-bold uppercase tracking-wider text-ink-400">
                                <span className="truncate">{category.name}</span>
                                <button
                                    type="button"
                                    aria-label={`Criar canal em ${category.name}`}
                                    className="text-ink-400 hover:text-ink-100 p-0.5 rounded hover:bg-ink-800 transition-colors"
                                    onClick={() => emit('tri-open-modal', { kind: 'createChannel', categoryName: category.name })}
                                >
                                    <Plus size={14} />
                                </button>
                            </div>
                            <div className="mt-1 space-y-1">
                                {category.channels.map(channel => {
                                    const active = channel.id === session.selectedChannelId;
                                    const connected = channel.id === session.connectedChannelId;
                                    return (
                                        <div key={channel.id}>
                                            <button
                                            type="button"
                                            onClick={() => {
                                                bridge.send({ name: 'selectChannel', channelId: channel.id });
                                                if (channel.kind === 'voice') {
                                                    bridge.send({ name: 'joinVoice', channelId: channel.id });
                                                } else {
                                                    bridge.send({ name: 'openTextRoom', channelId: channel.id });
                                                }
                                            }}
                                            className={cn(
                                                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-ink-300 hover:bg-ink-800 hover:text-ink-100 transition-colors',
                                                active && 'bg-ink-700/80 text-ink-100 font-medium',
                                                connected && 'text-brand-300 font-medium'
                                            )}
                                        >
                                            {channel.kind === 'voice' ? <Volume2 size={16} className={connected ? 'text-brand-400' : 'text-ink-400'} /> : <Hash size={16} className="text-ink-400" />}
                                            <span className="truncate">{channel.name}</span>
                                            {connected && (
                                                <span className="ml-auto flex h-2 w-2 rounded-full bg-brand-400" />
                                            )}
                                        </button>
                                        {channel.users && channel.users.length > 0 && (
                                            <div className="mt-0.5 space-y-0.5 pl-6">
                                                {channel.users.map(user => (
                                                    <VoiceUserRow key={user.id} user={user} />
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                            </div>
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}

function VoiceUserRow({ user }: { user: VoiceUser }) {
    const isSpeaking = useSpeakingHold(!!user.speaking, 400);

    return (
        <div className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-ink-300 hover:bg-ink-800/60 transition-colors">
            <span className={cn(
                'flex h-5 w-5 items-center justify-center rounded-full bg-ink-700 text-[10px] font-semibold text-ink-200 transition-all duration-150',
                isSpeaking && 'ring-2 ring-positive ring-offset-1 ring-offset-ink-900 shadow-[0_0_8px_rgba(35,165,90,0.6)]'
            )}>
                {user.avatarUrl ? (
                    <img src={user.avatarUrl} alt="" className="h-5 w-5 rounded-full object-cover" />
                ) : (
                    user.name.slice(0, 1).toUpperCase()
                )}
            </span>
            <span className="truncate">{user.name}</span>
            {user.deafened ? (
                <HeadphoneOff size={12} className="ml-auto text-critical" />
            ) : user.muted || user.serverMuted ? (
                <MicOff size={12} className="ml-auto text-ink-400" />
            ) : isSpeaking ? (
                <Mic size={12} className="ml-auto text-positive" />
            ) : null}
        </div>
    );
}