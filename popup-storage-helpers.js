(function (root) {
  'use strict';

  const utils = root.CSSInjectorUtils;
  if (!utils) {
    console.error('[CSS Injector] Missing CSSInjectorUtils (utils.js).');
    return;
  }

  const isPlainObject = utils.isPlainObject;
  const estimateStorageUsage = utils.estimateStorageUsage;

  function normalizeHostname(value) {
    if (typeof value !== 'string') return null;
    const trimmedValue = value.trim();
    if (!trimmedValue) return null;
    if (trimmedValue.startsWith('__')) return null;
    if (/[/\\?#]/.test(trimmedValue)) return null;

    // URL normalizes explicit default ports away (for example, :80 on HTTP),
    // so reject port syntax before parsing. A bracketed IPv6 literal is the
    // only valid host form containing colons here, and it must end at `]`.
    if (trimmedValue.startsWith('[')) {
      if (!/^\[[^\[\]]+\]$/.test(trimmedValue)) return null;
    } else if (trimmedValue.includes(':')) {
      return null;
    }

    try {
      const parsed = new URL(`http://${trimmedValue}`);
      if (parsed.username || parsed.password || parsed.port || parsed.host !== parsed.hostname) {
        return null;
      }
      const normalizedHost = parsed.hostname.toLowerCase();
      if (!normalizedHost || normalizedHost.endsWith('_enabled')) {
        return null;
      }
      return normalizedHost;
    } catch {
      return null;
    }
  }

  function isInternalStorageKey(key) {
    return typeof key === 'string' && key.startsWith('__');
  }

  function getHostEntriesFromStorage(allItems) {
    const entries = [];
    const items = isPlainObject(allItems) ? allItems : {};

    for (const [key, value] of Object.entries(items)) {
      if (isInternalStorageKey(key) || key.startsWith('draft:')) continue;
      if (key.endsWith('_enabled') || typeof value !== 'string') {
        continue;
      }

      const normalizedHost = normalizeHostname(key);
      if (!normalizedHost) {
        continue;
      }

      entries.push({
        host: normalizedHost,
        storageKey: key,
        css: value,
        enabled: items[`${key}_enabled`] !== false
      });
    }

    entries.sort((leftEntry, rightEntry) => {
      const hostComparison = leftEntry.host.localeCompare(rightEntry.host);
      if (hostComparison !== 0) {
        return hostComparison;
      }
      return leftEntry.storageKey.localeCompare(rightEntry.storageKey);
    });
    return entries;
  }

  function buildExportPayload(entries, meta) {
    const fileType = meta && meta.fileType;
    const schemaVersion = meta && meta.schemaVersion;
    const extensionVersion = meta && meta.extensionVersion;

    const uniqueEntriesByHost = new Map();
    for (const entry of entries) {
      uniqueEntriesByHost.set(entry.host, {
        host: entry.host,
        css: entry.css,
        enabled: entry.enabled
      });
    }

    const serializedEntries = Array.from(uniqueEntriesByHost.values())
      .sort((leftEntry, rightEntry) => leftEntry.host.localeCompare(rightEntry.host));

    return {
      type: fileType,
      schemaVersion,
      exportedAt: new Date().toISOString(),
      extensionVersion,
      entries: serializedEntries
    };
  }

  function parseImportPayload(payload, meta) {
    const fileType = meta && meta.fileType;
    const schemaVersion = meta && meta.schemaVersion;

    if (!isPlainObject(payload)) {
      throw new Error('Invalid file format.');
    }

    if (payload.type !== fileType) {
      throw new Error('Unsupported config type.');
    }

    if (payload.schemaVersion !== schemaVersion) {
      throw new Error('Unsupported config version.');
    }

    if (!Array.isArray(payload.entries)) {
      throw new Error('Invalid entries format.');
    }

    const hostMap = new Map();
    payload.entries.forEach((entry, index) => {
      if (!isPlainObject(entry)) {
        throw new Error(`Invalid entry at index ${index + 1}.`);
      }

      const normalizedHost = normalizeHostname(entry.host);
      if (!normalizedHost) {
        throw new Error(`Invalid host at entry ${index + 1}.`);
      }

      if (typeof entry.css !== 'string') {
        throw new Error(`Invalid CSS at entry ${index + 1}.`);
      }

      if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
        throw new Error(`Invalid enabled value at entry ${index + 1}.`);
      }

      hostMap.set(normalizedHost, {
        css: entry.css,
        enabled: entry.enabled !== false
      });
    });

    const itemsToSet = Object.create(null);
    const importedHosts = new Set();

    for (const [host, values] of hostMap.entries()) {
      importedHosts.add(host);
      itemsToSet[host] = values.css;
      itemsToSet[`${host}_enabled`] = values.enabled;
    }

    return {
      itemsToSet,
      importedHosts
    };
  }

  function buildKeysToRemove(allItems, importedHosts) {
    const keysToRemove = new Set();
    for (const key of getManagedStorageKeys(allItems)) {
      const isEnabledKey = key.endsWith('_enabled');
      const hostKey = isEnabledKey ? key.slice(0, -'_enabled'.length) : key;
      const normalizedHost = normalizeHostname(hostKey);
      const canonicalKey = normalizedHost
        ? `${normalizedHost}${isEnabledKey ? '_enabled' : ''}`
        : null;

      if (!normalizedHost || !importedHosts.has(normalizedHost) || key !== canonicalKey) {
        keysToRemove.add(key);
      }
    }

    return Array.from(keysToRemove);
  }

  function getManagedStorageKeys(allItems) {
    const items = isPlainObject(allItems) ? allItems : {};
    const managedKeys = new Set();

    for (const [key, value] of Object.entries(items)) {
      if (isInternalStorageKey(key) || key.startsWith('draft:')) continue;

      if (key.endsWith('_enabled')) {
        const hostKey = key.slice(0, -'_enabled'.length);
        if (normalizeHostname(hostKey)) managedKeys.add(key);
        continue;
      }

      if (typeof value !== 'string' || !normalizeHostname(key)) continue;
      managedKeys.add(key);
      const enabledKey = `${key}_enabled`;
      if (Object.prototype.hasOwnProperty.call(items, enabledKey)) {
        managedKeys.add(enabledKey);
      }
    }

    return Array.from(managedKeys);
  }

  function extractManagedHostItems(allItems) {
    const managedItems = Object.create(null);
    const items = isPlainObject(allItems) ? allItems : {};
    getManagedStorageKeys(items).forEach((key) => {
      managedItems[key] = items[key];
    });

    return managedItems;
  }

  function buildPostImportStorage(currentItems, nextItems) {
    const postImportItems = Object.assign(Object.create(null), currentItems || {});
    for (const key of getManagedStorageKeys(postImportItems)) {
      delete postImportItems[key];
    }
    Object.assign(postImportItems, nextItems || {});
    return postImportItems;
  }

  function createRestoreKeySet(leftItems, rightItems) {
    return Array.from(new Set([
      ...Object.keys(leftItems || {}),
      ...Object.keys(rightItems || {})
    ]));
  }

  function assertStorageLimits(items, limits) {
    const maxItems = limits && limits.maxItems;
    const quotaBytes = limits && limits.quotaBytes;
    const keyCount = Object.keys(items).length;
    if (Number.isFinite(maxItems) && maxItems > 0 && keyCount > maxItems) {
      throw new Error(`Import too large: ${keyCount} keys exceeds limit ${maxItems}.`);
    }

    if (!Number.isFinite(quotaBytes) || quotaBytes <= 0) {
      return;
    }

    const { totalBytes, maxItemBytes } = estimateStorageUsage(items);
    if (totalBytes > quotaBytes) {
      throw new Error(`Import too large: ${totalBytes} bytes exceeds local storage limit.`);
    }
    if (maxItemBytes > quotaBytes) {
      throw new Error('Import too large: one item exceeds local storage limit.');
    }
  }

  function canWriteImportBeforeCleanup(currentItems, nextItems, limits) {
    const transientItems = Object.assign(Object.create(null), currentItems || {}, nextItems || {});
    try {
      assertStorageLimits(transientItems, limits);
      return true;
    } catch {
      return false;
    }
  }

  function getImportFileSizeLimit(quotaBytes, configuredMinimum = 1024 * 1024) {
    const hardCap = 192 * 1024 * 1024;
    const requestedMinimum = Number.isFinite(configuredMinimum) && configuredMinimum > 0
      ? configuredMinimum
      : (1024 * 1024);
    const minimum = Math.min(requestedMinimum, hardCap);
    if (!Number.isFinite(quotaBytes) || quotaBytes <= 0) return minimum;

    const derivedLimit = Math.min(
      (quotaBytes * 16) + (4 * 1024 * 1024),
      hardCap
    );
    return Math.max(minimum, Math.ceil(derivedLimit));
  }

  function getImportFailureMessage(errorMessage, localMutated, rollbackSucceeded) {
    const message = typeof errorMessage === 'string' && errorMessage
      ? errorMessage
      : 'Import failed.';
    if (!localMutated) return message;
    if (rollbackSucceeded) return `${message} Previous state was restored.`;
    return `${message} Warning: automatic rollback did not complete; restore a backup before continuing.`;
  }

  function chunkObjectEntries(items, chunkSize) {
    const entries = Object.entries(items);
    const chunks = [];
    for (let index = 0; index < entries.length; index += chunkSize) {
      const chunkEntries = entries.slice(index, index + chunkSize);
      const chunkItems = Object.create(null);
      for (const [key, value] of chunkEntries) {
        chunkItems[key] = value;
      }
      chunks.push(chunkItems);
    }
    return chunks;
  }

  function chunkArray(values, chunkSize) {
    const chunks = [];
    for (let index = 0; index < values.length; index += chunkSize) {
      chunks.push(values.slice(index, index + chunkSize));
    }
    return chunks;
  }

  function cloneStorageItems(items) {
    return Object.assign(Object.create(null), items || {});
  }

  function getExtensionVersion() {
    try {
      return root.chrome && root.chrome.runtime && root.chrome.runtime.getManifest
        ? (root.chrome.runtime.getManifest().version || null)
        : null;
    } catch {
      return null;
    }
  }

  function createExportFilename() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    return `custom-css-injector-config-${year}${month}${day}-${hours}${minutes}${seconds}.json`;
  }

  root.CSSInjectorPopupStorageHelpers = {
    isPlainObject,
    normalizeHostname,
    isInternalStorageKey,
    getHostEntriesFromStorage,
    buildExportPayload,
    parseImportPayload,
    buildKeysToRemove,
    getManagedStorageKeys,
    extractManagedHostItems,
    buildPostImportStorage,
    createRestoreKeySet,
    canWriteImportBeforeCleanup,
    getImportFileSizeLimit,
    getImportFailureMessage,
    assertStorageLimits,
    estimateStorageUsage,
    chunkObjectEntries,
    chunkArray,
    cloneStorageItems,
    getExtensionVersion,
    createExportFilename
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
