import { useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import { Icon } from './Icon';
import { ModalLayer, useModalClose } from './ModalLayer';

// "Criar seu servidor" flow, from Discord's own code and CSS recovered with REA plus captures
// (SERVIDORES.md, REA_CLAUDE_20261016.md):
//   start ("Criar seu servidor", observed) -> customize ("Personalize o seu servidor", observed;
//   CUSTOMIZE_GUILD: name suggestion "Servidor de {username}", primary "Criar" + secondary "Voltar")
//   start -> join (JOIN_GUILD, module 812633 + 2d1f7e43168351af.css: required "Link de convite", sample chips
//   that fill the field, primary "Entrar no servidor"; errors shown in the field).
// Left out as in the Qt client: the community/friends question, templates, server icon upload, the
// guidelines footer and the Discovery row (no triscord function or never observed).
// Inferred: modal width 444px and option rows 402x54 measured on the captures (WIDTH_SMALL token unresolved).
type Page = 'start' | 'customize' | 'join';
// Submits read the field itself, so a submit right after a paste never sees a stale state value.
const field = (event: Event, key: string) =>
  (((event.currentTarget as HTMLFormElement).elements.namedItem(key) as HTMLInputElement | null)?.value ?? '').trim();
const SAMPLE = '3f9c2a7e5b1d4c8fa06e2b9d7c1f4a53';

export function ServerModal({ bridge, displayName, onClose }: { bridge: Bridge; displayName: string; onClose: () => void }) {
  const [page, setPage] = useState<Page>('start');
  const [name, setName] = useState(`Servidor de ${displayName}`.slice(0, 32));
  const [invite, setInvite] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { closing, close } = useModalClose(onClose);
  const go = (next: Page) => { setPage(next); setError(null); };
  const submit = (command: Parameters<Bridge['request']>[0]) => {
    setBusy(true); setError(null);
    bridge.request(command).then(close).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  // type="button": inside the customize/join forms a plain button submits, and closing created the server (user report).
  const closeButton = <button type="button" class="tri-modal__close" aria-label="Fechar" onClick={close}><Icon name="Close" size={24} /></button>;
  return (
    <ModalLayer closing={closing} onRequestClose={close}>
      <div class="tri-modal" role="dialog" aria-label={page === 'join' ? 'Entrar em um servidor' : 'Criar seu servidor'}>
        {page === 'start' && (
          <div class="tri-modal__page">
            {closeButton}
            <h1 class="tri-modal__title">Criar seu servidor</h1>
            <p class="tri-modal__subtitle">Seu servidor é onde você e seus amigos se reúnem. Crie o seu e comece a interagir.</p>
            <button class="tri-modal__option" onClick={() => go('customize')}>
              <span>Criar o meu</span><Icon name="ChevronSmallRight" size={24} />
            </button>
            <h2 class="tri-modal__question">Já tem um convite?</h2>
            <button class="tri-modal__secondary" onClick={() => go('join')}>Entrar em um servidor</button>
          </div>
        )}
        {page === 'customize' && (
          <form class="tri-modal__page" onSubmit={e => { e.preventDefault(); const value = field(e, 'serverName'); if (value) submit({ name: 'createServer', serverName: value }); }}>
            {closeButton}
            <h1 class="tri-modal__title">Personalize o seu servidor</h1>
            <p class="tri-modal__subtitle">Deixe seu novo servidor com a sua cara dando um nome e um ícone a ele. Se quiser, é possível mudar depois.</p>
            <label class="tri-modal__label" for="tri-server-name">Nome do servidor <span class="tri-required">*</span></label>
            <input id="tri-server-name" name="serverName" class="tri-modal__input" value={name} maxLength={32} autoFocus onInput={e => setName((e.target as HTMLInputElement).value)} />
            {error && <p class="tri-modal__error" role="alert">{error}</p>}
            <div class="tri-modal__footer">
              <button type="button" class="tri-modal__back" onClick={() => go('start')}>Voltar</button>
              <button type="submit" class="tri-modal__primary" disabled={busy || !name.trim()}>Criar</button>
            </div>
          </form>
        )}
        {page === 'join' && (
          <form class="tri-modal__page tri-modal__page--join" onSubmit={e => { e.preventDefault(); submit({ name: 'acceptInvite', invite: field(e, 'invite') }); }}>
            {closeButton}
            <h1 class="tri-modal__title">Entrar em um servidor</h1>
            <p class="tri-modal__subtitle tri-modal__subtitle--sm">Insira um convite abaixo para entrar em um servidor existente</p>
            <label class={`tri-modal__label ${error ? 'is-error' : ''}`} for="tri-invite">Link de convite <span class="tri-required">*</span></label>
            <input id="tri-invite" name="invite" class={`tri-modal__input ${error ? 'has-error' : ''}`} value={invite} placeholder={SAMPLE} maxLength={256} autoFocus
              onInput={e => setInvite((e.target as HTMLInputElement).value)} aria-invalid={!!error} />
            {error && <p class="tri-modal__error" role="alert">{error}</p>}
            <p class="tri-modal__samples-title">Convites devem ser mais ou menos assim</p>
            <div class="tri-modal__samples"><button type="button" class="tri-modal__sample" onClick={() => setInvite(SAMPLE)}>{SAMPLE}</button></div>
            <div class="tri-modal__footer">
              <button type="button" class="tri-modal__back" onClick={() => go('start')}>Voltar</button>
              <button type="submit" class="tri-modal__primary" disabled={busy}>Entrar no servidor</button>
            </div>
          </form>
        )}
      </div>
    </ModalLayer>
  );
}
