import { useEffect, useRef, useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import type { ShareSource } from '../protocol';
import type { SessionStore } from '../store';
import { Icon } from './Icon';
import { ModalLayer, useModalClose } from './ModalLayer';

// Share picker, observed in Discord (SHARE.md, 1280x900 window, 96 DPI): 960x746 modal centred (16px margin
// in smaller windows) over a darkened window; segmented tabs on a 910x40 rail (4px inset, 32px segments)
// "Aplicativos" and "Tela Inteira"; two-column grid of 439x247 thumbnails (radius 8, black), step 455x297,
// caption with 16px icon and 16px name; hover darkens the thumbnail, draws a 2px outline 2px away and shows
// a white 155x42 "Compartilhar tela" button. There is no confirm button: choosing a source starts sharing.
// Stream mode block (SHARE.md, same as the Qt picker): "Jogos" (16px bold) over "Vídeo mais suave · 720p · 30fps"
// (12px), a 110x40 SD/HD toggle and a 40x40 gear opening "Modo de transmissão" (245px, right-aligned with the gear,
// bottom 10px above it): radios "Jogos" / "Compartilhamento de tela" with their quality, then "Silenciar áudio da
// transmissão". INFERRED mapping (as in Qt): SD 720p / HD 1080p, Jogos 30 fps (60 in HD), Compartilhamento de tela
// 15 fps (triscord has no 5 fps "Fonte"). HD needs Nitro in Discord: no paid lock here. Saved as settings.
// Monitors are captioned "Tela 1", "Tela 2" (named by the core, as Discord's y/R7n4). "Dispositivos" lists the capture
// devices (the cameras of the settings page) and streams the chosen one as the screen share; its CTA is "Selecionar"
// (e72JFB) and with no device Discord's empty state shows "Você não tem nenhum dispositivo de captura disponível."
// (/z3YaZ) and "No futuro, você poderá usar esta aba…" (agwSGA). Cards: module __2f580 (styles/call.css).
// INFERRED: the black preview with the device icon (Discord shows the camera's own preview; no camera here).
// Left out: "Personalizada", "Avançado" and the Nitro banner.
type Mode = 'game' | 'screen';
function quality(mode: Mode, hd: boolean, parenthesised: boolean) {
  const res = `${hd ? 1080 : 720}p`, fps = `${mode === 'game' ? (hd ? 60 : 30) : 15}fps`;
  const lead = mode === 'game' ? 'Vídeo mais suave' : 'Texto mais claro';
  return parenthesised ? `${lead} (${res}, ${fps})` : `${lead} · ${res} · ${fps}`;
}
export function SharePicker({ bridge, store, onClose }: { bridge: Bridge; store: SessionStore; onClose: () => void }) {
  const [tab, setTab] = useState<'window' | 'screen' | 'device'>('window');
  const [list, setList] = useState<{ generation: string; sources: ShareSource[] } | null>(null);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  // After 4 s without a thumbnail the card says so (it can still be shared) instead of staying black.
  const [thumbsLate, setThumbsLate] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setThumbsLate(true), 4000); return () => clearTimeout(timer); }, []);
  const { closing, close } = useModalClose(onClose);
  const settings = store.current?.settings;
  const [mode, setMode] = useState<Mode>(settings?.shareMode ?? 'game');
  const [hd, setHd] = useState(!!settings?.shareHd);
  const [audio, setAudio] = useState(!!settings?.shareAudio);
  const [modeMenu, setModeMenu] = useState(false);
  const gear = useRef<HTMLButtonElement>(null), menuRef = useRef<HTMLDivElement>(null);
  const save = (key: 'shareMode' | 'shareHd' | 'shareAudio', value: Mode | boolean) =>
    bridge.send({ name: 'setSetting', key, value } as Parameters<Bridge['send']>[0]);
  useEffect(() => {
    if (!modeMenu) return;
    const outside = (e: PointerEvent) => { if (!menuRef.current?.contains(e.target as Node) && !gear.current?.contains(e.target as Node)) setModeMenu(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setModeMenu(false); gear.current?.focus(); } };
    addEventListener('pointerdown', outside, true); addEventListener('keydown', key, true);
    return () => { removeEventListener('pointerdown', outside, true); removeEventListener('keydown', key, true); };
  }, [modeMenu]);
  useEffect(() => {
    // Thumbnails can arrive before the list's reply (fast captures: the monitors come first). They are kept by
    // generation and applied once the reply says which one is current (18/10: Tela 1 and Tela 2 stayed black).
    let generation = '';
    const early = new Map<string, Record<number, string>>();
    const off = store.onEvent(event => {
      if (event.name !== 'shareThumbnail') return;
      if (event.generation === generation) setThumbs(t => ({ ...t, [event.index]: event.image }));
      else if (!generation) early.set(event.generation, { ...early.get(event.generation), [event.index]: event.image });
    });
    bridge.request<{ generation: string; sources: ShareSource[] }>({ name: 'listShareSources' })
      .then(value => { generation = value.generation; setThumbs(t => ({ ...early.get(generation), ...t })); early.clear(); setList(value); })
      .catch(() => setList({ generation: '', sources: [] }));
    bridge.send({ name: 'requestDevices' });
    return off;
  }, [bridge, store]);
  const devices = settings?.cameraDevices ?? [];
  const shown = (list?.sources ?? []).filter(source => source.kind === tab);
  const start = (source: ShareSource) => {
    if (!list) return;
    bridge.send({ name: 'startScreenShare', generation: list.generation, index: source.index });
    close();
  };
  const startDevice = (deviceId: string) => { bridge.send({ name: 'startDeviceShare', deviceId }); close(); };
  return (
    <ModalLayer closing={closing} onRequestClose={close}>
      <div class="tri-share-picker" role="dialog" aria-label="Compartilhar tela">
        <div class="tri-share-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'window'} class={tab === 'window' ? 'is-selected' : ''} onClick={() => setTab('window')}>
            <Icon name="Browser" size={16} /> Aplicativos
          </button>
          <button role="tab" aria-selected={tab === 'screen'} class={tab === 'screen' ? 'is-selected' : ''} onClick={() => setTab('screen')}>
            <Icon name="ScreenShare" size={16} /> Tela Inteira
          </button>
          <button role="tab" aria-selected={tab === 'device'} class={tab === 'device' ? 'is-selected' : ''} onClick={() => setTab('device')}>
            <Icon name="Video" size={16} /> Dispositivos
          </button>
        </div>
        <div class="tri-share-grid">
          {tab === 'device' && devices.length === 0 && (
            <div class="tri-share-empty">
              <Icon name="Video" size={24} />
              <strong>Você não tem nenhum dispositivo de captura disponível.</strong>
              <span>No futuro, você poderá usar esta aba para compartilhar a partir de dispositivos específicos, como sua câmera.</span>
            </div>
          )}
          {tab === 'device' && devices.map(device => (
            <button key={device.id} class="tri-share-source" onClick={() => startDevice(device.id)} aria-label={device.name}>
              <span class="tri-share-source__frame"><span class="tri-share-source__thumb">
                <span class="tri-share-source__overlay"><span class="tri-share-source__cta">Selecionar</span></span>
              </span></span>
              <span class="tri-share-source__caption"><Icon name="Video" size={16} /><span>{device.name}</span></span>
            </button>
          ))}
          {tab !== 'device' && shown.map(source => (
            <button key={source.index} class="tri-share-source" onClick={() => start(source)} aria-label={source.name}>
              <span class="tri-share-source__frame"><span class="tri-share-source__thumb">
                {thumbs[source.index] ? <img src={thumbs[source.index]} alt="" />
                  : list && thumbsLate && <span class="tri-share-source__missing"><Icon name={source.kind === 'screen' ? 'ScreenShare' : 'Browser'} size={32} />Prévia indisponível</span>}
                <span class="tri-share-source__overlay"><span class="tri-share-source__cta">Compartilhar tela</span></span>
              </span></span>
              <span class="tri-share-source__caption">
                <Icon name={source.kind === 'screen' ? 'ScreenShare' : 'Browser'} size={16} />
                <span>{source.name}</span>
              </span>
            </button>
          ))}
        </div>
        <div class="tri-share-mode">
          <div class="tri-share-mode__text">
            <strong>{mode === 'game' ? 'Jogos' : 'Compartilhamento de tela'}</strong>
            <span>{quality(mode, hd, false)}</span>
          </div>
          <div class="tri-share-quality" role="radiogroup" aria-label="Resolução">
            {[false, true].map(value => (
              <button key={String(value)} role="radio" aria-checked={hd === value} class={hd === value ? 'is-selected' : ''}
                onClick={() => { setHd(value); save('shareHd', value); }}>{value ? 'HD' : 'SD'}</button>
            ))}
          </div>
          <button ref={gear} class="tri-share-mode__gear" aria-label="Modo de transmissão" aria-haspopup="menu" aria-expanded={modeMenu}
            onClick={() => setModeMenu(open => !open)}><Icon name="Settings" size={20} /></button>
          {modeMenu && (
            <div ref={menuRef} class="tri-share-mode__menu" role="menu" aria-label="Modo de transmissão">
              <div class="tri-share-mode__menu-title">Modo de transmissão</div>
              {(['game', 'screen'] as Mode[]).map(value => (
                <button key={value} role="menuitemradio" aria-checked={mode === value} class="tri-share-mode__row"
                  onClick={() => { setMode(value); save('shareMode', value); }}>
                  <span><strong>{value === 'game' ? 'Jogos' : 'Compartilhamento de tela'}</strong><small>{quality(value, hd, true)}</small></span>
                  <span class={`tri-share-mode__radio ${mode === value ? 'is-checked' : ''}`} aria-hidden="true" />
                </button>
              ))}
              <div class="tri-share-mode__separator" role="separator" />
              <button role="menuitemcheckbox" aria-checked={!audio} class="tri-share-mode__row tri-share-mode__row--single"
                onClick={() => { setAudio(!audio); save('shareAudio', !audio); }}>
                <span><strong>Silenciar áudio da transmissão</strong></span>
                <span class={`tri-menu__checkbox ${!audio ? 'is-checked' : ''}`} aria-hidden="true">
                  {!audio && <svg viewBox="0 0 20 20" width="20" height="20"><path d="M5 10.5 8.5 14 15 6.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>}
                </span>
              </button>
            </div>
          )}
        </div>
      </div>
    </ModalLayer>
  );
}
