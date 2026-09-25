import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPluginInventory } from '../plugins.mjs';
import { startServer } from '../server.mjs';

function fixture(t, bundles = ['dsh-example']) {
  const home = mkdtempSync(join(tmpdir(), 'claudia-plugin-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const profile = join(home, 'profiles', 'web');
  mkdirSync(profile, { recursive: true });
  const manifest = join(profile, 'package.json');
  writeFileSync(manifest, JSON.stringify({ dependencies: { yaml: '1' }, dsh: { profile: { bundles } } }));
  const pkg = (name, body) => {
    const dir = join(profile, 'node_modules', name); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.2.3', dsh: { bundle: { patch: './cordis.patch.yml' } }, ...body }));
  };
  return { home, profile, manifest, pkg, get: options => createPluginInventory({ home, hostAnchor: '/missing-host', ...options }) };
}
test('formal bundles only; metadata and Loader projection; no configs exported', t => {
  const f = fixture(t); f.pkg('dsh-example', { config: { password: 'DO_NOT_EXPOSE' } }); f.pkg('yaml');
  const bytes = readFileSync(f.manifest);
  const value = f.get({ getEntries: () => [{ id: 'email', options: { name: 'dsh-example', config: { secret: 'PRIVATE' } }, disabled: false, fiber: { state: 2 } }] })();
  assert.deepEqual(value.packages, [{ name: 'dsh-example', version: '1.2.3', installed: true, enabled: true, phase: 'active' }]);
  assert.equal(value.runtimeAvailable, true); assert.equal(value.available, true);
  assert.ok(!JSON.stringify(value).includes('PRIVATE')); assert.ok(!JSON.stringify(value).includes('DO_NOT_EXPOSE'));
  assert.deepEqual(readFileSync(f.manifest), bytes);
});
test('disabled plugin is installed but not loaded', t => {
  const f = fixture(t); f.pkg('dsh-example');
  const item = f.get({ getEntries: () => [{ options: { name: 'dsh-example' }, disabled: true }] })().packages[0];
  assert.equal(item.installed, true); assert.equal(item.enabled, false); assert.equal(item.phase, null);
});
test('missing metadata is not success', t => {
  const f = fixture(t);
  assert.deepEqual(f.get()().packages[0], { name: 'dsh-example', version: null, installed: false, enabled: null, phase: null });
});
test('missing Loader is unknown, not inactive', t => {
  const f = fixture(t); f.pkg('dsh-example'); const value = f.get()();
  assert.equal(value.runtimeAvailable, false); assert.equal(value.packages[0].phase, null);
});
test('metadata name mismatch and plain dependency are not confirmed bundle', t => {
  const f = fixture(t, ['dsh-example', 'yaml']); f.pkg('dsh-example', { name: 'wrong' }); f.pkg('yaml', { dsh: {} });
  assert.ok(f.get()().packages.every(p => !p.installed));
});
test('duplicates deduplicated; ambiguous runtime stays unknown', t => {
  const f = fixture(t, ['dsh-example', 'dsh-example']); f.pkg('dsh-example');
  const value = f.get({ getEntries: () => Array(2).fill({ options: { name: 'dsh-example' }, fiber: { state: 2 } }) })();
  assert.equal(value.packages.length, 1); assert.equal(value.packages[0].phase, null);
});
test('path escape or broken manifest fail safely without raw errors', t => {
  const f = fixture(t, ['../../.credentials.yaml']);
  const value = f.get()(); assert.equal(value.available, false); assert.deepEqual(value.packages, []);
  writeFileSync(f.manifest, 'PRIVATE-invalid'); assert.ok(!JSON.stringify(f.get()()).includes('PRIVATE'));
});
test('Loader failure preserves installed inventory', t => {
  const f = fixture(t); f.pkg('dsh-example');
  const value = f.get({ getEntries: () => { throw Error('PRIVATE'); } })();
  assert.equal(value.available, true); assert.equal(value.runtimeAvailable, false); assert.equal(value.packages[0].installed, true);
});
test('plugin endpoint read only, lazy, protected by origin, unrelated state unaffected', async t => {
  const f = fixture(t); f.pkg('dsh-example'); let reads = 0;
  const snapshot = f.get();
  const app = await startServer({ dataDir: join(f.home, 'data'), port: 0, getPlugins: () => { reads++; return snapshot(); }, createRuntime: () => ({ status: async () => ({ configured: false }), selection: () => ({}), close: async () => {} }) });
  t.after(() => app.close());
  assert.equal((await fetch(app.url + '/api/state')).status, 200); assert.equal(reads, 0);
  const response = await fetch(app.url + '/api/plugins'); assert.equal(response.status, 200);
  assert.equal((await response.json()).packages.length, 1); assert.equal(reads, 1);
  assert.equal((await fetch(app.url + '/api/plugins', { headers: { Origin: 'https://other.example' } })).status, 403);
  const { csrfToken } = await (await fetch(app.url + '/api/bootstrap')).json();
  assert.equal((await fetch(app.url + '/api/plugins', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Claudia-Token': csrfToken }, body: '{}' })).status, 404);
  assert.equal(reads, 1);
});
test('manual update endpoint requires local CSRF, accepts no options, and delegates once', async t => {
  const f = fixture(t), calls = [];
  const update = { currentVersion: '0.4.2', latestVersion: '0.4.3', updateAvailable: true, relation: 'older', releaseUrl: 'https://github.com/iamhej/dsh-claudia/releases/tag/v0.4.3', checkedAt: '2026-09-26T00:00:00.000Z' };
  const app = await startServer({ dataDir: join(f.home, 'data'), port: 0,
    createRuntime: () => ({ status: async () => ({ configured: false }), selection: () => ({}), close: async () => {} }),
    createServices: () => ({ maintenance: { status: () => ({ running: false }), async checkUpdate() { calls.push('check'); return update; }, async close() {} } }) });
  t.after(() => app.close());
  const { csrfToken } = await (await fetch(app.url + '/api/bootstrap')).json();
  assert.equal((await fetch(app.url + '/api/update/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  const headers = { 'Content-Type': 'application/json', 'X-Claudia-Token': csrfToken };
  assert.equal((await fetch(app.url + '/api/update/check', { method: 'POST', headers, body: '{"force":true}' })).status, 400);
  const response = await fetch(app.url + '/api/update/check', { method: 'POST', headers, body: '{}' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { update });
  assert.deepEqual(calls, ['check']);
});
