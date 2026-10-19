// Read-only recovery of public styles / selected call JS from Chromium's cache.
// Format references: Chromium net/disk_cache/blockfile/{addr,disk_format,
// disk_format_base}.h. No response headers or non-asset entries are exported.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const [cache, output, mode] = process.argv.slice(2);
if (mode && !['--call-code', '--chat-code', '--markdown-code', '--timestamp-code'].includes(mode)) throw new Error('Unknown recovery mode');
if (!cache || !output || fs.existsSync(output)) throw new Error('Supply cache and a new output directory');
const relativeOutput = path.relative(path.resolve(cache), path.resolve(output));
if (!relativeOutput || (!relativeOutput.startsWith(`..${path.sep}`) && relativeOutput !== '..' && !path.isAbsolute(relativeOutput)))
  throw new Error('Output must be outside the source cache');
const files = new Map();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function file(name) {
  if (!files.has(name)) files.set(name, fs.readFileSync(path.join(cache, name)));
  return files.get(name);
}
function read(address, size) {
  if (!(address >>> 31) || size < 0 || size > 20000000) throw new Error('Invalid address/size');
  const type = (address >>> 28) & 7;
  if (type === 0) {
    const body = file(`f_${(address & 0xfffffff).toString(16).padStart(6, '0')}`);
    if (size > body.length) throw new Error('Truncated external body');
    return body.subarray(0, size);
  }
  const unit = ({1:36, 2:256, 3:1024, 4:4096})[type];
  const body = file(`data_${(address >>> 16) & 255}`);
  if (!unit || body.readUInt32LE(0) !== 0xc104cac3 || body.readInt32LE(12) !== unit ||
      size > (((address >>> 24) & 3) + 1) * unit) throw new Error('Invalid block header/extent');
  const start = 8192 + (address & 0xffff) * unit;
  if (start + size > body.length) throw new Error('Truncated block');
  return body.subarray(start, start + size);
}
function decode(body) {
  for (const [encoding, method] of [['brotli', zlib.brotliDecompressSync], ['gzip', zlib.gunzipSync]]) {
    try { return {encoding, bytes:method(body, {maxOutputLength:30000000})}; } catch {}
  }
  return {encoding:'identity', bytes:body};
}
const entries = file('data_1');
if (entries.readUInt32LE(0) !== 0xc104cac3 || entries.readInt32LE(12) !== 256) throw new Error('Unsupported entry storage');
fs.mkdirSync(output, {recursive:true});
const assets = [], failures = [], skipped = [];
for (let start = 8192; start + 256 <= entries.length; start += 256) {
  if (entries.readInt32LE(start + 20) !== 0) continue;
  const length = entries.readInt32LE(start + 32);
  if (length <= 0 || length > 1023) continue;
  let key;
  try {
    const longKey = entries.readUInt32LE(start + 36);
    key = longKey ? read(longKey, length).toString('utf8') : entries.subarray(start + 96, start + 96 + length).toString('utf8');
  } catch { continue; }
  const match = key.match(mode
    ? /https:\/\/discord\.com\/assets\/[A-Za-z0-9._-]+\.js$/
    : /https:\/\/discord\.com\/assets\/[A-Za-z0-9._-]+\.css$/);
  if (!match) continue;
  const url = match[0];
  try {
    const compressed = read(entries.readUInt32LE(start + 60), entries.readInt32LE(start + 44));
    const decoded = decode(compressed);
    const text = decoded.bytes.toString('utf8');
    if (mode === '--call-code' && !/__2f4f7|__90dc5|videoGrid|toggleFullScreen|\b(?:584841|195500|804273|517689)\b/.test(text)) continue;
    if (mode === '--chat-code' && !/__5126c|_c19a55|\b(?:13673|318626|58703)\b/.test(text)) continue;
    if (mode === '--timestamp-code' && !/\b536637\(/.test(text)) continue;
    if (mode === '--markdown-code' && !/\b(?:478676|999915|694403)\b/.test(text)) continue;
    if (['--chat-code','--markdown-code', '--timestamp-code'].includes(mode) && decoded.bytes.length > 2000000) {
      skipped.push({url, bytes:decoded.bytes.length, reason:`Large bootstrap excluded from focused ${mode} pass`}); continue;
    }
    if (!text.includes('{')) throw new Error('Not source text');
    const name = path.basename(new URL(url).pathname);
    fs.writeFileSync(path.join(output, name), decoded.bytes, {flag:'wx'});
    assets.push({url, name, entryOffset:start, compressedSha256:hash(compressed),
      sha256:hash(decoded.bytes), bytes:decoded.bytes.length, encoding:decoded.encoding});
  } catch (error) { failures.push({url, error:error.message}); }
}
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({
  cache, mode:mode || 'styles', assets, failures, skipped, sourceFiles:[...files].map(([name, bytes]) => ({name, sha256:hash(bytes)})),
  limitations:['Scan of entry blocks, not index traversal; stale entries may be present.',
    'Cache is read live; no atomic snapshot or runtime layout is established.']
}, null, 2));
console.log(JSON.stringify({recovered:assets.length, failed:failures.length, output}));
