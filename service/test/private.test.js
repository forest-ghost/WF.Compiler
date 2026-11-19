import test from 'node:test';
import assert from 'node:assert/strict';
import {CompilerCoordinator, parseCoordinates} from '../src/worker.js';
import {PRIVATE_MAX_FAILURES} from '../src/policy.js';

class Storage {
  values = new Map();
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { return this.values.delete(key); }
  async list({prefix}) { return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).map(([k, v]) => [k, structuredClone(v)])); }
  async transaction(fn) { return fn(this); }
  async setAlarm(time) { this.alarm = time; }
  async getAlarm() { return this.alarm; }
  async deleteAlarm() { this.alarm = null; }
}
class Bucket {
  objects = new Map();
  async put(key, bytes) { this.objects.set(key, new Uint8Array(bytes)); }
  async get(key) { const value = this.objects.get(key); return value && {body: value}; }
  async delete(keys) { for (const key of [keys].flat()) this.objects.delete(key); }
}
const CODE = '48213907';
function setup() {
  const storage = new Storage();
  const env = {SOURCES: new Bucket(), TEMPORARY: new Bucket(), RUNNER_TOKEN: 'runner-test', SERVICE_ENABLED: 'true', PRIVATE_CODE: CODE};
  return {storage, env, coordinator: new CompilerCoordinator({storage}, env)};
}
const zip = new Uint8Array([80, 75, 3, 4, 1]);
const gwc = device => new Uint8Array([2, 10, 67, 65, 82, 84, 0, 0, 0, 0, 0, device.length]);
const req = (path, options = {}) => new Request('https://compiler.test' + path, options);
const code = (value = CODE) => ({'X-Private-Code': value});
const runner = lease => ({Authorization: 'Bearer runner-test', 'X-Job-Lease': lease});

async function upload(coordinator, headers = code()) {
  await coordinator.ctx.storage.put('runnerHeartbeat', Date.now());
  const form = new FormData();
  form.set('cartridge', new File([zip], 'Ride the metro.gwz'));
  return coordinator.fetch(req('/api/v1/private/uploads', {method: 'POST', headers, body: form}));
}
async function build(coordinator) {
  const {uploadId} = await (await upload(coordinator)).json();
  const {lease, purpose} = await (await coordinator.fetch(req('/internal/runner/claim', {method: 'POST', headers: runner()}))).json();
  assert.equal(purpose, 'preview', 'the runner sees an ordinary preview job');
  for (const device of ['iPhone', 'WhereYouGo'])
    await coordinator.fetch(req(`/internal/runner/${uploadId}/build/${device}`, {method: 'PUT', headers: runner(lease), body: gwc(device)}));
  const results = ['Emulator', 'iPhone', 'WhereYouGo'].map(device => ({device, ok: true, messages: [],
    ...(device === 'Emulator' ? {metadata: {title: 'Ride The Metro', coordinates: 'N 38° 35.123 W 090° 30.456'}} : {})}));
  await coordinator.fetch(req(`/internal/runner/${uploadId}/complete`, {method: 'POST', headers: runner(lease), body: JSON.stringify({results})}));
  return uploadId;
}
const publish = (coordinator, id, details = {title: 'TEST · Ride The Metro', coordinates: 'N 38° 35.123 W 090° 30.456', description: 'Test copy'}) =>
  coordinator.fetch(req(`/api/v1/private/uploads/${id}/publish`, {method: 'POST', headers: code(), body: JSON.stringify(details)}));

test('upload, check, publish, list, download and delete a permanent private cartridge', async () => {
  const {coordinator, storage, env} = setup();
  const uploadId = await build(coordinator);
  const status = await (await coordinator.fetch(req(`/api/v1/uploads/${uploadId}`))).json();
  assert.equal(status.status, 'valid');
  assert.equal(status.metadata.title, 'Ride The Metro');
  const reservedBefore = await storage.get('reservedBytes');

  const published = await publish(coordinator, uploadId);
  assert.equal(published.status, 201);
  const {id} = await published.json();
  assert.equal((await (await publish(coordinator, uploadId)).json()).id, id, 'publishing twice returns the same listing');
  assert.equal(await storage.get('reservedBytes'), reservedBefore + zip.length + gwc('iPhone').length + gwc('WhereYouGo').length);
  assert.deepEqual([...env.SOURCES.objects.keys()].sort(), [`private/${id}/WhereYouGo.gwc`, `private/${id}/iPhone.gwc`, `private/${id}/source.gwz`].sort());

  const list = await (await coordinator.fetch(req('/api/v1/private/cartridges', {headers: code()}))).json();
  assert.equal(list.items.length, 1);
  const [item] = list.items;
  assert.equal(item.author, 'Forest-Ghost');
  assert.equal(item.private, true);
  assert.equal(item.status, 'ready');
  assert.equal(item.expiresAt, undefined, 'private cartridges never expire');
  assert.deepEqual([item.latitude, item.longitude], [38.585383, -90.5076]);
  assert.deepEqual(item.downloads.map(d => d.device), ['iPhone', 'WhereYouGo']);

  const file = await coordinator.fetch(req(item.downloads[0].url, {headers: code()}));
  assert.equal(file.status, 200);
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), gwc('iPhone'));
  assert.match(file.headers.get('content-disposition'), /TEST-Ride-The-Metro-iPhone\.gwc/);

  // The temporary job expires; the private copy stays.
  const job = await storage.get(`job:${uploadId}`);
  await storage.put(`job:${uploadId}`, {...job, expiresAt: Date.now() - 1});
  await coordinator.alarm();
  assert.equal(env.TEMPORARY.objects.size, 0);
  assert.equal(env.SOURCES.objects.size, 3);
  assert.equal((await coordinator.fetch(req(item.downloads[1].url, {headers: code()}))).status, 200);

  const kept = await storage.get('reservedBytes');
  assert.equal((await coordinator.fetch(req(`/api/v1/private/cartridges/${id}`, {method: 'DELETE', headers: code()}))).status, 200);
  assert.equal(env.SOURCES.objects.size, 0);
  assert.equal(await storage.get('reservedBytes'), kept - item.downloads.reduce((t, d) => t + d.bytes, zip.length));
  assert.equal((await (await coordinator.fetch(req('/api/v1/private/cartridges', {headers: code()}))).json()).items.length, 0);
});

test('private uploads stay out of the public preview list and cannot be published as previews', async () => {
  const {coordinator} = setup();
  const uploadId = await build(coordinator);
  const asPreview = await coordinator.fetch(req(`/api/v1/preview/uploads/${uploadId}/publish`, {method: 'POST', body: JSON.stringify({title: 'x', coordinates: 'Play Anywhere', permission: true})}));
  assert.equal(asPreview.status, 409);
  await publish(coordinator, uploadId);
  const previews = await (await coordinator.fetch(req('/api/v1/preview/cartridges'))).json();
  assert.equal(previews.items.length, 0);
});

test('every private route needs the code', async () => {
  const {coordinator, env} = setup();
  const uploadId = await build(coordinator);
  const {id} = await (await publish(coordinator, uploadId)).json();
  for (const [path, method] of [['/api/v1/private/cartridges', 'GET'], [`/api/v1/private/cartridges/${id}/download/iPhone`, 'GET'],
    [`/api/v1/private/cartridges/${id}`, 'DELETE'], ['/api/v1/private/session', 'POST']]) {
    assert.equal((await coordinator.fetch(req(path, {method}))).status, 401, path);
  }
  assert.equal((await upload(coordinator, {})).status, 401);
  assert.equal(env.SOURCES.objects.size, 3, 'nothing was deleted without the code');
});

test('wrong codes lock the private library for everyone for up to an hour', async () => {
  const {coordinator, storage} = setup();
  for (let i = 0; i < PRIVATE_MAX_FAILURES; i++)
    assert.equal((await coordinator.fetch(req('/api/v1/private/session', {method: 'POST', headers: code(String(10000000 + i))}))).status, 401);
  const locked = await coordinator.fetch(req('/api/v1/private/session', {method: 'POST', headers: code()}));
  assert.equal(locked.status, 429, 'even the right code waits out the lock');
  const state = await storage.get('privateFailures');
  await storage.put('privateFailures', {...state, since: Date.now() - 61 * 60 * 1000});
  const open = await coordinator.fetch(req('/api/v1/private/session', {method: 'POST', headers: code()}));
  assert.equal(open.status, 200);
  assert.deepEqual(await open.json(), {ok: true, owner: 'Forest-Ghost'});
});

test('the private library stays closed until the code secret is set', async () => {
  const {coordinator, env} = setup();
  delete env.PRIVATE_CODE;
  assert.equal((await coordinator.fetch(req('/api/v1/private/session', {method: 'POST', headers: code()}))).status, 503);
  env.PRIVATE_CODE = '1234';
  assert.equal((await coordinator.fetch(req('/api/v1/private/session', {method: 'POST', headers: code('1234')}))).status, 503);
});

test('reads both coordinate styles', () => {
  assert.deepEqual(parseCoordinates('N 38° 35.123 W 090° 30.456'), {latitude: 38.585383, longitude: -90.5076});
  assert.deepEqual(parseCoordinates('38.5854, -90.5076'), {latitude: 38.5854, longitude: -90.5076});
  assert.equal(parseCoordinates('Play Anywhere'), null);
});
