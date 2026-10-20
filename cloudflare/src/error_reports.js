// Error reports (20/10): the desktop app sends the log of a session that showed signs of a bug (desktop/src/
// error_reports.cpp), so a failure no longer depends on asking a friend for triscord.log. Each report, text included,
// is a row of the error_reports D1 table (migrations/0002_error_reports.sql): R2 needs a payment method on the account,
// and a log is small (the app sends at most ~512 KB, usually 10-50 KB; 3 per account per hour, kept 14 days). The admin page (/admin) lists and opens them
// with the ADMIN_KEY Worker secret. Nothing here is reachable without a session (upload) or that key (reading).
export const REPORT_MAX_COMPRESSED = 256 * 1024;
// Below D1's 2 MB limit for one value, with room for the scrubbed text.
export const REPORT_MAX_TEXT = 1000 * 1000;
export const REPORTS_PER_HOUR = 3;
export const REPORT_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,4}$/;
const SIGNAL_RE = /^[a-z][a-z-]{0,23}$/;
const REPORT_ID_RE = /^[0-9a-f-]{36}$/;
const ADMIN_REPORT_RE = /^\/admin\/api\/reports\/([0-9a-f-]{36})$/;

// Defence in depth: the app already scrubs, but a log must never keep a bearer token or an e-mail address here.
export function scrubLog(text) {
  return text.replace(/[0-9a-fA-F]{32,}/g, '<hex>').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>');
}
export function parseSignals(header) {
  if (typeof header !== 'string' || !header.trim()) return null;
  const list = [...new Set(header.split(',').map(s => s.trim()))];
  return list.length <= 12 && list.every(s => SIGNAL_RE.test(s)) ? list : null;
}
async function inflate(request) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > REPORT_MAX_COMPRESSED) return { error: 'too_large' };
  const compressed = new Uint8Array(await request.arrayBuffer());
  if (!compressed.length) return { error: 'empty' };
  if (compressed.length > REPORT_MAX_COMPRESSED) return { error: 'too_large' };
  const reader = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > REPORT_MAX_TEXT) { await reader.cancel(); return { error: 'too_large' }; }
      chunks.push(value);
    }
  } catch { return { error: 'invalid_body' }; }
  const bytes = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; }
  catch { return { error: 'invalid_body' }; }
}
async function pruneExpired(env, now) {
  const { results } = await env.DB.prepare('SELECT id FROM error_reports WHERE created_at < ?1 LIMIT 25').bind(now - REPORT_RETENTION_MS).all();
  if (!results.length) return;
  await env.DB.batch(results.map(row => env.DB.prepare('DELETE FROM error_reports WHERE id = ?1').bind(row.id)));
}

// POST /logs: body = the log compressed with zlib (deflate), X-Triscord-Version, X-Triscord-Signals (what made the
// app send it), X-Triscord-Reason (auto | manual). At most REPORTS_PER_HOUR per account.
async function handleUpload(request, env, helpers) {
  const { json, resolveSession, bearerToken } = helpers;
  if (!env.DB) return json({ error: 'service_not_configured' }, 503);
  const identity = await resolveSession(env, bearerToken(request));
  if (!identity) return json({ error: 'unauthorized' }, 401);
  const version = request.headers.get('X-Triscord-Version') || '';
  const signals = parseSignals(request.headers.get('X-Triscord-Signals'));
  const reason = request.headers.get('X-Triscord-Reason');
  if (!VERSION_RE.test(version) || !signals || (reason !== 'auto' && reason !== 'manual')) return json({ error: 'invalid_report' }, 400);
  const now = Date.now();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM error_reports WHERE account_id = ?1 AND created_at > ?2')
    .bind(identity.accountId, now - 60 * 60 * 1000).first();
  if ((recent?.n || 0) >= REPORTS_PER_HOUR) return json({ error: 'rate_limited' }, 429);
  const body = await inflate(request);
  if (body.error) return json({ error: body.error }, body.error === 'too_large' ? 413 : 400);
  const text = scrubLog(body.text);
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO error_reports(id,account_id,nick,version,signals,reason,bytes,created_at,text) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)')
    .bind(id, identity.accountId, identity.nick, version, signals.join(','), reason, text.length, now, text).run();
  await pruneExpired(env, now);
  return json({ id }, 201);
}

function adminAuthorized(request, env, helpers) {
  return typeof env.ADMIN_KEY === 'string' && env.ADMIN_KEY.length >= 16 && helpers.equalSecret(helpers.bearerToken(request), env.ADMIN_KEY);
}
const adminHeaders = type => ({
  'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
});
async function handleAdminApi(request, env, url, helpers) {
  const { json } = helpers;
  if (!env.ADMIN_KEY) return json({ error: 'service_not_configured' }, 503);
  if (!adminAuthorized(request, env, helpers)) return json({ error: 'unauthorized' }, 401);
  if (!env.DB) return json({ error: 'service_not_configured' }, 503);
  const since = Date.now() - REPORT_RETENTION_MS;
  if (request.method === 'GET' && url.pathname === '/admin/api/reports') {
    const { results } = await env.DB.prepare(
      'SELECT id, account_id AS accountId, nick, version, signals, reason, bytes, created_at AS createdAt FROM error_reports WHERE created_at >= ?1 ORDER BY created_at DESC LIMIT 300'
    ).bind(since).all();
    const reports = results.map(row => ({ ...row, signals: row.signals ? row.signals.split(',') : [] }));
    return Response.json({ reports }, { headers: { 'Cache-Control': 'no-store' } });
  }
  const match = url.pathname.match(ADMIN_REPORT_RE);
  if (match && REPORT_ID_RE.test(match[1])) {
    const id = match[1];
    if (request.method === 'GET') {
      const row = await env.DB.prepare('SELECT text FROM error_reports WHERE id = ?1').bind(id).first();
      return row ? new Response(row.text, { headers: adminHeaders('text/plain; charset=utf-8') }) : json({ error: 'not_found' }, 404);
    }
    if (request.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM error_reports WHERE id = ?1').bind(id).run();
      return new Response(null, { status: 204 });
    }
  }
  return json({ error: 'not_found' }, 404);
}

// Returns a Response for the error-report routes, null for anything else.
export async function handleErrorReports(request, env, url, helpers) {
  if (url.pathname === '/logs') return request.method === 'POST' ? handleUpload(request, env, helpers) : helpers.json({ error: 'not_found' }, 404);
  if (request.method === 'GET' && (url.pathname === '/admin' || url.pathname === '/admin/'))
    return new Response(ADMIN_HTML, { headers: adminHeaders('text/html; charset=utf-8') });
  if (request.method === 'GET' && url.pathname === '/admin/app.js') return new Response(ADMIN_JS, { headers: adminHeaders('text/javascript; charset=utf-8') });
  if (request.method === 'GET' && url.pathname === '/admin/app.css') return new Response(ADMIN_CSS, { headers: adminHeaders('text/css; charset=utf-8') });
  if (url.pathname.startsWith('/admin/api/')) return handleAdminApi(request, env, url, helpers);
  return null;
}

const ADMIN_HTML = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Triscord · Relatórios de erro</title><link rel="stylesheet" href="/admin/app.css"></head>
<body>
<header><h1>Relatórios de erro</h1><span id="status"></span></header>
<form id="login" hidden><label>Chave de admin <input id="key" type="password" autocomplete="off" required></label><button>Entrar</button></form>
<main id="main" hidden>
  <section><h2>Por versão e sinal <small>últimos 14 dias</small></h2><table id="summary"></table></section>
  <section><h2>Relatórios</h2>
    <div class="filters"><select id="version"><option value="">Todas as versões</option></select>
      <select id="signal"><option value="">Todos os sinais</option></select><button id="logout" type="button">Sair</button></div>
    <table id="reports"><thead><tr><th>Quando</th><th>Quem</th><th>Versão</th><th>Sinais</th><th>Tipo</th><th>Tamanho</th></tr></thead><tbody></tbody></table>
  </section>
  <section id="viewer" hidden><div class="viewer-head"><h2 id="viewer-title"></h2>
    <input id="find" type="search" placeholder="Filtrar linhas (ex.: failed, keyframe, signaling)">
    <button id="download" type="button">Baixar</button><button id="remove" type="button" class="danger">Apagar</button><button id="close" type="button">Fechar</button></div>
    <pre id="log"></pre></section>
</main>
<script src="/admin/app.js"></script>
</body></html>`;

const ADMIN_CSS = `:root{color-scheme:light dark;--bg:#f6f6f8;--panel:#fff;--text:#1f2024;--muted:#686b73;--line:#e1e2e6;--accent:#5865f2;--danger:#d83c3e;--chip:#eceefe}
@media (prefers-color-scheme:dark){:root{--bg:#1e1f22;--panel:#2b2d31;--text:#e8e9ec;--muted:#a3a6ad;--line:#3a3c42;--accent:#7983f5;--danger:#f0686a;--chip:#383a6b}}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;font:14px/1.45 system-ui,"Segoe UI",sans-serif;background:var(--bg);color:var(--text)}
header{display:flex;align-items:baseline;gap:16px;padding:20px 24px 8px}h1{font-size:20px;margin:0}h2{font-size:15px;margin:0 0 10px}small{color:var(--muted);font-weight:400}
#status{color:var(--muted)}main{padding:8px 24px 32px;display:grid;gap:20px}section{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:16px;overflow:auto}
form{margin:24px;display:flex;gap:8px;align-items:end}input,select,button{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:6px 10px}
button{cursor:pointer;background:var(--accent);border-color:var(--accent);color:#fff}button.danger{background:var(--danger);border-color:var(--danger)}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--muted);font-weight:600}
td.num{font-variant-numeric:tabular-nums;text-align:right}#reports tbody tr{cursor:pointer}#reports tbody tr:hover,#reports tbody tr.is-open{background:var(--chip)}
.chip{display:inline-block;padding:1px 8px;margin-right:4px;border-radius:10px;background:var(--chip);font-size:12px}
.filters,.viewer-head{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px}.viewer-head h2{margin:0 auto 0 0}
pre{margin:0;max-height:70vh;overflow:auto;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
mark{background:#f5c54266;color:inherit}`;

const ADMIN_JS = `'use strict';
const $ = id => document.getElementById(id);
let key = sessionStorage.getItem('triscordAdminKey') || '', reports = [], openId = null, logText = '';
const fmtDate = ms => new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
const fmtSize = n => n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB';
function el(tag, props = {}, ...children) { const node = Object.assign(document.createElement(tag), props); node.append(...children); return node; }
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { Authorization: 'Bearer ' + key } });
  if (response.status === 401) { logout('Chave inválida.'); throw new Error('unauthorized'); }
  if (!response.ok && response.status !== 204) throw new Error('HTTP ' + response.status);
  return response;
}
function logout(message) { key = ''; sessionStorage.removeItem('triscordAdminKey'); $('main').hidden = true; $('login').hidden = false; $('status').textContent = message || ''; }
function fill(select, values, label) { const current = select.value; select.replaceChildren(el('option', { value: '', textContent: label }), ...values.map(v => el('option', { value: v, textContent: v }))); select.value = values.includes(current) ? current : ''; }
function render() {
  const versions = [...new Set(reports.map(r => r.version))].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  const signals = [...new Set(reports.flatMap(r => r.signals))].sort();
  fill($('version'), versions, 'Todas as versões'); fill($('signal'), signals, 'Todos os sinais');
  const head = el('tr', {}, el('th', { textContent: 'Versão' }), ...signals.map(s => el('th', { textContent: s })), el('th', { textContent: 'Relatórios' }), el('th', { textContent: 'Pessoas' }));
  const rows = versions.map(v => { const list = reports.filter(r => r.version === v);
    return el('tr', {}, el('td', { textContent: v }), ...signals.map(s => el('td', { className: 'num', textContent: String(list.filter(r => r.signals.includes(s)).length || '') })),
      el('td', { className: 'num', textContent: String(list.length) }), el('td', { className: 'num', textContent: String(new Set(list.map(r => r.accountId)).size) })); });
  $('summary').replaceChildren(el('thead', {}, head), el('tbody', {}, ...rows));
  const v = $('version').value, s = $('signal').value;
  const shown = reports.filter(r => (!v || r.version === v) && (!s || r.signals.includes(s)));
  $('reports').tBodies[0].replaceChildren(...shown.map(r => { const row = el('tr', { className: r.id === openId ? 'is-open' : '' },
    el('td', { textContent: fmtDate(r.createdAt) }), el('td', { textContent: r.nick, title: r.accountId }), el('td', { textContent: r.version }),
    el('td', {}, ...r.signals.map(x => el('span', { className: 'chip', textContent: x }))), el('td', { textContent: r.reason === 'manual' ? 'manual' : 'automático' }),
    el('td', { className: 'num', textContent: fmtSize(r.bytes) }));
    row.addEventListener('click', () => open(r)); return row; }));
  $('status').textContent = reports.length + ' relatório(s)';
}
function showLog() {
  const term = $('find').value.trim().toLowerCase();
  const lines = term ? logText.split('\\n').filter(line => line.toLowerCase().includes(term)) : logText.split('\\n');
  $('log').textContent = lines.join('\\n');
}
async function open(report) {
  openId = report.id; render();
  $('viewer').hidden = false; $('viewer-title').textContent = report.nick + ' · ' + report.version + ' · ' + fmtDate(report.createdAt);
  $('log').textContent = 'Carregando…';
  logText = await (await api('/admin/api/reports/' + report.id)).text(); showLog();
  $('viewer').scrollIntoView({ behavior: 'smooth' });
}
async function load() {
  $('login').hidden = true; $('main').hidden = false; $('status').textContent = 'Carregando…';
  try { reports = (await (await api('/admin/api/reports')).json()).reports; render(); } catch (error) { if (key) $('status').textContent = 'Falha ao carregar: ' + error.message; }
}
$('login').addEventListener('submit', event => { event.preventDefault(); key = $('key').value; sessionStorage.setItem('triscordAdminKey', key); $('key').value = ''; load(); });
$('logout').addEventListener('click', () => logout());
$('version').addEventListener('change', render); $('signal').addEventListener('change', render);
$('find').addEventListener('input', showLog);
$('close').addEventListener('click', () => { $('viewer').hidden = true; openId = null; render(); });
$('download').addEventListener('click', () => { const a = el('a', { href: URL.createObjectURL(new Blob([logText], { type: 'text/plain' })), download: 'triscord-' + openId + '.log' }); a.click(); URL.revokeObjectURL(a.href); });
$('remove').addEventListener('click', async () => { if (!openId || !confirm('Apagar este relatório?')) return; await api('/admin/api/reports/' + openId, { method: 'DELETE' }); $('viewer').hidden = true; openId = null; load(); });
if (key) load(); else logout();
`;
