import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import type { ChatMessage } from '../protocol';
import { Icon } from './Icon';
import { Tooltip } from './Tooltip';
import { Markdown } from './Markdown';
import { openContextMenu, type MenuEntry } from './ContextMenu';

// Voice channel chat panel, observed in Discord (CHAT.md, reference/discord-voicechat-1-open.png): 450px on the
// right, full height under the title bar, --background-base-lower; 48px header (chat icon, channel name, close)
// over a 1px --border-subtle divider; message list; the same composer as the text channel.
// Messages from Discord's CSS recovered with REA (out/rea-claude-20261016/css-rules/message_c19a55.css,
// message__5126c.css): cozy layout, 40px avatar 16px from the edge, content at 72px, 2px vertical padding,
// header 22px line with the 16px medium username in --text-strong and the 12px --chat-text-muted timestamp;
// a new group starts 17px lower (group-spacing-16); continuation messages show the time on hover in the 56px
// gutter; hover background --message-background-hover. Groups: same author, same day, at most 7 minutes apart
// (bundle: `r=7*Millis.MINUTE`, same-day check `864e5>=|a-b| && same date`). Timestamps: moment calendar
// formats from the bundle, "[Hoje às] LT", "[Ontem às] LT", otherwise "L LT" (observed 09/09/2026 02:09).
// Date divider (module __908e2): thin --border-subtle line, 12px semibold --text-muted label on the chat
// background, 24px above / 8px below. Reactions (module _f8896c): 8px-radius pills, 20px emoji, count 14px
// semibold. Hover action bar (CHAT.md, observed): 32px box 16px above the message, 14px from its right edge,
// 28px buttons with 20px glyphs: three quick reactions, a 1px divider, "Adicionar reação".
// triscord: the six reactions the hub accepts; deleting (Discord: "Mais" menu) waits for the context menu work.
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
      <div class={`tri-message__bar ${picker ? 'is-open' : ''}`}>
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

export function ChatPanel({ channelName, messages, avatars, bridge, onClose }: { channelName: string; messages: ChatMessage[]; avatars?: Avatars; bridge: Bridge; onClose: () => void }) {
  const list = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [rateLimited, setRateLimited] = useState(false);
  // REA composer module __74017: 56px minimum, growing to the 50vh limit.
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
    const on = () => { setRateLimited(true); setTimeout(() => setRateLimited(false), 1500); };
    addEventListener('tri-chat-rate-limited', on);
    return () => removeEventListener('tri-chat-rate-limited', on);
  }, []);
  const send = (event: Event) => {
    event.preventDefault();
    const input = (event.currentTarget as HTMLFormElement).elements.namedItem('message') as HTMLTextAreaElement;
    const value = input.value.trim();
    if (!value) return;
    bridge.request({ name: 'sendChatMessage', text: value }).then(() => { setText(''); input.value = ''; atBottom.current = true; }).catch(() => {});
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
    <aside class="tri-chat-panel" aria-label={`Chat de ${channelName}`}>
      <header class="tri-chat-panel__header">
        <Icon name="Chat" size={20} className="tri-chat-panel__icon" />
        <h2 class="tri-chat-panel__title">{channelName}</h2>
        <button class="tri-icon-button tri-chat-panel__close" aria-label="Fechar" onClick={onClose}><Icon name="Close" size={24} /></button>
      </header>
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
      <form class="tri-composer" onSubmit={send}>
        <div class={`tri-composer__box ${rateLimited ? 'is-rate-limited' : ''}`}>
          <textarea ref={composer} class="tri-composer__input" name="message" rows={1}
            placeholder={`Conversar em ${channelName}`} aria-label={`Conversar em ${channelName}`} aria-multiline="true"
            maxLength={2000} autoComplete="off" value={text} onInput={e => setText((e.target as HTMLTextAreaElement).value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }} />
        </div>
      </form>
    </aside>
  );
}
