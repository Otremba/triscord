import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastControlActivity, controlCloseReport, recordControlClose } from '../src/control_diagnostics.js';
test('valid traffic prevents a false idle timeout even with no automatic pong timestamp', () => {
  const data = { created: 1000, lastActivity: 59000 };
  assert.equal(61000 - lastControlActivity(data, 0), 2000);
  assert.equal(lastControlActivity(data, 60000), 60000);
  assert.equal(lastControlActivity({ created: 1000 }), 1000);
});
test('close report captures the exhausted budget and omits credentials and payloads', () => {
  const data = { created: 1000, lastActivity: 59000, sid: 'socket', room: 'geral', ready: true, rateCount: 41,
    identity: { serverId: 'server-a', sessionHash: 'never-copy', accountId: 'account' }, user: { message: 'never-copy' }, token: 'never-copy' };
  const r = controlCloseReport(data, 1008, 'Control rate limit (commands 41/40)', 61000, 50000);
  assert.equal(r.commandsInWindow, 41); assert.equal(r.activityAgeMs, 2000); assert.equal(r.autoResponseAgeMs, 11000);
  assert.equal(JSON.stringify(r).includes('never-copy'), false);
  assert.equal(controlCloseReport(data, 1000, 'Bearer very-secret-token-value', 61000).reason.includes('very-secret-token-value'), false);
});
test('server close diagnostics are bounded independently of client uploads', async () => {
  let writes = 0;
  const env = { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ n: 12 }), run: async () => { ++writes; } }) }) } };
  await recordControlClose(env, { identity: { accountId: 'account' } }, 1008, 'limit');
  assert.equal(writes, 0);
});
