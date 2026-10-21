import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import type { ChatMessage } from '../protocol';
import { Icon } from './Icon';
import { Tooltip } from './Tooltip';
import { Markdown } from './Markdown';
import { openContextMenu, type MenuEntry } from './ContextMenu';
import { ChatComposer } from './ChatComposer';

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

export function ChatPanel({ channelName, messages, avatars, bridge, onClose, full = false, conversation = false }: { channelName: string; messages: ChatMessage[]; avatars?: Avatars; bridge: Bridge; onClose?: () => void; full?: boolean; conversation?: boolean }) {
  const list = useRef<HTMLDivElement>(null);
  // Stick to the bottom when new messages arrive and the list was already at the bottom.
  const atBottom = useRef(true);
  useLayoutEffect(() => { const el = list.current; if (el && atBottom.current) el.scrollTop = el.scrollHeight; }, [messages.length]);
  const items: preact.JSX.Element[] = [];
  messages.forEach((m, i) => {
    const prev = messages[i - 1];
    const newDay = !prev || !sameDay(new Date(prev.timestamp), new Date(m.timestamp));
    if (newDay) items.push(<li key={`d-${m.id}`} class="tri-divider" role="separator"><span class="tri-divider__content">{dayLabel(m.timestamp)}</span></li>);
    const groupStart = newDay || prev.authorId !== m.authorId || m.timestamp - prev.timestamp >= 5 * MINUTE;
    items.push(<Message key={m.id} message={m} groupStart={groupStart} bridge={bridge} avatars={avatars} />);
  });
  return (
    <div class={`tri-chat-panel ${full ? 'tri-chat-panel--full' : ''} ${conversation ? 'tri-chat-panel--conversation' : ''}`} aria-label={`Chat de ${channelName}`}>
      {conversation && <header class="tri-conversation-heading"><Icon name="Chat" size={16}/><h2>Conversa</h2></header>}
      {!full && onClose && (
        <header class="tri-chat-panel__header">
          <Icon name="Chat" size={20} className="tri-chat-panel__icon" />
          <h2 class="tri-chat-panel__title">{channelName}</h2>
          <button class="tri-icon-button tri-chat-panel__close" aria-label="Fechar" onClick={onClose}><Icon name="Close" size={24} /></button>
        </header>
      )}
      <div class="tri-chat-panel__scroller" ref={list}
        onScroll={e => { const el = e.currentTarget as HTMLDivElement; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8; }}>
        <div class="tri-chat-panel__content">
          {(!conversation || messages.length === 0) && <div class="tri-channel-welcome">
            <span class="tri-channel-welcome__icon"><Icon name="Chat" size={36} /></span>
            <h3 class="tri-channel-welcome__title">Bem-vindo(a) a {channelName}!</h3>
            <p class="tri-channel-welcome__text">Este é o começo do canal {channelName}.</p>
          </div>}
          <ol class="tri-messages">{items}</ol>
        </div>
      </div>
      <ChatComposer channelName={channelName} bridge={bridge} onSent={() => { atBottom.current = true; }}/>
    </div>
  );
}
