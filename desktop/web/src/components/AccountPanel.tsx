import type { Bridge } from '../bridge';
import { openSoundboard } from './Soundboard';
import { openAccountPopover } from './AccountPopover';
import { openAudioMenu } from './AudioMenu';
import type { Session } from '../protocol';
import { callChannelOf } from '../protocol';
import type { IconName } from '../icons.generated';
import { Icon } from './Icon';
import { Tooltip } from './Tooltip';
import { AudioEqualizer } from './ui/AudioEqualizer';
import { AudioRipple } from './ui/AudioRipple';

// Split audio button: module __5e764 — 32x32 button with square right corners, 1px gap, 16x32 chevron
// (16px ChevronSmallDown) with square left corners; hovering the group lights both halves.
function SplitAudioButton({ red, icon, label, menuLabel, onToggle, onMenu }:
  { red: boolean; icon: IconName; label: string; menuLabel: string; onToggle: () => void; onMenu: (event: MouseEvent) => void }) {
  return (
    <div class={`tri-split ${red ? 'is-red' : ''}`}>
      <Tooltip text={label}>
        <button class={`tri-account__button tri-split__main ${red ? 'is-red' : ''}`} aria-label={label} aria-pressed={red} onClick={onToggle}>
          <Icon name={icon} size={20} />
        </button>
      </Tooltip>
      <button class="tri-account__button tri-split__chevron" aria-label={menuLabel} aria-haspopup="dialog" onClick={onMenu}>
        <Icon name="ChevronSmallDown" size={16} />
      </button>
    </div>
  );
}

const STATUS_LABEL: Record<Session['account']['status'], string> = {
  online: 'Disponível', idle: 'Ausente', dnd: 'Não perturbar', invisible: 'Invisível', offline: 'Offline',
};

// Panels: layout module __5e434 — absolute, 8px (--custom-panels-spacing) from the sidebar's bottom/left,
// width 100% - 16, --background-base-low, 1px --border-muted, radius 8.
// Account row: module __37e49 — 56px, 14px medium, gap 8; popout button padding 5px, radius 4, hover
// --background-mod-normal; buttons gap 8; red icon --icon-feedback-critical when muted/deafened.
// Observed in Discord (out/claude-observations/motion/panel-deafen-toggle, voice-join, share-start):
// - hovering the account swaps the status line for the username;
// - tooltips above the buttons, texts from the pt-BR locale: "Silenciar"/"Dessilenciar" (HITUcR/l3z++I),
//   "Desativar áudio"/"Reativar áudio" (wjcRFX/XiejaJ), "Configurações de usuário";
// - voice section: green signal icon (ConnectionFineIcon) left of "Voz conectada" / "Vídeo conectado" (daXg45 /
//   HtVOdd), the room / server line, "Desconectar"; a row of buttons: camera (VideoSlash while off, green while
//   on, "Ativar câmera"/"Desativar câmera"), share ("Compartilhar tela"/"Parar de transmitir", green while
//   sharing); while sharing, a row above with the shared window's name and a stop button.
// Left out (no triscord function): the noise suppression button and activities of the button row.
export function AccountPanel({ session, bridge }: { session: Session; bridge: Bridge }) {
  const { account, muted, deafened } = session;
  const channel = callChannelOf(session);
  const server = session.servers.find(s => s.id === (session.callServerId ?? session.selectedServerId));
  const share = () => (session.sharing ? bridge.send({ name: 'stopScreenShare' }) : dispatchEvent(new Event('tri-open-share-picker')));
  return (
    <section class="tri-panels" aria-label="Conta">
      {channel && session.sharing && (
        <div class="tri-stream-panel">
          <Icon name="ScreenArrow" size={20} className="tri-stream-panel__icon" />
          <span class="tri-stream-panel__name">{session.sharingName ?? ''}</span>
          <Tooltip text="Parar de transmitir">
            <button class="tri-account__button" aria-label="Parar de transmitir" onClick={() => bridge.send({ name: 'stopScreenShare' })}>
              <Icon name="ScreenX" size={20} />
            </button>
          </Tooltip>
        </div>
      )}
      {channel && (
        <div class="tri-voice-panel tri-glass-panel border-b border-white/10">
          <div class="tri-voice-panel__top">
            <div class="flex items-center gap-2">
              <Icon name="ConnectionFine" size={20} className="tri-voice-panel__signal text-neon-emerald" />
              <AudioEqualizer active={true} />
            </div>
            <div class="tri-voice-panel__texts">
              <span class="tri-voice-panel__title font-semibold text-white">{session.camera ? 'Vídeo conectado' : 'Voz conectada'}</span>
              <span class="tri-voice-panel__room text-xs text-slate-400">{channel.name} / {server?.name ?? 'Triscord'}</span>
            </div>
            <Tooltip text="Desconectar">
              <button class="tri-account__button hover:text-red-400" aria-label="Desconectar" onClick={() => bridge.send({ name: 'leaveVoice' })}>
                <Icon name="Disconnect" size={20} />
              </button>
            </Tooltip>
          </div>
          <div class="tri-voice-panel__buttons">
            {session.runtime?.camera !== false && <Tooltip text={session.cameraPending ? 'Cancelar ativação da câmera' : session.camera ? 'Desativar câmera' : 'Ativar câmera'}>
              <button class={`tri-voice-panel__button ${session.camera ? 'is-green' : ''}`} aria-label={session.cameraPending ? 'Cancelar ativação da câmera' : session.camera ? 'Desativar câmera' : 'Ativar câmera'}
                onClick={() => bridge.send({ name: 'setCamera', on: !(session.camera || session.cameraPending) })}><Icon name={session.camera ? 'Video' : 'VideoSlash'} size={20} /></button>
            </Tooltip>}
            <Tooltip text={session.sharing ? 'Parar de transmitir' : 'Compartilhar tela'}>
              <button class={`tri-voice-panel__button ${session.sharing ? 'is-green' : ''}`} aria-label={session.sharing ? 'Parar de transmitir' : 'Compartilhar tela'}
                onClick={share}><Icon name={session.sharing ? 'ScreenX' : 'ScreenArrow'} size={20} /></button>
            </Tooltip>
            {session.runtime?.soundboard !== false && <Tooltip text="Abrir efeitos sonoros"><button class="tri-voice-panel__button" aria-label="Abrir efeitos sonoros" onClick={e => openSoundboard(e.currentTarget)}><Icon name="Soundboard" size={20} /></button></Tooltip>}
          </div>
        </div>
      )}
      <div class="tri-account">
        <button class="tri-account__popout" aria-label={`${account.displayName}, ${STATUS_LABEL[account.status]}`} aria-haspopup="dialog" aria-expanded="false" onClick={e=>openAccountPopover(e.currentTarget)}>
          <span class="tri-avatar tri-avatar--32">
            {account.avatarUrl ? <img src={account.avatarUrl} alt="" /> : <span class="tri-avatar__letter">{account.displayName.slice(0, 1).toUpperCase()}</span>}
            <span class={`tri-avatar__status tri-avatar__status--${account.status}`} />
          </span>
          <span class="tri-account__names">
            <span class="tri-account__display">{account.displayName}</span>
            <span class="tri-account__sub">
              <span class="tri-account__status">{account.customStatus || STATUS_LABEL[account.status]}</span>
              <span class="tri-account__username">{account.username}</span>
            </span>
          </span>
        </button>
        <div class="tri-account__buttons">
          <SplitAudioButton red={muted} icon={muted ? 'MicrophoneMuted' : 'Microphone'} label={muted ? 'Dessilenciar' : 'Silenciar'}
            menuLabel="Opções de entrada" onToggle={() => bridge.send({ name: 'setMuted', muted: !muted })}
            onMenu={e => openAudioMenu(e.currentTarget as HTMLElement,'input')} />
          <SplitAudioButton red={deafened} icon={deafened ? 'HeadphonesDeafened' : 'Headphones'} label={deafened ? 'Reativar áudio' : 'Desativar áudio'}
            menuLabel="Opções de saída" onToggle={() => bridge.send({ name: 'setDeafened', deafened: !deafened })}
            onMenu={e => openAudioMenu(e.currentTarget as HTMLElement,'output')} />
          <Tooltip text="Configurações de usuário">
            <button class="tri-account__button" aria-label="Configurações de usuário" onClick={() => dispatchEvent(new Event('tri-open-settings'))}>
              <Icon name="Settings" size={20} />
            </button>
          </Tooltip>
        </div>
      </div>
    </section>
  );
}
