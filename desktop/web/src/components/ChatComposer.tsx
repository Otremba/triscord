import { useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import { Icon } from './Icon';
import { Tooltip } from './Tooltip';
import { soundEngine } from '../sound-engine';

/** Owns drafts and submission independently of history and message presentation. */
export function ChatComposer({ channelName, bridge, onSent }: {
  channelName: string; bridge: Bridge; onSent: () => void;
}) {
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
      soundEngine.play('messageSent');
      if (!mounted.current) return;
      // Preserve text entered while the previous submission is in flight.
      if (draftRevision.current === revision) setText('');
      onSent();
    }).catch(() => {
      if (mounted.current) setSendError(true);
    }).finally(() => {
      pending.current = false;
      if (mounted.current) setSending(false);
    });
  };
  return (
    <form class="tri-composer" onSubmit={send} aria-busy={sending}>
      <div id={feedbackId} class="tri-composer__feedback">
        {sendError ? <p role="alert">Não foi possível enviar. Seu rascunho foi mantido. Tente novamente.</p>
          : rateLimited ? <p role="status">Muitas mensagens em sequência. Aguarde um instante antes de reenviar.</p>
          : sending ? <p role="status">Enviando mensagem…</p> : null}
      </div>
      <div class={`tri-composer__box tri-composer-floating ${rateLimited ? 'is-rate-limited' : ''}`}>
        <textarea ref={composer} class="tri-composer__input" name="message" rows={1}
          placeholder={`Mensagem em ${channelName}…`} aria-label={`Conversar em ${channelName}`} aria-multiline="true" aria-describedby={feedbackId}
          maxLength={2000} autoComplete="off" value={text} onInput={e => edit(e.currentTarget.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }} />
        <div class="tri-composer__buttons">
          <Tooltip text="Adicionar emoji">
            <button type="button" class="tri-composer__action" aria-label="Adicionar emoji" onClick={() => { edit(text + ' 😄 '); composer.current?.focus(); }}>
              <Icon name="Reaction" size={20} />
            </button>
          </Tooltip>
          <button type="submit" class="tri-composer__send" disabled={sending || !text.trim()} aria-label={sendError ? 'Tentar enviar novamente' : 'Enviar mensagem'}>
            {sendError ? 'Tentar novamente' : sending ? 'Enviando…' : 'Enviar'}
          </button>
        </div>
      </div>
      <span class="tri-composer__hint">Enter para enviar <span aria-hidden="true">·</span> Shift + Enter para uma nova linha</span>
    </form>
  );
}
