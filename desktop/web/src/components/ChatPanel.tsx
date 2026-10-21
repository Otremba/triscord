import { useEffect, useLayoutEffect, useId, useRef, useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import type { ChatMessage } from '../protocol';
import { Icon } from './Icon';
import { Tooltip } from './Tooltip';
import { Markdown } from './Markdown';
import { openContextMenu, type MenuEntry } from './ContextMenu';

// Voice and text channel chat panel.
const REACTIONS = ['\u{1F44D}', '❤️', '\u{1F602}', '\u{1F62E}', '\u{1F622}', '\u{1F389}'];
const MINUTE = 60_000;
const two = (n: number) => String(n).padStart(2, '0');
const hhmm = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}`;
const sameDay = (a: Date, b: Date) => Math.abs(a.getTime() - b.getTime()) <= 864e5 && a.getDate() === b.getDate();
function calendar(ts: number, now = new Date()) {
  const d = new Date(ts), yesterday = new Date(now.getTime() - 864e5);
  if (sameDay(d, now)) return `Hoje às ${hhmm(d)}`;
  if (sameDay(d, yesterday)) return `Ontem às ${hhmm(d)}`;
  return `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()} ${hhmm(d)}`;
}
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const dayLabel = (ts: number) => { const d = new Date(ts); return `${d.getDate()} de ${MONTHS[d.getMonth()]} de ${d.getFullYear()}`; };

// Message context menu (observed, motion/ctx-message: 220px "fixed" menu): a row of four quick reactions,
// "Adicionar reação" (submenu), then "Editar mensagem", "Responder", "Encaminhar", "Criar tópico", "Copiar texto",
// "Fixar mensagem", ..., and the danger "Excluir mensagem" for own messages, each with a leading 20px icon.
// triscord keeps: quick reactions (its six reactions: the first four), "Adicionar reação" with the six, "Copiar
// texto" (CopyIcon) and "Excluir mensagem" (TrashIcon; Shift skips the confirmation, as Discord's hint says).
function messageMenu(message: ChatMessage, bridge: Bridge): MenuEntry[] {
  const react = (emoji: string) => bridge.send({ name: 'toggleReaction', messageId: message.id, emoji });
  return [
    { kind: 'reactions', emojis: REACTIONS.slice(0, 4), onPick: react },
    { kind: 'item', label: 'Adicionar reação', icon: 'Reaction', action: () => {},
      submenu: REACTIONS.map(emoji => ({ kind: 'item' as const, label: emoji, action: () => react(emoji) })) },
    { kind: 'separator' },
    { kind: 'item', label: 'Copiar texto', icon: 'Copy', action: () => bridge.send({ name: 'copyMessageText', messageId: message.id }) },
    ...(message.own ? [{ kind: 'separator' as const }, { kind: 'item' as const, label: 'Excluir mensagem', icon: 'Trash' as const, danger: true,
      action: (e: MouseEvent | KeyboardEvent) => (e.shiftKey ? bridge.send({ name: 'deleteChatMessage', messageId: message.id })
        : dispatchEvent(new CustomEvent('tri-open-modal', { detail: { kind: 'deleteMessage', message } }))) }] : []),
  ];
}

type Avatars = Record<string, { still?: string; animated?: string }> | undefined;
function Message({ message, groupStart, bridge, avatars }: { message: ChatMessage; groupStart: boolean; bridge: Bridge; avatars: Avatars }) {
  // Author avatar: the still frame; an animated GIF plays while the message is hovered, as Discord does in chat.
  const avatar = avatars?.[message.authorId];
  const [picker, setPicker] = useState(false);
  const react = (emoji: string) => { setPicker(false); bridge.send({ name: 'toggleReaction', messageId: message.id, emoji }); };
  return (
    <li class={`tri-message ${groupStart ? 'is-group-start' : ''}`} onMouseLeave={() => setPicker(false)}
      onContextMenu={e => openContextMenu(e, messageMenu(message, bridge), { width: 'fixed', label: 'Ações da mensagem' })}>
      {groupStart ? (
        <>
          <span class="tri-message__avatar tri-avatar tri-avatar--40">{avatar?.still
            ? <>{<img class="tri-message__avatar-still" src={avatar.still} alt="" />}{avatar.animated && <img class="tri-message__avatar-animated" src={avatar.animated} alt="" />}</>
            : <span class="tri-avatar__letter">{message.authorName.slice(0, 1).toUpperCase()}</span>}</span>
          <h3 class="tri-message__header">
            <span class="tri-message__username">{message.authorName}</span>
            <time class="tri-message__timestamp">{calendar(message.timestamp)}</time>
          </h3>
        </>
      ) : <time class="tri-message__timestamp tri-message__timestamp--alt">{hhmm(new Date(message.timestamp))}</time>}
      <div class="tri-message__content"><Markdown nodes={message.markdown} text={message.text} messageId={message.id} bridge={bridge}/></div>
      {message.reactions.length > 0 && (
        <div class="tri-reactions">
          {message.reactions.map(r => (
            <button key={r.emoji} class={`tri-reaction ${r.me ? 'is-me' : ''}`} onClick={() => react(r.emoji)} aria-pressed={r.me}>
              <span class="tri-reaction__inner"><span class="tri-reaction__emoji">{r.emoji}</span><span class="tri-reaction__count">{r.count}</span></span>
            </button>
          ))}
        </div>
      )}
      <div class={`tri-message__bar tri-message-action-dock ${picker ? 'is-open' : ''}`}>
        {REACTIONS.slice(0, 3).map(emoji => (
          <Tooltip key={emoji} text={<><strong>{emoji}</strong><br />Clique para reagir</>}>
            <button class="tri-message__bar-button" aria-label={`Reagir com ${emoji}`} onClick={() => react(emoji)}><span class="tri-message__bar-emoji">{emoji}</span></button>
          </Tooltip>
        ))}
        <span class="tri-message__bar-divider" />
        <Tooltip text="Adicionar reação">
          <button class="tri-message__bar-button" aria-label="Adicionar reação" onClick={() => setPicker(!picker)}><Icon name="Reaction" size={20} /></button>
        </Tooltip>
        <Tooltip text="Mais">
          <button class="tri-message__bar-button" aria-label="Mais" onClick={e => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            openContextMenu(e, messageMenu(message, bridge), { width: 'fixed', label: 'Ações da mensagem', at: { x: r.left, y: r.bottom + 4 } });
          }}><Icon name="MoreHorizontal" size={20} /></button>
        </Tooltip>
        {picker && (
          <div class="tri-reaction-picker" role="menu">
            {REACTIONS.map(emoji => <button key={emoji} role="menuitem" class="tri-reaction-picker__item" onClick={() => react(emoji)}>{emoji}</button>)}
          </div>
        )}
      </div>
    </li>
  );
}

export function ChatPanel({ channelName, messages, avatars, bridge, onClose, full = false }: { channelName: string; messages: ChatMessage[]; avatars?: Avatars; bridge: Bridge; onClose?: () => void; full?: boolean }) {
  const list = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [rateLimited, setRateLimited] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState(false);
  const feedbackId = useId();
  const pending = useRef(false);
  const mounted = useRef(true);
  const draftRevision = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const edit = (value: string) => { draftRevision.current++; setText(value); setSendError(false); };
  // Auto-resize composer height up to viewport limits.
  useLayoutEffect(() => {
    const input = composer.current;
    if (!input) return;
    const resize = () => {
      input.style.height = '0px';
      input.style.height = `${input.scrollHeight}px`;
    };
    resize();
    addEventListener('resize', resize);
    return () => removeEventListener('resize', resize);
  }, [text]);
  // Stick to the bottom when new messages arrive and the list was already at the bottom.
  const atBottom = useRef(true);
  useLayoutEffect(() => { const el = list.current; if (el && atBottom.current) el.scrollTop = el.scrollHeight; }, [messages.length]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const on = () => {
      setRateLimited(true);
      clearTimeout(timer);
      timer = setTimeout(() => setRateLimited(false), 1500);
    };
    addEventListener('tri-chat-rate-limited', on);
    return () => { removeEventListener('tri-chat-rate-limited', on); clearTimeout(timer); };
  }, []);
  const send = (event: Event) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || pending.current) return;
    const revision = draftRevision.current;
    pending.current = true;
    setSending(true);
    setSendError(false);
    bridge.request({ name: 'sendChatMessage', text: value }).then(() => {
      if (!mounted.current) return;
      // Typing while the request is in flight must not lose the next message.
      if (draftRevision.current === revision) setText('');
      atBottom.current = true;
    }).catch(() => {
      if (mounted.current) setSendError(true);
    }).finally(() => {
      pending.current = false;
      if (mounted.current) setSending(false);
    });
  };
  const items: preact.JSX.Element[] = [];
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    const newDay = !prev || !sameDay(new Date(prev.timestamp), new Date(m.timestamp));
    if (newDay) items.push(<li key={`d-${m.id}`} class="tri-divider" role="separator"><span class="tri-divider__content">{dayLabel(m.timestamp)}</span></li>);
    const groupStart = newDay || prev.authorId !== m.authorId || m.timestamp - prev.timestamp >= 5 * MINUTE;
    items.push(<Message key={m.id} message={m} groupStart={groupStart} bridge={bridge} avatars={avatars} />);
  });
  return (
    <div class={`tri-chat-panel ${full ? 'tri-chat-panel--full' : ''}`} aria-label={`Chat de ${channelName}`}>
      {!full && onClose && (
        <header class="tri-chat-panel__header">
          <Icon name="Chat" size={20} className="tri-chat-panel__icon" />
          <h2 class="tri-chat-panel__title">{channelName}</h2>
          <button class="tri-icon-button tri-chat-panel__close" aria-label="Fechar" onClick={onClose}><Icon name="Close" size={24} /></button>
        </header>
      )}
      <div class="tri-chat-panel__scroller" ref={list}
        onScroll={e => { const el = e.currentTarget as HTMLDivElement; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8; }}>
        {/* Start of the channel, above its history (Discord, audit 18/10): 68px circle with the 36px chat icon,
            "Bem-vindo(a) a <canal>!" heading-xxl/extrabold, "Este é o começo do canal <canal>." text-md; Discord's
            "Editar canal" button has no triscord function. The column sits at the bottom while the history is short. */}
        <div class="tri-chat-panel__content">
          <div class="tri-channel-welcome">
            <span class="tri-channel-welcome__icon"><Icon name="Chat" size={36} /></span>
            <h3 class="tri-channel-welcome__title">Bem-vindo(a) a {channelName}!</h3>
            <p class="tri-channel-welcome__text">Este é o começo do canal {channelName}.</p>
          </div>
          <ol class="tri-messages">{items}</ol>
        </div>
      </div>
      <form class="tri-composer" onSubmit={send} aria-busy={sending}>
        <div id={feedbackId} class="tri-composer__feedback">
          {sendError ? <p role="alert">Não foi possível enviar. Seu rascunho foi mantido. Tente novamente.</p>
            : rateLimited ? <p role="status">Muitas mensagens em sequência. Aguarde um instante antes de reenviar.</p>
            : sending ? <p role="status">Enviando mensagem…</p> : null}
        </div>
        <div class={`tri-composer__box tri-composer-floating ${rateLimited ? 'is-rate-limited' : ''}`}>
          <Tooltip text="Enviar um arquivo">
            <button type="button" class="tri-composer__attach" aria-label="Enviar um arquivo" onClick={() => dispatchEvent(new CustomEvent('tri-preview-notice', { detail: 'Envio de arquivos em desenvolvimento.' }))}>
              <Icon name="CirclePlus" size={24} />
            </button>
          </Tooltip>
          <textarea ref={composer} class="tri-composer__input" name="message" rows={1}
            placeholder={`Conversar em ${channelName}`} aria-label={`Conversar em ${channelName}`} aria-multiline="true" aria-describedby={feedbackId}
            maxLength={2000} autoComplete="off" value={text} onInput={e => edit((e.target as HTMLTextAreaElement).value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }} />
          <div class="tri-composer__buttons">
            <Tooltip text="Enviar um presente">
              <button type="button" class="tri-composer__action" aria-label="Enviar um presente" onClick={() => dispatchEvent(new CustomEvent('tri-preview-notice', { detail: 'Presentes Nitro em desenvolvimento.' }))}>
                <Icon name="Gift" size={24} />
              </button>
            </Tooltip>
            <Tooltip text="Abrir seletor de GIF">
              <button type="button" class="tri-composer__action" aria-label="Abrir seletor de GIF" onClick={() => dispatchEvent(new CustomEvent('tri-preview-notice', { detail: 'Seletor de GIF em desenvolvimento.' }))}>
                <Icon name="Gif" size={24} />
              </button>
            </Tooltip>
            <Tooltip text="Abrir seletor de figurinhas">
              <button type="button" class="tri-composer__action" aria-label="Abrir seletor de figurinhas" onClick={() => dispatchEvent(new CustomEvent('tri-preview-notice', { detail: 'Figurinhas em desenvolvimento.' }))}>
                <Icon name="Sticker" size={24} />
              </button>
            </Tooltip>
            <Tooltip text="Selecione um emoji">
              <button type="button" class="tri-composer__action" aria-label="Selecione um emoji" onClick={() => edit(text + ' 😄 ')}>
                <Icon name="Reaction" size={24} />
              </button>
            </Tooltip>
            <button type="submit" class="tri-composer__send" disabled={sending || !text.trim()} aria-label={sendError ? 'Tentar enviar novamente' : 'Enviar mensagem'}>
              {sendError ? 'Tentar novamente' : sending ? 'Enviando…' : 'Enviar'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
