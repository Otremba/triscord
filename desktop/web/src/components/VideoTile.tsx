import { useEffect, useRef, useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import type { VideoStream, VoiceUser } from '../protocol';
import { attachCanvas, overlaysSuspended } from '../video';

// The native image fills the entire card; participant actions live in the context menu.
// `role`: grid card, the focused stage or a filmstrip thumbnail of the visão ampliada:
// the native window covers the whole card and draws what fits that place). `style` positions it in the focused view.
export function VideoTile({ stream, bridge, label, speaking, onContextMenu, onClick, role = 'grid', style }: { stream: VideoStream; bridge: Bridge;
  label?: string; speaking?: boolean; user?: VoiceUser; onContextMenu?: (event: MouseEvent) => void; onClick?: (event: MouseEvent) => void;
  role?: 'grid' | 'stage' | 'film'; style?: Record<string, string> }) {
  const surface = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (stream.path === 'shared-buffer' && !stream.hidden) attachCanvas(stream.id, canvas.current);
    const element = surface.current;
    if (!element) return;
    const report = () => {
      const r = element.getBoundingClientRect();
      if (canvas.current) {
        canvas.current.width = Math.round(r.width * devicePixelRatio);
        canvas.current.height = Math.round(r.height * devicePixelRatio);
      }
      bridge.send({ name: 'videoSurface', streamId: stream.id, scale: devicePixelRatio,
        rect: stream.hidden || stream.loading || overlaysSuspended() ? { x: 0, y: 0, width: 0, height: 0 }
          : { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } });
    };
    const observer = new ResizeObserver(report); observer.observe(element);
    addEventListener('tri-overlays-changed', report); addEventListener('tri-layout-changed', report); addEventListener('resize', report);
    return () => {
      observer.disconnect(); removeEventListener('tri-overlays-changed', report); removeEventListener('tri-layout-changed', report); removeEventListener('resize', report);
      attachCanvas(stream.id, null);
      bridge.send({ name: 'videoSurface', streamId: stream.id, scale: devicePixelRatio, rect: { x: 0, y: 0, width: 0, height: 0 } });
    };
  }, [stream.id, stream.path, stream.hidden, stream.loading, bridge]);
  useEffect(() => { bridge.send({ name: 'videoRole', streamId: stream.id, role }); }, [stream.id, role, bridge]);
  const name = label ?? stream.title;
  return <div class={`tri-video-tile tri-video-tile--${role} ${speaking ? 'is-speaking' : ''}`} aria-label={name} data-hidden={!!stream.hidden} data-stream={stream.id}
    onContextMenu={onContextMenu} style={style} onClick={e => { if (!(e.target as HTMLElement).closest('button')) onClick?.(e); }}>
    <div class="tri-video-tile__surface" ref={surface}>
      {stream.hidden ? <button class="tri-video-tile__placeholder" aria-label={stream.kind === 'screen' ? 'Mostrar transmissão' : 'Mostrar vídeo'} onClick={() => {
        setError(''); bridge.request({name:'setStreamHidden',streamId:stream.id,hidden:false}).catch(e=>setError(e.message));
      }}>{stream.kind === 'screen' ? 'Transmissão oculta para você' : 'Vídeo oculto para você'}</button>
        : stream.loading ? <div class="tri-video-tile__placeholder" role="status">Conectando à transmissão…</div>
        : stream.path === 'shared-buffer' && <canvas ref={canvas} class="tri-video-tile__canvas"/>}
    </div>
    {error && <div class="tri-video-tile__error" role="alert">{error}</div>}
  </div>;
}
