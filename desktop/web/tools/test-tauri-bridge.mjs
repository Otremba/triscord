// Headless IPC contract tests. No browser, window, device, production API or installed settings.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/bridge.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm' });
globalThis.location = { search: '' };
const notices = [];
globalThis.dispatchEvent = event => { notices.push(event.detail); return true; };
const { TauriBridge, createBridge } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString('base64')}`);
const listeners = new Map();
const registrations = [];
const calls = [];
const host = {
  event: { listen: (name, callback) => { listeners.set(name, callback); return new Promise(resolve => registrations.push(() => resolve(() => {}))); } },
  core: { invoke: async (name, args) => { calls.push({ name, args }); return { code: 'invite' }; } },
};
const bridge = new TauriBridge(host);
const messages = [];
bridge.onMessage(message => messages.push(message));
const request = bridge.request({ name: 'requestSnapshot' });
await Promise.resolve();
assert.equal(calls.length, 0, 'invoke must wait for event registration');
registrations.forEach(resolve => resolve());
assert.deepEqual(await request, { code: 'invite' });
assert.equal(calls.length, 1);
listeners.get('triscord-core')({ payload: { v: 1, type: 'snapshot', revision: 1, session: {} } });
assert.equal(messages.length, 1);
host.core.invoke = async () => { throw { code: 'unavailable', message: 'Recurso indisponível' }; };
await assert.rejects(bridge.request({ name: 'setCamera', on: true }), /Recurso indisponível/);
bridge.send({ name: 'setCamera', on: true });
await new Promise(resolve => setImmediate(resolve));
assert.deepEqual(notices, ['Recurso indisponível']);
globalThis.window = { __TAURI__: host, chrome: { webview: {} } };
assert.ok(createBridge(() => { throw new Error('must not fall back to fixture'); }) instanceof TauriBridge);
console.log('Tauri IPC: listener ordering, events, errors and fixture isolation passed');
