'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require('../popup-persistence.js');

const { createPersistenceController } = globalThis.CSSInjectorPopupPersistence;

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createFakeTimers() {
  let nextId = 0;
  const tasks = new Map();
  return {
    setTimeout(callback) {
      const id = ++nextId;
      tasks.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      tasks.delete(id);
    },
    runAll() {
      const callbacks = Array.from(tasks.values());
      tasks.clear();
      callbacks.forEach((callback) => callback());
    },
    size() {
      return tasks.size;
    }
  };
}

function createController(write, timers = createFakeTimers(), options = {}) {
  return {
    controller: createPersistenceController(Object.assign({
      write,
      delayMs: 250,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout
    }, options)),
    timers
  };
}

test('debounced schedules coalesce to the newest host revision', async () => {
  const writes = [];
  const { controller, timers } = createController(async (payload) => writes.push(payload));

  const firstRevision = controller.schedule({ host: 'example.com', css: 'a', enabled: true });
  const secondRevision = controller.schedule({ host: 'example.com', css: 'b', enabled: false });

  assert.equal(firstRevision, 1);
  assert.equal(secondRevision, 2);
  assert.equal(timers.size(), 1);
  timers.runAll();
  await controller.waitForIdle();

  assert.deepEqual(writes, [{ host: 'example.com', css: 'b', enabled: false, revision: 2 }]);
  assert.equal(controller.hasPending(), false);
});

test('flush drains a payload scheduled during an in-flight write', async () => {
  const firstWrite = createDeferred();
  const writes = [];
  const { controller } = createController(async (payload) => {
    writes.push(payload);
    if (payload.revision === 1) await firstWrite.promise;
  });

  controller.schedule({ host: 'example.com', css: 'first', enabled: true });
  const flushPromise = controller.flush();
  await Promise.resolve();
  controller.schedule({ host: 'example.com', css: 'second', enabled: true });
  firstWrite.resolve();

  assert.equal(await flushPromise, true);
  assert.deepEqual(writes.map((payload) => payload.css), ['first', 'second']);
  assert.equal(controller.hasPending('example.com'), false);
});

test('a newer revision replaces a stale payload before its queued write begins', async () => {
  const firstWrite = createDeferred();
  const writes = [];
  const { controller } = createController(async (payload) => {
    writes.push(`${payload.host}:${payload.css}`);
    if (payload.host === 'a.example') await firstWrite.promise;
  });

  controller.schedule({ host: 'a.example', css: 'a1', enabled: true });
  controller.schedule({ host: 'b.example', css: 'b1', enabled: true });
  const flushPromise = controller.flush();
  await Promise.resolve();
  controller.schedule({ host: 'b.example', css: 'b2', enabled: true });
  firstWrite.resolve();

  assert.equal(await flushPromise, true);
  assert.deepEqual(writes, ['a.example:a1', 'b.example:b2']);
});

test('different hosts scheduled before debounce are both persisted', async () => {
  const writes = [];
  const { controller, timers } = createController(async (payload) => writes.push(payload.host));

  controller.schedule({ host: 'a.example', css: 'a', enabled: true });
  controller.schedule({ host: 'b.example', css: 'b', enabled: true });
  timers.runAll();
  await controller.waitForIdle();

  assert.deepEqual(writes, ['a.example', 'b.example']);
});

test('concurrent flush callers share one drain and one write', async () => {
  const deferredWrite = createDeferred();
  let writes = 0;
  const { controller } = createController(async () => {
    writes += 1;
    await deferredWrite.promise;
  });

  controller.schedule({ host: 'example.com', css: 'shared', enabled: true });
  const firstFlush = controller.flush();
  const secondFlush = controller.flush();
  deferredWrite.resolve();

  assert.equal(await firstFlush, true);
  assert.equal(await secondFlush, true);
  assert.equal(writes, 1);
});

test('a failed write stays retryable and flush reports false', async () => {
  let attempts = 0;
  const seenErrors = [];
  const { controller, timers } = createController(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('storage unavailable');
  }, undefined, {
    onError(error) {
      seenErrors.push(error.message);
    }
  });

  controller.schedule({ host: 'example.com', css: 'retry', enabled: true });
  assert.equal(await controller.flush(), false);
  assert.equal(controller.hasPending('example.com'), true);
  assert.equal(controller.getLastError().message, 'storage unavailable');
  assert.equal(timers.size(), 0, 'a failure must not create an automatic retry loop');

  assert.equal(await controller.flush(), true);
  assert.equal(attempts, 2);
  assert.deepEqual(seenErrors, ['storage unavailable']);
  assert.equal(controller.hasPending(), false);
});

test('a newer payload replaces the failed revision as the retry target', async () => {
  const firstWrite = createDeferred();
  const writes = [];
  const { controller } = createController(async (payload) => {
    writes.push(payload.css);
    if (payload.css === 'old') await firstWrite.promise;
  });

  controller.schedule({ host: 'example.com', css: 'old', enabled: true });
  const failedFlush = controller.flush();
  await Promise.resolve();
  controller.schedule({ host: 'example.com', css: 'new', enabled: true });
  firstWrite.reject(new Error('old failed'));

  assert.equal(await failedFlush, false);
  assert.equal(controller.getPendingPayload('example.com').css, 'new');
  assert.equal(await controller.flush(), true);
  assert.deepEqual(writes, ['old', 'new']);
});

test('close-time snapshot returns only newest state and keeps normal flush as fallback', async () => {
  const writes = [];
  const { controller } = createController(async (payload) => writes.push(payload));

  controller.schedule({ host: 'example.com', css: 'old', enabled: true });
  controller.schedule({ host: 'example.com', css: 'new', enabled: false });
  const immediatePayloads = controller.getPendingForImmediateDispatch();

  assert.deepEqual(immediatePayloads, [
    { host: 'example.com', css: 'new', enabled: false, revision: 2 }
  ]);
  assert.deepEqual(controller.getPendingForImmediateDispatch(), []);
  assert.equal(await controller.flush(), true);
  assert.deepEqual(writes, [
    { host: 'example.com', css: 'new', enabled: false, revision: 2 }
  ]);
});

test('close-time snapshot cannot let an in-flight older write win', async () => {
  const firstWrite = createDeferred();
  const writes = [];
  const { controller } = createController(async (payload) => {
    writes.push(payload.css);
    await firstWrite.promise;
  });

  controller.schedule({ host: 'example.com', css: 'already-dispatched', enabled: true });
  const flushPromise = controller.flush();
  await Promise.resolve();
  controller.schedule({ host: 'example.com', css: 'close-state', enabled: true });

  assert.equal(controller.getPendingForImmediateDispatch()[0].css, 'close-state');
  firstWrite.resolve();
  assert.equal(await flushPromise, true);
  assert.deepEqual(writes, ['already-dispatched', 'close-state']);
});

test('a rejected immediate dispatch leaves the newest payload retryable by flush', async () => {
  const writes = [];
  const { controller } = createController(async (payload) => writes.push(payload.css));

  controller.schedule({ host: 'example.com', css: 'fallback', enabled: true });
  const [immediatePayload] = controller.getPendingForImmediateDispatch();
  await Promise.reject(new Error('immediate failed')).catch(() => {});

  assert.equal(immediatePayload.css, 'fallback');
  assert.equal(controller.hasPending('example.com'), true);
  assert.equal(await controller.flush(), true);
  assert.deepEqual(writes, ['fallback']);
});

test('reset invalidation waits for dispatched work and drops later host revisions', async () => {
  const firstWrite = createDeferred();
  const writes = [];
  const { controller } = createController(async (payload) => {
    writes.push(payload.css);
    await firstWrite.promise;
  });

  controller.schedule({ host: 'example.com', css: 'in-flight', enabled: true });
  controller.flush();
  await Promise.resolve();
  controller.schedule({ host: 'example.com', css: 'must-not-write', enabled: true });
  controller.invalidateHost('example.com');

  firstWrite.resolve();
  await controller.waitForIdle();
  assert.equal(await controller.flush(), true);
  assert.deepEqual(writes, ['in-flight']);
  assert.equal(controller.hasPending('example.com'), false);
});

test('host invalidation does not discard another host payload', async () => {
  const writes = [];
  const { controller } = createController(async (payload) => writes.push(payload.host));

  controller.schedule({ host: 'a.example', css: 'a', enabled: true });
  controller.schedule({ host: 'b.example', css: 'b', enabled: true });
  controller.invalidateHost('a.example');

  assert.equal(await controller.flush(), true);
  assert.deepEqual(writes, ['b.example']);
  assert.equal(controller.hasPending('a.example'), false);
});

test('host invalidation advances the read revision even without a pending write', () => {
  const { controller } = createController(async () => {});
  const before = controller.getRevision('example.com');
  controller.invalidateHost('example.com');
  const after = controller.getRevision('example.com');

  assert.ok(after > before);
});

test('invalid payloads are rejected before they enter the queue', () => {
  const { controller } = createController(async () => {});
  assert.throws(() => controller.schedule({ css: 'x' }), /requires a host/);
  assert.equal(controller.hasPending(), false);
});
