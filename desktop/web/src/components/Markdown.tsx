import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Bridge } from '../bridge';
import type { MarkdownNode } from '../protocol';
import '../styles/markdown.css';

export function safeWebHref(value?: string): string | undefined {
  if (!value || /[\x00-\x20\x7f]/.test(value)) return;
  try { const url = new URL(value);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname && !url.username && !url.password) return value;
  } catch { /* Unsupported/invalid links stay inert. */ }
}

// Port of native formatDiscordTimestamp: retained Moment modules379418,536637.
export function relativeTimestamp(seconds: number, now = Date.now()): string {
  const date = new Date(seconds * 1000), current = new Date(now);
  const first = date < current ? date : current, last = date < current ? current : date;
  const addMonths = (count: number) => {
    const d = new Date(first); d.setDate(1); d.setMonth(d.getMonth() + count);
    d.setDate(Math.min(first.getDate(), new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); return d;
  };
  let months = (last.getFullYear() - first.getFullYear()) * 12 + last.getMonth() - first.getMonth();
  if (addMonths(months) > last) months--;
  const remainder = last.getTime() - addMonths(months).getTime();
  const duration = Math.round(months * 146097 / 4800) * 86400000 + remainder;
  const fractional = months + remainder / 86400000 * 4800 / 146097;
  const sec = Math.round(duration / 1000), min = Math.round(duration / 60000), hours = Math.round(duration / 3600000), days = Math.round(duration / 86400000);
  const month = Math.round(fractional), years = Math.round(fractional / 12);
  let count = 1, unit = 'segundo';
  if (sec < 60) { count = Math.max(1, sec); unit = count === 1 ? 'segundo' : 'segundos'; }
  else if (min <= 1) unit = 'minuto'; else if (min < 60) { count = min; unit = 'minutos'; }
  else if (hours <= 1) unit = 'hora'; else if (hours < 22) { count = hours; unit = 'horas'; }
  else if (days <= 1) unit = 'dia'; else if (days < 26) { count = days; unit = 'dias'; }
  else if (month <= 1) unit = 'mês'; else if (month < 11) { count = month; unit = 'meses'; }
  else if (years <= 1) unit = 'ano'; else { count = years; unit = 'anos'; }
  return `${date > current ? 'em' : 'há'} ${count} ${unit}`;
}
function Timestamp({ node }: { node: MarkdownNode }) {
  const [now, setNow] = useState(Date.now());
  const seconds = Number(node.seconds), valid = Number.isFinite(seconds) && Math.abs(seconds) <= 8640000000000;
  useEffect(() => {
    if (!valid || node.format !== 'R') return;
    const delay = Math.abs(Date.now() - seconds * 1000) < 60000 ? 1000 : 60000;
    const timer = setTimeout(() => setNow(Date.now()), delay); return () => clearTimeout(timer);
  }, [now, valid, seconds, node.format]);
  return <span class="tri-markdown__timestamp" title={valid ? new Date(seconds * 1000).toLocaleString('pt-BR') : undefined}>
    {valid && node.format === 'R' ? relativeTimestamp(seconds, now) : node.text}
  </span>;
}
function Spoiler({ children }: { children: (hidden: boolean) => ComponentChildren }) {
  const [revealed, reveal] = useState(false);
  return <span class={`tri-markdown__spoiler ${revealed ? 'is-revealed' : ''}`} role={revealed ? undefined : 'button'}
    tabIndex={revealed ? undefined : 0} aria-label={revealed ? undefined : 'Revelar spoiler'}
    onClick={revealed ? undefined : e => { e.preventDefault(); e.stopPropagation(); reveal(true); }}
    onKeyDown={revealed ? undefined : e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); reveal(true); } }}>
    <span class="tri-markdown__spoiler-content" aria-hidden={revealed ? undefined : true}>{children(!revealed)}</span>
  </span>;
}
export function Markdown({ nodes, text, messageId, bridge }: { nodes?: MarkdownNode[]; text: string; messageId: string; bridge: Bridge }) {
  const [error, setError] = useState('');
  const renderNodes = (items: MarkdownNode[], hidden = false): ComponentChildren => items.map((node, i) => {
    const children = () => renderNodes(node.children ?? [], hidden);
    switch (node.type) {
      case 'paragraph': return <div key={i} class="tri-markdown__paragraph">{children()}</div>;
      case 'heading': return node.level === 1 ? <h1 key={i}>{children()}</h1> : node.level === 2 ? <h2 key={i}>{children()}</h2> : <h3 key={i}>{children()}</h3>;
      case 'subtext': return <div key={i} class="tri-markdown__subtext">{children()}</div>;
      case 'strong': return <strong key={i}>{children()}</strong>;
      case 'em': return <em key={i}>{children()}</em>;
      case 'underline': return <u key={i}>{children()}</u>;
      case 'strike': return <s key={i}>{children()}</s>;
      case 'inlineCode': return <code key={i} class="tri-markdown__inline-code">{node.text}</code>;
      case 'codeBlock': return <pre key={i}><code>{node.text}</code></pre>;
      case 'quote': return <blockquote key={i}>{children()}</blockquote>;
      case 'list': return node.ordered
        ? <ol key={i} start={node.start}>{node.items?.map((item, j) => <li key={j}>{renderNodes(item, hidden)}</li>)}</ol>
        : <ul key={i}>{node.items?.map((item, j) => <li key={j}>{renderNodes(item, hidden)}</li>)}</ul>;
      case 'spoiler': return <Spoiler key={i}>{concealed => renderNodes(node.children ?? [], hidden || concealed)}</Spoiler>;
      case 'mention': return <span key={i} class="tri-markdown__mention">{node.text}</span>;
      case 'timestamp': return <Timestamp key={i} node={node}/>;
      case 'break': return <br key={i}/>;
      case 'link': {
        const href = safeWebHref(node.href);
        if (!href || hidden) return <span key={i}>{children()}</span>;
        return <a key={i} href={href} title={node.title || href} rel="noopener noreferrer" onClick={e => {
          e.preventDefault(); setError(''); bridge.request({ name: 'openChatLink', messageId, url: href }).catch(e => setError((e as Error).message));
        }}>{children()}</a>;
      }
      default: return node.text ?? '';
    }
  });
  return <div class="tri-markdown">{nodes ? renderNodes(nodes) : text}{error && <span class="tri-markdown__error" role="alert">{error}</span>}</div>;
}
