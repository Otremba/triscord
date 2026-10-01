/**
 * Soundboard: short clips anyone in a call can play for everyone in it, from
 * one library shared by everyone on the server.
 *
 * A clip is identified by the SHA-256 of its bytes. The server runs on a host
 * that forgets everything on restart, so the library is kept by the apps:
 * every app stores a full copy (metadata and audio) in IndexedDB, syncs it on
 * connect and downloads whatever it is missing. The server merges the copies
 * (see server/sound-library.js) and asks the apps for any audio it lost.
 *
 * Playing sends only the id; everyone then plays the clip locally, so it never
 * goes through the microphone, RNNoise or the voice codec, and every listener
 * controls its own soundboard volume.
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
// When the server is fetching lost audio back from another app
const SOUNDBOARD_PENDING_RETRIES = 4;
const SOUNDBOARD_PENDING_RETRY_MS = 1500;

/**
 * The local copy of the library: one IndexedDB store of entries
 * { id, name, emoji, mime, addedBy, addedAt, updatedAt, deleted, data }.
 * A deleted sound stays as a tombstone (deleted: true, data: null) so this app
 * never offers it back. Falls back to memory when IndexedDB is unavailable.
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

  /** Every entry, tombstones included. */
  async all() {
    const entries = await this.run('readonly', store => (store ? store.getAll() : null));
    return entries || Array.from(this.memory.values());
  }

  async get(id) {
    const entry = await this.run('readonly', store => (store ? store.get(id) : null));
    return entry || this.memory.get(id) || null;
  }

  async put(entry) {
    this.memory.set(entry.id, entry);
    await this.run('readwrite', store => (store ? store.put(entry) : null));
  }

  async remove(id) {
    this.memory.delete(id);
    await this.run('readwrite', store => (store ? store.delete(id) : null));
  }
}

class SoundboardError extends Error {}

class Soundboard {
  /**
   * @param socket the Socket.IO connection to the signalling server
   * @param options.shouldPlay (event) => boolean, e.g. false while deafened
   * @param options.getUsername () => string, credited on sounds this app adds
   */
  constructor(socket, { shouldPlay = () => true, getUsername = () => '' } = {}) {
    this.socket = socket;
    this.shouldPlay = shouldPlay;
    this.getUsername = getUsername;
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
    this.onLibraryChanged = null; // () — the shared library changed

    this.syncing = false;
    this.syncAgain = false;
    this.downloading = false;

    this.handlers = {
      connect: () => this.sync(),
      'soundboard-played': event => this.handlePlayed(event),
      'soundboard-library-changed': ({ entries } = {}) => this.applyRemote(entries || []),
      'soundboard-need-data': ({ soundId } = {}) => this.resend(soundId)
    };
    Object.entries(this.handlers).forEach(([event, handler]) => socket.on(event, handler));
    if (socket.connected) this.sync();
  }

  static loadNumber(key, fallback) {
    const value = parseInt(localStorage.getItem(key), 10);
    return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : fallback;
  }

  destroy() {
    Object.entries(this.handlers).forEach(([event, handler]) => this.socket.off(event, handler));
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

  // ---- Shared library ----

  /** What travels to the server: everything but the audio. */
  static meta(entry) {
    return {
      id: entry.id,
      name: entry.name,
      emoji: entry.emoji,
      mime: entry.mime,
      addedBy: entry.addedBy,
      addedAt: entry.addedAt,
      // Sounds saved by 1.1.4 have no updatedAt: they count as old edits
      updatedAt: entry.updatedAt || entry.addedAt || 0,
      deleted: !!entry.deleted
    };
  }

  /** Same rule as the server: the latest edit wins, a deletion wins a tie. */
  static newer(incoming, current) {
    if (!current) return true;
    const a = incoming.updatedAt || 0;
    const b = current.updatedAt || current.addedAt || 0;
    if (a !== b) return a > b;
    return !!incoming.deleted && !current.deleted;
  }

  /** The sounds to show: everything not deleted, oldest first. */
  async listSounds() {
    const entries = await this.library.all();
    return entries.filter(e => !e.deleted).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  }

  notifyChanged() {
    if (this.onLibraryChanged) this.onLibraryChanged();
  }

  /**
   * Send this app's copy, take back the merged library, resend the audio the
   * server lost, then download whatever this app is missing.
   */
  async sync() {
    if (this.syncing) {
      this.syncAgain = true;
      return;
    }
    this.syncing = true;
    try {
      const local = await this.library.all();
      const username = this.getUsername();
      const result = await this.request('soundboard-sync', {
        username,
        entries: local.map(e => ({
          ...Soundboard.meta(e),
          // Sounds saved by 1.1.4 have no author: they were this user's own
          addedBy: e.addedBy || username,
          hasData: !!e.data
        }))
      });
      if (!result || !result.ok) return;

      await this.applyRemote(result.entries || [], { download: false });
      for (const id of result.missing || []) await this.resend(id);
      this.downloadMissing();
    } catch (err) {
      console.warn('[Soundboard] Sync failed:', err);
    } finally {
      this.syncing = false;
      if (this.syncAgain) {
        this.syncAgain = false;
        this.sync();
      }
    }
  }

  /** Merge entries from the server into the local copy. */
  async applyRemote(entries, { download = true } = {}) {
    let changed = false;
    for (const remote of entries) {
      const local = await this.library.get(remote.id);
      // A record saved by 1.1.4 (no updatedAt) always takes the server's
      // version, which carries the author and dates
      const legacy = local && !local.updatedAt;
      if (!legacy && !Soundboard.newer(remote, local)) continue;
      const keepData = !remote.deleted && local && local.data ? local.data : null;
      await this.library.put({ ...remote, data: keepData });
      if (remote.deleted) {
        this.clips.delete(remote.id);
        this.decoded.delete(remote.id);
      }
      changed = true;
    }
    if (changed) this.notifyChanged();
    if (download) this.downloadMissing();
  }

  /** Give the server audio it lost, if this app has it. */
  async resend(soundId) {
    const entry = soundId && await this.library.get(soundId);
    if (!entry || entry.deleted || !entry.data) return;
    await this.request('soundboard-upload', {
      soundId: entry.id, mime: entry.mime, data: entry.data, name: entry.name, emoji: entry.emoji,
      username: this.getUsername(), play: false
    });
  }

  /** Download, one at a time, the audio of every sound this app lacks. */
  async downloadMissing() {
    if (this.downloading) return;
    this.downloading = true;
    try {
      const entries = await this.library.all();
      for (const entry of entries) {
        if (entry.deleted || entry.data) continue;
        const clip = await this.fetchClip(entry.id);
        if (!clip) continue;
        const current = await this.library.get(entry.id);
        if (current && !current.deleted) {
          await this.library.put({ ...current, data: clip.data });
          this.notifyChanged();
        }
      }
    } finally {
      this.downloading = false;
    }
  }

  /** The audio of a sound: from memory, the local copy, or the server. */
  async fetchClip(soundId) {
    if (this.clips.has(soundId)) return this.clips.get(soundId);

    const entry = await this.library.get(soundId);
    if (entry && entry.data) {
      const clip = { mime: entry.mime, data: entry.data };
      this.clips.set(soundId, clip);
      return clip;
    }

    for (let attempt = 0; attempt <= SOUNDBOARD_PENDING_RETRIES; attempt++) {
      const fetched = await this.request('soundboard-fetch', { soundId });
      if (fetched && fetched.ok) {
        const clip = { mime: fetched.mime, data: fetched.data };
        this.clips.set(soundId, clip);
        return clip;
      }
      // 'pending': the server asked the other apps for it; anything else is final
      if (!fetched || fetched.error !== 'pending') {
        if (fetched && fetched.error === 'rate-limited') {
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }
        return null;
      }
      await new Promise(r => setTimeout(r, SOUNDBOARD_PENDING_RETRY_MS));
    }
    return null;
  }

  /** Publish an edit (add, rename, delete) and keep the server's version. */
  async publish(entry, data) {
    const result = await this.request('soundboard-upsert', {
      username: this.getUsername(),
      entry: Soundboard.meta(entry),
      ...(data ? { data } : {})
    });
    if (result && result.ok && result.entry) {
      const current = await this.library.get(entry.id);
      const keepData = !result.entry.deleted ? (data || (current && current.data) || null) : null;
      await this.library.put({ ...result.entry, data: keepData });
      this.notifyChanged();
    }
    return result;
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
    const now = Date.now();
    const name = file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, SOUNDBOARD_MAX_NAME_LENGTH) || 'Som';
    const sound = {
      id, name, emoji: SOUNDBOARD_DEFAULT_EMOJI, mime, data,
      addedBy: this.getUsername(), addedAt: now, updatedAt: now, deleted: false
    };

    this.decoded.set(id, buffer);
    this.clips.set(id, { mime, data });
    // Saved locally first: if the server is unreachable, the next sync shares it
    await this.library.put(sound);

    const result = await this.publish(sound, data);
    if (result && result.error === 'library-full') {
      await this.library.remove(id);
      throw new SoundboardError('A biblioteca compartilhada está cheia. Remova algum som antes de adicionar outro.');
    }
    return sound;
  }

  /** Rename or change the emoji, for everyone. */
  async updateSound(sound, changes) {
    const updated = { ...sound, ...changes, updatedAt: Date.now() };
    await this.library.put(updated);
    await this.publish(updated);
    return updated;
  }

  /** Delete for everyone; a tombstone stays so it is not offered back. */
  async deleteSound(sound) {
    const tombstone = { ...Soundboard.meta(sound), deleted: true, updatedAt: Date.now(), data: null };
    await this.library.put(tombstone);
    this.clips.delete(sound.id);
    this.decoded.delete(sound.id);
    await this.publish(tombstone);
  }

  static async hash(data) {
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  }

  // ---- Playback ----

  /** Play for yourself only, to check a clip before sending it to the call. */
  async preview(sound) {
    if (!(await this.fetchClip(sound.id))) throw new SoundboardError('Este som ainda está sendo baixado.');
    await this.playLocally(sound.id);
  }

  /** Play for everyone in the call (including yourself, via the server's echo). */
  async play(sound) {
    const clip = await this.fetchClip(sound.id);
    if (!clip) throw new SoundboardError('Este som ainda está sendo baixado.');
    const meta = { soundId: sound.id, name: sound.name, emoji: sound.emoji };

    let result = await this.request('soundboard-play', meta);
    if (result && result.needData) {
      result = await this.request('soundboard-upload', {
        ...meta, mime: clip.mime, data: clip.data, username: this.getUsername()
      });
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
      if (!(await this.fetchClip(event.soundId))) return;
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
