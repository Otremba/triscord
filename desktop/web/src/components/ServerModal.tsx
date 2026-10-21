import { useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import { Icon } from './Icon';
import { ModalLayer, useModalClose } from './ModalLayer';

// Server creation and joining modal dialog.
type Page = 'start' | 'customize' | 'join';
// Submits read the field itself, so a submit right after a paste never sees a stale state value.
const field = (event: Event, key: string) =>
  (((event.currentTarget as HTMLFormElement).elements.namedItem(key) as HTMLInputElement | null)?.value ?? '').trim();

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
  const closeButton = <button type="button" class="tri-modal__close" aria-label="Fechar" disabled={busy} onClick={close}><Icon name="Close" size={24} /></button>;
  return (
    <ModalLayer closing={closing} onRequestClose={()=>{if(!busy)close();}}>
      <div class="tri-modal" role="dialog" aria-label={page === 'join' ? 'Entrar em um servidor' : 'Criar seu servidor'}>
        {page === 'start' && (
          <div class="tri-modal__page">
            {closeButton}
            <h1 class="tri-modal__title">Criar seu servidor</h1>
            <p class="tri-modal__subtitle">Crie um servidor ou entre com um convite.</p>
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
            <p class="tri-modal__subtitle">Escolha o nome do servidor.</p>
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
            <input id="tri-invite" name="invite" class={`tri-modal__input ${error ? 'has-error' : ''}`} value={invite} placeholder="Link ou código de convite" maxLength={256} autoFocus
              onInput={e => setInvite((e.target as HTMLInputElement).value)} aria-invalid={!!error} />
            {error && <p class="tri-modal__error" role="alert">{error}</p>}
            <div class="tri-modal__footer">
              <button type="button" class="tri-modal__back" onClick={() => go('start')}>Voltar</button>
              <button type="submit" class="tri-modal__primary" disabled={busy||!invite.trim()}>Entrar no servidor</button>
            </div>
          </form>
        )}
      </div>
    </ModalLayer>
  );
}
