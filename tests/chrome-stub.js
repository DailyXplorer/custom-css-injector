'use strict';

const { isDeepStrictEqual } = require('node:util');

function cloneValue(value) {
  if (value === undefined) return undefined;
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function cloneItems(items) {
  const copy = {};
  for (const [key, value] of Object.entries(items || {})) {
    copy[key] = cloneValue(value);
  }
  return copy;
}

function createEvent(listenerBucket) {
  return {
    addListener(listener) {
      if (typeof listener === 'function' && !listenerBucket.includes(listener)) {
        listenerBucket.push(listener);
      }
    },
    removeListener(listener) {
      const index = listenerBucket.indexOf(listener);
      if (index >= 0) listenerBucket.splice(index, 1);
    },
    hasListener(listener) {
      return listenerBucket.includes(listener);
    },
    hasListeners() {
      return listenerBucket.length > 0;
    }
  };
}

function createChromeStub(initialState = {}) {
  const listeners = {
    onInstalled: [],
    onStartup: [],
    onMessage: [],
    onStorageChanged: []
  };
  const stores = {
    local: new Map(Object.entries(cloneItems(initialState.local))),
    sync: new Map(Object.entries(cloneItems(initialState.sync)))
  };
  const failureRules = [];
  const hangRules = [];
  const storageCalls = [];
  const tabsSendMessageCalls = [];
  let tabsResponder = null;

  const runtime = {
    id: 'test-extension-id',
    lastError: undefined,
    onInstalled: createEvent(listeners.onInstalled),
    onStartup: createEvent(listeners.onStartup),
    onMessage: createEvent(listeners.onMessage)
  };

  function addRule(bucket, area, method, value, options = {}) {
    const occurrence = Number.isInteger(options.call) && options.call > 0
      ? options.call
      : 1;
    bucket.push({ area, method, value, remaining: occurrence });
  }

  function consumeRule(bucket, area, method) {
    const ruleIndex = bucket.findIndex((rule) => rule.area === area && rule.method === method);
    if (ruleIndex < 0) return null;

    const rule = bucket[ruleIndex];
    rule.remaining -= 1;
    if (rule.remaining > 0) return null;

    bucket.splice(ruleIndex, 1);
    return rule;
  }

  function getFailureMessage(value) {
    if (value instanceof Error && value.message) return value.message;
    if (value && typeof value.message === 'string' && value.message) return value.message;
    return String(value || 'Chrome API operation failed');
  }

  function invokeApi(area, method, operation, callback) {
    storageCalls.push({ area, method });
    const failureRule = consumeRule(failureRules, area, method);
    const hangRule = consumeRule(hangRules, area, method);

    if (hangRule) {
      return typeof callback === 'function' ? undefined : new Promise(() => {});
    }

    if (typeof callback === 'function') {
      queueMicrotask(() => {
        if (failureRule) {
          runtime.lastError = { message: getFailureMessage(failureRule.value) };
          try {
            callback(undefined);
          } finally {
            runtime.lastError = undefined;
          }
          return;
        }

        callback(cloneValue(operation()));
      });
      return undefined;
    }

    return new Promise((resolve, reject) => {
      queueMicrotask(() => {
        if (failureRule) {
          reject(new Error(getFailureMessage(failureRule.value)));
          return;
        }

        try {
          resolve(cloneValue(operation()));
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  function emitStorageChanges(changes, area) {
    if (Object.keys(changes).length === 0) return;
    for (const listener of [...listeners.onStorageChanged]) {
      listener(cloneItems(changes), area);
    }
  }

  function readStore(store, keys) {
    const result = {};

    if (keys === null || keys === undefined) {
      for (const [key, value] of store.entries()) {
        result[key] = cloneValue(value);
      }
      return result;
    }

    if (typeof keys === 'string') {
      if (store.has(keys)) result[keys] = cloneValue(store.get(keys));
      return result;
    }

    if (Array.isArray(keys)) {
      for (const key of keys) {
        if (store.has(key)) result[key] = cloneValue(store.get(key));
      }
      return result;
    }

    if (keys && typeof keys === 'object') {
      for (const [key, defaultValue] of Object.entries(keys)) {
        result[key] = store.has(key) ? cloneValue(store.get(key)) : cloneValue(defaultValue);
      }
    }

    return result;
  }

  function createStorageArea(area) {
    const store = stores[area];

    return {
      QUOTA_BYTES: area === 'local' ? 10 * 1024 * 1024 : 102400,

      get(keys, callback) {
        return invokeApi(area, 'get', () => readStore(store, keys), callback);
      },

      set(items, callback) {
        return invokeApi(area, 'set', () => {
          const changes = {};
          for (const [key, nextValue] of Object.entries(items || {})) {
            const hadValue = store.has(key);
            const previousValue = hadValue ? store.get(key) : undefined;
            if (hadValue && isDeepStrictEqual(previousValue, nextValue)) continue;

            store.set(key, cloneValue(nextValue));
            changes[key] = {};
            if (hadValue) changes[key].oldValue = cloneValue(previousValue);
            changes[key].newValue = cloneValue(nextValue);
          }
          emitStorageChanges(changes, area);
        }, callback);
      },

      remove(keys, callback) {
        return invokeApi(area, 'remove', () => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          const changes = {};
          for (const key of keyList) {
            if (!store.has(key)) continue;
            changes[key] = { oldValue: cloneValue(store.get(key)) };
            store.delete(key);
          }
          emitStorageChanges(changes, area);
        }, callback);
      },

      clear(callback) {
        return invokeApi(area, 'clear', () => {
          const changes = {};
          for (const [key, value] of store.entries()) {
            changes[key] = { oldValue: cloneValue(value) };
          }
          store.clear();
          emitStorageChanges(changes, area);
        }, callback);
      }
    };
  }

  function sendTabMessage(tabId, message, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    const normalizedOptions = options || {};
    tabsSendMessageCalls.push({
      tabId,
      message: cloneValue(message),
      options: cloneValue(normalizedOptions)
    });

    const responsePromise = Promise.resolve().then(() => {
      if (typeof tabsResponder !== 'function') {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      }
      return tabsResponder(tabId, cloneValue(message), cloneValue(normalizedOptions));
    });

    if (typeof callback === 'function') {
      responsePromise.then(
        (response) => callback(cloneValue(response)),
        (error) => {
          runtime.lastError = { message: getFailureMessage(error) };
          try {
            callback(undefined);
          } finally {
            runtime.lastError = undefined;
          }
        }
      );
      return undefined;
    }

    return responsePromise.then(cloneValue);
  }

  const chrome = {
    runtime,
    storage: {
      local: createStorageArea('local'),
      sync: createStorageArea('sync'),
      onChanged: createEvent(listeners.onStorageChanged)
    },
    tabs: {
      sendMessage: sendTabMessage
    }
  };

  return {
    chrome,
    listeners,
    storageCalls,
    tabsSendMessageCalls,
    failNext(area, method, error, options) {
      addRule(failureRules, area, method, error, options);
    },
    hangNext(area, method, options) {
      addRule(hangRules, area, method, true, options);
    },
    getStorageSnapshot(area) {
      return readStore(stores[area], null);
    },
    get tabsResponder() {
      return tabsResponder;
    },
    set tabsResponder(responder) {
      tabsResponder = responder;
    }
  };
}

function installChromeStub(initialState) {
  const stub = initialState && initialState.chrome
    ? initialState
    : createChromeStub(initialState);
  globalThis.chrome = stub.chrome;
  return stub;
}

function resetChromeGlobal() {
  delete globalThis.chrome;
}

module.exports = {
  createChromeStub,
  installChromeStub,
  resetChromeGlobal
};
