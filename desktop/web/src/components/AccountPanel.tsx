import { Mic, MicOff, Headphones, HeadphoneOff, Settings, LogOut } from 'lucide-react';
import type { Bridge } from '../bridge';
import type { Session } from '../protocol';
import { cn } from '../lib/utils';
import { Tooltip } from './ui/tooltip';
import { soundEngine } from '../sound-engine';
import { emit, EVENTS } from '../events';

export function AccountPanel({ session, bridge }: { session: Session; bridge: Bridge }) {
    const { account, muted, deafened } = session;
    return (
        <div className="flex h-14 shrink-0 items-center gap-2 border-t border-ink-800 bg-ink-900 px-2">
            <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-ink-800"
                onClick={() => {
                    emit(EVENTS.openSettings);
                    bridge.send({ name: 'openSettings' });
                }}
            >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink-700 text-sm font-semibold text-ink-200">
                    {account.avatarUrl ? <img src={account.avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover" /> : account.displayName.slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-ink-100">{account.displayName}</span>
                    <span className="block truncate text-xs text-ink-400">{account.username}</span>
                </span>
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
                    className={cn('flex h-8 w-8 items-center justify-center rounded-md text-ink-300 hover:bg-ink-700', muted && 'text-critical')}
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
                    className={cn('flex h-8 w-8 items-center justify-center rounded-md text-ink-300 hover:bg-ink-700', deafened && 'text-critical')}
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
                    className="flex h-8 w-8 items-center justify-center rounded-md text-ink-300 hover:bg-ink-700"
                >
                    <Settings size={18} />
                </button>
            </Tooltip>
            <Tooltip label="Sair">
                <button
                    type="button"
                    aria-label="Sair"
                    onClick={() => bridge.send({ name: 'signOut' })}
                    className="flex h-8 w-8 items-center justify-center rounded-md text-ink-300 hover:bg-ink-700 hover:text-critical"
                >
                    <LogOut size={18} />
                </button>
            </Tooltip>
        </div>
    );
}