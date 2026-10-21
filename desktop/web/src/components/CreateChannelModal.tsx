import { useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { useModalClose } from './ModalLayer';

// Channel creation modal dialog.
const field = (event: Event, key: string) =>
  (((event.currentTarget as HTMLFormElement).elements.namedItem(key) as HTMLInputElement | null)?.value ?? '').trim();

export function CreateChannelModal({ bridge, categoryName, onClose }: { bridge: Bridge; categoryName: string; onClose: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { closing, close } = useModalClose(onClose);
  const submit = (event: Event) => {
    const value = field(event, 'channelName');   // the field itself: a submit right after a paste sees no stale state
    if (!value) return;
    setBusy(true); setError(null);
    bridge.request({ name: 'createChannel', channelName: value }).then(close).catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  return (
    <Modal title="Criar canal" subtitle={`em ${categoryName}`} onClose={close} closing={closing} onSubmit={submit}
      preview={error && <p class="tri-dmodal__error" role="alert">{error}</p>}
      actions={[{ label: 'Cancelar', variant: 'secondary', onClick: close },
                { label: 'Criar canal', variant: 'primary', type: 'submit', disabled: busy || !name.trim() }]}>
      <div class="tri-create-channel">
        <div class="tri-field" role="radiogroup" aria-labelledby="tri-channel-type">
          <span id="tri-channel-type" class="tri-field__label">Tipo de canal</span>
          <label class="tri-radio is-selected">
            <input type="radio" name="channelType" value="voice" checked class="tri-radio__input" />
            <span class="tri-radio__circle" aria-hidden="true" />
            <span class="tri-radio__content">
              <span class="tri-radio__title"><Icon name="VoiceSpeaker" size={20} />Voz</span>
              <span class="tri-radio__description">Passe tempo com a turma com voz, vídeo e compartilhamento de tela</span>
            </span>
          </label>
        </div>
        <div class="tri-field">
          <label class="tri-field__label" for="tri-channel-name">Nome do canal</label>
          <div class="tri-text-input">
            <Icon name="VoiceSpeaker" size={16} className="tri-text-input__prefix" />
            <input id="tri-channel-name" name="channelName" class="tri-text-input__input" placeholder="novo-canal" maxLength={32} autoFocus
              value={name} onInput={e => setName((e.target as HTMLInputElement).value)} />
          </div>
        </div>
      </div>
    </Modal>
  );
}
