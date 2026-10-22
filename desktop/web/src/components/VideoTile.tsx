import { useEffect, useRef } from 'react';
import type { Bridge } from '../bridge';
import type { VideoStream } from '../protocol';
import { overlaysSuspended } from '../video';

import { cn } from '../lib/utils';

// A native window draws the stream over this tile (Path A). The page only reports geometry and occlusion.
export function VideoTile({
    stream,
    bridge,
    onClick,
    isFocused = false,
}: {
    stream: VideoStream;
    bridge: Bridge;
    onClick?: () => void;
    isFocused?: boolean;
}) {
    const surface = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const element = surface.current;
        if (!element) return;
        const report = () => {
            const r = element.getBoundingClientRect();
            bridge.send({
                name: 'videoSurface',
                streamId: stream.id,
                scale: devicePixelRatio,
                rect: stream.hidden || stream.loading || overlaysSuspended()
                    ? { x: 0, y: 0, width: 0, height: 0 }
                    : { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
            });
        };
        const observer = new ResizeObserver(report);
        observer.observe(element);
        addEventListener('tri-overlays-changed', report);
        addEventListener('tri-layout-changed', report);
        addEventListener('resize', report);
        return () => {
            observer.disconnect();
            removeEventListener('tri-overlays-changed', report);
            removeEventListener('tri-layout-changed', report);
            removeEventListener('resize', report);
            bridge.send({ name: 'videoSurface', streamId: stream.id, scale: devicePixelRatio, rect: { x: 0, y: 0, width: 0, height: 0 } });
        };
    }, [stream.id, stream.hidden, stream.loading, bridge]);

    useEffect(() => {
        bridge.send({ name: 'videoRole', streamId: stream.id, role: 'grid' });
    }, [stream.id, bridge]);

    return (
        <div
            onClick={onClick}
            className={cn(
                'relative aspect-video overflow-hidden rounded-xl bg-ink-950 border border-ink-800 shadow-md group transition-all duration-150',
                onClick && 'cursor-pointer hover:border-brand-500/60',
                isFocused && 'ring-2 ring-brand-400 border-brand-500 shadow-[0_0_24px_rgba(88,101,242,0.35)]'
            )}
            data-stream={stream.id}
        >
            <div ref={surface} className="absolute inset-0" />
            {stream.hidden ? (
                <button
                    type="button"
                    className="absolute inset-0 flex items-center justify-center text-sm text-ink-400 bg-ink-900/90 hover:text-ink-200 transition-colors"
                    onClick={() => bridge.request({ name: 'setStreamHidden', streamId: stream.id, hidden: false })}
                >
                    {stream.kind === 'screen' ? 'Transmissão oculta (clique para exibir)' : 'Vídeo oculto (clique para exibir)'}
                </button>
            ) : stream.loading ? (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-400 bg-ink-900/60 backdrop-blur-sm">
                    Conectando à transmissão…
                </div>
            ) : null}

            {/* Bottom Title Pill */}
            {!stream.hidden && (
                <div className="absolute bottom-3 left-3 z-10 flex items-center gap-2 rounded-md bg-ink-950/80 px-2.5 py-1 text-xs text-ink-200 backdrop-blur-sm shadow-sm pointer-events-none opacity-90 group-hover:opacity-100 transition-opacity">
                    <span className="font-medium truncate max-w-[200px]">{stream.title}</span>
                    {stream.kind === 'screen' && (
                        <span className="rounded bg-brand-500/20 px-1 py-0.5 text-[10px] font-semibold text-brand-300 uppercase tracking-wider">
                            AO VIVO
                        </span>
                    )}
                </div>
            )}
        </div>
    );
}