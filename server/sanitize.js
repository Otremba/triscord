/**
 * Input validation/sanitization for anything a client sends us. Socket.io
 * payloads come straight from user-controlled clients (including modified
 * ones talking to the socket directly, bypassing the UI entirely), so nothing
 * here can be trusted until it passes through these.
 */

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_COLOR = '#5865F2';
const MAX_USERNAME_LENGTH = 32;
const MAX_STATUS_LENGTH = 64;
const MAX_MESSAGE_LENGTH = 2000;
const MAX_ROOM_NAME_LENGTH = 48;
const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024; // 3MB decoded image cap

// Soundboard clips: short, small, and only formats Chromium decodes natively
const MAX_SOUND_BYTES = 1024 * 1024;
const MAX_SOUND_NAME_LENGTH = 32;
const MAX_SOUND_EMOJI_LENGTH = 8;
const DEFAULT_SOUND_EMOJI = '\u{1F50A}';
const SOUND_MIME_TYPES = ['audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/wave', 'audio/x-wav', 'audio/webm', 'audio/mp4', 'audio/aac'];
// A sound's id is the SHA-256 of its bytes, so the same file always maps to it
const SOUND_ID_RE = /^[0-9a-f]{64}$/;

// Small, fixed emoji set - keeps reactions from becoming a free-text field
const ALLOWED_REACTIONS = ['\u{1F44D}', '❤️', '\u{1F602}', '\u{1F62E}', '\u{1F622}', '\u{1F389}'];

// Drop ASCII control/formatting characters (codes 0-31 and 127) a hostile
// client could smuggle in. Written as a codepoint filter rather than a regex
// so the source never has to carry literal control bytes.
function stripControlChars(str) {
  let out = '';
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code >= 32 && code !== 127) out += ch;
  }
  return out;
}

function sanitizeUsername(name) {
  if (typeof name !== 'string') return 'Anônimo';
  const cleaned = stripControlChars(name).trim().slice(0, MAX_USERNAME_LENGTH);
  return cleaned || 'Anônimo';
}

function sanitizeColor(color) {
  return typeof color === 'string' && HEX_COLOR_RE.test(color) ? color : DEFAULT_COLOR;
}

function sanitizeStatus(status) {
  if (typeof status !== 'string') return '';
  return stripControlChars(status).trim().slice(0, MAX_STATUS_LENGTH);
}

function sanitizeMessageText(text) {
  if (typeof text !== 'string') return '';
  return text.trim().slice(0, MAX_MESSAGE_LENGTH);
}

function sanitizeRoomName(name) {
  if (typeof name !== 'string') return '';
  return stripControlChars(name).trim().slice(0, MAX_ROOM_NAME_LENGTH);
}

// Only ever a plain 'data:image/...;base64,...' string under the size cap -
// never trust it enough to write to disk or treat as a URL to fetch.
function sanitizeAttachment(attachment) {
  if (!attachment || typeof attachment !== 'object') return null;
  const { dataUrl, name } = attachment;
  if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpeg|jpg|gif|webp);base64,/.test(dataUrl)) return null;
  if (dataUrl.length > MAX_ATTACHMENT_BYTES * 1.4) return null; // base64 overhead
  return {
    type: 'image',
    dataUrl,
    name: typeof name === 'string' ? name.slice(0, 120) : 'imagem'
  };
}

// Whitelist of fields a client may ever change about itself via
// user-state-change; anything else (userId, isOwner, socketId, ...) is
// dropped so one peer can never spoof another's identity or role.
const USER_STATE_FIELDS = {
  isMuted: (v) => typeof v === 'boolean',
  isDeafened: (v) => typeof v === 'boolean',
  isCameraOn: (v) => typeof v === 'boolean',
  isScreenSharing: (v) => typeof v === 'boolean',
  isSpeaking: (v) => typeof v === 'boolean',
  username: () => true,
  avatar: () => true,
  status: () => true
};

function sanitizeUserStateUpdate(update) {
  if (!update || typeof update !== 'object') return {};
  const clean = {};
  for (const key of Object.keys(USER_STATE_FIELDS)) {
    if (!(key in update)) continue;
    if (!USER_STATE_FIELDS[key](update[key])) continue;
    if (key === 'username') clean.username = sanitizeUsername(update.username);
    else if (key === 'avatar') clean.avatar = sanitizeColor(update.avatar);
    else if (key === 'status') clean.status = sanitizeStatus(update.status);
    else clean[key] = update[key];
  }
  return clean;
}

function sanitizeSoundId(id) {
  return typeof id === 'string' && SOUND_ID_RE.test(id) ? id : null;
}

// Name and emoji are only ever rendered as text, but keep them short and clean
function sanitizeSoundMeta(meta = {}) {
  const name = typeof meta.name === 'string'
    ? stripControlChars(meta.name).trim().slice(0, MAX_SOUND_NAME_LENGTH)
    : '';
  const emoji = typeof meta.emoji === 'string'
    ? Array.from(stripControlChars(meta.emoji).trim()).slice(0, MAX_SOUND_EMOJI_LENGTH).join('')
    : '';
  return { name: name || 'Som', emoji: emoji || DEFAULT_SOUND_EMOJI };
}

// The audio bytes as a Buffer, or null when they are not acceptable
function sanitizeSoundData(data, mime) {
  if (!SOUND_MIME_TYPES.includes(mime)) return null;
  let buffer = null;
  if (Buffer.isBuffer(data)) buffer = data;
  else if (data instanceof ArrayBuffer) buffer = Buffer.from(data);
  if (!buffer || buffer.length === 0 || buffer.length > MAX_SOUND_BYTES) return null;
  return buffer;
}

module.exports = {
  HEX_COLOR_RE,
  DEFAULT_COLOR,
  MAX_USERNAME_LENGTH,
  MAX_STATUS_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_ATTACHMENT_BYTES,
  MAX_SOUND_BYTES,
  SOUND_MIME_TYPES,
  ALLOWED_REACTIONS,
  sanitizeUsername,
  sanitizeColor,
  sanitizeStatus,
  sanitizeMessageText,
  sanitizeRoomName,
  sanitizeAttachment,
  sanitizeUserStateUpdate,
  sanitizeSoundId,
  sanitizeSoundMeta,
  sanitizeSoundData
};
