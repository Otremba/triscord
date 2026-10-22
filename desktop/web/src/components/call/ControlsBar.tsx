import type { Bridge } from '@/bridge';
import type { Session } from '@/protocol';
import { Mic, MicOff, Headphones, HeadphoneOff, Video, VideoOff, ScreenShare, ScreenShareOff, Settings, PhoneOff } from 'lucide-react';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { emit } from '@/events';
import { soundEngine } from '@/sound-engine';

export function ControlsBar({ session, bridge }: { session: Session; bridge: Bridge }) {
    const isMuted = !!session.muted;
    const isDeafened = !!session.deafened;
    const hasCamera = !!session.camera;
    const isSharing = !!session.sharing;

    return (
        <div className="flex items-center justify-between bg-ink-900 border-t border-ink-800 px-4 py-2.5">
            <div className="flex items-center gap-2">
                <Tooltip label={isMuted ? 'Ativar microfone' : 'Silenciar microfone'} side="top">
                    <button
                        type="button"
                        aria-label={isMuted ? 'Ativar microfone' : 'Silenciar microfone'}
                        className={cn(
                            'flex h-9 w-9 items-center justify-center rounded-md transition-colors',
                            isMuted ? 'bg-critical/20 text-critical hover:bg-critical/30' : 'text-ink-300 hover:bg-ink-700 hover:text-ink-100'
                        )}
                        onClick={() => {
                            soundEngine.play(isMuted ? 'unmute' : 'mute');
                            bridge.send({ name: 'setMuted', muted: !isMuted });
                        }}
                    >
                        {isMuted ? <MicOff size={18} /> : <Mic size={18} />}
                    </button>
                </Tooltip>

                <Tooltip label={isDeafened ? 'Reativar áudio' : 'Desativar áudio'} side="top">
                    <button
                        type="button"
                        aria-label={isDeafened ? 'Reativar áudio' : 'Desativar áudio'}
                        className={cn(
                            'flex h-9 w-9 items-center justify-center rounded-md transition-colors',
                            isDeafened ? 'bg-critical/20 text-critical hover:bg-critical/30' : 'text-ink-300 hover:bg-ink-700 hover:text-ink-100'
                        )}
                        onClick={() => {
                            soundEngine.play(isDeafened ? 'undeafen' : 'deafen');
                            bridge.send({ name: 'setDeafened', deafened: !isDeafened });
                        }}
                    >
                        {isDeafened ? <HeadphoneOff size={18} /> : <Headphones size={18} />}
                    </button>
                </Tooltip>

                <Tooltip label={hasCamera ? 'Desativar câmera' : 'Ativar câmera'} side="top">
                    <button
                        type="button"
                        aria-label={hasCamera ? 'Desativar câmera' : 'Ativar câmera'}
                        className={cn(
                            'flex h-9 w-9 items-center justify-center rounded-md transition-colors',
                            hasCamera ? 'bg-positive/20 text-positive hover:bg-positive/30' : 'text-ink-300 hover:bg-ink-700 hover:text-ink-100'
                        )}
                        onClick={() => {
                            soundEngine.play(hasCamera ? 'cameraOff' : 'cameraOn');
                            bridge.send({ name: 'setCamera', on: !hasCamera });
                        }}
                    >
                        {hasCamera ? <Video size={18} /> : <VideoOff size={18} />}
                    </button>
                </Tooltip>

                <Tooltip label={isSharing ? 'Parar transmissão' : 'Compartilhar tela'} side="top">
                    <button
                        type="button"
                        aria-label={isSharing ? 'Parar transmissão' : 'Compartilhar tela'}
                        className={cn(
                            'flex h-9 w-9 items-center justify-center rounded-md transition-colors',
                            isSharing ? 'bg-positive/20 text-positive hover:bg-positive/30' : 'text-ink-300 hover:bg-ink-700 hover:text-ink-100'
                        )}
                        onClick={() => {
                            soundEngine.play(isSharing ? 'streamStop' : 'streamStart');
                            if (isSharing) {
                                bridge.send({ name: 'stopScreenShare' });
                            } else {
                                bridge.send({ name: 'startScreenShare', generation: 'screen-1', index: 0 });
                            }
                        }}
                    >
                        {isSharing ? <ScreenShareOff size={18} /> : <ScreenShare size={18} />}
                    </button>
                </Tooltip>
            </div>

            <div className="flex items-center gap-2">
                <Tooltip label="Configurações" side="top">
                    <button
                        type="button"
                        aria-label="Configurações"
                        className="flex h-9 w-9 items-center justify-center rounded-md text-ink-300 hover:bg-ink-700 hover:text-ink-100 transition-colors"
                        onClick={() => emit('tri-open-settings')}
                    >
                        <Settings size={18} />
                    </button>
                </Tooltip>

                <Tooltip label="Desconectar da chamada" side="top">
                    <button
                        type="button"
                        aria-label="Desconectar da chamada"
                        className="flex h-9 w-9 items-center justify-center rounded-md bg-critical text-white hover:bg-critical/90 transition-colors"
                        onClick={() => {
                            soundEngine.play('leave');
                            bridge.send({ name: 'leaveVoice' });
                        }}
                    >
                        <PhoneOff size={18} />
                    </button>
                </Tooltip>
            </div>
        </div>
    );
}