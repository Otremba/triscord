const { test } = require('node:test');
const assert = require('node:assert/strict');
const sanitize = require('./sanitize.cjs');

test('account names and room metadata reject control bytes and stay bounded', () => {
  assert.equal(sanitize.sanitizeUsername('  Bo\u0000b\u007f  '), 'Bob');
  for (const value of [null, 42, {}, '   ']) assert.equal(sanitize.sanitizeUsername(value), 'Anônimo');
  assert.equal(sanitize.sanitizeUsername('a'.repeat(100)).length, 32);
  assert.equal(sanitize.sanitizeStatus(' \u001bBusy\n '), 'Busy');
  assert.equal(sanitize.sanitizeStatus('x'.repeat(100)).length, 64);
  assert.equal(sanitize.sanitizeRoomName(' \u0000General\t '), 'General');
  assert.equal(sanitize.sanitizeRoomName('x'.repeat(100)).length, 48);
});

test('untrusted ids, style values and chat text keep their protocol limits', () => {
  assert.equal(sanitize.sanitizeUserId('account-1_2'), 'account-1_2');
  for (const value of ['', 'a/b', '<script>', 'x'.repeat(65), {}, null]) assert.equal(sanitize.sanitizeUserId(value), null);
  assert.equal(sanitize.sanitizeColor('#abcdef'), '#abcdef');
  for (const value of ['red"><script>', '#fff', null, {}]) assert.equal(sanitize.sanitizeColor(value), sanitize.DEFAULT_COLOR);
  assert.equal(sanitize.sanitizeMessageText('  hello  '), 'hello');
  assert.equal(sanitize.sanitizeMessageText('x'.repeat(3000)).length, 2000);
  assert.equal(sanitize.sanitizeMessageText({}), '');
});

test('state updates cannot claim another account, ownership or server moderation', () => {
  assert.deepEqual(sanitize.sanitizeUserStateUpdate({
    userId:'victim', socketId:'victim', isOwner:true, isServerMuted:false,
    isMuted:false, isDeafened:'false', isScreenSharing:true, status:' ready\u0000 ',
    appVersion:'0.9.47', arbitrary:'ignored',
  }), {isMuted:false, isScreenSharing:true, status:'ready', appVersion:'0.9.47'});
  for (const value of [null, 42, 'invalid']) assert.deepEqual(sanitize.sanitizeUserStateUpdate(value), {});
});
