'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  installChromeStub,
  resetChromeGlobal
} = require('./chrome-stub.js');

const MIGRATION_FLAG = '__cssInjectorMigratedSyncToLocal';
const backgroundModulePath = require.resolve('../background.js');

function loadBackground(stub) {
  globalThis.chrome = stub.chrome;
  delete require.cache[backgroundModulePath];
  require(backgroundModulePath);
}

async function settle(turns = 6) {
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function setupBackground(t, initialState) {
  const stub = installChromeStub(initialState);
  loadBackground(stub);
  t.after(() => {
    delete require.cache[backgroundModulePath];
    resetChromeGlobal();
  });
  return stub;
}

function muteConsoleWarn(t) {
  const originalWarn = console.warn;
  console.warn = () => {};
  t.after(() => {
    console.warn = originalWarn;
  });
}

function sendRuntimeMessage(stub, message, sender) {
  const listener = stub.listeners.onMessage.at(-1);
  assert.equal(typeof listener, 'function');

  return new Promise((resolve) => {
    const keepsChannelOpen = listener(message, sender, resolve);
    assert.equal(keepsChannelOpen, true);
  });
}

test('fresh install marks migration complete without adding site data', async (t) => {
  const stub = setupBackground(t);
  await settle();

  assert.deepEqual(stub.getStorageSnapshot('local'), { [MIGRATION_FLAG]: true });
  assert.deepEqual(stub.getStorageSnapshot('sync'), {});
});

test('legacy CSS and its disabled state migrate from sync to local', async (t) => {
  const stub = setupBackground(t, {
    sync: { 'a.com': 'body{}', 'a.com_enabled': false }
  });
  await settle();

  assert.deepEqual(stub.getStorageSnapshot('local'), {
    'a.com': 'body{}',
    'a.com_enabled': false,
    [MIGRATION_FLAG]: true
  });
  assert.deepEqual(stub.getStorageSnapshot('sync'), {});
});

test('local CSS wins while the corresponding legacy sync keys are drained', async (t) => {
  const stub = setupBackground(t, {
    local: { 'a.com': 'NEW' },
    sync: { 'a.com': 'OLD', 'a.com_enabled': false }
  });
  await settle();

  assert.deepEqual(stub.getStorageSnapshot('local'), {
    'a.com': 'NEW',
    [MIGRATION_FLAG]: true
  });
  assert.deepEqual(stub.getStorageSnapshot('sync'), {});
});

test('migration defaults a missing legacy enabled flag to true', async (t) => {
  const stub = setupBackground(t, { sync: { 'a.com': 'x' } });
  await settle();

  assert.equal(stub.getStorageSnapshot('local')['a.com_enabled'], true);
});

test('non-string legacy host values remain untouched in sync', async (t) => {
  const stub = setupBackground(t, { sync: { 'a.com': 42 } });
  await settle();

  assert.deepEqual(stub.getStorageSnapshot('sync'), { 'a.com': 42 });
  assert.deepEqual(stub.getStorageSnapshot('local'), { [MIGRATION_FLAG]: true });
});

test('migration removes local draft keys', async (t) => {
  const stub = setupBackground(t, {
    local: { 'draft:a.com': 'draft', 'b.com': 'saved' }
  });
  await settle();

  assert.deepEqual(stub.getStorageSnapshot('local'), {
    'b.com': 'saved',
    [MIGRATION_FLAG]: true
  });
});

test('migration marker makes later background loads idempotent', async (t) => {
  const stub = setupBackground(t, { sync: { 'a.com': 'legacy' } });
  await settle();

  await stub.chrome.storage.local.set({ 'a.com': 'changed-after-migration' });
  loadBackground(stub);
  await settle();

  assert.equal(stub.getStorageSnapshot('local')['a.com'], 'changed-after-migration');
  assert.equal(stub.getStorageSnapshot('local')[MIGRATION_FLAG], true);
});

test('a migration data-write failure leaves sync data and marker untouched', async (t) => {
  muteConsoleWarn(t);
  const stub = installChromeStub({ sync: { 'a.com': 'legacy' } });
  stub.failNext('local', 'set', new Error('write failed'));
  loadBackground(stub);
  t.after(() => {
    delete require.cache[backgroundModulePath];
    resetChromeGlobal();
  });
  await settle();

  assert.deepEqual(stub.getStorageSnapshot('local'), {});
  assert.deepEqual(stub.getStorageSnapshot('sync'), { 'a.com': 'legacy' });
});

test('a marker-read failure aborts migration without touching sync', async (t) => {
  muteConsoleWarn(t);
  const stub = installChromeStub({ sync: { 'a.com': 'legacy' } });
  stub.failNext('local', 'get', new Error('marker read failed'));
  loadBackground(stub);
  t.after(() => {
    delete require.cache[backgroundModulePath];
    resetChromeGlobal();
  });
  await settle();

  assert.deepEqual(stub.getStorageSnapshot('local'), {});
  assert.deepEqual(stub.getStorageSnapshot('sync'), { 'a.com': 'legacy' });
});

test('a sync-read failure aborts migration without setting the marker', async (t) => {
  muteConsoleWarn(t);
  const stub = installChromeStub({ sync: { 'a.com': 'legacy' } });
  stub.failNext('sync', 'get', new Error('sync read failed'));
  loadBackground(stub);
  t.after(() => {
    delete require.cache[backgroundModulePath];
    resetChromeGlobal();
  });
  await settle();

  assert.deepEqual(stub.getStorageSnapshot('local'), {});
  assert.deepEqual(stub.getStorageSnapshot('sync'), { 'a.com': 'legacy' });
});

test('a local snapshot read failure cannot overwrite newer local CSS', async (t) => {
  muteConsoleWarn(t);
  const stub = installChromeStub({
    local: { 'a.com': 'NEW' },
    sync: { 'a.com': 'OLD' }
  });
  stub.failNext('local', 'get', new Error('local snapshot failed'), { call: 2 });
  loadBackground(stub);
  t.after(() => {
    delete require.cache[backgroundModulePath];
    resetChromeGlobal();
  });
  await settle();

  assert.deepEqual(stub.getStorageSnapshot('local'), { 'a.com': 'NEW' });
  assert.deepEqual(stub.getStorageSnapshot('sync'), { 'a.com': 'OLD' });
});

test('migration preserves its data-write, sync-drain, draft-cleanup, marker order', async (t) => {
  const stub = setupBackground(t, {
    local: { 'draft:a.com': 'draft' },
    sync: { 'a.com': 'legacy' }
  });
  await settle();

  const mutations = stub.storageCalls
    .filter((call) => call.method !== 'get')
    .map((call) => `${call.area}:${call.method}`);
  assert.deepEqual(mutations, [
    'local:set',
    'sync:remove',
    'local:remove',
    'local:set'
  ]);
});

test('trusted ping messages receive an ok response', async (t) => {
  const stub = setupBackground(t);
  await settle();

  const response = await sendRuntimeMessage(
    stub,
    { type: 'ping' },
    { id: stub.chrome.runtime.id }
  );
  assert.deepEqual(response, { ok: true });
});

test('messages from another extension id are rejected', async (t) => {
  const stub = setupBackground(t);
  await settle();

  const response = await sendRuntimeMessage(stub, { type: 'ping' }, { id: 'other' });
  assert.deepEqual(response, { ok: false, error: 'Untrusted sender' });
});

test('top-host messages prefer the sender tab URL', async (t) => {
  const stub = setupBackground(t);
  await settle();

  const response = await sendRuntimeMessage(
    stub,
    { type: 'context:getTopHost' },
    { id: stub.chrome.runtime.id, tab: { id: 7, url: 'https://x.example/path' } }
  );

  assert.deepEqual(response, { ok: true, host: 'x.example' });
  assert.equal(stub.tabsSendMessageCalls.length, 0);
});

test('top-host fallback targets frame zero when the tab URL is unavailable', async (t) => {
  const stub = setupBackground(t);
  stub.tabsResponder = () => ({ ok: true, host: 'top.example' });
  await settle();

  const response = await sendRuntimeMessage(
    stub,
    { type: 'context:getTopHost' },
    { id: stub.chrome.runtime.id, tab: { id: 7 } }
  );

  assert.deepEqual(response, { ok: true, host: 'top.example' });
  assert.deepEqual(stub.tabsSendMessageCalls[0], {
    tabId: 7,
    message: { type: 'context:getHost' },
    options: { frameId: 0 }
  });
});

test('unsupported trusted messages receive a stable error', async (t) => {
  const stub = setupBackground(t);
  await settle();

  const response = await sendRuntimeMessage(
    stub,
    { type: 'unknown' },
    { id: stub.chrome.runtime.id }
  );
  assert.deepEqual(response, { ok: false, error: 'Unsupported message type: unknown' });
});
