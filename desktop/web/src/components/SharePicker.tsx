import { useEffect, useRef, useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import type { ShareSource } from '../protocol';
import type { SessionStore } from '../store';
import { Icon } from './Icon';
import { ModalLayer, useModalClose } from './ModalLayer';
import { loadShareSources, type ShareSourceState } from '../share-sources';

// Screen and window share source picker modal.
type Mode = 'game' | 'screen';
function quality(mode: Mode, hd: boolean, parenthesised: boolean) {
  const res = `${hd ? 1080 : 720}p`, fps = `${mode === 'game' ? (hd ? 60 : 30) : 15}fps`;
  const lead = mode === 'game' ? 'Vídeo mais suave' : 'Texto mais claro';
  return parenthesised ? `${lead} (${res}, ${fps})` : `${lead} · ${res} · ${fps}`;
}
export function SharePicker({ bridge, store, onClose }: { bridge: Bridge; store: SessionStore; onClose: () => void }) {
  const [tab, setTab] = useState<'window' | 'screen' | 'device'>('window');
  const [sourceState, setSourceState] = useState<ShareSourceState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const list = sourceState.status === 'ready' ? sourceState : null;
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  // After 4 s without a thumbnail the card says so (it can still be shared) instead of staying black.
  const [thumbsLate, setThumbsLate] = useState(false);
  useEffect(() => { setThumbsLate(false); const timer = setTimeout(() => setThumbsLate(true), 4000); return () => clearTimeout(timer); }, [attempt]);
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
    setThumbs({});
    const off = loadShareSources(bridge, store, setSourceState,
      (index, image) => setThumbs(t => ({ ...t, [index]: image })));
    bridge.send({ name: 'requestDevices' });
    return off;
  }, [bridge, store, attempt]);
  const devices = settings?.cameraDevices ?? [];
  const hasDeviceTab = store.current?.runtime?.camera !== false && (devices.length > 0);
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
          {hasDeviceTab && (
            <button role="tab" aria-selected={tab === 'device'} class={tab === 'device' ? 'is-selected' : ''} onClick={() => setTab('device')}>
              <Icon name="Video" size={16} /> Dispositivos
            </button>
          )}
        </div>
        <div class="tri-share-grid" aria-busy={tab !== 'device' && sourceState.status === 'loading'}>
          {tab !== 'device' && sourceState.status === 'loading' && (
            <div class="tri-share-empty" role="status"><strong>Buscando telas e aplicativos…</strong></div>
          )}
          {tab !== 'device' && sourceState.status === 'error' && (
            <div class="tri-share-empty">
              <div role="alert"><strong>Não foi possível listar telas e aplicativos.</strong><span>{sourceState.message}</span></div>
              <button type="button" class="tri-share-retry" onClick={() => setAttempt(value => value + 1)}>Tentar novamente</button>
            </div>
          )}
          {tab !== 'device' && list && shown.length === 0 && (
            <div class="tri-share-empty" role="status">
              <strong>{tab === 'window' ? 'Nenhum aplicativo disponível.' : 'Nenhuma tela disponível.'}</strong>
              <span>{tab === 'window' ? 'Abra o aplicativo que deseja compartilhar ou escolha Tela Inteira.' : 'Confira os monitores conectados e tente novamente.'}</span>
              <button type="button" class="tri-share-retry" onClick={() => setAttempt(value => value + 1)}>Atualizar lista</button>
            </div>
          )}
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
              <button role="menuitemcheckbox" aria-checked={!audio} disabled={store.current?.runtime?.screenAudio === false} class="tri-share-mode__row tri-share-mode__row--single"
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
