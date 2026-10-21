import type { Bridge } from '../bridge';
import type { ChatMessage } from '../protocol';
import { Modal } from './Modal';
import { useModalClose } from './ModalLayer';

// Modal confirmation to delete a chat message.
export function DeleteMessageModal({ bridge, message, onClose }: { bridge: Bridge; message: ChatMessage; onClose: () => void }) {
  const { closing, close } = useModalClose(onClose);
  return (
    <Modal title="Excluir mensagem" subtitle="Deseja mesmo excluir essa mensagem?" onClose={close} closing={closing}
      actions={[{ label: 'Cancelar', variant: 'secondary', onClick: close },
                { label: 'Excluir', variant: 'critical', onClick: () => { bridge.send({ name: 'deleteChatMessage', messageId: message.id }); close(); } }]}>
      <div class="tri-delete-preview" aria-hidden="true">
        <div class="tri-message is-group-start tri-message--preview">
          <span class="tri-message__avatar tri-avatar tri-avatar--40"><span class="tri-avatar__letter">{message.authorName.slice(0, 1).toUpperCase()}</span></span>
          <div class="tri-message__header"><span class="tri-message__username">{message.authorName}</span></div>
          <div class="tri-message__content">{message.text || 'Mensagem'}</div>
        </div>
      </div>
      <p class="tri-delete-hint">Dica: segure Shift ao clicar em <strong>Excluir</strong> para apagar mensagens sem confirmação.</p>
    </Modal>
  );
}
