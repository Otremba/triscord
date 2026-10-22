import { Mic, MicOff, Headphones, HeadphoneOff, Video, VideoOff, UserX } from 'lucide-react';
import { Tooltip } from '@/components/ui/tooltip';
import type { VoiceUser } from '@/protocol';
import { cn } from '@/lib/utils';

interface ParticipantCardProps {
    user: VoiceUser;
    isSpeaking?: boolean;
    onMuteToggle?: () => void;
    onDeafenToggle?: () => void;
    onVideoToggle?: () => void;
    onKick?: () => void;
}

export function ParticipantCard({
    user,
    isSpeaking = false,
    onMuteToggle,
    onDeafenToggle,
    onVideoToggle,
    onKick,
}: ParticipantCardProps) {
    const isMuted = user.muted;
    const isDeafened = user.deafened;
    const hasVideo = user.camera ?? false;
    const isSelf = user.self ?? false;

    return (
        <div className={cn('flex items-center gap-3 px-2 py-1.5 text-sm text-ink-300 hover:bg-ink-800 rounded-md transition-colors', isSelf && 'bg-ink-800/60')}>
            <div className="relative flex h-8 w-8 items-center justify-center rounded-full bg-ink-700 text-xs font-semibold text-ink-200">
                {user.avatarUrl ? (
                    <img src={user.avatarUrl} alt="" className="h-8 w-8 rounded-full object-cover" />
                ) : (
                    user.name.slice(0, 1).toUpperCase()
                )}
                {isSpeaking && (
                    <span className="absolute -inset-0.5 rounded-full ring-2 ring-positive animate-pulse pointer-events-none" />
                )}
            </div>
            <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-ink-100 truncate">{user.name}</p>
                {isSelf && (
                    <span className="text-xs text-ink-400 font-normal">(você)</span>
                )}
            </div>
            <div className="flex items-center gap-1 shrink-0">
                {/* Microphone */}
                {onMuteToggle && (
                    <Tooltip label={isMuted ? 'Ativar áudio' : 'Desativar áudio'} side="top">
                        <button
                            type="button"
                            className="p-1.5 rounded text-ink-400 hover:text-ink-100 hover:bg-ink-700"
                            onClick={onMuteToggle}
                        >
                            {isMuted ? <MicOff size={16} className="text-critical" /> : <Mic size={16} />}
                        </button>
                    </Tooltip>
                )}
                {/* Headphones/Deafen */}
                {onDeafenToggle && (
                    <Tooltip label={isDeafened ? 'Reativar áudio' : 'Desativar áudio'} side="top">
                        <button
                            type="button"
                            className="p-1.5 rounded text-ink-400 hover:text-ink-100 hover:bg-ink-700"
                            onClick={onDeafenToggle}
                        >
                            {isDeafened ? <HeadphoneOff size={16} className="text-critical" /> : <Headphones size={16} />}
                        </button>
                    </Tooltip>
                )}
                {/* Video */}
                {onVideoToggle && (
                    <Tooltip label={hasVideo ? 'Desativar vídeo' : 'Ativar vídeo'} side="top">
                        <button
                            type="button"
                            className="p-1.5 rounded text-ink-400 hover:text-ink-100 hover:bg-ink-700"
                            onClick={onVideoToggle}
                        >
                            {hasVideo ? <Video size={16} className="text-positive" /> : <VideoOff size={16} />}
                        </button>
                    </Tooltip>
                )}
                {/* Kick button (if not self) */}
                {!isSelf && onKick && (
                    <Tooltip label="Remover da chamada" side="top">
                        <button
                            type="button"
                            className="p-1.5 rounded text-critical hover:bg-critical/20"
                            onClick={onKick}
                        >
                            <UserX size={16} />
                        </button>
                    </Tooltip>
                )}
            </div>
        </div>
    );
}