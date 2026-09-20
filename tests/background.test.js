'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  installChromeStub,
  resetChromeGlobal
} = require('./chrome-stub.js');

const MIGRATION_FLAG = '__cssInjectorMigratedSyncToLocal';
const backgroundModulePath = require.resolve('../background.js');
require('./load-extension-globals.js');

function loadBackground(stub) {
  globalThis.chrome = stub.chrome;
  delete require.cache[backgroundModulePath];
  globalThis.importScripts = () => {};
  try {
    require(backgroundModulePath);
  } finally {
    delete globalThis.importScripts;
  }
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

test('an update restores configured HTTP tabs after migration and skips unsupported or discarded tabs', async (t) => {
  const stub = setupBackground(t, {
    sync: { 'saved.example': 'body { color: red; }' },
    local: { 'disabled.example': 'body { color: blue; }', 'disabled.example_enabled': false,
      'chromewebstore.google.com': 'body {}', 'microsoftedge.microsoft.com': 'body {}' }
  });
  stub.chrome.tabs.query = async () => [
    { id: 1, url: 'https://saved.example/path' },
    { id: 2, url: 'http://disabled.example/' },
    { id: 3, url: 'https://other.example/' },
    { id: 4, url: 'chrome://settings/' },
    { id: 5, url: 'https://chromewebstore.google.com/' },
    { id: 6, url: 'https://saved.example/', discarded: true },
    { id: 7, url: 'https://microsoftedge.microsoft.com/addons/detail/example' }
  ];
  const restored = [];
  stub.chrome.scripting = {
    async executeScript(injection) {
      assert.equal(stub.getStorageSnapshot('local')['saved.example'], 'body { color: red; }');
      if (injection.func) return [{ frameId: 0, documentId: `document-${injection.target.tabId}`, result: { requiresReload: false } }];
      restored.push(injection);
      return [{ frameId: 0 }];
    }
  };
  stub.listeners.onInstalled[0]({ reason: 'update' });
  await settle();
  for (const tabId of [1, 2]) {
    assert.deepEqual(restored.filter(({ target }) => target.tabId === tabId), [
      { target: { tabId, documentIds: [`document-${tabId}`] }, injectImmediately: true, world: 'MAIN', files: ['shadow-dom-bridge.js'] },
      { target: { tabId, documentIds: [`document-${tabId}`] }, injectImmediately: true, world: 'ISOLATED', files: ['utils.js', 'constants.js', 'content-script.js'] }
    ]);
  }
  assert.equal(restored.length, 4);
  assert.equal(stub.getStorageSnapshot('local')['disabled.example_enabled'], false);
});

test('update restoration falls back to frame zero and a closed tab cannot prevent another tab from recovering', async (t) => {
  muteConsoleWarn(t);
  const stub = setupBackground(t, { local: { 'saved.example': 'body {}' } });
  stub.chrome.tabs.query = async () => [
    { id: 1, url: 'https://saved.example/closed' },
    { id: 2, url: 'https://saved.example/restricted-frame' }
  ];
  const delivered = [];
  stub.chrome.scripting = {
    async executeScript(injection) {
      if (injection.target.tabId === 1) throw new Error('No tab with id 1');
      if (injection.target.allFrames) throw new Error('Cannot access a frame');
      if (injection.func) return [{ frameId: 0, documentId: 'top-document', result: { requiresReload: false } }];
      delivered.push({ world: injection.world, target: injection.target });
      return [{ frameId: 0 }];
    }
  };
  stub.listeners.onInstalled[0]({ reason: 'update' });
  await settle();
  assert.deepEqual(delivered, [
    { world: 'MAIN', target: { tabId: 2, documentIds: ['top-document'] } },
    { world: 'ISOLATED', target: { tabId: 2, documentIds: ['top-document'] } }
  ]);
});

test('fresh installation and ordinary worker startup do not enumerate open tabs', async (t) => {
  const stub = setupBackground(t, { sync: { 'saved.example': 'body {}' } });
  let queried = false;
  stub.chrome.tabs.query = async () => { queried = true; return []; };
  stub.listeners.onInstalled[0]({ reason: 'install' });
  stub.listeners.onStartup[0]();
  await settle();
  assert.equal(stub.getStorageSnapshot('local')['saved.example'], 'body {}');
  assert.equal(queried, false);
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
