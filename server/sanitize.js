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

module.exports = {
  HEX_COLOR_RE,
  DEFAULT_COLOR,
  MAX_USERNAME_LENGTH,
  MAX_STATUS_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_ATTACHMENT_BYTES,
  ALLOWED_REACTIONS,
  sanitizeUsername,
  sanitizeColor,
  sanitizeStatus,
  sanitizeMessageText,
  sanitizeRoomName,
  sanitizeAttachment,
  sanitizeUserStateUpdate
};
