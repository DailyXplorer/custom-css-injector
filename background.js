const MIGRATION_FLAG = '__cssInjectorMigratedSyncToLocal';

let migrationChain = Promise.resolve();

function getErrorMessage(error) {
  if (error instanceof Error && typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim();
  }
  if (error && typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim();
  }
  return 'Unknown error';
}

function isTrustedSender(sender) {
  try {
    return !!sender && sender.id === chrome.runtime.id;
  } catch {
    return false;
  }
}

function getHostnameFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

const TOP_FRAME_HOST_RETRY_DELAYS_MS = [150, 400];

function sendHostRequestToTopFrame(tabId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: 'context:getHost' }, { frameId: 0 }, (response) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(
          response && response.ok === true && typeof response.host === 'string' && response.host
            ? response.host
            : null
        );
      });
    } catch {
      resolve(null);
    }
  });
}

async function requestHostFromTopFrame(tabId) {
  if (typeof tabId !== 'number') {
    return null;
  }

  let host = await sendHostRequestToTopFrame(tabId);
  for (const delayMs of TOP_FRAME_HOST_RETRY_DELAYS_MS) {
    if (host) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    host = await sendHostRequestToTopFrame(tabId);
  }

  return host;
}

async function getTopHostFromSender(sender) {
  const senderTab = sender && sender.tab ? sender.tab : null;
  const senderTabUrl = senderTab && typeof senderTab.url === 'string' ? senderTab.url : null;
  const senderTabHost = getHostnameFromUrl(senderTabUrl);
  if (senderTabHost) {
    return senderTabHost;
  }

  const senderTabId = senderTab && typeof senderTab.id === 'number' ? senderTab.id : null;
  if (typeof senderTabId !== 'number') {
    return null;
  }

  return requestHostFromTopFrame(senderTabId);
}

async function migrateLegacyStorageBody() {
  try {
    const marker = await new Promise((resolve, reject) => {
      chrome.storage.local.get(MIGRATION_FLAG, (items) => {
        const err = chrome.runtime.lastError;
        if (err) reject(err);
        else resolve(items && items[MIGRATION_FLAG] === true);
      });
    });
    if (marker) return;

    const syncAll = await new Promise((resolve, reject) => {
      chrome.storage.sync.get(null, (items) => {
        const err = chrome.runtime.lastError;
        if (err) reject(err);
        else resolve(items || {});
      });
    });
    const localAll = await new Promise((resolve, reject) => {
      chrome.storage.local.get(null, (items) => {
        const err = chrome.runtime.lastError;
        if (err) reject(err);
        else resolve(items || {});
      });
    });

    const toLocal = {};
    const syncKeysToRemove = [];

    for (const [key, value] of Object.entries(syncAll)) {
      if (typeof key !== 'string' || key.endsWith('_enabled')) continue;
      if (typeof value !== 'string') continue;

      const host = key;
      syncKeysToRemove.push(host, `${host}_enabled`);

      if (Object.prototype.hasOwnProperty.call(localAll, host)) {
        continue;
      }

      toLocal[host] = value;
      toLocal[`${host}_enabled`] = syncAll[`${host}_enabled`] !== false;
    }

    const draftKeysToRemove = Object.keys(localAll).filter(
      (k) => typeof k === 'string' && k.startsWith('draft:')
    );

    if (Object.keys(toLocal).length > 0) {
      await new Promise((resolve, reject) => {
        chrome.storage.local.set(toLocal, () => {
          const err = chrome.runtime.lastError;
          if (err) reject(err);
          else resolve();
        });
      });
    }

    const uniqueSyncRemove = [...new Set(syncKeysToRemove)];
    if (uniqueSyncRemove.length > 0) {
      await new Promise((resolve, reject) => {
        chrome.storage.sync.remove(uniqueSyncRemove, () => {
          const err = chrome.runtime.lastError;
          if (err) reject(err);
          else resolve();
        });
      });
    }

    if (draftKeysToRemove.length > 0) {
      await new Promise((resolve, reject) => {
        chrome.storage.local.remove(draftKeysToRemove, () => {
          const err = chrome.runtime.lastError;
          if (err) reject(err);
          else resolve();
        });
      });
    }

    await new Promise((resolve, reject) => {
      chrome.storage.local.set({ [MIGRATION_FLAG]: true }, () => {
        const err = chrome.runtime.lastError;
        if (err) reject(err);
        else resolve();
      });
    });
  } catch (error) {
    console.warn('CSS Injector storage migration failed:', error);
  }
}

function migrateLegacyStorage() {
  migrationChain = migrationChain
    .then(() => migrateLegacyStorageBody())
    .catch((error) => {
      console.warn('CSS Injector storage migration failed:', error);
    });
  return migrationChain;
}

chrome.runtime.onInstalled.addListener(() => {
  try {
    console.log('CSS Injector extension installed');
  } catch (error) {
    console.error('Failed to handle extension installation:', error);
  }
  migrateLegacyStorage();
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    migrateLegacyStorage();
  });
}

migrateLegacyStorage();

async function handleRuntimeMessage(message, sender) {
  if (!message || typeof message.type !== 'string') {
    return { ok: false, error: 'Invalid message' };
  }

  if (!isTrustedSender(sender)) {
    return { ok: false, error: 'Untrusted sender' };
  }

  if (message.type === 'ping') {
    return { ok: true };
  }

  if (message.type === 'context:getTopHost') {
    const host = await getTopHostFromSender(sender);
    return host
      ? { ok: true, host }
      : { ok: false, error: 'Top host unavailable' };
  }

  return { ok: false, error: `Unsupported message type: ${message.type}` };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  Promise.resolve()
    .then(() => handleRuntimeMessage(message, sender))
    .then((response) => {
      sendResponse(response);
    })
    .catch((error) => {
      console.error('Failed to handle message:', error);
      sendResponse({ ok: false, error: getErrorMessage(error) });
    });

  return true;
});
