import type { Bridge } from '@/bridge';
import type { Session } from '@/protocol';
import { Video, VideoOff, ScreenShare, ScreenShareOff, PhoneOff } from 'lucide-react';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { soundEngine } from '@/sound-engine';
import { emit, EVENTS } from '@/events';

export function ControlsBar({ session, bridge }: { session: Session; bridge: Bridge }) {
    const hasCamera = !!session.camera;
    const isSharing = !!session.sharing;

    return (
        <div className="flex items-center justify-center gap-3 bg-ink-900 border-t border-ink-800 px-4 py-2.5">
            <Tooltip label={hasCamera ? 'Desativar câmera' : 'Ativar câmera'} side="top">
                <button
                    type="button"
                    aria-label={hasCamera ? 'Desativar câmera' : 'Ativar câmera'}
                    className={cn(
                        'flex h-10 w-10 items-center justify-center rounded-full transition-colors',
                        hasCamera
                            ? 'bg-positive text-white hover:bg-positive/90'
                            : 'bg-ink-800 text-ink-300 hover:bg-ink-700 hover:text-ink-100'
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
                        'flex h-10 w-10 items-center justify-center rounded-full transition-colors',
                        isSharing
                            ? 'bg-positive text-white hover:bg-positive/90'
                            : 'bg-ink-800 text-ink-300 hover:bg-ink-700 hover:text-ink-100'
                    )}
                    onClick={() => {
                        if (isSharing) {
                            soundEngine.play('streamStop');
                            bridge.send({ name: 'stopScreenShare' });
                        } else {
                            emit(EVENTS.openModal, { kind: 'shareScreen' });
                        }
                    }}
                >
                    {isSharing ? <ScreenShareOff size={18} /> : <ScreenShare size={18} />}
                </button>
            </Tooltip>

            <Tooltip label="Desconectar da chamada" side="top">
                <button
                    type="button"
                    aria-label="Desconectar da chamada"
                    className="flex h-10 w-10 items-center justify-center rounded-full bg-critical text-white hover:bg-critical/90 transition-colors shadow-sm"
                    onClick={() => {
                        soundEngine.play('leave');
                        bridge.send({ name: 'leaveVoice' });
                    }}
                >
                    <PhoneOff size={18} />
                </button>
            </Tooltip>
        </div>
    );
}