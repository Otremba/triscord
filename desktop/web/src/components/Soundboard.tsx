import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import type { Session } from '../protocol';
import { Icon } from './Icon';
import { suspendOverlays } from '../video';
import { usePopoutAnimation } from './popoutAnimation';

// Geometry: out/claude-observations/SOUNDBOARD.md (532×522, rail 48, tiles 148×40). CSS from Discord's modules recovered
// with REA (out/rea-claude-20261016/css-rules/soundboard*.css): picker __09f65, rail _a1e0e0, sections __61424, tile __9be63.
// This is the Triscord bundled catalog, not Discord's servers, Nitro, or frequent-use history.
export function openSoundboard(anchor: HTMLElement) {
  dispatchEvent(new CustomEvent('tri-open-soundboard', { detail: anchor }));
}
export function SoundboardHost({ session, bridge }: { session: Session; bridge: Bridge }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  useEffect(() => {
    const open = (event: Event) => setAnchor((event as CustomEvent<HTMLElement>).detail);
    addEventListener('tri-open-soundboard', open);
    return () => removeEventListener('tri-open-soundboard', open);
  }, []);
  useEffect(close, [session.connectedChannelId, session.selectedServerId]);
  return anchor && session.connectedChannelId
    ? <Soundboard session={session} bridge={bridge} anchor={anchor} close={close} /> : null;
}
function Soundboard({ session, bridge, anchor, close }: { session: Session; bridge: Bridge; anchor: HTMLElement; close: () => void }) {
  const panel = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(''), [collapsed, collapse] = useState(false), [error, setError] = useState('');
  const [pos, setPos] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    const position = () => { const rect = anchor.getBoundingClientRect();
      setPos({ left: Math.max(8, Math.min(rect.left, innerWidth - Math.min(532, innerWidth - 16) - 8)),
        top: Math.max(8, rect.top - Math.min(522, innerHeight - 16) - 8) }); };
    position(); addEventListener('resize', position); return () => removeEventListener('resize', position);
  }, [anchor]);
  useEffect(() => {
    search.current?.focus(); suspendOverlays(true);
    const outside = (e: PointerEvent) => { if (!panel.current?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    addEventListener('pointerdown', outside); addEventListener('keydown', key, true);
    return () => { removeEventListener('pointerdown', outside); removeEventListener('keydown', key, true);
      bridge.send({ name: 'stopSoundPreview' }); suspendOverlays(false); if (anchor.isConnected) anchor.focus(); };
  }, [anchor, bridge, close]);
  const sounds = (session.soundboard ?? []).filter(s => s.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const server = session.servers.find(s => s.id === session.selectedServerId)?.name ?? 'Triscord';
  const play = (soundId: string, preview: boolean) => {
    setError(''); bridge.request({ name: preview ? 'previewSound' : 'playSound', soundId }).catch(e => setError(String(e.message)));
  };
  const anim = usePopoutAnimation('translate', 'top');   // Discord Popout: TRANSLATE (default), above its button
  return <div ref={panel} role="dialog" aria-label="Efeitos sonoros" class={`tri-soundboard ${anim.className}`} data-popout-animating={anim['data-popout-animating']} style={pos}>
    <div class="tri-soundboard__search"><Icon name="MagnifyingGlass" size={20} />
      <input ref={search} aria-label="Buscar sons" placeholder="Encontre o som perfeito" value={query} onInput={e => setQuery(e.currentTarget.value)} />
    </div>
    <div class="tri-soundboard__body">
      <nav class="tri-soundboard__rail" aria-label="Categorias de sons"><button aria-label={server} aria-pressed="true" onClick={() => collapse(false)}><Icon name="Soundboard" size={24} /></button></nav>
      <div class="tri-soundboard__scroller">
        <button class="tri-soundboard__heading" aria-expanded={!collapsed} onClick={() => collapse(!collapsed)}>
          <Icon name="Soundboard" size={16} /><span>{server}</span><Icon name={collapsed ? 'ChevronSmallRight' : 'ChevronSmallDown'} size={16} />
        </button>
        {!collapsed && <div class="tri-soundboard__grid">{sounds.map(sound =>
          // Tile = soundButton__9be63 (module 817232): the name; on hover an overlay (--background-surface-highest at
          // 80%) with the preview button on the left (secondaryIcon 16px) and PlayIcon in the middle (primaryIcon);
          // Discord's favourite star on the right has no triscord function.
          <div class={`tri-soundboard__tile ${session.soundboardPlayingId === sound.id ? 'is-playing' : ''} ${session.deafened ? 'is-disabled' : ''}`} key={sound.id}>
            <button class="tri-soundboard__play" aria-label={`Tocar ${sound.name}`} disabled={session.deafened} onClick={() => play(sound.id, false)}>
              <span class="tri-soundboard__name">{sound.name}</span>
            </button>
            <div class="tri-soundboard__overlay" aria-hidden="true">
              <div class="tri-soundboard__overlay-bg" />
              <div class="tri-soundboard__overlay-actions">
                <button class="tri-soundboard__preview" aria-label={`Ouvir prévia de ${sound.name}`} title="Ouvir prévia" tabIndex={-1} disabled={session.deafened}
                  onClick={() => play(sound.id, true)}><Icon name="VoiceSpeaker" size={16} /></button>
                <Icon name="Play" size={16} className="tri-soundboard__play-icon" />
                <span class="tri-soundboard__overlay-spacer" />
              </div>
            </div>
          </div>)}</div>}
        <div role="status" class="tri-soundboard__status">{error || session.soundboardError || (session.deafened ? 'Reative o áudio para ouvir os efeitos sonoros.' : '')}</div>
      </div>
    </div>
  </div>;
}
