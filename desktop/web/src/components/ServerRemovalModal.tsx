import { useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import { Modal } from './Modal';
import { useModalClose } from './ModalLayer';

// Deleting or leaving a server, with Discord's own strings (pt-BR locale of the cached bundle, REA):
// - delete (guild settings "Excluir servidor", l3hWP6; owner only): title `Excluir "name"` (us7mC1), subtitle
//   "Deseja mesmo excluir **name**? Esta ação é irreversível." (Zuo+Vd), a field "Insira o nome do servidor" (abprOC)
//   whose mismatch shows "Você não digitou o nome do servidor corretamente" (c2/DS/), and the destructive confirm.
// - leave (server menu "Sair do servidor", J2TBi3; members): title `Sair de "name"` (1GX6P/), "Deseja mesmo sair de
//   **name**? Você não poderá entrar neste servidor até ser convidado(a) novamente." (ZEXC0r).
// INFERRED: the modal's layout (the delete modal module 310482 is lazy and not in the cache), so it uses the same
// design-system modal as "Excluir mensagem"; Discord puts deletion in the server settings, which triscord does not
// have, so the owner reaches it from the server's context menu.
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
