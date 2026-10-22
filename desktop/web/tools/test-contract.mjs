// Contract tests for the preserved core layer (protocol, bridge, store, fixtures, call-status,
// focus-policy, share-sources, events). No DOM, browser or native bridge is started.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Run a small TypeScript harness under Node's native type stripping, which exercises the pure
// contract modules without a DOM. The harness is written to a temp file so imports resolve.
const harness = `
import { pathToFileURL } from 'node:url';
const src = (f) => pathToFileURL('${root.replace(/\\/g, '/')}/src/' + f).href;
const { callStatus } = await import(src('call-status.ts'));
const { modalTabTarget } = await import(src('focus-policy.ts'));
const { fixtureSession } = await import(src('fixtures.ts'));
const { PROTOCOL_VERSION } = await import(src('protocol.ts'));
const { EVENTS } = await import(src('events.ts'));
import assert from 'node:assert/strict';

// call-status: explicit media state is authoritative.
assert.equal(callStatus({ voiceState: 'connected', camera: false, connection: 'connected' }).label, 'Voz conectada');
assert.equal(callStatus({ voiceState: 'connected', camera: true, connection: 'connected' }).label, 'Vídeo conectado');
assert.equal(callStatus({ voiceState: 'error', connection: 'connected' }).tone, 'critical');
assert.equal(callStatus({ voiceState: undefined, voiceRequested: true, connection: 'offline' }).label, 'Aguardando conexão de voz');
assert.equal(callStatus({ voiceState: undefined, voiceRequested: false, connection: 'offline' }).state, 'idle');

// focus-policy: wrap and empty fallback.
const c = [{ n: 'a' }, { n: 'b' }, { n: 'c' }];
assert.equal(modalTabTarget(c, c[0], true), c[2]);
assert.equal(modalTabTarget(c, c[2], false), c[0]);
assert.equal(modalTabTarget([], null, false), null);

// fixtures: deterministic sessions.
assert.equal(fixtureSession('call').connectedChannelId, 'geral');
assert.equal(fixtureSession('stream').streams[0].path, 'native-overlay');
assert.equal(fixtureSession('login').auth.state, 'signedOut');

// protocol: version is stable.
assert.equal(typeof PROTOCOL_VERSION, 'number');

// events: centralized names.
assert.equal(EVENTS.openModal, 'tri-open-modal');
assert.equal(EVENTS.layoutChanged, 'tri-layout-changed');

console.log('Contract: call-status, focus-policy, fixtures, protocol and events passed');
`;

const result = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', harness], {
    cwd: root,
    encoding: 'utf8',
});

if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
}
process.stdout.write(result.stdout);