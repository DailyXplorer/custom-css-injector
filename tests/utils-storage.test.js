'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { utils } = require('./load-extension-globals.js');
const {
  createChromeStub,
  installChromeStub,
  resetChromeGlobal
} = require('./chrome-stub.js');

function setupChrome(t, initialState) {
  const stub = installChromeStub(initialState);
  t.after(resetChromeGlobal);
  return stub;
}

test('stub storage methods support Promise round trips', async () => {
  const stub = createChromeStub();

  await stub.chrome.storage.local.set({ a: 'x' });
  assert.deepEqual(await stub.chrome.storage.local.get('a'), { a: 'x' });
  await stub.chrome.storage.local.remove('a');
  assert.deepEqual(await stub.chrome.storage.local.get(null), {});
});

test('stub lastError exists only while a callback is running', async () => {
  const stub = createChromeStub();
  stub.failNext('local', 'get', new Error('callback failed'));

  let errorDuringCallback;
  await new Promise((resolve) => {
    stub.chrome.storage.local.get(null, () => {
      errorDuringCallback = stub.chrome.runtime.lastError;
      resolve();
    });
  });

  assert.deepEqual(errorDuringCallback, { message: 'callback failed' });
  assert.equal(stub.chrome.runtime.lastError, undefined);
});

test('stub failure occurrence can target a later matching call', async () => {
  const stub = createChromeStub({ local: { a: 1 } });
  stub.failNext('local', 'get', new Error('second read failed'), { call: 2 });

  assert.deepEqual(await stub.chrome.storage.local.get('a'), { a: 1 });
  await assert.rejects(stub.chrome.storage.local.get('a'), /second read failed/);
  assert.deepEqual(await stub.chrome.storage.local.get('a'), { a: 1 });
});

test('stub emits storage changes for changed values only', async () => {
  const stub = createChromeStub({ local: { a: 1 } });
  const events = [];
  stub.chrome.storage.onChanged.addListener((changes, area) => {
    events.push({ changes, area });
  });

  await stub.chrome.storage.local.set({ a: 1 });
  await stub.chrome.storage.local.set({ a: 2 });

  assert.deepEqual(events, [{
    changes: { a: { oldValue: 1, newValue: 2 } },
    area: 'local'
  }]);
});

test('stub tabs.sendMessage supports Promise responses', async () => {
  const stub = createChromeStub();
  stub.tabsResponder = async (_tabId, message, options) => ({
    ok: true,
    type: message.type,
    frameId: options.frameId
  });

  const response = await stub.chrome.tabs.sendMessage(
    7,
    { type: 'context:getHost' },
    { frameId: 0 }
  );

  assert.deepEqual(response, { ok: true, type: 'context:getHost', frameId: 0 });
});

test('stub tabs.sendMessage scopes connection lastError to its callback', async () => {
  const stub = createChromeStub();
  let errorDuringCallback;

  await new Promise((resolve) => {
    stub.chrome.tabs.sendMessage(7, { type: 'ping' }, {}, () => {
      errorDuringCallback = stub.chrome.runtime.lastError;
      resolve();
    });
  });

  assert.match(errorDuringCallback.message, /Could not establish connection/);
  assert.equal(stub.chrome.runtime.lastError, undefined);
});

test('storageGet resolves selected local values', async (t) => {
  setupChrome(t, { local: { k: 'v', other: 1 } });

  assert.deepEqual(await utils.storageGet('local', ['k'], 50), { k: 'v' });
});

test('storageGet normalizes chrome.runtime.lastError into Error', async (t) => {
  const stub = setupChrome(t);
  stub.failNext('local', 'get', new Error('read failed'));

  await assert.rejects(
    utils.storageGet('local', null, 50),
    (error) => error instanceof Error && error.message === 'read failed'
  );
});

test('storageGet rejects unavailable storage areas', async (t) => {
  setupChrome(t);

  await assert.rejects(
    utils.storageGet('managed', null, 50),
    /Storage area unavailable: managed/
  );
});

test('storageSet persists items', async (t) => {
  const stub = setupChrome(t);

  await utils.storageSet('local', { k: 'v' }, 50);
  assert.deepEqual(stub.getStorageSnapshot('local'), { k: 'v' });
});

test('storageSet rejects chrome.runtime.lastError', async (t) => {
  const stub = setupChrome(t);
  stub.failNext('local', 'set', new Error('write failed'));

  await assert.rejects(utils.storageSet('local', { k: 'v' }, 50), /write failed/);
  assert.deepEqual(stub.getStorageSnapshot('local'), {});
});

test('storageSet rejects when its callback never arrives', async (t) => {
  const stub = setupChrome(t);
  stub.hangNext('local', 'set');

  await assert.rejects(
    utils.storageSet('local', { k: 'v' }, 10),
    /Storage write timed out/
  );
});

test('storageRemove deletes requested keys', async (t) => {
  const stub = setupChrome(t, { local: { keep: 1, remove: 2 } });

  await utils.storageRemove('local', ['remove'], 50);
  assert.deepEqual(stub.getStorageSnapshot('local'), { keep: 1 });
});

test('storageRemove rejects chrome.runtime.lastError', async (t) => {
  const stub = setupChrome(t, { local: { k: 'v' } });
  stub.failNext('local', 'remove', new Error('remove failed'));

  await assert.rejects(utils.storageRemove('local', 'k', 50), /remove failed/);
  assert.deepEqual(stub.getStorageSnapshot('local'), { k: 'v' });
});
