// Small profile assets live in the existing D1 database. No new storage
// subscription is required. Bytes are preserved, including animated GIFs.
export const MEDIA_LIMITS = { avatar: 512 * 1024, banner: 1024 * 1024 };
const STORAGE_LIMIT = 64 * 1024 * 1024;
const MAX_DIMENSION = 4096;
const MAX_FRAME_PIXELS = 100_000_000;
const json = (data, status) => Response.json(data, { status });

function dimensions(width, height) {
  return width > 0 && height > 0 && width <= MAX_DIMENSION && height <= MAX_DIMENSION;
}

// Check the container, dimensions and boundaries rather than trusting the
// client's filename or MIME. This is not a pixel decoder or a transcoder.
export function inspectImage(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (start, length) => String.fromCharCode(...bytes.subarray(start, start + length));
  if (bytes.length >= 33 && ascii(0, 8) === '\x89PNG\r\n\x1a\n') {
    if (view.getUint32(8) !== 13 || ascii(12, 4) !== 'IHDR') return null;
    const width = view.getUint32(16), height = view.getUint32(20);
    if (!dimensions(width, height)) return null;
    let offset = 8, hasData = false;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset), type = ascii(offset + 4, 4);
      if (length > bytes.length - offset - 12) return null;
      if (type === 'acTL') return null; // APNG needs its own animation budget.
      if (type === 'IDAT' && length > 0) hasData = true;
      offset += length + 12;
      if (type === 'IEND') return length === 0 && hasData && offset === bytes.length
        ? { mime: 'image/png', width, height, animated: false } : null;
    }
    return null;
  }
  if (bytes.length >= 14 && ['GIF87a', 'GIF89a'].includes(ascii(0, 6))) {
    const width = view.getUint16(6, true), height = view.getUint16(8, true);
    if (!dimensions(width, height)) return null;
    let offset = 13 + ((bytes[10] & 128) ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0);
    let frames = 0, pixels = 0;
    const skipBlocks = () => {
      while (offset < bytes.length) {
        const length = bytes[offset++];
        if (length === 0) return true;
        offset += length;
        if (offset > bytes.length) return false;
      }
      return false;
    };
    while (offset < bytes.length) {
      const marker = bytes[offset++];
      if (marker === 0x3b) return frames > 0 && offset === bytes.length
        ? { mime: 'image/gif', width, height, animated: frames > 1 } : null;
      if (marker === 0x21) {
        if (offset >= bytes.length) return null;
        offset++; // extension label
        if (!skipBlocks()) return null;
      } else if (marker === 0x2c) {
        if (offset + 9 > bytes.length) return null;
        const left = view.getUint16(offset, true), top = view.getUint16(offset + 2, true);
        const frameWidth = view.getUint16(offset + 4, true), frameHeight = view.getUint16(offset + 6, true);
        if (!dimensions(frameWidth, frameHeight) || left + frameWidth > width || top + frameHeight > height) return null;
        pixels += width * height;
        if (++frames > 200 || pixels > MAX_FRAME_PIXELS) return null;
        const packed = bytes[offset + 8];
        offset += 9 + ((packed & 128) ? 3 * (1 << ((packed & 7) + 1)) : 0);
        if (offset >= bytes.length || bytes[offset] < 2 || bytes[offset] > 8) return null;
        offset++; // LZW minimum code size
        if (!skipBlocks()) return null;
      } else return null;
    }
    return null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
      bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) {
    let offset = 2, size = null;
    while (offset + 1 < bytes.length) {
      if (bytes[offset++] !== 0xff) return null;
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (offset + 2 > bytes.length) return null;
      const length = view.getUint16(offset);
      if (length < 2 || length > bytes.length - offset) return null;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8) return null;
        const height = view.getUint16(offset + 3), width = view.getUint16(offset + 5);
        if (!dimensions(width, height)) return null;
        size = { mime: 'image/jpeg', width, height, animated: false };
      }
      // A scan with image data must follow the frame header.
      if (marker === 0xda) return size && offset + length < bytes.length - 2 ? size : null;
      offset += length;
    }
  }
  return null;
}

async function readBounded(request, limit) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function uploadMedia(request, env, account, kind) {
  let bytes;
  try { bytes = await readBounded(request, MEDIA_LIMITS[kind]); }
  catch { return json({ error: 'invalid_body' }, 400); }
  if (!bytes) return json({ error: 'media_too_large', max_bytes: MEDIA_LIMITS[kind] }, 413);
  const image = inspectImage(bytes);
  const mime = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!image || mime !== image.mime) return json({ error: 'unsupported_media' }, 415);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  const path = `/media/${encodeURIComponent(account.id)}/${kind}/${hash}`;
  const mediaUrl = new URL(path, request.url).href;
  const column = kind === 'avatar' ? 'avatar_url' : 'banner_url';
  const now = Date.now();
  // Conditional upsert and account update share one transaction. The sum is
  // over small metadata rows; at most two assets per account are retained.
  // SQLite serializes writes, so simultaneous uploads cannot exceed the cap.
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO profile_media(account_id,kind,hash,mime,size,data,updated_at)
      SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE
        (SELECT COALESCE(SUM(size),0) FROM profile_media) -
        COALESCE((SELECT size FROM profile_media WHERE account_id=?1 AND kind=?2),0) + ?5 <= ?8
      ON CONFLICT(account_id,kind) DO UPDATE SET hash=excluded.hash,mime=excluded.mime,
        size=excluded.size,data=excluded.data,updated_at=excluded.updated_at`)
      .bind(account.id, kind, hash, image.mime, bytes.length, bytes.buffer, now, STORAGE_LIMIT),
    env.DB.prepare(`UPDATE accounts SET ${column}=?1, ${kind === 'avatar' ? 'avatar_custom=1,' : ''} updated_at=?2
      WHERE id=?3 AND EXISTS(SELECT 1 FROM profile_media WHERE account_id=?3 AND kind=?4 AND hash=?5)`)
      .bind(mediaUrl, now, account.id, kind, hash)
  ]);
  if (!result[0].meta.changes) return json({ error: 'media_storage_full' }, 507);
  return { media: { url: mediaUrl, hash, size: bytes.length, ...image },
    account: { ...account, [column]: mediaUrl } };
}

export async function deleteMedia(env, account, kind) {
  const column = kind === 'avatar' ? 'avatar_url' : 'banner_url';
  await env.DB.batch([
    env.DB.prepare('DELETE FROM profile_media WHERE account_id=? AND kind=?').bind(account.id, kind),
    env.DB.prepare(`UPDATE accounts SET ${column}=NULL, ${kind === 'avatar' ? 'avatar_custom=0,' : ''} updated_at=? WHERE id=?`)
      .bind(Date.now(), account.id)
  ]);
  return { ...account, [column]: null };
}

export async function serveMedia(request, env, match) {
  let accountId;
  try { accountId = decodeURIComponent(match[1]); } catch { return json({ error: 'not_found' }, 404); }
  const row = await env.DB.prepare('SELECT hash,mime,size,data FROM profile_media WHERE account_id=? AND kind=? AND hash=?')
    .bind(accountId, match[2], match[3]).first();
  if (!row) return json({ error: 'not_found' }, 404);
  const headers = {
    'Content-Type': row.mime, 'Content-Length': String(row.size),
    'Cache-Control': 'public, max-age=300', ETag: `"${row.hash}"`,
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox"
  };
  if (request.headers.get('if-none-match') === headers.ETag) {
    delete headers['Content-Length'];
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === 'HEAD' ? null : new Uint8Array(row.data), { headers });
}
