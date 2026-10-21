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

// Format relative timestamp in Portuguese.
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
import { Icon } from './Icon';

const KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'fn', 'for',
  'from', 'function', 'if', 'impl', 'import', 'in', 'instanceof', 'let', 'loop', 'match',
  'mod', 'mut', 'new', 'null', 'pub', 'return', 'self', 'static', 'struct', 'super', 'switch',
  'this', 'throw', 'true', 'try', 'typeof', 'use', 'var', 'void', 'while', 'with', 'yield',
]);

function highlightCode(code: string): ComponentChildren {
  const tokens: ComponentChildren[] = [];
  const regex = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*)|(\b\d+(?:\.\d+)?\b)|(\b[a-zA-Z_]\w*\b)|(\s+|[^\s\w"'/`#]+)/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  let i = 0;
  while ((match = regex.exec(code)) !== null) {
    if (match[1]) {
      tokens.push(<span key={i++} class="tri-code-string">{match[1]}</span>);
    } else if (match[2]) {
      tokens.push(<span key={i++} class="tri-code-comment">{match[2]}</span>);
    } else if (match[3]) {
      tokens.push(<span key={i++} class="tri-code-number">{match[3]}</span>);
    } else if (match[4]) {
      if (KEYWORDS.has(match[4])) {
        tokens.push(<span key={i++} class="tri-code-keyword">{match[4]}</span>);
      } else {
        tokens.push(match[4]);
      }
    } else {
      tokens.push(match[0]);
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < code.length) {
    tokens.push(code.slice(lastIndex));
  }
  return tokens.length > 0 ? tokens : code;
}

export function parseMarkdownText(input: string): MarkdownNode[] {
  if (!input) return [];
  const nodes: MarkdownNode[] = [];
  const codeBlockRegex = /```([a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  const processInline = (text: string): MarkdownNode[] => {
    if (!text) return [];
    const inlineNodes: MarkdownNode[] = [];
    const regex = /(\|\|([\s\S]+?)\|\|)|(`([^`]+)`)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(https?:\/\/[^\s<>]+)|(\*\*\*([^*]+)\*\*\*)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(__([^_]+)__)|(~~([^~]+)~~)/g;
    let idx = 0;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(text)) !== null) {
      if (m.index > idx) {
        inlineNodes.push({ type: 'text', text: text.slice(idx, m.index) });
      }
      if (m[1]) {
        inlineNodes.push({ type: 'spoiler', children: processInline(m[2]) });
      } else if (m[3]) {
        inlineNodes.push({ type: 'inlineCode', text: m[4] });
      } else if (m[5]) {
        inlineNodes.push({ type: 'link', href: m[7], children: [{ type: 'text', text: m[6] }] });
      } else if (m[8]) {
        inlineNodes.push({ type: 'link', href: m[8], children: [{ type: 'text', text: m[8] }] });
      } else if (m[9]) {
        inlineNodes.push({ type: 'strong', children: [{ type: 'em', children: [{ type: 'text', text: m[10] }] }] });
      } else if (m[11]) {
        inlineNodes.push({ type: 'strong', children: [{ type: 'text', text: m[12] }] });
      } else if (m[13]) {
        inlineNodes.push({ type: 'em', children: [{ type: 'text', text: m[14] }] });
      } else if (m[15]) {
        inlineNodes.push({ type: 'underline', children: [{ type: 'text', text: m[16] }] });
      } else if (m[17]) {
        inlineNodes.push({ type: 'strike', children: [{ type: 'text', text: m[18] }] });
      }
      idx = regex.lastIndex;
    }
    if (idx < text.length) {
      inlineNodes.push({ type: 'text', text: text.slice(idx) });
    }
    return inlineNodes;
  };

  while ((match = codeBlockRegex.exec(input)) !== null) {
    if (match.index > lastIndex) {
      const preceding = input.slice(lastIndex, match.index);
      for (const line of preceding.split('\n')) {
        if (line.startsWith('> ')) {
          nodes.push({ type: 'quote', children: processInline(line.slice(2)) });
        } else if (line.startsWith('# ')) {
          nodes.push({ type: 'heading', level: 1, children: processInline(line.slice(2)) });
        } else if (line.startsWith('## ')) {
          nodes.push({ type: 'heading', level: 2, children: processInline(line.slice(3)) });
        } else if (line.startsWith('### ')) {
          nodes.push({ type: 'heading', level: 3, children: processInline(line.slice(4)) });
        } else if (line.startsWith('-# ')) {
          nodes.push({ type: 'subtext', children: processInline(line.slice(3)) });
        } else if (line.length > 0) {
          nodes.push(...processInline(line));
        }
      }
    }
    nodes.push({ type: 'codeBlock', language: match[1] || undefined, text: match[2].trimEnd() });
    lastIndex = codeBlockRegex.lastIndex;
  }
  if (lastIndex < input.length) {
    const remaining = input.slice(lastIndex);
    const lines = remaining.split('\n');
    lines.forEach((line, i) => {
      if (line.startsWith('> ')) {
        nodes.push({ type: 'quote', children: processInline(line.slice(2)) });
      } else if (line.startsWith('# ')) {
        nodes.push({ type: 'heading', level: 1, children: processInline(line.slice(2)) });
      } else if (line.startsWith('## ')) {
        nodes.push({ type: 'heading', level: 2, children: processInline(line.slice(3)) });
      } else if (line.startsWith('### ')) {
        nodes.push({ type: 'heading', level: 3, children: processInline(line.slice(4)) });
      } else if (line.startsWith('-# ')) {
        nodes.push({ type: 'subtext', children: processInline(line.slice(3)) });
      } else {
        nodes.push(...processInline(line));
      }
      if (i < lines.length - 1) {
        nodes.push({ type: 'break' });
      }
    });
  }
  return nodes;
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
  const ast = nodes && nodes.length > 0 ? nodes : parseMarkdownText(text);
  const [copied, setCopied] = useState<number | null>(null);

  const copyCode = (codeText: string, index: number) => {
    navigator.clipboard?.writeText(codeText);
    setCopied(index);
    setTimeout(() => setCopied(null), 1500);
  };

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
      case 'codeBlock':
        return (
          <div key={i} class="tri-codeblock-wrapper">
            {node.language && <div class="tri-codeblock-lang">{node.language}</div>}
            <button class="tri-codeblock-copy" aria-label="Copiar código" title={copied === i ? 'Copiado!' : 'Copiar código'}
              onClick={() => copyCode(node.text ?? '', i)}>
              <Icon name={copied === i ? 'CircleCheck' : 'Copy'} size={16} />
            </button>
            <pre><code>{highlightCode(node.text ?? '')}</code></pre>
          </div>
        );
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
  return <div class="tri-markdown">{renderNodes(ast)}{error && <span class="tri-markdown__error" role="alert">{error}</span>}</div>;
}
