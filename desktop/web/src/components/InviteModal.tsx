import { useEffect, useRef, useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import { Modal } from './Modal';
import { useModalClose } from './ModalLayer';

// Server invite generation and copy modal.
export function InviteModal({ bridge, serverId, serverName, onClose }: { bridge: Bridge; serverId: string; serverName: string; onClose: () => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'default' | 'success' | 'error'>('default');
  const timer = useRef<number>();
  const { closing, close } = useModalClose(onClose);
  useEffect(() => {
    let live = true;
    bridge.request<{ code: string }>({ name: 'createInvite', serverId })
      .then(value => { if (live) setCode(value.code); })
      .catch((e: Error) => { if (live) setError(e.message); });
    return () => { live = false; clearTimeout(timer.current); };
  }, [serverId]);
  const copy = () => {
    if (!code) return;
    bridge.request({ name: 'copyInvite', code }).then(() => setMode('success'), () => setMode('error'));
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMode('default'), 1000);
  };
  return (
    <Modal title={`Convidar amigos para ${serverName}`} onClose={close} closing={closing}>
      <p class="tri-invite__subtext">Compartilhe este link com outros para conceder acesso ao seu servidor!</p>
      <div class="tri-invite__stack">
        <div class={`tri-copy-input is-${mode}`} data-disabled={!code}>
          <input class="tri-copy-input__input" type="text" readOnly value={code ?? ''} aria-label="Convite" onClick={e => (e.target as HTMLInputElement).select()} />
          <button type="button" class="tri-copy-input__button" disabled={!code} onClick={copy}>{mode === 'success' ? 'Copiado' : 'Copiar'}</button>
        </div>
        {error ? <p class="tri-invite__error" role="alert">{error}</p>
               : <p class="tri-invite__footer">Seu link de convite nunca irá expirar.</p>}
      </div>
    </Modal>
  );
}
