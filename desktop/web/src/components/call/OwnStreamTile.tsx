import { useState, useEffect, useRef } from 'react';
import type { Bridge } from '@/bridge';
import type { Session } from '@/protocol';
import { Monitor, ScreenShare, ScreenShareOff, Volume2, VolumeX } from 'lucide-react';
import { soundEngine } from '@/sound-engine';
import { emit, EVENTS } from '@/events';
import { overlaysSuspended } from '@/video';
import { cn } from '@/lib/utils';

export function OwnStreamTile({
    session,
    bridge,
    onClick,
    isFocused = false,
}: {
    session: Session;
    bridge: Bridge;
    onClick?: () => void;
    isFocused?: boolean;
}) {
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

    const surface = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const element = surface.current;
        if (!element) return;
        const report = () => {
            const r = element.getBoundingClientRect();
            bridge.send({
                name: 'videoSurface',
                streamId: 'own-stream',
                scale: devicePixelRatio,
                rect: overlaysSuspended()
                    ? { x: 0, y: 0, width: 0, height: 0 }
                    : { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
            });
        };
        const observer = new ResizeObserver(report);
        observer.observe(element);
        addEventListener('tri-overlays-changed', report);
        addEventListener('tri-layout-changed', report);
        addEventListener('resize', report);
        report();
        return () => {
            observer.disconnect();
            removeEventListener('tri-overlays-changed', report);
            removeEventListener('tri-layout-changed', report);
            removeEventListener('resize', report);
            bridge.send({
                name: 'videoSurface',
                streamId: 'own-stream',
                scale: devicePixelRatio,
                rect: { x: 0, y: 0, width: 0, height: 0 },
            });
        };
    }, [bridge]);

    useEffect(() => {
        bridge.send({ name: 'videoRole', streamId: 'own-stream', role: 'grid' });
    }, [bridge]);

    return (
        <div
            onClick={onClick}
            className={cn(
                "relative aspect-video w-full overflow-hidden rounded-2xl bg-gradient-to-b from-ink-950 via-ink-900 to-ink-950 border border-brand-500/40 shadow-[0_0_30px_rgba(88,101,242,0.15)] flex flex-col justify-between p-3 sm:p-4 select-none group transition-all duration-150",
                onClick && "cursor-pointer hover:border-brand-400",
                isFocused && "ring-2 ring-brand-400 border-brand-400 shadow-[0_0_30px_rgba(88,101,242,0.4)]"
            )}
            data-stream="own-stream"
        >
            {/* Top Bar: Badges and Quality Info */}
            <div className="relative z-10 flex items-center justify-between gap-2 shrink-0">
                <div className="flex items-center gap-2">
                    <span className="flex items-center gap-1.5 rounded-md bg-positive/20 border border-positive/40 px-2.5 py-0.5 text-xs font-bold text-positive shadow-sm">
                        <span className="h-2 w-2 rounded-full bg-positive animate-pulse" />
                        <span>AO VIVO</span>
                    </span>
                    <span className="flex items-center gap-1 rounded-md bg-ink-900/90 border border-ink-800 px-2.5 py-0.5 text-xs font-medium text-ink-200 backdrop-blur-md">
                        <Monitor size={13} className="text-brand-400" />
                        <span className="truncate max-w-[160px] sm:max-w-[240px]">{streamTitle}</span>
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

            {/* Center Stage: Live Screen Preview Video Surface */}
            <div className="relative flex-1 min-h-0 w-full my-2 rounded-xl overflow-hidden bg-ink-950/90 border border-ink-800/80 shadow-inner flex items-center justify-center">
                {/* Surface reported to Presenter child HWND */}
                <div ref={surface} className="absolute inset-0" />

                {/* Standby placeholder before the first hardware frame arrives */}
                <div className="pointer-events-none flex flex-col items-center justify-center text-center p-4 opacity-50">
                    <div className="flex h-10 w-10 sm:h-12 sm:w-12 items-center justify-center rounded-xl bg-brand-600/30 text-brand-300 mb-1.5">
                        <ScreenShare size={22} />
                    </div>
                    <span className="text-xs text-ink-400 font-medium">Você está transmitindo sua tela…</span>
                </div>
            </div>

            {/* Bottom Bar: Action Controls */}
            <div className="relative z-10 flex items-center justify-between border-t border-ink-800/80 pt-2 shrink-0">
                <div className="flex items-center gap-2 text-ink-400 text-[11px] sm:text-xs">
                    <span className="flex items-center gap-1.5 bg-ink-900/80 border border-ink-800/80 rounded-md px-2 py-0.5">
                        <span className="h-1.5 w-1.5 rounded-full bg-positive" />
                        <span>Duração: <strong className="text-ink-200 font-mono">{formatTimer(seconds)}</strong></span>
                    </span>
                    <span className="hidden sm:inline-block text-ink-400 font-medium">
                        Visível para todos no canal
                    </span>
                </div>

                <div className="flex items-center gap-2 ml-auto" onClick={e => e.stopPropagation()}>
                    <button
                        type="button"
                        onClick={handleChangeSource}
                        className="flex items-center gap-1.5 rounded-lg bg-ink-800 hover:bg-ink-700 px-3 py-1 text-xs font-semibold text-ink-200 hover:text-white transition-colors"
                        title="Trocar tela ou janela compartilhada"
                    >
                        <Monitor size={13} />
                        <span>Trocar Janela</span>
                    </button>

                    <button
                        type="button"
                        onClick={handleStop}
                        className="flex items-center gap-1.5 rounded-lg bg-critical hover:bg-critical/90 px-3.5 py-1 text-xs font-semibold text-white shadow-sm transition-colors"
                        title="Encerrar transmissão de tela"
                    >
                        <ScreenShareOff size={13} />
                        <span>Parar Transmissão</span>
                    </button>
                </div>
            </div>
        </div>
    );
}
