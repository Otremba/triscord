import { useEffect, useRef, useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import type { SessionStore } from '../store';
import { CameraPreview } from './CameraPreview';
import type { Session, SettingsState } from '../protocol';
import type { IconName } from '../icons.generated';
import { Icon } from './Icon';
import { ModalLayer, useModalClose } from './ModalLayer';
import { Modal } from './Modal';

// User settings, observed in Discord (out/claude-observations/motion/settings-*.png, SETTINGS.md; 1280x900 window):
// - a layer inside the window, 40px from every edge, 1px border, opening/closing with the modal springs
//   (motion/settings-open, settings-close: same timing as ModalLayer);
// - navigation 252px on --background-base-lower: 48px avatar + name (16px semibold) + "Editar perfis" with a pencil,
//   a 40px "Buscar" field, categories with 20px icons and 16px labels, the selected one on --background-mod-normal
//   (measured #42434a), radius 8, 36px tall; sub-sections on a 1px rail with a 20px white marker on the active one;
//   14px group labels ("Experiência"); a separator and the danger "Sair" with its icon at the end;
// - content on --background-base-low: 48px header with the page title (16px) and an X, a divider, a centred
//   column (≈696px) with 24px section headings, 16px semibold labels, 14px descriptions;
// - controls: 340x40 selects (radius 8, --input-* tokens, icon before the device name), sliders with a 4px track,
//   brand fill and a 16px white handle, 48x24 switches (brand when on), 48px theme swatches with a brand ring
//   and a check on the selected one.
// Pages kept (each control has a triscord function): Conta (display name, the name triscord shows), Voz e vídeo
// (microphone, speaker, both volumes, noise suppression on/off, camera), Aparência (the four standard themes:
// Claro, Cinza, Escuro, Ônix — Discord's names for the light, dark, darker and midnight token sets) and Sair.
// Not observable here or without a triscord function: search results beyond filtering the navigation,
// "Teste do microfone", input profiles, sensitivity, echo cancellation, notifications (needs a widget-free notifier
// in the web client), and every other category.
type Page = 'account' | 'notifications' | 'voice' | 'appearance' | 'windows';
// "Relatórios de erro" (20/10): every 30 minutes, and at start for the previous session, a log with new signs of a bug
// goes to the hub (desktop/src/error_reports.h); "Enviar log agora" sends the running session's log at once.
function ErrorReports({ bridge, enabled, available, onChange }: { bridge: Bridge; enabled: boolean; available: boolean; onChange: (on: boolean) => void }) {
  const [state, setState] = useState<{ busy?: boolean; done?: boolean; error?: string }>({});
  const send = () => {
    setState({ busy: true });
    bridge.request({ name: 'sendErrorReport' }).then(() => setState({ done: true })).catch((err: Error) => setState({ error: err.message }));
  };
  return (
    <>
      <h2 class="tri-settings__heading" data-sub>Relatórios de erro</h2>
      <div class="tri-settings__toggle-row tri-settings__toggle-row--spaced">
        <div><span class="tri-settings__label">Enviar relatórios de erro automaticamente</span>
          <p class="tri-settings__description">Quando algo falhar (transmissão, compartilhamento, conexão), o Triscord envia o log da sessão para os desenvolvedores automaticamente. O log não tem mensagens, senhas nem tokens, e é apagado depois de 14 dias.</p></div>
        <Switch checked={enabled} label="Enviar relatórios de erro automaticamente" onChange={onChange} />
      </div>
      <div class="tri-settings__row">
        <span class="tri-settings__label">Enviar log agora
          <span class="tri-settings__description" role="status">{!available ? 'Esta instalação não grava log.'
            : state.done ? 'Log enviado. Obrigado!' : state.error ? state.error : 'Use quando algo estiver dando errado agora, para os desenvolvedores verem.'}</span></span>
        <button class="tri-button tri-button--secondary tri-settings__row-button" disabled={!available || state.busy} onClick={send}>
          {state.busy ? 'Enviando…' : 'Enviar log'}</button>
      </div>
    </>
  );
}

const NAV: { page: Page; label: string; icon: IconName; group?: string; subs: string[] }[] = [
  { page: 'account', label: 'Conta', icon: 'User', subs: ['Informações da conta', 'Senha e autenticação'] },
  { page: 'notifications', label: 'Notificações', icon: 'Bell', subs: ['Visão geral'] },
  { page: 'voice', label: 'Voz e vídeo', icon: 'Microphone', group: 'Experiência', subs: ['Voz', 'Câmera', 'Painel de efeitos sonoros'] },
  { page: 'appearance', label: 'Aparência', icon: 'PaintPalette', subs: ['Tema'] },
  { page: 'windows', label: 'Configurações do Windows', icon: 'WindowLaunch', subs: ['Inicialização', 'Janela', 'Relatórios de erro'] },
];
const TITLES: Record<Page, string> = { account: 'Conta', notifications: 'Notificações', voice: 'Voz e vídeo', appearance: 'Aparência', windows: 'Configurações do Windows' };
const THEMES: { id: SettingsState['theme']; name: string }[] = [
  { id: 'light', name: 'Claro' }, { id: 'dark', name: 'Cinza' }, { id: 'darker', name: 'Escuro' }, { id: 'midnight', name: 'Ônix' },
];
// "Temas coloridos" (/xvEMy): Discord's gradient presets (BACKGROUND_GRADIENT_PRESET). triscord offers the pink one,
// "Algodão-doce" (COTTON_CANDY, godtzA), free; the swatch shows the preset's gradient (styles/custom-theme.css).
const COLOR_THEMES: { id: SettingsState['theme']; name: string }[] = [{ id: 'cotton-candy', name: 'Algodão-doce' }];

function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} class={`tri-switch ${checked ? 'is-on' : ''}`} onClick={() => onChange(!checked)}>
      <span class="tri-switch__knob" />
    </button>
  );
}

function Slider({ value, max, label, onChange }: { value: number; max: number; label: string; onChange: (v: number) => void }) {
  return (
    <input type="range" class="tri-slider" min={0} max={max} value={value} aria-label={label}
      style={{ '--tri-fill': `${(100 * value) / max}%` } as Record<string, string>}
      onInput={e => onChange(+(e.target as HTMLInputElement).value)} />
  );
}

function Select({ value, options, icon, label, onChange }: {
  value: string; options: { id: string; name: string; isDefault?: boolean }[]; icon?: IconName; label: string; onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    addEventListener('mousedown', close, true);
    return () => removeEventListener('mousedown', close, true);
  }, [open]);
  // Discord labels the default "Padrão do Windows (<the default device>)", the name muted (audit 18/10).
  const fallback = options.find(o => o.isDefault)?.name;
  const all: { id: string; name: string; isDefault?: boolean; detail?: string }[] = [{ id: '', name: 'Padrão do Windows', detail: fallback }, ...options];
  const current = all.find(o => o.id === value) ?? { id: value, name: 'Dispositivo Indisponível' };
  return (
    <div class="tri-select" ref={ref}>
      <button type="button" class={`tri-select__value ${open ? 'is-open' : ''}`} aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={() => setOpen(!open)}>
        {icon && <Icon name={icon} size={20} className="tri-select__icon" />}
        <span class="tri-select__text">{current.name}{current.detail && <span class="tri-select__detail"> ({current.detail})</span>}</span>
        <Icon name={open ? 'ChevronSmallUp' : 'ChevronSmallDown'} size={24} className="tri-select__chevron" />
      </button>
      {open && (
        <div class="tri-select__popout" role="listbox" aria-label={label}>
          {all.map(o => (
            <button type="button" key={o.id || 'default'} role="option" aria-selected={o.id === value} class={`tri-select__option ${o.id === value ? 'is-selected' : ''}`}
              onClick={() => { setOpen(false); if (o.id !== value) onChange(o.id); }}>{o.name}{o.detail && <span class="tri-select__detail"> ({o.detail})</span>}</button>
          ))}
        </div>
      )}
    </div>
  );
}

function NameModal({ bridge, current, onClose }: { bridge: Bridge; current: string; onClose: () => void }) {
  const { closing, close } = useModalClose(onClose);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Alterar seu nome de usuário" onClose={close} closing={closing}
      onSubmit={e => {
        const value = ((e.currentTarget as HTMLFormElement).elements.namedItem('nick') as HTMLInputElement).value.trim();
        if (value.length < 2) { setError('Use pelo menos dois caracteres.'); return; }
        setBusy(true); setError(null);
        bridge.request({ name: 'setNick', nick: value }).then(close).catch((err: Error) => setError(err.message)).finally(() => setBusy(false));
      }}
      preview={error && <p class="tri-dmodal__error" role="alert">{error}</p>}
      actions={[{ label: 'Cancelar', variant: 'secondary', onClick: close }, { label: 'Concluído', variant: 'primary', type: 'submit', disabled: busy }]}>
      <div class="tri-field">
        <label class="tri-field__label" for="tri-settings-nick">Nome de usuário</label>
        <div class="tri-text-input"><input id="tri-settings-nick" name="nick" class="tri-text-input__input" defaultValue={current} maxLength={32} autoFocus /></div>
      </div>
    </Modal>
  );
}

// "Senha e autenticação": Discord's "Alterar senha" modal (current password, new password, confirmation). An account
// created only with a nick has no password yet: then the modal creates one, without the current-password field.
function PasswordModal({ bridge, hasPassword, onClose }: { bridge: Bridge; hasPassword: boolean; onClose: () => void }) {
  const { closing, close } = useModalClose(onClose);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={hasPassword ? 'Alterar sua senha' : 'Criar uma senha'}
      subtitle={hasPassword ? 'Insira sua senha atual e uma nova senha.' : 'Com uma senha, você entra nesta conta em outro computador usando seu nome de usuário.'}
      onClose={close} closing={closing}
      onSubmit={e => {
        const form = e.currentTarget as HTMLFormElement;
        const value = (name: string) => (form.elements.namedItem(name) as HTMLInputElement | null)?.value ?? '';
        const password = value('password');
        if (password.length < 6) { setError('A senha precisa ter pelo menos 6 caracteres.'); return; }
        if (password !== value('confirm')) { setError('As senhas não coincidem.'); return; }
        setBusy(true); setError(null);
        bridge.request({ name: 'setPassword', password, ...(hasPassword ? { currentPassword: value('current') } : {}) })
          .then(close).catch((err: Error) => setError(err.message)).finally(() => setBusy(false));
      }}
      preview={error && <p class="tri-dmodal__error" role="alert">{error}</p>}
      actions={[{ label: 'Cancelar', variant: 'secondary', onClick: close }, { label: 'Concluído', variant: 'primary', type: 'submit', disabled: busy }]}>
      {hasPassword && <div class="tri-field">
        <label class="tri-field__label" for="tri-password-current">Senha atual</label>
        <div class="tri-text-input"><input id="tri-password-current" name="current" type="password" class="tri-text-input__input" maxLength={128} autoComplete="current-password" autoFocus /></div>
      </div>}
      <div class="tri-field">
        <label class="tri-field__label" for="tri-password-new">Nova senha</label>
        <div class="tri-text-input"><input id="tri-password-new" name="password" type="password" class="tri-text-input__input" maxLength={128} autoComplete="new-password" autoFocus={!hasPassword} /></div>
      </div>
      <div class="tri-field">
        <label class="tri-field__label" for="tri-password-confirm">Confirmar nova senha</label>
        <div class="tri-text-input"><input id="tri-password-confirm" name="confirm" type="password" class="tri-text-input__input" maxLength={128} autoComplete="new-password" /></div>
      </div>
    </Modal>
  );
}

export function SignOutModal({ bridge, onClose }: { bridge: Bridge; onClose: () => void }) {
  const { closing, close } = useModalClose(onClose);
  // INFERRED: Discord's logout confirmation was not opened; title "Sair" (TzJA4g) and the locale's
  // "Você tem certeza de que deseja sair?" (6kDZh1), critical "Sair" as in its other confirmations.
  return (
    <Modal title="Sair" subtitle="Você tem certeza de que deseja sair?" onClose={close} closing={closing}
      actions={[{ label: 'Cancelar', variant: 'secondary', onClick: close }, { label: 'Sair', variant: 'critical', onClick: () => { bridge.send({ name: 'signOut' }); close(); } }]} />
  );
}

export function Settings({ session, bridge, store, onClose }: { session: Session; bridge: Bridge; store: SessionStore; onClose: () => void }) {
  const { closing, close } = useModalClose(onClose);
  const [page, setPage] = useState<Page>('voice');
  const [cameraPreview, setCameraPreview] = useState(false);
  useEffect(() => setCameraPreview(false),[page,session.settings?.cameraDevice]);
  const [query, setQuery] = useState('');
  const [dialog, setDialog] = useState<'name' | 'password' | 'signOut' | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [activeSub, setActiveSub] = useState(0);
  const s = session.settings;
  const set = (key: string, value: string | number | boolean) => bridge.send({ name: 'setSetting', key, value } as Parameters<Bridge['send']>[0]);
  useEffect(() => { bridge.send({ name: 'requestDevices' }); }, []);
  useEffect(() => { scroller.current?.scrollTo({ top: 0 }); setActiveSub(0); }, [page]);
  // The active sub-section follows the scroll position (observed in Voz e vídeo).
  const onScroll = () => {
    const el = scroller.current; if (!el) return;
    const heads = [...el.querySelectorAll<HTMLElement>('[data-sub]')];
    let active = 0;
    heads.forEach((h, i) => { if (h.offsetTop - 80 <= el.scrollTop) active = i; });
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) active = heads.length - 1;
    setActiveSub(active);
  };
  const goSub = (i: number) => { const h = scroller.current?.querySelectorAll<HTMLElement>('[data-sub]')[i]; if (h && scroller.current) scroller.current.scrollTo({ top: h.offsetTop - 56 }); };
  const q = query.trim().toLowerCase();
  const nav = NAV.filter(n => !q || n.label.toLowerCase().includes(q) || n.subs.some(x => x.toLowerCase().includes(q)));
  const { account } = session;
  return (
    <ModalLayer closing={closing} onRequestClose={dialog ? () => {} : close}>
      <div class="tri-settings" role="dialog" aria-label="Configurações de usuário">
        <nav class="tri-settings__nav" aria-label="Configurações">
          <button class="tri-settings__profile" onClick={() => dispatchEvent(new Event('tri-open-profile'))}>
            <span class="tri-avatar tri-avatar--48">
              {account.avatarUrl ? <img src={account.avatarUrl} alt="" /> : <span class="tri-avatar__letter">{account.displayName.slice(0, 1).toUpperCase()}</span>}
            </span>
            <span class="tri-settings__profile-text">
              <span class="tri-settings__profile-name">{account.displayName}</span>
              <span class="tri-settings__profile-edit">Editar perfis <Icon name="Pencil" size={12} /></span>
            </span>
          </button>
          <label class="tri-settings__search">
            <Icon name="MagnifyingGlass" size={20} />
            <input placeholder="Buscar" aria-label="Buscar" value={query} onInput={e => setQuery((e.target as HTMLInputElement).value)} />
          </label>
          <div class="tri-settings__nav-list">
            {nav.map(n => (
              <div key={n.page}>
                {n.group && <div class="tri-settings__group">{n.group}</div>}
                <button class={`tri-settings__item ${page === n.page ? 'is-selected' : ''}`} aria-current={page === n.page} onClick={() => setPage(n.page)}>
                  <Icon name={n.icon} size={20} /><span>{n.label}</span>
                </button>
                {page === n.page && n.subs.length > 1 && (
                  <div class="tri-settings__subs">
                    {n.subs.map((sub, i) => (
                      <button key={sub} class={`tri-settings__sub ${activeSub === i ? 'is-active' : ''}`} onClick={() => goSub(i)}>{sub}</button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <div class="tri-settings__separator" />
            <button class="tri-settings__item is-danger" onClick={() => setDialog('signOut')}>
              <Icon name="DoorExit" size={20} /><span>Sair</span>
            </button>
          </div>
        </nav>
        <section class="tri-settings__content">
          <header class="tri-settings__header">
            <h1 class="tri-settings__title">{TITLES[page]}</h1>
            <button class="tri-settings__close" aria-label="Fechar" onClick={close}><Icon name="Close" size={24} /></button>
          </header>
          <div class="tri-settings__scroller" ref={scroller} onScroll={onScroll}>
            <div class="tri-settings__column">
              {page === 'account' && (
                <>
                  <h2 class="tri-settings__heading" data-sub>Informações da conta</h2>
                  <div class="tri-settings__row">
                    <span class="tri-settings__label">Nome de usuário</span>
                    <span class="tri-settings__value">{account.username}</span>
                    <button class="tri-button tri-button--secondary tri-settings__row-button" onClick={() => setDialog('name')}>Editar</button>
                  </div>
                  <h2 class="tri-settings__heading" data-sub>Senha e autenticação</h2>
                  <div class="tri-settings__row">
                    <span class="tri-settings__label">Senha
                      <span class="tri-settings__description">{session.profile?.hasPassword
                        ? 'Use seu nome de usuário e esta senha para entrar em outro computador.'
                        : session.profile?.google ? 'Opcional: você já entra com o Google. Com uma senha, também entra só com o nome de usuário.'
                        : 'Sua conta ainda não tem senha. Crie uma para entrar em outro computador.'}</span></span>
                    <button class="tri-button tri-button--primary tri-settings__row-button" onClick={() => setDialog('password')}>
                      {session.profile?.hasPassword ? 'Alterar senha' : 'Criar senha'}</button>
                  </div>
                </>
              )}
              {page === 'voice' && s && (
                <>
                  <h2 class="tri-settings__heading" data-sub>Voz</h2>
                  <div class="tri-settings__grid">
                    <div class="tri-settings__field"><span class="tri-settings__label">Microfone</span>
                      <Select value={s.inputDevice} options={s.inputDevices} icon="Microphone" label="Microfone" onChange={id => set('inputDevice', id)} /></div>
                    <div class="tri-settings__field"><span class="tri-settings__label">Alto-falante</span>
                      <Select value={s.outputDevice} options={s.outputDevices} icon="Headphones" label="Alto-falante" onChange={id => set('outputDevice', id)} /></div>
                    <div class="tri-settings__field"><span class="tri-settings__label">Volume do Microfone</span>
                      <Slider value={s.inputVolume} max={100} label="Volume do Microfone" onChange={v => set('inputVolume', v)} /></div>
                    <div class="tri-settings__field"><span class="tri-settings__label">Volume do Alto-falante</span>
                      <Slider value={s.outputVolume} max={200} label="Volume do Alto-falante" onChange={v => set('outputVolume', v)} /></div>
                  </div>
                  <div class="tri-settings__divider" />
                  <div class="tri-settings__toggle-row">
                    <div><span class="tri-settings__label">Supressão de ruído</span>
                      <p class="tri-settings__description">Reduz ruídos de fundo, como teclado, ventilador e carros. Intensidades maiores podem alterar a voz.</p></div>
                    <Switch checked={s.noiseSuppression} label="Supressão de ruído" onChange={on => set('noiseSuppression', on)} />
                  </div>
                  {s.noiseSuppression && (() => {
                    const high = s.noiseSuppressionHighAvailable !== false, mode = high ? s.noiseSuppressionMode ?? 'high' : 'standard';
                    const options = [
                      { id: 'high', title: 'Alta qualidade', disabled: !high,
                        description: high ? 'Tira teclado, carros e ventilador até enquanto você fala (DeepFilterNet). Usa um pouco mais o processador.'
                          : 'Indisponível nesta instalação.' },
                      { id: 'standard', title: 'Padrão', disabled: false, description: 'Mais leve: tira ruído constante e o que vem entre as frases (RNNoise).' },
                    ] as const;
                    return <div class="tri-settings__noise-mode" role="radiogroup" aria-label="Tipo de supressão de ruído">
                      {options.map(o => <label key={o.id} class={`tri-radio ${mode === o.id ? 'is-selected' : ''} ${o.disabled ? 'is-disabled' : ''}`}>
                        <input type="radio" name="noiseSuppressionMode" value={o.id} checked={mode === o.id} disabled={o.disabled} class="tri-radio__input"
                          onChange={() => set('noiseSuppressionMode', o.id)} />
                        <span class="tri-radio__circle" aria-hidden="true" />
                        <span class="tri-radio__content"><span class="tri-radio__title">{o.title}</span>
                          <span class="tri-radio__description">{o.description}</span></span>
                      </label>)}
                    </div>;
                  })()}
                  {s.noiseSuppression && <div class="tri-settings__field tri-settings__noise-strength">
                    <span class="tri-settings__label">Intensidade da supressão de ruído: {s.noiseSuppressionStrength ?? 100}%</span>
                    <p class="tri-settings__description tri-settings__description--above">Ajusta o ruído do seu microfone enviado às outras pessoas. 0% não aplica redução; 100% aplica a redução máxima. Diminua se a sua voz ficar artificial.</p>
                    <Slider value={s.noiseSuppressionStrength ?? 100} max={100} label="Intensidade da supressão de ruído"
                      onChange={v => set('noiseSuppressionStrength', v)} />
                  </div>}
                  <div class="tri-settings__toggle-row">
                    <div><span class="tri-settings__label">Controle de ganho automático</span>
                      <p class="tri-settings__description">Ajusta automaticamente o volume do seu microfone para que os outros ouçam você sempre no mesmo nível.</p></div>
                    <Switch checked={s.automaticGainControl ?? true} label="Controle de ganho automático" onChange={on => set('automaticGainControl', on)} />
                  </div>
                  <div class="tri-settings__divider" />
                  <h2 class="tri-settings__heading" data-sub>Câmera</h2>
                  <div class="tri-settings__field tri-settings__field--half"><span class="tri-settings__label">Câmera</span>
                    <Select value={s.cameraDevice} options={s.cameraDevices} icon="Video" label="Câmera" onChange={id => set('cameraDevice', id)} /></div>
                  {cameraPreview && !closing && <CameraPreview bridge={bridge} store={store}/>}
                  <div class="tri-camera-preview-actions"><button class="tri-button tri-button--primary" onClick={() => setCameraPreview(!cameraPreview)}>
                    {cameraPreview ? 'Parar teste' : 'Testar vídeo'}</button></div>
                  <div class="tri-settings__divider" />
                  {/* Bundled soundboard volume and original local call cues. */}
                  <h2 class="tri-settings__heading" data-sub>Painel de efeitos sonoros</h2>
                  <div class="tri-settings__toggle-row tri-settings__toggle-row--spaced">
                    <div><span class="tri-settings__label">Sons da chamada</span>
                      <p class="tri-settings__description">Ouça avisos de entrada, saída e ao ativar ou silenciar seu microfone.</p></div>
                    <Switch checked={s.callSounds ?? true} label="Sons da chamada" onChange={on => set('callSounds', on)} />
                  </div>
                  <div class="tri-settings__field">
                    <span class="tri-settings__label">Volume dos efeitos sonoros</span>
                    <p class="tri-settings__description tri-settings__description--above">Controle o volume dos sons para você individualmente.</p>
                    <Slider value={s.soundboardVolume ?? 70} max={100} label="Volume dos efeitos sonoros" onChange={v => set('soundboardVolume', v)} />
                  </div>
                </>
              )}
              {page === 'notifications' && s && (
                // Observed (motion/settings-notifications.png): "Visão geral" with "Ativar notificações na área de
                // trabalho" (/0WCll) and "Ativar alerta na barra de tarefas" (xSmFQG, with its observed description).
                // Discord's description of the first points to per-server notification settings, which triscord does
                // not have; the text below says what triscord notifies (NotificationPolicy). "Notifique-me quando..."
                // lists events triscord does not have (friends, events, reactions) and is left out.
                <>
                  <h2 class="tri-settings__heading" data-sub>Visão geral</h2>
                  <div class="tri-settings__toggle-row tri-settings__toggle-row--spaced">
                    <div><span class="tri-settings__label">Ativar notificações na área de trabalho</span>
                      <p class="tri-settings__description">Avisa quando alguém mencionar você no chat da sala ou entrar na sua sala enquanto o Triscord estiver em segundo plano.</p></div>
                    <Switch checked={s.desktopNotifications} label="Ativar notificações na área de trabalho" onChange={on => set('desktopNotifications', on)} />
                  </div>
                  <div class="tri-settings__toggle-row tri-settings__toggle-row--spaced">
                    <div><span class="tri-settings__label">Ativar alerta na barra de tarefas</span>
                      <p class="tri-settings__description">Pisca o ícone do aplicativo na sua barra de tarefas ao receber novas notificações.</p></div>
                    <Switch checked={s.taskbarAlert} label="Ativar alerta na barra de tarefas" onChange={on => set('taskbarAlert', on)} />
                  </div>
                </>
              )}
              {page === 'windows' && s && (
                // Discord's "Configurações do Windows" (open at logon, open minimized, minimize to tray). The native core
                // keeps the tray icon and the single instance; "Abrir minimizado" only matters for a start at logon.
                <>
                  <h2 class="tri-settings__heading" data-sub>Inicialização</h2>
                  {s.loginSupported !== false && (
                    <div class="tri-settings__toggle-row tri-settings__toggle-row--spaced">
                      <div><span class="tri-settings__label">Abrir o Triscord</span>
                        <p class="tri-settings__description">Inicia o Triscord quando você entra no Windows.</p></div>
                      <Switch checked={!!s.openAtLogin} label="Abrir o Triscord" onChange={on => set('openAtLogin', on)} />
                    </div>
                  )}
                  <div class="tri-settings__toggle-row tri-settings__toggle-row--spaced">
                    <div><span class="tri-settings__label">Abrir minimizado</span>
                      <p class="tri-settings__description">Ao iniciar com o Windows, o Triscord fica na bandeja em vez de abrir a janela.</p></div>
                    <Switch checked={!!s.startMinimized} label="Abrir minimizado" onChange={on => set('startMinimized', on)} />
                  </div>
                  <h2 class="tri-settings__heading" data-sub>Janela</h2>
                  <div class="tri-settings__toggle-row tri-settings__toggle-row--spaced">
                    <div><span class="tri-settings__label">Minimizar para a bandeja</span>
                      <p class="tri-settings__description">Fechar a janela mantém o Triscord na bandeja do sistema, e sua chamada continua. Para sair de vez, use o ícone da bandeja.</p></div>
                    <Switch checked={s.closeToTray !== false} label="Minimizar para a bandeja" onChange={on => set('closeToTray', on)} />
                  </div>
                  <ErrorReports bridge={bridge} enabled={s.errorReports !== false} available={!!s.errorReportsAvailable} onChange={on => set('errorReports', on)} />
                </>
              )}
              {page === 'appearance' && s && (
                <>
                  <h2 class="tri-settings__heading" data-sub>Tema</h2>
                  <span class="tri-settings__label">Temas padrão</span>
                  <div class="tri-themes" role="radiogroup" aria-label="Temas padrão">
                    {THEMES.map(t => (
                      <button key={t.id} role="radio" aria-checked={s.theme === t.id} aria-label={t.name} title={t.name}
                        class={`tri-theme tri-theme--${t.id} ${s.theme === t.id ? 'is-selected' : ''}`} onClick={() => set('theme', t.id)}>
                        {s.theme === t.id && <span class="tri-theme__check" aria-hidden="true"><Icon name="CircleCheck" size={20} /></span>}
                      </button>
                    ))}
                  </div>
                  <span class="tri-settings__label">Temas coloridos</span>
                  <div class="tri-themes" role="radiogroup" aria-label="Temas coloridos">
                    {COLOR_THEMES.map(t => (
                      <button key={t.id} role="radio" aria-checked={s.theme === t.id} aria-label={t.name} title={t.name}
                        class={`tri-theme tri-theme--${t.id} ${s.theme === t.id ? 'is-selected' : ''}`} onClick={() => set('theme', t.id)}>
                        {s.theme === t.id && <span class="tri-theme__check" aria-hidden="true"><Icon name="CircleCheck" size={20} /></span>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </section>
      </div>
      {dialog === 'name' && <NameModal bridge={bridge} current={account.username} onClose={() => setDialog(null)} />}
      {dialog === 'password' && <PasswordModal bridge={bridge} hasPassword={!!session.profile?.hasPassword} onClose={() => setDialog(null)} />}
      {dialog === 'signOut' && <SignOutModal bridge={bridge} onClose={() => setDialog(null)} />}
    </ModalLayer>
  );
}
