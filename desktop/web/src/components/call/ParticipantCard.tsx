import { Mic, MicOff, HeadphoneOff, Video, UserX, ScreenShare } from 'lucide-react';
import { Tooltip } from '@/components/ui/tooltip';
import type { VoiceUser } from '@/protocol';
import { cn } from '@/lib/utils';
import { useSpeakingHold } from '@/hooks/useSpeakingHold';

interface ParticipantCardProps {
    user: VoiceUser;
    isSpeaking?: boolean;
    variant?: 'stage' | 'compact';
    isFocused?: boolean;
    onClick?: () => void;
    onKick?: () => void;
}

export function ParticipantCard({
    user,
    isSpeaking = false,
    variant = 'stage',
    isFocused = false,
    onClick,
    onKick,
}: ParticipantCardProps) {
    const activeSpeaking = useSpeakingHold(isSpeaking, 400);
    const isMuted = user.muted || user.serverMuted;
    const isDeafened = user.deafened;
    const hasVideo = user.camera ?? false;
    const isSelf = user.self ?? false;

    if (variant === 'compact') {
        return (
            <div
                onClick={onClick}
                className={cn(
                    'flex items-center gap-3 px-2 py-1.5 text-sm text-ink-300 hover:bg-ink-800 rounded-md transition-colors',
                    isSelf && 'bg-ink-800/60',
                    onClick && 'cursor-pointer hover:bg-ink-800/90',
                    isFocused && 'ring-1 ring-brand-400 bg-brand-500/10 text-ink-100'
                )}
            >
                <div className="relative flex h-8 w-8 items-center justify-center rounded-full bg-ink-700 text-xs font-semibold text-ink-200">
                    {user.avatarUrl ? (
                        <img src={user.avatarUrl} alt="" className={cn('h-8 w-8 rounded-full object-cover transition-all duration-150', activeSpeaking && 'ring-2 ring-positive ring-offset-1 ring-offset-ink-900')} />
                    ) : (
                        user.name.slice(0, 1).toUpperCase()
                    )}
                    {activeSpeaking && !user.avatarUrl && (
                        <span className="absolute -inset-0.5 rounded-full ring-2 ring-positive pointer-events-none" />
                    )}
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-ink-100 truncate">{user.name}</p>
                    {isSelf && (
                        <span className="text-xs text-ink-400 font-normal">(você)</span>
                    )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                    {user.live && (
                        <span className="flex items-center gap-0.5 rounded bg-brand-500/20 px-1 py-0.5 text-[9px] font-bold text-brand-300 uppercase tracking-wider">
                            <ScreenShare size={10} />
                            <span>AO VIVO</span>
                        </span>
                    )}
                    {isDeafened ? (
                        <HeadphoneOff size={16} className="text-critical" />
                    ) : isMuted ? (
                        <MicOff size={16} className="text-critical" />
                    ) : activeSpeaking ? (
                        <Mic size={16} className="text-positive" />
                    ) : null}
                </div>
            </div>
        );
    }

    return (
        <div
            onClick={onClick}
            className={cn(
                'group relative flex aspect-video w-full flex-col items-center justify-center rounded-2xl border bg-ink-900/90 p-4 transition-all duration-150 select-none shadow-lg',
                onClick && 'cursor-pointer hover:border-brand-500/50',
                isFocused && 'ring-2 ring-brand-400 border-brand-500 shadow-[0_0_24px_rgba(88,101,242,0.35)]',
                activeSpeaking
                    ? 'border-[#23a55a] shadow-[0_0_24px_rgba(35,165,90,0.35),inset_0_0_16px_rgba(35,165,90,0.15)] ring-1 ring-[#23a55a]'
                    : !isFocused && 'border-ink-800/80 hover:border-ink-700 hover:bg-ink-900'
            )}
        >
            {/* Center Avatar */}
            <div className="relative flex items-center justify-center">
                <div
                    className={cn(
                        'flex h-20 w-20 items-center justify-center rounded-full bg-ink-800 text-2xl font-bold text-ink-100 shadow-xl transition-all duration-150',
                        activeSpeaking
                            ? 'ring-4 ring-[#23a55a] ring-offset-4 ring-offset-ink-900 shadow-[0_0_20px_rgba(35,165,90,0.55)]'
                            : ''
                    )}
                >
                    {user.avatarUrl ? (
                        <img src={user.avatarUrl} alt="" className="h-full w-full rounded-full object-cover" />
                    ) : (
                        user.name.slice(0, 1).toUpperCase()
                    )}
                </div>
            </div>

            {/* Bottom Name & Status Pill */}
            <div className="absolute bottom-3 left-3 right-3 flex items-center justify-between">
                <div className="flex items-center gap-1.5 rounded-md bg-ink-950/80 px-2.5 py-1 backdrop-blur-sm max-w-[80%]">
                    <span className="truncate text-xs font-medium text-ink-200">{user.name}</span>
                    {isSelf && <span className="text-[10px] text-ink-400 shrink-0">(você)</span>}
                    {user.live && (
                        <span className="flex items-center gap-0.5 rounded bg-brand-500/20 px-1 py-0.5 text-[9px] font-bold text-brand-300 uppercase tracking-wider shrink-0 ml-1">
                            <ScreenShare size={10} />
                            <span>AO VIVO</span>
                        </span>
                    )}
                </div>

                <div className="flex items-center gap-1 rounded-md bg-ink-950/80 p-1 backdrop-blur-sm">
                    {isDeafened ? (
                        <HeadphoneOff size={14} className="text-critical" />
                    ) : isMuted ? (
                        <MicOff size={14} className="text-critical" />
                    ) : null}
                    {hasVideo && <Video size={14} className="text-positive" />}
                </div>
            </div>

            {/* Hover Actions */}
            {!isSelf && onKick && (
                <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Tooltip label="Remover da chamada" side="left">
                        <button
                            type="button"
                            aria-label="Remover da chamada"
                            onClick={onKick}
                            className="flex h-7 w-7 items-center justify-center rounded-full bg-ink-950/80 text-critical hover:bg-critical hover:text-white transition-colors"
                        >
                            <UserX size={14} />
                        </button>
                    </Tooltip>
                </div>
            )}
        </div>
    );
}