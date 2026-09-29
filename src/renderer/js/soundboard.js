/**
 * Soundboard: short clips anyone in a call can play for everyone in it.
 *
 * A clip is identified by the SHA-256 of its bytes. Each person's own library
 * lives in IndexedDB on their device. Playing sends only the id to the server;
 * the bytes go up once per room (when the server answers needData) and each
 * listener fetches them once. Everyone then plays the clip locally, so it
 * never goes through the microphone, RNNoise or the voice codec, and every
 * listener controls its own soundboard volume.
 */

const SOUNDBOARD_MAX_BYTES = 1024 * 1024;
const SOUNDBOARD_MAX_SECONDS = 10;
const SOUNDBOARD_MAX_NAME_LENGTH = 32;
const SOUNDBOARD_DEFAULT_EMOJI = '\u{1F50A}';
// Must match SOUND_MIME_TYPES in server/sanitize.js
const SOUNDBOARD_MIME_TYPES = ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/wave', 'audio/x-wav', 'audio/webm', 'audio/mp4', 'audio/aac'];
const SOUNDBOARD_MIME_BY_EXTENSION = {
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav',
  webm: 'audio/webm', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac'
};
const SOUNDBOARD_REQUEST_TIMEOUT_MS = 10000;

/**
 * The local library: one IndexedDB store of { id, name, emoji, mime, data,
 * addedAt }. Falls back to memory when IndexedDB is unavailable, so the
 * soundboard still works for the session.
 */
class SoundLibrary {
  constructor() {
    this.memory = new Map();
    this.dbPromise = this.open().catch((err) => {
      console.warn('[Soundboard] IndexedDB unavailable, keeping sounds in memory only:', err);
      return null;
    });
  }

  open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('triscord-soundboard', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('sounds', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async run(mode, fn) {
    const db = await this.dbPromise;
    if (!db) return fn(null);
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sounds', mode);
      const request = fn(tx.objectStore('sounds'));
      tx.oncomplete = () => resolve(request ? request.result : undefined);
      tx.onerror = () => reject(tx.error);
    });
  }

  async list() {
    const sounds = await this.run('readonly', store => (store ? store.getAll() : null));
    return (sounds || Array.from(this.memory.values())).sort((a, b) => a.addedAt - b.addedAt);
  }

  async put(sound) {
    this.memory.set(sound.id, sound);
    await this.run('readwrite', store => (store ? store.put(sound) : null));
  }

  async delete(id) {
    this.memory.delete(id);
    await this.run('readwrite', store => (store ? store.delete(id) : null));
  }
}

class SoundboardError extends Error {}

class Soundboard {
  /**
   * @param socket the Socket.IO connection to the signalling server
   * @param options.shouldPlay (event) => boolean, e.g. false while deafened
   */
  constructor(socket, { shouldPlay = () => true } = {}) {
    this.socket = socket;
    this.shouldPlay = shouldPlay;
    this.library = new SoundLibrary();

    // soundId -> { mime, data } and soundId -> decoded AudioBuffer
    this.clips = new Map();
    this.decoded = new Map();
    this.playing = new Set();

    this.context = null;
    this.output = null;
    this.volume = Soundboard.loadNumber('triscord_soundboard_volume', 70);
    this.muted = localStorage.getItem('triscord_soundboard_muted') === '1';

    this.onPlayed = null; // (event) — someone's clip started playing here

    this.handlePlayed = this.handlePlayed.bind(this);
    socket.on('soundboard-played', this.handlePlayed);
  }

  static loadNumber(key, fallback) {
    const value = parseInt(localStorage.getItem(key), 10);
    return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : fallback;
  }

  destroy() {
    this.socket.off('soundboard-played', this.handlePlayed);
    this.stopAll();
    if (this.context) this.context.close().catch(() => {});
    this.context = null;
  }

  ensureContext() {
    if (!this.context) {
      this.context = new AudioContext();
      this.output = this.context.createGain();
      this.output.gain.value = this.volume / 100;
      this.output.connect(this.context.destination);
    }
    if (this.context.state === 'suspended') this.context.resume().catch(() => {});
    return this.context;
  }

  setVolume(volume) {
    this.volume = Math.min(100, Math.max(0, volume));
    localStorage.setItem('triscord_soundboard_volume', String(this.volume));
    if (this.output) this.output.gain.setTargetAtTime(this.volume / 100, this.context.currentTime, 0.02);
  }

  setMuted(muted) {
    this.muted = muted;
    localStorage.setItem('triscord_soundboard_muted', muted ? '1' : '0');
    if (muted) this.stopAll();
  }

  stopAll() {
    this.playing.forEach((source) => {
      try { source.stop(); } catch (e) {}
    });
    this.playing.clear();
  }

  // ---- Library ----

  listSounds() {
    return this.library.list();
  }

  async importFile(file) {
    const extension = (file.name.split('.').pop() || '').toLowerCase();
    const mime = SOUNDBOARD_MIME_TYPES.includes(file.type) ? file.type : SOUNDBOARD_MIME_BY_EXTENSION[extension];
    if (!mime) throw new SoundboardError(`"${file.name}" não é um formato suportado (use MP3, OGG, WAV, M4A ou WEBM).`);
    if (file.size > SOUNDBOARD_MAX_BYTES) throw new SoundboardError(`"${file.name}" passa de 1 MB.`);

    const data = await file.arrayBuffer();
    let buffer;
    try {
      // decodeAudioData takes ownership of the buffer it is given, so hand it a copy
      buffer = await this.ensureContext().decodeAudioData(data.slice(0));
    } catch (err) {
      throw new SoundboardError(`Não foi possível ler o áudio de "${file.name}".`);
    }
    if (buffer.duration > SOUNDBOARD_MAX_SECONDS + 0.5) {
      throw new SoundboardError(`"${file.name}" tem ${Math.round(buffer.duration)} s; o limite é ${SOUNDBOARD_MAX_SECONDS} s.`);
    }

    const id = await Soundboard.hash(data);
    const name = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, SOUNDBOARD_MAX_NAME_LENGTH) || 'Som';
    const sound = { id, name, emoji: SOUNDBOARD_DEFAULT_EMOJI, mime, data, addedAt: Date.now() };

    this.decoded.set(id, buffer);
    await this.library.put(sound);
    return sound;
  }

  async updateSound(sound, changes) {
    const updated = { ...sound, ...changes };
    await this.library.put(updated);
    return updated;
  }

  deleteSound(sound) {
    return this.library.delete(sound.id);
  }

  static async hash(data) {
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }

  // ---- Playback ----

  /** Play for yourself only, to check a clip before sending it to the call. */
  async preview(sound) {
    this.clips.set(sound.id, { mime: sound.mime, data: sound.data });
    await this.playLocally(sound.id);
  }

  /** Play for everyone in the call (including yourself, via the server's echo). */
  async play(sound) {
    this.clips.set(sound.id, { mime: sound.mime, data: sound.data });
    const meta = { soundId: sound.id, name: sound.name, emoji: sound.emoji };

    let result = await this.request('soundboard-play', meta);
    if (result && result.needData) {
      result = await this.request('soundboard-upload', { ...meta, mime: sound.mime, data: sound.data });
    }
    if (!result || !result.ok) throw new SoundboardError(Soundboard.describeError(result && result.error));
  }

  async request(event, payload) {
    try {
      return await this.socket.timeout(SOUNDBOARD_REQUEST_TIMEOUT_MS).emitWithAck(event, payload);
    } catch (err) {
      return { ok: false, error: 'timeout' };
    }
  }

  static describeError(error) {
    switch (error) {
      case 'rate-limited': return 'Calma! Espere um pouco antes de tocar outro som.';
      case 'invalid-sound': return 'O servidor recusou este arquivo de áudio.';
      case 'timeout': return 'O servidor não respondeu. Verifique a conexão.';
      default: return 'Não foi possível tocar o som.';
    }
  }

  async handlePlayed(event) {
    if (this.muted || !this.shouldPlay(event)) return;

    try {
      if (!this.clips.has(event.soundId)) {
        const fetched = await this.request('soundboard-fetch', { soundId: event.soundId });
        if (!fetched || !fetched.ok) return;
        this.clips.set(event.soundId, { mime: fetched.mime, data: fetched.data });
      }
      if (this.onPlayed) this.onPlayed(event);
      await this.playLocally(event.soundId);
    } catch (err) {
      console.warn('[Soundboard] Could not play a clip:', err);
    }
  }

  async playLocally(soundId) {
    const context = this.ensureContext();
    let buffer = this.decoded.get(soundId);
    if (!buffer) {
      const clip = this.clips.get(soundId);
      if (!clip) return;
      buffer = await context.decodeAudioData(clip.data.slice(0));
      this.decoded.set(soundId, buffer);
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output);
    source.onended = () => this.playing.delete(source);
    this.playing.add(source);
    source.start();
  }
}

window.Soundboard = Soundboard;
window.SoundboardError = SoundboardError;
window.SOUNDBOARD_MAX_NAME_LENGTH = SOUNDBOARD_MAX_NAME_LENGTH;
