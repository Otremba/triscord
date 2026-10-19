import { useEffect, useRef, useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import { Modal } from './Modal';
import { useModalClose } from './ModalLayer';

// Invite, from Discord's InstantInviteModal (chunk 940ef764bff92620.js, CSS module __67dba), its copy field
// (modules 747007/416052/109802, CSS module _fffc15) and the capture discord-invite-modal.png / -copied.png.
// Title "Convidar amigos para {servidor}". triscord has no friends list, so this is Discord's own variant
// without friends (getBodyContent with showFriends false): subText__67dba text-sm "Compartilhe este link com
// outros para conceder acesso ao seu servidor!" (the owner's string; only owners can invite), then the copy
// field and, 16px below, footerText__67dba text-xs: hub invites have no expiry or use limit, which Discord
// words as "Seu link de convite nunca irá expirar." (QrHBnC). The "never expire" checkbox and link settings
// are left out (no triscord function). The field holds the bare code: triscord has no invite domain and
// "Entrar em um servidor" accepts the code.
// Copy button: brand by default, green "Copiado" for 1s after copying, red on failure (delay 1e3 in 416052).
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
