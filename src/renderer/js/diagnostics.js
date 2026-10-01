/**
 * Diagnostics: a local record of what happened in this app — connections,
 * people dropping, errors, and the quality of calls and screen shares — that
 * Settings turns into a report someone can paste into a conversation with
 * Claude (or send to whoever maintains the app) to find and fix a problem.
 *
 * Nothing leaves the device on its own: the user copies or saves the report.
 * IP addresses are masked, and ICE credentials are never recorded.
 *
 * Most events come for free: the app already logs what matters with
 * prefixes like [WebRTC], and every warning and error is kept too.
 */

const DIAG_STORAGE_KEY = 'triscord_diagnostics';
const DIAG_MAX_EVENTS = 1500;
const DIAG_SAVE_DELAY_MS = 2000;
const DIAG_MAX_MESSAGE = 400;
const DIAG_MAX_DATA = 1500;
const DIAG_REPORT_TIMELINE = 400;
// console.log/info lines worth keeping; warnings and errors are always kept
const DIAG_CONSOLE_PREFIXES = {
  '[WebRTC]': 'webrtc',
  '[App]': 'app',
  '[AudioPlayback]': 'audio',
  '[AudioUnlock]': 'audio',
  '[Microphone]': 'audio',
  '[RNNoise]': 'audio',
  '[Soundboard]': 'soundboard',
  '[SystemAudio]': 'screen'
};
// Lines that only repeat what another line already says
const DIAG_IGNORED = [/^\[App\] Remote stream received/];

class Diagnostics {
  constructor() {
    this.events = Diagnostics.load();
    this.saveTimer = null;
    this.recording = false; // guards against logging our own console calls
    window.addEventListener('beforeunload', () => this.save());
  }

  static load() {
    try {
      const saved = JSON.parse(localStorage.getItem(DIAG_STORAGE_KEY));
      return Array.isArray(saved) ? saved.slice(-DIAG_MAX_EVENTS) : [];
    } catch (err) {
      return [];
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      localStorage.setItem(DIAG_STORAGE_KEY, JSON.stringify(this.events));
    } catch (err) {
      // Storage full: keep the newer half rather than lose everything
      this.events = this.events.slice(-Math.floor(DIAG_MAX_EVENTS / 2));
    }
  }

  scheduleSave() {
    if (!this.saveTimer) this.saveTimer = setTimeout(() => this.save(), DIAG_SAVE_DELAY_MS);
  }

  /** Mask IPv4 and IPv6 addresses (ICE candidates carry the user's IP). */
  static mask(text) {
    return String(text)
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
      // IPv6: hex groups with '::' or at least three colons (a time like
      // 14:03:22 has two and stays readable)
      .replace(/[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}/gi, m => (m.includes('::') || (m.match(/:/g) || []).length >= 3 ? '[ip]' : m));
  }

  static describe(value) {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === 'string') return value;
    if (value === undefined) return 'undefined';
    try {
      return JSON.stringify(value);
    } catch (err) {
      return String(value);
    }
  }

  /**
   * Record one event.
   * @param category 'app' | 'socket' | 'webrtc' | 'screen' | 'audio' | 'stats' | ...
   * @param level 'info' | 'warn' | 'error'
   */
  log(category, message, data = null, level = 'info') {
    const event = {
      t: Date.now(),
      level,
      category,
      message: Diagnostics.mask(message).slice(0, DIAG_MAX_MESSAGE)
    };
    if (data !== null && data !== undefined) {
      event.data = Diagnostics.mask(Diagnostics.describe(data)).slice(0, DIAG_MAX_DATA);
    }
    this.events.push(event);
    if (this.events.length > DIAG_MAX_EVENTS) this.events.splice(0, this.events.length - DIAG_MAX_EVENTS);
    this.scheduleSave();
  }

  clear() {
    this.events = [];
    this.save();
  }

  /** Keep the app's own log lines, every warning and error, and crashes. */
  capture() {
    ['log', 'info', 'warn', 'error'].forEach((method) => {
      const original = console[method].bind(console);
      console[method] = (...args) => {
        original(...args);
        if (this.recording) return;
        this.recording = true;
        try {
          const text = args.map(Diagnostics.describe).join(' ');
          if (DIAG_IGNORED.some(re => re.test(text))) return;
          const prefix = Object.keys(DIAG_CONSOLE_PREFIXES).find(p => text.startsWith(p));
          const level = method === 'warn' ? 'warn' : method === 'error' ? 'error' : 'info';
          if (prefix || level !== 'info') {
            this.log(prefix ? DIAG_CONSOLE_PREFIXES[prefix] : 'console', text, null, level);
          }
        } finally {
          this.recording = false;
        }
      };
    });

    window.addEventListener('error', (e) => {
      this.log('crash', e.message || 'Erro', { source: e.filename, line: e.lineno, column: e.colno }, 'error');
    });
    window.addEventListener('unhandledrejection', (e) => {
      this.log('crash', `Promise rejeitada: ${Diagnostics.describe(e.reason)}`, null, 'error');
    });
  }

  /** A compact snapshot of every connection, taken periodically during a call. */
  recordStats(rows, resources) {
    const peers = rows.map(r => ({
      user: r.user,
      connection: r.connection,
      path: r.path,
      rttMs: r.rttMs,
      lossPct: r.lossPct,
      uploadKbps: r.uploadEstimateKbps,
      micSending: r.micSending,
      screenOut: r.screenOut,
      screenIn: r.screenIn
    }));
    this.log('stats', `${peers.length} conexão(ões)`, { peers, resources });
  }

  summary() {
    const count = test => this.events.filter(test).length;
    return {
      events: this.events.length,
      since: this.events.length ? this.events[0].t : null,
      serverDisconnects: count(e => e.category === 'socket' && e.message.startsWith('Desconectado')),
      peerDrops: count(e => /Connection state with .*: (failed|disconnected)/.test(e.message)),
      iceRestarts: count(e => /Restarting ICE/.test(e.message)),
      rebuilds: count(e => /Rebuilding connection/.test(e.message)),
      errors: count(e => e.level === 'error'),
      warnings: count(e => e.level === 'warn')
    };
  }

  static time(t, withDate = false) {
    const d = new Date(t);
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    return withDate ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${time}` : time;
  }

  /**
   * The report, as Markdown meant to be pasted into a conversation.
   * @param context { environment: {label: value}, peers: getDiagnostics() rows, mainLog: [] }
   */
  buildReport({ environment = {}, peers = [], mainLog = [] } = {}) {
    const s = this.summary();
    const lines = [];
    lines.push('# Relatório de diagnóstico do Triscord');
    lines.push('');
    lines.push(`> Gerado em ${Diagnostics.time(Date.now(), true)}. Ao enviar para o Claude, conte também o que aconteceu: quem, quando e o que deu errado.`);
    lines.push('');
    lines.push('## Ambiente');
    Object.entries(environment).forEach(([label, value]) => lines.push(`- **${label}:** ${Diagnostics.mask(value)}`));
    lines.push('');
    lines.push(`## Resumo (${s.events} eventos${s.since ? ` desde ${Diagnostics.time(s.since, true)}` : ''})`);
    lines.push(`- Quedas da conexão com o servidor: ${s.serverDisconnects}`);
    lines.push(`- Conexões com outras pessoas que caíram ou falharam: ${s.peerDrops}`);
    lines.push(`- Reinícios de ICE: ${s.iceRestarts} · Conexões reconstruídas: ${s.rebuilds}`);
    lines.push(`- Erros: ${s.errors} · Avisos: ${s.warnings}`);
    lines.push('');

    lines.push('## Conexões agora');
    if (!peers.length) {
      lines.push('Nenhuma (fora de uma chamada).');
    } else {
      lines.push('| Pessoa | Estado | Caminho | RTT | Perda | Upload estimado | Mic enviando | Tela enviada | Tela recebida | Reinícios |');
      lines.push('|---|---|---|---|---|---|---|---|---|---|');
      peers.forEach((p) => {
        const cells = [
          p.user, `${p.connection} (ICE ${p.ice}, sinalização ${p.signaling})`, p.path || '-',
          p.rttMs != null ? `${p.rttMs} ms` : '-', p.lossPct != null ? `${p.lossPct}%` : '-',
          p.uploadEstimateKbps != null ? `${p.uploadEstimateKbps} kbps` : '-',
          p.micSending ? 'sim' : 'NÃO', p.screenOut || '-', p.screenIn || '-', p.restarts
        ];
        lines.push(`| ${cells.map(c => Diagnostics.mask(c).replace(/\|/g, '/')).join(' | ')} |`);
      });
    }
    lines.push('');

    if (mainLog.length) {
      lines.push('## Avisos e erros do processo principal');
      lines.push('```');
      mainLog.slice(-50).forEach(e => lines.push(`${Diagnostics.time(e.t, true)} ${e.level} ${Diagnostics.mask(e.message)}`));
      lines.push('```');
      lines.push('');
    }

    const timeline = this.events.slice(-DIAG_REPORT_TIMELINE);
    lines.push(`## Linha do tempo (últimos ${timeline.length} eventos)`);
    lines.push('```');
    timeline.forEach((e) => {
      const data = e.data ? ` ${e.data}` : '';
      lines.push(`${Diagnostics.time(e.t, true)} ${e.level.padEnd(5)} [${e.category}] ${e.message}${data}`);
    });
    lines.push('```');
    return lines.join('\n');
  }

  /**
   * Can this network reach the internet through STUN, and can each TURN
   * server allocate a relay? A dead TURN leaves people behind strict NATs
   * (CGNAT, mobile data) unable to connect at all.
   */
  static async testConnection(iceServers) {
    const probe = (server, relayOnly) => new Promise((resolve) => {
      const pc = new RTCPeerConnection({ iceServers: [server], iceTransportPolicy: relayOnly ? 'relay' : 'all' });
      pc.createDataChannel('probe');
      const types = new Set();
      const errors = new Set();
      const started = performance.now();
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        pc.close();
        resolve({ types: Array.from(types), errors: Array.from(errors).slice(0, 2), ms: Math.round(performance.now() - started) });
      };
      pc.onicecandidate = (e) => {
        if (e.candidate) types.add(e.candidate.type);
        // One relay (or server-reflexive) candidate answers the question
        if (e.candidate && e.candidate.type === (relayOnly ? 'relay' : 'srflx')) finish();
        if (!e.candidate) finish();
      };
      pc.onicecandidateerror = e => errors.add(`${e.errorCode} ${e.errorText}`.trim());
      pc.setLocalDescription().catch(finish);
      setTimeout(finish, 8000);
    });

    // Every server at once, so the whole test takes one timeout at most
    const targets = iceServers.flatMap(server => (Array.isArray(server.urls) ? server.urls : [server.urls])
      .map(url => ({ server: { ...server, urls: url }, url, isTurn: /^turns?:/.test(url) })));
    return Promise.all(targets.map(async ({ server, url, isTurn }) => {
      const r = await probe(server, isTurn);
      const ok = isTurn ? r.types.includes('relay') : r.types.includes('srflx');
      return { url, kind: isTurn ? 'TURN' : 'STUN', ok, ms: r.ms, errors: r.errors };
    }));
  }
}

window.Diagnostics = Diagnostics;
window.triscordDiagnostics = new Diagnostics();
window.triscordDiagnostics.capture();
window.triscordDiagnostics.log('app', 'Triscord aberto');
