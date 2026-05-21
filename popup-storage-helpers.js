(function (root) {
  'use strict';

  const localTextEncoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

  function getUtils() {
    return typeof root.CSSInjectorUtils !== 'undefined' ? root.CSSInjectorUtils : null;
  }

  function isPlainObject(value) {
    const u = getUtils();
    if (u && typeof u.isPlainObject === 'function') {
      return u.isPlainObject(value);
    }
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function normalizeHostname(value) {
    if (typeof value !== 'string') return null;
    const trimmedValue = value.trim();
    if (!trimmedValue) return null;
    if (/[/\\?#]/.test(trimmedValue)) return null;
    try {
      const parsed = new URL(`http://${trimmedValue}`);
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
    const keysToRemove = [];
    const existingEntries = getHostEntriesFromStorage(allItems);

    for (const entry of existingEntries) {
      if (importedHosts.has(entry.host)) {
        continue;
      }
      keysToRemove.push(entry.storageKey, `${entry.storageKey}_enabled`);
    }

    return keysToRemove;
  }

  function extractManagedHostItems(allItems) {
    const managedItems = Object.create(null);
    const existingEntries = getHostEntriesFromStorage(allItems);

    existingEntries.forEach((entry) => {
      managedItems[entry.storageKey] = entry.css;
      managedItems[`${entry.storageKey}_enabled`] = entry.enabled;
    });

    return managedItems;
  }

  function createRestoreKeySet(leftItems, rightItems) {
    return Array.from(new Set([
      ...Object.keys(leftItems || {}),
      ...Object.keys(rightItems || {})
    ]));
  }

  function getUtf8Size(value) {
    const u = getUtils();
    if (u && typeof u.getUtf8Size === 'function') {
      return u.getUtf8Size(value);
    }
    const text = String(value);
    if (localTextEncoder) {
      return localTextEncoder.encode(text).length;
    }
    try {
      return unescape(encodeURIComponent(text)).length;
    } catch {
      return text.length;
    }
  }

  function estimateStorageUsage(items) {
    const u = getUtils();
    if (u && typeof u.estimateStorageUsage === 'function') {
      return u.estimateStorageUsage(items);
    }
    let totalBytes = 0;
    let maxItemBytes = 0;
    for (const [key, value] of Object.entries(items || {})) {
      const serializedValue = JSON.stringify(value);
      const itemBytes = getUtf8Size(key) + getUtf8Size(serializedValue);
      totalBytes += itemBytes;
      if (itemBytes > maxItemBytes) {
        maxItemBytes = itemBytes;
      }
    }
    return { totalBytes, maxItemBytes };
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
    const transientItems = Object.assign({}, currentItems || {}, nextItems || {});
    try {
      assertStorageLimits(transientItems, limits);
      return true;
    } catch {
      return false;
    }
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
    extractManagedHostItems,
    createRestoreKeySet,
    canWriteImportBeforeCleanup,
    assertStorageLimits,
    estimateStorageUsage,
    chunkObjectEntries,
    chunkArray,
    cloneStorageItems,
    getExtensionVersion,
    createExportFilename
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
