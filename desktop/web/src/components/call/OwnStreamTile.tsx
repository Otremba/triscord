import { useState, useEffect } from 'react';
import type { Bridge } from '@/bridge';
import type { Session } from '@/protocol';
import { Monitor, ScreenShare, ScreenShareOff, Volume2, VolumeX, Sparkles } from 'lucide-react';
import { soundEngine } from '@/sound-engine';
import { emit, EVENTS } from '@/events';

export function OwnStreamTile({ session, bridge }: { session: Session; bridge: Bridge }) {
    const s = session.settings;
    const isHd = s?.shareHd ?? true;
    const shareAudio = s?.shareAudio ?? true;
    const streamTitle = session.sharingName || 'Tela Inteira';

    // Timer for active stream
    const [seconds, setSeconds] = useState(0);
    useEffect(() => {
        const interval = setInterval(() => {
            setSeconds(prev => prev + 1);
        }, 1000);
        return () => clearInterval(interval);
    }, []);

    const formatTimer = (totalSeconds: number) => {
        const mins = Math.floor(totalSeconds / 60);
        const secs = totalSeconds % 60;
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };

    const handleStop = () => {
        soundEngine.play('streamStop');
        bridge.send({ name: 'stopScreenShare' });
    };

    const handleChangeSource = () => {
        emit(EVENTS.openModal, { kind: 'shareScreen' });
    };

    return (
        <div className="relative aspect-video w-full overflow-hidden rounded-2xl bg-gradient-to-b from-ink-950 via-ink-900 to-ink-950 border border-brand-500/40 shadow-[0_0_30px_rgba(88,101,242,0.15)] flex flex-col justify-between p-5 select-none group">
            {/* Ambient Background Graphic */}
            <div className="absolute inset-0 pointer-events-none opacity-20 overflow-hidden flex items-center justify-center">
                <div className="h-96 w-96 rounded-full bg-brand-500/30 blur-3xl" />
                <div className="absolute h-64 w-64 rounded-full bg-indigo-500/20 blur-2xl" />
            </div>

            {/* Top Bar: Badges and Quality Info */}
            <div className="relative z-10 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <span className="flex items-center gap-1.5 rounded-md bg-positive/20 border border-positive/40 px-2.5 py-1 text-xs font-bold text-positive shadow-sm">
                        <span className="h-2 w-2 rounded-full bg-positive animate-pulse" />
                        <span>AO VIVO</span>
                    </span>
                    <span className="flex items-center gap-1 rounded-md bg-ink-900/90 border border-ink-800 px-2.5 py-1 text-xs font-medium text-ink-200 backdrop-blur-md">
                        <Monitor size={13} className="text-brand-400" />
                        <span className="truncate max-w-[180px] sm:max-w-[260px]">{streamTitle}</span>
                    </span>
                </div>

                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-300">
                    <span className="rounded-md bg-ink-900/80 border border-ink-800 px-2 py-0.5 backdrop-blur-md">
                        {isHd ? '1080p 60 FPS' : '720p 30 FPS'}
                    </span>
                    <span className="rounded-md bg-ink-900/80 border border-ink-800 px-2 py-0.5 backdrop-blur-md hidden sm:inline-block">
                        {isHd ? '8.0 Mbps' : '2.5 Mbps'}
                    </span>
                    <span className="rounded-md bg-ink-900/80 border border-ink-800 px-2 py-0.5 backdrop-blur-md flex items-center gap-1">
                        {shareAudio ? <Volume2 size={12} className="text-positive" /> : <VolumeX size={12} className="text-critical" />}
                        <span className="hidden sm:inline">{shareAudio ? 'Áudio' : 'Sem áudio'}</span>
                    </span>
                </div>
            </div>

            {/* Center Stage: Radar Graphic & Status */}
            <div className="relative z-10 flex flex-col items-center justify-center text-center my-auto px-4">
                <div className="relative mb-3 flex items-center justify-center">
                    {/* Concentric live waves */}
                    <div className="absolute -inset-4 rounded-full border border-brand-500/20 animate-ping opacity-40 pointer-events-none" />
                    <div className="absolute -inset-8 rounded-full border border-brand-500/10 pointer-events-none" />

                    <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-tr from-brand-600 to-indigo-500 text-white shadow-xl shadow-brand-500/20 ring-4 ring-ink-900">
                        <ScreenShare size={28} />
                    </div>
                </div>

                <h3 className="text-base font-bold text-ink-100 flex items-center gap-1.5">
                    <span>Você está transmitindo sua tela</span>
                    <Sparkles size={14} className="text-brand-400" />
                </h3>
                <p className="text-xs text-ink-400 mt-1 max-w-md">
                    Sua transmissão está ativa e sendo codificada por aceleração de hardware (D3D11 / NVENC) diretamente para os participantes na VPS.
                </p>

                {/* Duration Timer */}
                <div className="mt-2.5 inline-flex items-center gap-1.5 rounded-full bg-ink-900/90 border border-ink-800 px-3 py-1 text-xs text-ink-300 font-mono font-medium backdrop-blur-md">
                    <span className="h-1.5 w-1.5 rounded-full bg-positive" />
                    <span>Duração: {formatTimer(seconds)}</span>
                </div>
            </div>

            {/* Bottom Bar: Action Controls */}
            <div className="relative z-10 flex items-center justify-between border-t border-ink-800/80 pt-3">
                <span className="text-xs text-ink-400 font-medium hidden sm:inline-block">
                    Visível para todos conectados no canal
                </span>

                <div className="flex items-center gap-2 ml-auto">
                    <button
                        type="button"
                        onClick={handleChangeSource}
                        className="flex items-center gap-1.5 rounded-lg bg-ink-800 hover:bg-ink-700 px-3 py-1.5 text-xs font-semibold text-ink-200 hover:text-white transition-colors"
                        title="Trocar tela ou janela compartilhada"
                    >
                        <Monitor size={14} />
                        <span>Trocar Janela</span>
                    </button>

                    <button
                        type="button"
                        onClick={handleStop}
                        className="flex items-center gap-1.5 rounded-lg bg-critical hover:bg-critical/90 px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors"
                        title="Encerrar transmissão de tela"
                    >
                        <ScreenShareOff size={14} />
                        <span>Parar Transmissão</span>
                    </button>
                </div>
            </div>
        </div>
    );
}
