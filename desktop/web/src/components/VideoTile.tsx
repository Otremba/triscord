import { useEffect, useRef } from 'react';
import type { Bridge } from '../bridge';
import type { VideoStream } from '../protocol';
import { overlaysSuspended } from '../video';

// A native window draws the stream over this tile (Path A). The page only reports geometry and occlusion.
export function VideoTile({ stream, bridge }: { stream: VideoStream; bridge: Bridge }) {
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
        <div className="relative aspect-video overflow-hidden rounded-lg bg-ink-900" data-stream={stream.id}>
            <div ref={surface} className="absolute inset-0" />
            {stream.hidden ? (
                <button
                    type="button"
                    className="absolute inset-0 flex items-center justify-center text-sm text-ink-400"
                    onClick={() => bridge.request({ name: 'setStreamHidden', streamId: stream.id, hidden: false })}
                >
                    {stream.kind === 'screen' ? 'Transmissão oculta para você' : 'Vídeo oculto para você'}
                </button>
            ) : stream.loading ? (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-400">Conectando à transmissão…</div>
            ) : null}
        </div>
    );
}