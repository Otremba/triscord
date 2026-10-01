/**
 * The shared soundboard library: one catalog of sounds for everyone on the
 * server, whatever room they are in.
 *
 * The server runs on a host that forgets everything on restart, so the
 * library is really kept by the clients: every app stores a full copy and
 * syncs it back on connect. The server only merges those copies and keeps the
 * audio bytes it has seen in memory (bounded), asking clients for any it lost.
 *
 * Entries merge last-writer-wins on updatedAt, stamped with the server's
 * clock so a client with a skewed clock cannot win every edit. A deleted sound
 * stays as a tombstone (deleted: true, no audio) so an app that was offline
 * cannot bring it back on its next sync.
 */

const crypto = require('crypto');
const { sanitizeSoundId, sanitizeSoundMeta, sanitizeSoundData, sanitizeUsername, SOUND_MIME_TYPES } = require('./sanitize');

const MAX_ACTIVE_SOUNDS = 200;
const MAX_TOMBSTONES = 1000;
const MAX_CLIP_BYTES = 80 * 1024 * 1024;

class SoundLibrary {
  constructor({ maxActive = MAX_ACTIVE_SOUNDS, maxTombstones = MAX_TOMBSTONES, maxClipBytes = MAX_CLIP_BYTES } = {}) {
    this.maxActive = maxActive;
    this.maxTombstones = maxTombstones;
    this.maxClipBytes = maxClipBytes;
    this.entries = new Map(); // id -> entry (metadata only)
    // id -> { mime, data }, in least-recently-used order
    this.clips = new Map();
    this.clipBytes = 0;
  }

  /**
   * Validate an entry coming from a client. updatedAt is clamped to the
   * server's clock; null when the entry is unusable.
   */
  static sanitizeEntry(raw, now = Date.now()) {
    if (!raw || typeof raw !== 'object') return null;
    const id = sanitizeSoundId(raw.id);
    if (!id) return null;

    const { name, emoji } = sanitizeSoundMeta(raw);
    const mime = SOUND_MIME_TYPES.includes(raw.mime) ? raw.mime : null;
    const time = value => (Number.isFinite(value) && value > 0 ? Math.min(value, now) : now);
    const deleted = raw.deleted === true;
    if (!deleted && !mime) return null;

    return {
      id,
      name,
      emoji,
      mime,
      addedBy: sanitizeUsername(raw.addedBy),
      addedAt: time(raw.addedAt),
      updatedAt: time(raw.updatedAt),
      deleted
    };
  }

  static newer(incoming, current) {
    if (!current) return true;
    if (incoming.updatedAt !== current.updatedAt) return incoming.updatedAt > current.updatedAt;
    // Same instant: a deletion wins, so two replicas always agree
    return incoming.deleted && !current.deleted;
  }

  activeCount() {
    let count = 0;
    this.entries.forEach(e => { if (!e.deleted) count++; });
    return count;
  }

  /**
   * Merge one (already sanitized) entry. Returns the stored entry when it
   * changed the library, null when it lost or was refused.
   */
  merge(entry) {
    const current = this.entries.get(entry.id);
    if (!SoundLibrary.newer(entry, current)) return null;

    const becomesActive = !entry.deleted && (!current || current.deleted);
    if (becomesActive && this.activeCount() >= this.maxActive) return null;

    // Keep who added it and when, whoever renames it later
    const stored = current
      ? { ...entry, addedBy: current.addedBy, addedAt: current.addedAt, mime: entry.mime || current.mime }
      : entry;
    this.entries.set(entry.id, stored);

    if (stored.deleted) {
      this.dropClip(stored.id);
      this.pruneTombstones();
    }
    return stored;
  }

  pruneTombstones() {
    const tombstones = Array.from(this.entries.values()).filter(e => e.deleted);
    if (tombstones.length <= this.maxTombstones) return;
    tombstones
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, tombstones.length - this.maxTombstones)
      .forEach(e => this.entries.delete(e.id));
  }

  snapshot() {
    return Array.from(this.entries.values());
  }

  isActive(id) {
    const entry = this.entries.get(id);
    return !!entry && !entry.deleted;
  }

  // ---- Audio bytes ----

  /**
   * Store the audio for an id. The id must be the SHA-256 of the bytes, or a
   * client could plant different audio under an id others will play.
   * Returns null on success or an error code.
   */
  storeClip(id, mime, rawData) {
    const data = sanitizeSoundData(rawData, mime);
    if (!data) return 'invalid-sound';
    if (crypto.createHash('sha256').update(data).digest('hex') !== id) return 'hash-mismatch';
    if (this.clips.has(id)) {
      this.touchClip(id);
      return null;
    }

    this.clips.set(id, { mime, data });
    this.clipBytes += data.length;
    // Evicted audio is not lost: clients still hold it and resend on request
    while (this.clipBytes > this.maxClipBytes && this.clips.size > 1) {
      const [oldestId, oldest] = this.clips.entries().next().value;
      this.clips.delete(oldestId);
      this.clipBytes -= oldest.data.length;
    }
    return null;
  }

  getClip(id) {
    const clip = this.clips.get(id);
    if (clip) this.touchClip(id);
    return clip || null;
  }

  touchClip(id) {
    const clip = this.clips.get(id);
    this.clips.delete(id);
    this.clips.set(id, clip);
  }

  dropClip(id) {
    const clip = this.clips.get(id);
    if (!clip) return;
    this.clips.delete(id);
    this.clipBytes -= clip.data.length;
  }

  /** Active sounds whose audio the server lacks, out of the ids a client holds. */
  missingClips(idsWithData) {
    return idsWithData.filter(id => this.isActive(id) && !this.clips.has(id));
  }
}

module.exports = { SoundLibrary, MAX_ACTIVE_SOUNDS, MAX_CLIP_BYTES };
