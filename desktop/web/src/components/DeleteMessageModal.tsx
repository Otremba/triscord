import type { Bridge } from '../bridge';
import type { ChatMessage } from '../protocol';
import { Modal } from './Modal';
import { useModalClose } from './ModalLayer';

// "Excluir mensagem" confirmation, from Discord's delete-message modal (chunk b_0ec277134df5e9c9, REA): the design-
// system modal titled "Excluir mensagem" (MWMcg7) with the subtitle "Deseja mesmo excluir essa mensagem?" (AMvpS4),
// a non-interactive preview of the message (CSS module _fd14e0 .message: --background-base-low, radius 3, legacy
// border + high elevation, 10px vertical padding, 20px below), the hint "Fica a dica: você pode pressionar Shift
// enquanto clica em excluir mensagem para ignorar a confirmação completamente." (IxY7E6, shown when opened from
// the context menu; "excluir mensagem" in bold), and the actions "Cancelar" (secondary) + "Excluir"
// (critical-primary). Shift+click on the menu item skips this modal, as the hint says.
export function DeleteMessageModal({ bridge, message, onClose }: { bridge: Bridge; message: ChatMessage; onClose: () => void }) {
  const { closing, close } = useModalClose(onClose);
  return (
    <Modal title="Excluir mensagem" subtitle="Deseja mesmo excluir essa mensagem?" onClose={close} closing={closing}
      actions={[{ label: 'Cancelar', variant: 'secondary', onClick: close },
                { label: 'Excluir', variant: 'critical', onClick: () => { bridge.send({ name: 'deleteChatMessage', messageId: message.id }); close(); } }]}>
      <div class="tri-delete-preview" aria-hidden="true">
        <div class="tri-message is-group-start tri-message--preview">
          <span class="tri-message__avatar tri-avatar tri-avatar--40"><span class="tri-avatar__letter">{message.authorName.slice(0, 1).toUpperCase()}</span></span>
          <h3 class="tri-message__header"><span class="tri-message__username">{message.authorName}</span></h3>
          <div class="tri-message__content">{message.text}</div>
        </div>
      </div>
      <p class="tri-delete-hint">Fica a dica: você pode pressionar Shift enquanto clica em <strong>excluir mensagem</strong> para ignorar a confirmação completamente.</p>
    </Modal>
  );
}
