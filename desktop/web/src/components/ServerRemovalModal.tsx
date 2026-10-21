import { useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import { Modal } from './Modal';
import { useModalClose } from './ModalLayer';

// Modal confirmation to delete or leave a server.
export function ServerRemovalModal({ bridge, serverId, serverName, mode, onClose }:
  { bridge: Bridge; serverId: string; serverName: string; mode: 'delete' | 'leave'; onClose: () => void }) {
  const { closing, close } = useModalClose(onClose);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const remove = mode === 'delete';
  const confirm = async () => {
    if (busy) return;
    if (remove && typed.trim() !== serverName) { setError('Você não digitou o nome do servidor corretamente'); return; }
    setBusy(true); setError('');
    try { await bridge.request({ name: remove ? 'deleteServer' : 'leaveServer', serverId }); close(); }
    catch (e) { setError((e as Error).message || 'Não foi possível concluir agora.'); setBusy(false); }
  };
  return (
    <Modal title={remove ? `Excluir "${serverName}"` : `Sair de "${serverName}"`} onClose={close} closing={closing}
      subtitle={remove ? <>Deseja mesmo excluir <strong>{serverName}</strong>? Esta ação é irreversível.</>
                       : <>Deseja mesmo sair de <strong>{serverName}</strong>? Você não poderá entrar neste servidor até ser convidado(a) novamente.</>}
      onSubmit={e => { e.preventDefault(); void confirm(); }}
      actions={[{ label: 'Cancelar', variant: 'secondary', onClick: close },
                { label: remove ? 'Excluir servidor' : 'Sair do servidor', variant: 'critical', type: 'submit', disabled: busy }]}>
      {remove ? (
        <div class="tri-field">
          <label class="tri-field__label" for="tri-server-confirm-name">Insira o nome do servidor</label>
          <div class="tri-text-input">
            <input id="tri-server-confirm-name" class="tri-text-input__input" maxLength={100} autoFocus value={typed}
              onInput={e => { setTyped((e.target as HTMLInputElement).value); setError(''); }} />
          </div>
          {error && <p class="tri-field__error" role="alert">{error}</p>}
        </div>
      ) : error ? <p class="tri-field__error" role="alert">{error}</p> : undefined}
    </Modal>
  );
}
