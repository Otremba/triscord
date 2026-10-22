import { useState } from 'react';
import { Mic, MicOff, Headphones, HeadphoneOff, Settings } from 'lucide-react';
import type { Bridge } from '../bridge';
import type { Session } from '../protocol';
import { cn } from '../lib/utils';
import { Tooltip } from './ui/tooltip';
import { soundEngine } from '../sound-engine';
import { emit, EVENTS } from '../events';
import { UserProfilePopout } from './UserProfilePopout';

export function AccountPanel({ session, bridge }: { session: Session; bridge: Bridge }) {
    const [profileOpen, setProfileOpen] = useState(false);
    const { account, muted, deafened } = session;

    return (
        <div className="relative flex h-14 shrink-0 items-center gap-1.5 border-t border-ink-800 bg-ink-900 px-2">
            {profileOpen && (
                <UserProfilePopout
                    session={session}
                    onClose={() => setProfileOpen(false)}
                />
            )}

            <button
                type="button"
                aria-label="Meu Perfil"
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left hover:bg-ink-800 transition-colors"
                onClick={() => setProfileOpen(prev => !prev)}
                title={`${account.displayName} (@${account.username})`}
            >
                <div className="relative shrink-0">
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-ink-700 text-sm font-semibold text-ink-200 overflow-hidden">
                        {account.avatarUrl ? (
                            <img src={account.avatarUrl} alt="" className="h-full w-full object-cover" />
                        ) : (
                            account.displayName.slice(0, 1).toUpperCase()
                        )}
                    </span>
                    <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-ink-900 bg-positive" />
                </div>
                <div className="min-w-0 flex-1 leading-tight">
                    <span className="block truncate text-sm font-semibold text-ink-100">{account.displayName}</span>
                    <span className="block truncate text-xs text-ink-400 font-normal">@{account.username}</span>
                </div>
            </button>

            <Tooltip label={muted ? 'Dessilenciar' : 'Silenciar'}>
                <button
                    type="button"
                    aria-label={muted ? 'Dessilenciar' : 'Silenciar'}
                    aria-pressed={muted}
                    onClick={() => {
                        soundEngine.play(muted ? 'unmute' : 'mute');
                        bridge.send({ name: 'setMuted', muted: !muted });
                    }}
                    className={cn(
                        'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-300 hover:bg-ink-700 hover:text-ink-100 transition-colors',
                        muted && 'text-critical hover:text-critical'
                    )}
                >
                    {muted ? <MicOff size={18} /> : <Mic size={18} />}
                </button>
            </Tooltip>

            <Tooltip label={deafened ? 'Reativar áudio' : 'Desativar áudio'}>
                <button
                    type="button"
                    aria-label={deafened ? 'Reativar áudio' : 'Desativar áudio'}
                    aria-pressed={deafened}
                    onClick={() => {
                        soundEngine.play(deafened ? 'undeafen' : 'deafen');
                        bridge.send({ name: 'setDeafened', deafened: !deafened });
                    }}
                    className={cn(
                        'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-300 hover:bg-ink-700 hover:text-ink-100 transition-colors',
                        deafened && 'text-critical hover:text-critical'
                    )}
                >
                    {deafened ? <HeadphoneOff size={18} /> : <Headphones size={18} />}
                </button>
            </Tooltip>

            <Tooltip label="Configurações">
                <button
                    type="button"
                    aria-label="Configurações"
                    onClick={() => {
                        emit(EVENTS.openSettings);
                        bridge.send({ name: 'openSettings' });
                    }}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-300 hover:bg-ink-700 hover:text-ink-100 transition-colors"
                >
                    <Settings size={18} />
                </button>
            </Tooltip>
        </div>
    );
}