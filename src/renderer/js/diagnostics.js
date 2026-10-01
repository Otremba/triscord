/**
 * Diagnostics: a local record of this app's calls — connections, people
 * dropping, errors, and numbers on how voice and screen shares actually
 * performed — that Settings turns into a report to paste into a conversation
 * with Claude (or send to whoever maintains the app). It serves two jobs: find
 * out what went wrong in a call, and show what to improve in Triscord itself,
 * so it measures, aggregates and points at likely causes rather than only
 * listing what happened.
 *
 * Two stores, both in localStorage:
 * - events: things that happened (connections, drops, warnings, errors);
 * - samples: every ~10 s during a call, raw counters for each connection
 *   (see getDiagnostics in webrtc.js) plus how loaded the PC is. The report
 *   compares consecutive samples to get rates (freezes per minute, loss,
 *   time limited by CPU...), so a busy call no longer pushes events out.
 *
 * Nothing leaves the device on its own: the user copies or saves the report.
 * IP addresses are masked, and ICE credentials are never recorded.
 */

const DIAG_STORAGE_KEY = 'triscord_diagnostics';
const DIAG_SAMPLES_KEY = 'triscord_diagnostics_samples';
const DIAG_MAX_EVENTS = 1500;
// One sample every ~10 s: the last hour of calls
const DIAG_MAX_SAMPLES = 360;
const DIAG_SAVE_DELAY_MS = 2000;
const DIAG_MAX_MESSAGE = 400;
const DIAG_MAX_DATA = 1500;
const DIAG_REPORT_TIMELINE = 300;
const DIAG_REPORT_RECENT_SAMPLES = 30;
// Two samples further apart than this belong to different calls
const DIAG_SAMPLE_GAP_MS = 30000;
// console.log/info lines worth keeping; warnings and errors are always kept
const DIAG_CONSOLE_PREFIXES = {
  '[WebRTC]': 'webrtc',
  '[App]': 'app',
  '[AudioPlayback]': 'audio',
  '[AudioUnlock]': 'audio',
  '[Microphone]': 'audio',
  '[RNNoise]': 'audio',
  '[Soundboard]': 'soundboard',
  '[SystemAudio]': 'screen',
  '[GpuRelay]': 'screen'
};
// Lines that only repeat what another line already says, or that the samples
// measure better (a track unmuting is a stall the freeze counters capture)
const DIAG_IGNORED = [/^\[App\] Remote stream received/, /^\[WebRTC\] Remote track unmuted/];

// ---- Small number helpers for the report ----

function diagAverage(values) {
  const list = values.filter(v => Number.isFinite(v));
  return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
}

function diagPercentile(values, p) {
  const list = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
  if (!list.length) return null;
  return list[Math.min(list.length - 1, Math.floor((p / 100) * list.length))];
}

function diagRound(value, digits = 0) {
  if (!Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function diagPct(part, whole, digits = 1) {
  return whole > 0 ? diagRound((100 * part) / whole, digits) : null;
}

// "1080p 62% · 720p 30% · menos 8%" from a list of frame heights
function diagHeightShare(heights) {
  const list = heights.filter(h => h > 0);
  if (!list.length) return '-';
  const share = test => diagPct(list.filter(test).length, list.length, 0);
  const parts = [];
  const full = share(h => h >= 1000);
  const hd = share(h => h >= 700 && h < 1000);
  const low = share(h => h < 700);
  if (full) parts.push(`1080p ${full}%`);
  if (hd) parts.push(`720p ${hd}%`);
  if (low) parts.push(`menos ${low}%`);
  return parts.join(' · ');
}

const DIAG_PC_NAMES = { cpu: 'processador', ram: 'memória RAM', gpu: 'placa de vídeo' };

class Diagnostics {
  constructor() {
    this.events = Diagnostics.load(DIAG_STORAGE_KEY, DIAG_MAX_EVENTS)
      // Older versions logged every stats sample as an event
      .filter(e => e.category !== 'stats');
    this.samples = Diagnostics.load(DIAG_SAMPLES_KEY, DIAG_MAX_SAMPLES);
    this.saveTimer = null;
    this.recording = false; // guards against logging our own console calls
    window.addEventListener('beforeunload', () => this.save());
  }

  static load(key, max) {
    try {
      const saved = JSON.parse(localStorage.getItem(key));
      return Array.isArray(saved) ? saved.slice(-max) : [];
    } catch (err) {
      return [];
    }
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      localStorage.setItem(DIAG_STORAGE_KEY, JSON.stringify(this.events));
      localStorage.setItem(DIAG_SAMPLES_KEY, JSON.stringify(this.samples));
    } catch (err) {
      // Storage full: keep the newer half rather than lose everything
      this.events = this.events.slice(-Math.floor(DIAG_MAX_EVENTS / 2));
      this.samples = this.samples.slice(-Math.floor(DIAG_MAX_SAMPLES / 2));
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
   * @param category 'app' | 'socket' | 'webrtc' | 'screen' | 'audio' | 'pc' | ...
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
    this.samples = [];
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

  /**
   * One sample of every connection, taken every ~10 s during a call.
   * @param rows getDiagnostics() rows, with user, version and pc added by the app
   * @param resources { appCpuPercent, appMemoryMB, freeMemoryMB, pc }
   */
  recordStats(rows, resources) {
    this.samples.push({
      t: Date.now(),
      pc: resources && resources.pc ? resources.pc : null,
      app: resources ? { cpu: resources.appCpuPercent, ramMB: resources.appMemoryMB } : null,
      peers: rows.map(r => ({
        id: r.socketId,
        user: r.user,
        version: r.version || null,
        pc: r.pc || null,
        connection: r.connection,
        m: r.metrics || {}
      }))
    });
    if (this.samples.length > DIAG_MAX_SAMPLES) this.samples.splice(0, this.samples.length - DIAG_MAX_SAMPLES);
    this.scheduleSave();
  }

  summary() {
    const count = test => this.events.filter(test).length;
    return {
      events: this.events.length,
      samples: this.samples.length,
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

  // ---- Aggregation over the samples ----

  /**
   * Walk consecutive samples of the same connection, calling
   * fn(previous metrics, current metrics, seconds between, peer). Pairs are
   * skipped across a gap (another call) or a counter going backwards (a new
   * connection, or a new share).
   */
  eachInterval(fn) {
    const last = new Map();
    this.samples.forEach((sample) => {
      sample.peers.forEach((peer) => {
        const previous = last.get(peer.id);
        if (previous && sample.t - previous.t <= DIAG_SAMPLE_GAP_MS) {
          fn(previous.m, peer.m, (sample.t - previous.t) / 1000, peer, sample);
        }
        last.set(peer.id, { t: sample.t, m: peer.m });
      });
    });
  }

  /** Session numbers per person, for the report's tables and findings. */
  analyze() {
    const people = new Map(); // user name -> aggregates
    const person = (peer) => {
      const key = peer.user || peer.id;
      if (!people.has(key)) {
        people.set(key, {
          name: key,
          versions: new Set(),
          out: { activeSec: 0, pausedSec: 0, floorSec: 0, fps: [], heights: [], limits: {}, bytes: 0, retransmitted: 0, keyFrames: 0, plis: 0, encodeTime: 0, frames: 0, codecs: new Set(), encoders: new Set(), gpuSec: 0, relaySec: 0 },
          in: { activeSec: 0, fps: [], heights: [], freezes: 0, freezeSec: 0, decoded: 0, dropped: 0, received: 0, lost: 0, bytes: 0, plis: 0, jitter: [], bufferDelay: 0, bufferEmitted: 0, decoders: new Set(), causes: {} },
          voice: { received: 0, lost: 0, concealed: 0, samples: 0, events: 0, sec: 0, jitter: [] },
          net: { rtt: [], upload: [], paths: new Set() },
          pc: { cpu: [], ram: [], gpu: [], issueSamples: {}, samples: 0 }
        });
      }
      return people.get(key);
    };
    const delta = (a, b, key) => {
      const d = (b && b[key]) - (a && a[key]);
      return Number.isFinite(d) && d >= 0 ? d : null;
    };

    this.samples.forEach((sample) => {
      sample.peers.forEach((peer) => {
        const p = person(peer);
        if (peer.version) p.versions.add(peer.version);
        const m = peer.m || {};
        if (Number.isFinite(m.rttMs)) p.net.rtt.push(m.rttMs);
        if (Number.isFinite(m.uploadKbps)) p.net.upload.push(m.uploadKbps);
        if (m.path) p.net.paths.add(`${m.path.local} → ${m.path.remote} (${m.path.protocol}${m.path.relayProtocol ? `, relay ${m.path.relayProtocol}` : ''})`);
        if (peer.pc) {
          p.pc.samples++;
          ['cpu', 'ram', 'gpu'].forEach((k) => { if (Number.isFinite(peer.pc[k])) p.pc[k].push(peer.pc[k]); });
          (peer.pc.issues || []).forEach((issue) => { p.pc.issueSamples[issue] = (p.pc.issueSamples[issue] || 0) + 1; });
        }
      });
    });

    this.eachInterval((a, b, dt, peer) => {
      const p = person(peer);

      // What we sent this person of our screen share
      if (b.screenOut && a.screenOut) {
        const o = p.out;
        const frames = delta(a.screenOut, b.screenOut, 'framesEncoded');
        if (b.screenOut.paused) o.pausedSec += dt;
        else if (frames) {
          o.activeSec += dt;
          o.frames += frames;
          o.fps.push(b.screenOut.fps);
          o.heights.push(b.screenOut.height);
          if (b.screenOut.floor) o.floorSec += dt;
          if (b.screenOut.gpu) o.gpuSec += dt;
          if (b.screenOut.gpuRelay) o.relaySec += dt;
          if (b.screenOut.codec) o.codecs.add(b.screenOut.codec);
          if (b.screenOut.encoder) o.encoders.add(b.screenOut.encoder);
          o.bytes += delta(a.screenOut, b.screenOut, 'bytesSent') || 0;
          o.retransmitted += delta(a.screenOut, b.screenOut, 'retransmittedBytesSent') || 0;
          o.keyFrames += delta(a.screenOut, b.screenOut, 'keyFramesEncoded') || 0;
          o.plis += delta(a.screenOut, b.screenOut, 'pliCount') || 0;
          o.encodeTime += delta(a.screenOut, b.screenOut, 'totalEncodeTime') || 0;
          const la = a.screenOut.limitDurations;
          const lb = b.screenOut.limitDurations;
          if (la && lb) {
            Object.keys(lb).forEach((reason) => {
              const d = lb[reason] - (la[reason] || 0);
              if (d > 0) o.limits[reason] = (o.limits[reason] || 0) + d;
            });
          }
        }
      }

      // What we received of their screen share
      if (b.screenIn && a.screenIn) {
        const i = p.in;
        const decoded = delta(a.screenIn, b.screenIn, 'framesDecoded');
        if (decoded !== null) {
          if (decoded > 0) i.activeSec += dt;
          i.decoded += decoded;
          i.fps.push(b.screenIn.fps);
          i.heights.push(b.screenIn.height);
          i.freezes += delta(a.screenIn, b.screenIn, 'freezeCount') || 0;
          i.freezeSec += delta(a.screenIn, b.screenIn, 'totalFreezesDuration') || 0;
          i.dropped += delta(a.screenIn, b.screenIn, 'framesDropped') || 0;
          i.received += delta(a.screenIn, b.screenIn, 'packetsReceived') || 0;
          i.lost += delta(a.screenIn, b.screenIn, 'packetsLost') || 0;
          i.bytes += delta(a.screenIn, b.screenIn, 'bytesReceived') || 0;
          i.plis += delta(a.screenIn, b.screenIn, 'pliCount') || 0;
          i.bufferDelay += delta(a.screenIn, b.screenIn, 'jitterBufferDelay') || 0;
          i.bufferEmitted += delta(a.screenIn, b.screenIn, 'jitterBufferEmittedCount') || 0;
          i.jitter.push(b.screenIn.jitterMs);
          if (b.screenIn.decoder) i.decoders.add(b.screenIn.decoder);
          const cause = b.screenIn.sender && b.screenIn.sender.cause;
          if (cause) i.causes[cause] = (i.causes[cause] || 0) + 1;
        }
      }

      // Their voice, as it reached us
      if (b.voiceIn && a.voiceIn) {
        const v = p.voice;
        const received = delta(a.voiceIn, b.voiceIn, 'packetsReceived');
        if (received) {
          v.sec += dt;
          v.received += received;
          v.lost += delta(a.voiceIn, b.voiceIn, 'packetsLost') || 0;
          v.concealed += delta(a.voiceIn, b.voiceIn, 'concealedSamples') || 0;
          v.samples += delta(a.voiceIn, b.voiceIn, 'totalSamplesReceived') || 0;
          v.events += delta(a.voiceIn, b.voiceIn, 'concealmentEvents') || 0;
          v.jitter.push(b.voiceIn.jitterMs);
        }
      }
    });

    // This PC
    const own = { cpu: [], ram: [], gpu: [], encoder: [], issueSamples: {}, samples: 0, appCpu: [], appRam: [] };
    this.samples.forEach((sample) => {
      if (sample.pc) {
        own.samples++;
        ['cpu', 'ram', 'gpu'].forEach((k) => { if (Number.isFinite(sample.pc[k])) own[k].push(sample.pc[k]); });
        if (Number.isFinite(sample.pc.gpuEncoder)) own.encoder.push(sample.pc.gpuEncoder);
        (sample.pc.issues || []).forEach((issue) => { own.issueSamples[issue] = (own.issueSamples[issue] || 0) + 1; });
      }
      if (sample.app) {
        if (Number.isFinite(sample.app.cpu)) own.appCpu.push(sample.app.cpu);
        if (Number.isFinite(sample.app.ramMB)) own.appRam.push(sample.app.ramMB);
      }
    });

    return { people: Array.from(people.values()), own };
  }

  /**
   * What the numbers point at: each finding says what happened, the likely
   * cause, and what to check or improve. Ordered most serious first.
   */
  findings(analysis, summary) {
    const found = [];
    const add = (level, text) => found.push({ level, text });

    analysis.people.forEach((p) => {
      const i = p.in;
      const minutes = i.activeSec / 60;
      if (minutes >= 0.5) {
        const freezesPerMin = i.freezes / minutes;
        const frozenPct = diagPct(i.freezeSec, i.activeSec);
        const lossPct = diagPct(i.lost, i.received + i.lost);
        // A still screen sends frames irregularly and Chromium counts those
        // gaps as freezes too, so the time spent frozen weighs more than the count
        if (frozenPct >= 5 || (frozenPct >= 2 && freezesPerMin >= 3)) {
          const where = lossPct !== null && lossPct < 1
            ? `quase sem perda de pacotes (${lossPct}%): o vídeo trava antes de sair, no PC ou na captura de ${p.name}. Peça o relatório de ${p.name} e veja "Sua tela, enviada" e o desempenho do PC`
            : `com ${lossPct}% de perda de pacotes: a rede entre vocês está descartando dados. Compare com o relatório de ${p.name} para saber de qual lado`;
          add(frozenPct >= 5 ? 'grave' : 'atenção', `A tela de ${p.name} travou ${diagRound(freezesPerMin, 1)} vez(es) por minuto (${frozenPct}% do tempo parada), ${where}.`);
        }
        const fpsP10 = diagPercentile(i.fps, 10);
        if (fpsP10 !== null && fpsP10 < 20 && !(freezesPerMin >= 1)) {
          add('atenção', `A tela de ${p.name} ficou abaixo de ${fpsP10} FPS em 10% do tempo.`);
        }
        const droppedPct = diagPct(i.dropped, i.decoded + i.dropped);
        if (droppedPct >= 5) add('atenção', `Este PC descartou ${droppedPct}% dos quadros da tela de ${p.name} (não deu conta de exibir): veja o desempenho deste PC.`);
      }

      const o = p.out;
      if (o.activeSec >= 30) {
        const limitTotal = Object.values(o.limits).reduce((a, b) => a + b, 0) || o.activeSec;
        const cpuPct = diagPct(o.limits.cpu || 0, limitTotal);
        const bwPct = diagPct(o.limits.bandwidth || 0, limitTotal);
        if (cpuPct >= 10) add('grave', `O envio da sua tela para ${p.name} ficou limitado pelo processador em ${cpuPct}% do tempo: o encoder não deu conta${o.gpuSec < o.activeSec / 2 ? ' (e ele rodou na CPU, não na placa de vídeo)' : ''}.`);
        if (bwPct >= 20) add('atenção', `O envio da sua tela para ${p.name} ficou limitado pela internet em ${bwPct}% do tempo (seu upload ou o download de ${p.name}).`);
        if (o.codecs.has('VP8') || o.codecs.has('VP9')) {
          add('atenção', `Sua tela foi para ${p.name} em ${Array.from(o.codecs).join('/')}, pela CPU: ${p.name} provavelmente estava numa versão antiga (versão: ${Array.from(p.versions).join(', ') || 'desconhecida'}).`);
        } else if (o.codecs.has('H264') && o.gpuSec < o.activeSec / 2) {
          add('atenção', `Sua tela foi para ${p.name} em H.264, mas comprimida pela CPU (${Array.from(o.encoders).join(', ')}): este PC não ofereceu encoder de hardware.`);
        }
        const retransPct = diagPct(o.retransmitted, o.bytes);
        if (retransPct >= 5) add('atenção', `${retransPct}% do que foi enviado para ${p.name} precisou ser reenviado: perda de pacotes no caminho.`);
      }

      const v = p.voice;
      if (v.sec >= 30) {
        const concealedPct = diagPct(v.concealed, v.samples);
        const lossPct = diagPct(v.lost, v.received + v.lost);
        if (concealedPct >= 2) add(concealedPct >= 5 ? 'grave' : 'atenção', `A voz de ${p.name} falhou ${concealedPct}% do tempo (perda ${lossPct}%, jitter médio ${diagRound(diagAverage(v.jitter))} ms).`);
      }

      const rttP95 = diagPercentile(p.net.rtt, 95);
      if (rttP95 !== null && rttP95 >= 250) add('atenção', `Atraso alto com ${p.name}: ${rttP95} ms em 5% do tempo (picos assim costumam ser a internet lotada de um dos lados).`);
      if (Array.from(p.net.paths).some(path => path.includes('relay'))) add('info', `A conexão com ${p.name} passou por um servidor TURN (relay): conexão direta não foi possível.`);

      Object.entries(p.pc.issueSamples).forEach(([issue, n]) => {
        const pct = diagPct(n, p.pc.samples, 0);
        if (pct >= 10) add('atenção', `O PC de ${p.name} ficou com ${DIAG_PC_NAMES[issue] || issue} no limite em ${pct}% do tempo.`);
      });
    });

    Object.entries(analysis.own.issueSamples).forEach(([issue, n]) => {
      const pct = diagPct(n, analysis.own.samples, 0);
      if (pct >= 10) add('grave', `Este PC ficou com ${DIAG_PC_NAMES[issue] || issue} no limite em ${pct}% do tempo da chamada.`);
    });

    if (summary.serverDisconnects) add('atenção', `A conexão com o servidor caiu ${summary.serverDisconnects} vez(es) (veja os horários na linha do tempo).`);
    if (summary.peerDrops) add('atenção', `Conexões com outras pessoas caíram ou falharam ${summary.peerDrops} vez(es); reinícios de ICE: ${summary.iceRestarts}, reconstruções: ${summary.rebuilds}.`);
    if (this.events.some(e => /poucos quadros/.test(e.message))) add('atenção', 'Uma janela compartilhada entregou poucos quadros por segundo: para jogos, a tela inteira funciona melhor.');
    if (summary.errors) add('atenção', `${summary.errors} erro(s) registrados: veja a linha do tempo.`);

    const order = { grave: 0, 'atenção': 1, info: 2 };
    return found.sort((a, b) => order[a.level] - order[b.level]);
  }

  /**
   * The report, as Markdown meant to be pasted into a conversation.
   * @param context { environment: {label: value}, peers: getDiagnostics() rows, mainLog: [] }
   */
  buildReport({ environment = {}, peers = [], mainLog = [] } = {}) {
    const s = this.summary();
    const analysis = this.analyze();
    const findings = this.findings(analysis, s);
    const lines = [];
    const table = (header, rows) => {
      if (!rows.length) return;
      lines.push(`| ${header.join(' | ')} |`);
      lines.push(`|${header.map(() => '---').join('|')}|`);
      rows.forEach(r => lines.push(`| ${r.map(c => Diagnostics.mask(c === null || c === undefined ? '-' : c).replace(/\|/g, '/')).join(' | ')} |`));
      lines.push('');
    };
    const fmt = (v, unit = '') => (v === null || v === undefined ? '-' : `${v}${unit}`);
    const minutes = sec => `${diagRound(sec / 60, 1)} min`;

    lines.push('# Relatório de diagnóstico do Triscord');
    lines.push('');
    lines.push(`> Gerado em ${Diagnostics.time(Date.now(), true)}. Serve para entender o que aconteceu numa chamada e para melhorar o Triscord: ` +
      'conte também o que aconteceu (quem, quando, o que deu errado) ou o que poderia ser melhor.');
    lines.push('');

    lines.push('## Ambiente');
    Object.entries(environment).forEach(([label, value]) => lines.push(`- **${label}:** ${Diagnostics.mask(value)}`));
    lines.push('');

    lines.push(`## O que analisar (${findings.length})`);
    if (!findings.length) lines.push('Nada fora do normal nas métricas registradas.');
    findings.forEach(f => lines.push(`- **[${f.level}]** ${f.text}`));
    lines.push('');

    const period = this.samples.length
      ? `${Diagnostics.time(this.samples[0].t, true)} a ${Diagnostics.time(this.samples[this.samples.length - 1].t, true)}`
      : 'sem amostras';
    lines.push(`## Métricas da sessão (${s.samples} amostras, ${period})`);
    lines.push('');

    const sent = analysis.people.filter(p => p.out.activeSec > 0 || p.out.pausedSec > 0);
    if (sent.length) {
      lines.push('### Sua tela, enviada para cada pessoa');
      table(
        ['Pessoa', 'Tempo', 'FPS médio / pior 10%', 'Resolução', 'Limitado por (tempo)', 'Segurando 720p', 'Codec · encoder', 'Placa de vídeo', 'Taxa média', 'Reenviado', 'Pedidos de quadro-chave', 'Codificação', 'Pausado'],
        sent.map((p) => {
          const o = p.out;
          const total = Object.values(o.limits).reduce((a, b) => a + b, 0);
          const limits = total
            ? Object.entries(o.limits).filter(([, d]) => d > 0).sort((a, b) => b[1] - a[1])
              .map(([r, d]) => `${{ none: 'nada', cpu: 'CPU', bandwidth: 'internet', other: 'outro' }[r] || r} ${diagPct(d, total, 0)}%`).join(' · ')
            : '-';
          return [
            p.name, minutes(o.activeSec), `${fmt(diagRound(diagAverage(o.fps)))} / ${fmt(diagPercentile(o.fps, 10))}`,
            diagHeightShare(o.heights), limits, `${fmt(diagPct(o.floorSec, o.activeSec, 0), '%')}`,
            `${Array.from(o.codecs).join('/') || '-'} · ${Array.from(o.encoders).join('/') || '-'}`,
            `${fmt(diagPct(o.gpuSec, o.activeSec, 0), '%')} do tempo${o.relaySec ? ' (relay)' : ''}`,
            o.activeSec ? `${Math.round((o.bytes * 8) / o.activeSec / 1000)} kbps` : '-',
            fmt(diagPct(o.retransmitted, o.bytes), '%'), o.plis,
            o.frames ? `${diagRound((o.encodeTime / o.frames) * 1000, 1)} ms/quadro` : '-', minutes(o.pausedSec)
          ];
        })
      );
    }

    const watched = analysis.people.filter(p => p.in.activeSec > 0);
    if (watched.length) {
      lines.push('### Telas recebidas');
      table(
        ['De', 'Tempo', 'FPS médio / pior 10%', 'Resolução', 'Travadas', 'Tempo travado', 'Quadros descartados', 'Perda', 'Jitter', 'Buffer', 'Taxa média', 'Decoder', 'Limitado por (segundo quem transmite)'],
        watched.map((p) => {
          const i = p.in;
          const mins = i.activeSec / 60;
          const causeNames = {
            ok: 'nada', 'viewer-network': 'internet deste PC', 'sender-upload': 'upload de quem transmite',
            'sender-cpu': 'PC de quem transmite', network: 'internet (um dos lados)'
          };
          const causes = Object.entries(i.causes).sort((a, b) => b[1] - a[1])
            .map(([c, n]) => `${causeNames[c] || c} ${diagPct(n, Object.values(i.causes).reduce((a, b) => a + b, 0), 0)}%`).join(' · ');
          return [
            p.name, minutes(i.activeSec), `${fmt(diagRound(diagAverage(i.fps)))} / ${fmt(diagPercentile(i.fps, 10))}`,
            diagHeightShare(i.heights), `${i.freezes} (${fmt(diagRound(mins ? i.freezes / mins : 0, 1))}/min)`,
            fmt(diagPct(i.freezeSec, i.activeSec), '%'), fmt(diagPct(i.dropped, i.decoded + i.dropped), '%'),
            fmt(diagPct(i.lost, i.received + i.lost), '%'), fmt(diagRound(diagAverage(i.jitter)), ' ms'),
            i.bufferEmitted ? `${Math.round((i.bufferDelay / i.bufferEmitted) * 1000)} ms` : '-',
            i.activeSec ? `${Math.round((i.bytes * 8) / i.activeSec / 1000)} kbps` : '-',
            Array.from(i.decoders).join('/') || '-', causes || '- (versão antiga)'
          ];
        })
      );
    }

    const heard = analysis.people.filter(p => p.voice.sec > 0);
    if (heard.length) {
      lines.push('### Voz recebida');
      table(
        ['De', 'Tempo', 'Falhas no áudio', 'Interrupções/min', 'Perda', 'Jitter médio'],
        heard.map((p) => {
          const v = p.voice;
          return [
            p.name, minutes(v.sec), fmt(diagPct(v.concealed, v.samples), '%'),
            fmt(diagRound(v.sec ? v.events / (v.sec / 60) : 0, 1)), fmt(diagPct(v.lost, v.received + v.lost), '%'),
            fmt(diagRound(diagAverage(v.jitter)), ' ms')
          ];
        })
      );
    }

    if (analysis.people.length) {
      lines.push('### Rede e PC de cada pessoa');
      table(
        ['Pessoa', 'Versão', 'Caminho', 'Atraso médio / pior 5%', 'Upload estimado médio', 'PC: CPU média/máx', 'RAM média/máx', 'GPU média/máx', 'No limite'],
        analysis.people.map((p) => {
          const pc = p.pc;
          const pair = values => (values.length ? `${Math.round(diagAverage(values))}% / ${Math.max(...values)}%` : '-');
          const issues = Object.entries(pc.issueSamples).map(([k, n]) => `${DIAG_PC_NAMES[k] || k} ${diagPct(n, pc.samples, 0)}%`).join(' · ');
          return [
            p.name, Array.from(p.versions).join(', ') || '-', Array.from(p.net.paths).join(' / ') || '-',
            `${fmt(diagRound(diagAverage(p.net.rtt)), ' ms')} / ${fmt(diagPercentile(p.net.rtt, 95), ' ms')}`,
            fmt(diagRound(diagAverage(p.net.upload)), ' kbps'), pair(pc.cpu), pair(pc.ram), pair(pc.gpu), issues || '-'
          ];
        })
      );
    }

    const own = analysis.own;
    if (own.samples) {
      const pair = values => (values.length ? `${Math.round(diagAverage(values))}% média, ${Math.max(...values)}% máx` : '-');
      lines.push('### Este PC durante as chamadas');
      lines.push(`- Processador: ${pair(own.cpu)} (Triscord: ${fmt(diagRound(diagAverage(own.appCpu)))}% em unidades por núcleo)`);
      lines.push(`- Memória RAM: ${pair(own.ram)} (Triscord: ${fmt(diagRound(diagAverage(own.appRam)))} MB)`);
      lines.push(`- Placa de vídeo: ${pair(own.gpu)} · codificador de vídeo: ${pair(own.encoder)}`);
      const issues = Object.entries(own.issueSamples).map(([k, n]) => `${DIAG_PC_NAMES[k] || k} ${diagPct(n, own.samples, 0)}% do tempo`);
      lines.push(`- No limite: ${issues.join(' · ') || 'nunca'}`);
      lines.push('');
    }

    lines.push(`## Resumo de eventos (${s.events} desde ${s.since ? Diagnostics.time(s.since, true) : '-'})`);
    lines.push(`- Quedas da conexão com o servidor: ${s.serverDisconnects}`);
    lines.push(`- Conexões com outras pessoas que caíram ou falharam: ${s.peerDrops}`);
    lines.push(`- Reinícios de ICE: ${s.iceRestarts} · Conexões reconstruídas: ${s.rebuilds}`);
    lines.push(`- Erros: ${s.errors} · Avisos: ${s.warnings}`);
    lines.push('');

    lines.push('## Conexões agora');
    if (!peers.length) {
      lines.push('Nenhuma (fora de uma chamada).');
    } else {
      table(
        ['Pessoa', 'Versão', 'Estado', 'Caminho', 'RTT', 'Perda', 'Upload estimado', 'Mic enviando', 'Tela enviada', 'Tela recebida', 'Reinícios'],
        peers.map(p => [
          p.user, p.version || '-', `${p.connection} (ICE ${p.ice}, sinalização ${p.signaling})`, p.path || '-',
          p.rttMs != null ? `${p.rttMs} ms` : '-', p.lossPct != null ? `${p.lossPct}%` : '-',
          p.uploadEstimateKbps != null ? `${p.uploadEstimateKbps} kbps` : '-',
          p.micSending ? 'sim' : 'NÃO', p.screenOut || '-', p.screenIn || '-', p.restarts
        ])
      );
    }

    if (mainLog.length) {
      lines.push('## Avisos e erros do processo principal');
      lines.push('```');
      mainLog.slice(-50).forEach(e => lines.push(`${Diagnostics.time(e.t, true)} ${e.level} ${Diagnostics.mask(e.message)}`));
      lines.push('```');
      lines.push('');
    }

    const recent = this.samples.slice(-DIAG_REPORT_RECENT_SAMPLES);
    if (recent.length) {
      lines.push(`## Amostras recentes (últimas ${recent.length}, uma a cada ~10 s)`);
      lines.push('```');
      recent.forEach((sample) => {
        const pc = sample.pc ? `CPU ${fmt(sample.pc.cpu)}% RAM ${fmt(sample.pc.ram)}% GPU ${fmt(sample.pc.gpu)}%` : 'PC -';
        const peerText = sample.peers.map((peer) => {
          const m = peer.m || {};
          const parts = [`${peer.user}: ${peer.connection}`, `rtt ${fmt(m.rttMs)}`];
          if (m.screenOut) parts.push(m.screenOut.paused ? 'envio pausado' : `envio ${m.screenOut.height}p@${m.screenOut.fps} ${m.screenOut.limitedBy}${m.screenOut.floor ? ' piso' : ''}`);
          if (m.screenIn) parts.push(`recebe ${m.screenIn.height}p@${m.screenIn.fps} travadas ${m.screenIn.freezeCount}`);
          return parts.join(' ');
        }).join(' | ');
        lines.push(`${Diagnostics.time(sample.t)} ${pc} || ${Diagnostics.mask(peerText)}`);
      });
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
