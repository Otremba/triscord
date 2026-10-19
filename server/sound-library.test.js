const crypto = require('crypto');
const { SoundLibrary } = require('./sound-library');

const NOW = 1_800_000_000_000;

function clipOf(text) {
  const data = Buffer.from(text);
  return { data, id: crypto.createHash('sha256').update(data).digest('hex') };
}

function entry(id, fields = {}) {
  return SoundLibrary.sanitizeEntry({
    id, name: 'Som', emoji: 'x', mime: 'audio/mpeg', addedBy: 'Ana', addedAt: NOW - 1000, updatedAt: NOW - 1000, ...fields
  }, NOW);
}

describe('SoundLibrary', () => {
  test('keeps the most recent edit of a sound, whatever order copies arrive in', () => {
    const lib = new SoundLibrary();
    const { id } = clipOf('a');
    lib.merge(entry(id, { name: 'Novo', updatedAt: NOW - 10 }));
    expect(lib.merge(entry(id, { name: 'Velho', updatedAt: NOW - 500 }))).toBeNull();
    expect(lib.entries.get(id).name).toBe('Novo');
  });

  test('a deletion is not undone by an app that was offline with the old copy', () => {
    const lib = new SoundLibrary();
    const { id } = clipOf('b');
    lib.merge(entry(id));
    lib.merge(entry(id, { deleted: true, updatedAt: NOW - 100 }));
    expect(lib.merge(entry(id, { updatedAt: NOW - 900 }))).toBeNull();
    expect(lib.entries.get(id).deleted).toBe(true);

    // Adding the same file again later does bring it back
    expect(lib.merge(entry(id, { updatedAt: NOW - 1 })).deleted).toBe(false);
  });

  test('a clock in the future cannot win every edit', () => {
    const e = entry(clipOf('c').id, { updatedAt: NOW + 10 * 86400000 });
    expect(e.updatedAt).toBe(NOW);
  });

  test('renames keep who added the sound', () => {
    const lib = new SoundLibrary();
    const { id } = clipOf('d');
    lib.merge(entry(id, { addedBy: 'Ana', addedById: 'user_ana' }));
    lib.merge(entry(id, { name: 'Renomeado', addedBy: 'Bia', addedById: 'user_bia', updatedAt: NOW - 1 }));
    expect(lib.entries.get(id)).toMatchObject({ name: 'Renomeado', addedBy: 'Ana', addedById: 'user_ana' });
  });

  test('keeps a valid uploader id and drops a malformed one', () => {
    const { id } = clipOf('k');
    expect(SoundLibrary.sanitizeEntry(entry(id, { addedById: 'user_abc123' }), NOW).addedById).toBe('user_abc123');
    expect(SoundLibrary.sanitizeEntry(entry(id, { addedById: 'x y<script>' }), NOW).addedById).toBe(null);
    // Sounds from before folders existed have no id
    expect(SoundLibrary.sanitizeEntry(entry(id), NOW).addedById).toBe(null);
  });

  test('refuses new sounds once the library is full, but not edits', () => {
    const lib = new SoundLibrary({ maxActive: 1 });
    const first = clipOf('e1').id;
    lib.merge(entry(first));
    expect(lib.merge(entry(clipOf('e2').id))).toBeNull();
    expect(lib.merge(entry(first, { name: 'Ok', updatedAt: NOW - 1 }))).not.toBeNull();
  });

  test('only stores audio whose id is its hash, and evicts the least recently used', () => {
    const lib = new SoundLibrary({ maxClipBytes: 10 });
    const a = clipOf('aaaaaa');
    const b = clipOf('bbbbbb');
    expect(lib.storeClip(a.id, 'audio/mpeg', b.data)).toBe('hash-mismatch');
    expect(lib.storeClip(a.id, 'text/html', a.data)).toBe('invalid-sound');
    expect(lib.storeClip(a.id, 'audio/mpeg', a.data)).toBeNull();
    expect(lib.storeClip(b.id, 'audio/mpeg', b.data)).toBeNull();
    expect(lib.getClip(a.id)).toBeNull();
    expect(lib.getClip(b.id).data.equals(b.data)).toBe(true);
  });

  test('lists the audio it is missing among what an app holds', () => {
    const lib = new SoundLibrary();
    const kept = clipOf('kept');
    const lost = clipOf('lost');
    const gone = clipOf('gone');
    lib.merge(entry(kept.id));
    lib.merge(entry(lost.id));
    lib.merge(entry(gone.id, { deleted: true }));
    lib.storeClip(kept.id, 'audio/mpeg', kept.data);
    expect(lib.missingClips([kept.id, lost.id, gone.id])).toEqual([lost.id]);
  });
});
