import type { Bridge } from '../bridge';
import { Modal } from './Modal';
import { useModalClose } from './ModalLayer';

// One-time notice about error reports (20/10, desktop/src/error_reports.h): shown once, outside calls, before the
// first report could go out. Either answer, or closing it, marks it seen; "Desativar" also turns the reports off.
// The same switch lives in Configurações do Windows > Relatórios de erro.
export function ErrorReportsNotice({ bridge, onClose }: { bridge: Bridge; onClose: () => void }) {
  const finish = () => { bridge.send({ name: 'setSetting', key: 'errorReportsNoticeSeen', value: true }); onClose(); };
  const { closing, close } = useModalClose(finish);
  return (
    <Modal title="Relatórios de erro" onClose={close} closing={closing}
      actions={[{ label: 'Desativar', variant: 'secondary', onClick: () => { bridge.send({ name: 'setSetting', key: 'errorReports', value: false }); close(); } },
                { label: 'Entendi', variant: 'primary', onClick: close }]}>
      <p class="tri-error-reports-notice">
        Quando a transmissão, o compartilhamento ou a conexão falharem, o Triscord envia o log daquela sessão para os
        desenvolvedores na próxima vez que abrir, para o problema ser corrigido sem você precisar mandar nada.
      </p>
      <p class="tri-error-reports-notice">
        O log não tem suas mensagens, senhas nem tokens, e é apagado depois de 14 dias. Você pode desativar quando
        quiser em Configurações do Windows.
      </p>
    </Modal>
  );
}
