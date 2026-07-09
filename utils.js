(function () {
  'use strict';

  const root = typeof globalThis !== 'undefined'
    ? globalThis
    : (typeof window !== 'undefined' ? window : this);
  const sharedTextEncoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

  function withTimeout(promise, ms, errorMessage) {
    let timeoutId;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(errorMessage || 'Operation timed out')), ms);
      })
    ]).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    });
  }

  function getStorageArea(area) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage[area]) {
      return null;
    }
    return chrome.storage[area];
  }

  function getStorageTimeoutMs(timeoutMs) {
    if (typeof timeoutMs === 'number' && timeoutMs > 0) return timeoutMs;
    if (typeof root.CSSInjectorConstants !== 'undefined' &&
        root.CSSInjectorConstants.STORAGE &&
        typeof root.CSSInjectorConstants.STORAGE.TIMEOUT_MS === 'number') {
      return root.CSSInjectorConstants.STORAGE.TIMEOUT_MS;
    }
    return 5000;
  }

  function getErrorMessage(error, fallbackMessage) {
    if (error instanceof Error && typeof error.message === 'string' && error.message.trim()) {
      return error.message.trim();
    }
    if (error && typeof error.message === 'string' && error.message.trim()) {
      return error.message.trim();
    }
    if (typeof error === 'string' && error.trim()) {
      return error.trim();
    }

    try {
      const serialized = JSON.stringify(error);
      if (typeof serialized === 'string' && serialized !== '{}' && serialized !== 'null') {
        return serialized;
      }
    } catch {
    }

    return fallbackMessage || 'Unknown error';
  }

  function normalizeRuntimeError(error, fallbackMessage) {
    if (error instanceof Error) {
      return error;
    }
    return new Error(getErrorMessage(error, fallbackMessage));
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  function createHostState(host, css, enabled) {
    return {
      host,
      css: typeof css === 'string' ? css : '',
      enabled: enabled !== false
    };
  }

  function extractHostStateFromStorage(host, data) {
    const items = isPlainObject(data) ? data : {};
    return createHostState(
      host,
      typeof items[host] === 'string' ? items[host] : '',
      items[`${host}_enabled`] !== false
    );
  }

  function getHostStateItems(state) {
    return {
      [state.host]: state.css,
      [`${state.host}_enabled`]: state.enabled
    };
  }

  function isSameHostState(leftState, rightState) {
    return !!leftState &&
      !!rightState &&
      leftState.css === rightState.css &&
      leftState.enabled === rightState.enabled;
  }

  function getProtocol(url) {
    try {
      return new URL(url).protocol;
    } catch {
      return null;
    }
  }

  function urlIsExtensionGalleryOrSimilar(url) {
    try {
      const u = new URL(url);
      const h = u.hostname;
      const p = u.pathname;
      if (h === 'chrome.google.com' && p.startsWith('/webstore')) {
        return true;
      }
      if (h === 'chromewebstore.google.com') {
        return true;
      }
      if (h === 'microsoftedge.microsoft.com' && p.includes('/addons')) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  function getUtf8Size(value) {
    const text = String(value);

    if (sharedTextEncoder) {
      return sharedTextEncoder.encode(text).length;
    }

    try {
      return unescape(encodeURIComponent(text)).length;
    } catch {
      return text.length;
    }
  }

  function estimateStorageUsage(items) {
    let totalBytes = 0;
    let maxItemBytes = 0;

    for (const [key, value] of Object.entries(isPlainObject(items) ? items : {})) {
      const serializedValue = JSON.stringify(value);
      const itemBytes = getUtf8Size(key) + getUtf8Size(serializedValue);
      totalBytes += itemBytes;
      if (itemBytes > maxItemBytes) {
        maxItemBytes = itemBytes;
      }
    }

    return { totalBytes, maxItemBytes };
  }

  function countLines(value) {
    const text = typeof value === 'string' ? value : '';
    let lineCount = 1;

    for (let index = 0; index < text.length; index++) {
      if (text.charCodeAt(index) === 10) {
        lineCount += 1;
      }
    }

    return lineCount;
  }

  function isCssNameCode(code) {
    return code >= 128 ||
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 45 ||
      code === 95;
  }

  function consumeCssIdentifierEscape(text, startIndex) {
    let index = startIndex + 1;
    if (index >= text.length) return { valid: false, value: '', nextIndex: index };

    const firstCode = text.charCodeAt(index);
    if (firstCode === 10 || firstCode === 12 || firstCode === 13) {
      return { valid: false, value: '', nextIndex: index + 1 };
    }

    let hexadecimal = '';
    while (index < text.length && hexadecimal.length < 6) {
      const code = text.charCodeAt(index);
      const isHexadecimal =
        (code >= 48 && code <= 57) ||
        (code >= 65 && code <= 70) ||
        (code >= 97 && code <= 102);
      if (!isHexadecimal) break;
      hexadecimal += text[index];
      index += 1;
    }

    if (hexadecimal) {
      if (index < text.length) {
        const whitespaceCode = text.charCodeAt(index);
        if (whitespaceCode === 13 && text.charCodeAt(index + 1) === 10) {
          index += 2;
        } else if (whitespaceCode === 9 || whitespaceCode === 10 ||
            whitespaceCode === 12 || whitespaceCode === 13 || whitespaceCode === 32) {
          index += 1;
        }
      }
      const codePoint = Number.parseInt(hexadecimal, 16);
      const normalizedCodePoint = codePoint === 0 || codePoint > 0x10FFFF
        ? 0xFFFD
        : codePoint;
      return {
        valid: true,
        value: String.fromCodePoint(normalizedCodePoint),
        nextIndex: index
      };
    }

    return { valid: true, value: text[index], nextIndex: index + 1 };
  }

  function hasTopLevelCssImport(value) {
    if (typeof value !== 'string' || !value) return false;

    let braceDepth = 0;
    let parenthesisDepth = 0;
    let bracketDepth = 0;

    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      const nextCharacter = value[index + 1];

      if (character === '/' && nextCharacter === '*') {
        const commentEnd = value.indexOf('*/', index + 2);
        if (commentEnd === -1) return false;
        index = commentEnd + 1;
        continue;
      }

      if (character === '"' || character === "'") {
        const quote = character;
        for (index += 1; index < value.length; index += 1) {
          if (value[index] === '\\') {
            if (value[index + 1] === '\r' && value[index + 2] === '\n') {
              index += 2;
            } else {
              index += 1;
            }
            continue;
          }
          if (value[index] === quote) break;
        }
        continue;
      }

      if (character === '\\') {
        if (nextCharacter === '\r' && value[index + 2] === '\n') {
          index += 2;
        } else {
          index += 1;
        }
        continue;
      }

      if (character === '{') {
        braceDepth += 1;
        continue;
      }
      if (character === '}') {
        braceDepth = Math.max(0, braceDepth - 1);
        continue;
      }
      if (character === '(') {
        parenthesisDepth += 1;
        continue;
      }
      if (character === ')') {
        parenthesisDepth = Math.max(0, parenthesisDepth - 1);
        continue;
      }
      if (character === '[') {
        bracketDepth += 1;
        continue;
      }
      if (character === ']') {
        bracketDepth = Math.max(0, bracketDepth - 1);
        continue;
      }

      if (character !== '@' || braceDepth !== 0 ||
          parenthesisDepth !== 0 || bracketDepth !== 0) {
        continue;
      }

      let identifier = '';
      let cursor = index + 1;
      while (cursor < value.length) {
        const code = value.charCodeAt(cursor);
        if (isCssNameCode(code)) {
          identifier += value[cursor];
          cursor += 1;
          continue;
        }
        if (value[cursor] === '\\') {
          const escape = consumeCssIdentifierEscape(value, cursor);
          if (!escape.valid) break;
          identifier += escape.value;
          cursor = escape.nextIndex;
          continue;
        }
        break;
      }

      if (identifier.toLowerCase() === 'import') return true;
      index = Math.max(index, cursor - 1);
    }

    return false;
  }

  const exposedUtils = {
    getCurrentHostname: function () {
      try {
        return window.location.hostname;
      } catch (e) {
        return null;
      }
    },

    getHostname: function (url) {
      try {
        return new URL(url).hostname;
      } catch {
        return null;
      }
    },

    getProtocol: function (url) {
      return getProtocol(url);
    },

    isScriptableUrl: function (url) {
      const protocol = getProtocol(url);
      if (protocol !== 'http:' && protocol !== 'https:') {
        return false;
      }
      return !urlIsExtensionGalleryOrSimilar(url);
    },

    withTimeout: function (promise, ms, errorMessage) {
      return withTimeout(promise, ms, errorMessage);
    },

    storageGet: function (area, keys, timeoutMs) {
      const storageArea = getStorageArea(area);
      if (!storageArea || typeof storageArea.get !== 'function') {
        return Promise.reject(new Error(`Storage area unavailable: ${area}`));
      }
      const resolvedTimeout = getStorageTimeoutMs(timeoutMs);
      return withTimeout(new Promise((resolve, reject) => {
        storageArea.get(keys, (items) => {
          const error = chrome.runtime && chrome.runtime.lastError;
          if (error) {
            reject(normalizeRuntimeError(error, 'Storage read failed'));
            return;
          }
          resolve(items || {});
        });
      }), resolvedTimeout, 'Storage read timed out');
    },

    storageSet: function (area, items, timeoutMs) {
      const storageArea = getStorageArea(area);
      if (!storageArea || typeof storageArea.set !== 'function') {
        return Promise.reject(new Error(`Storage area unavailable: ${area}`));
      }
      const resolvedTimeout = getStorageTimeoutMs(timeoutMs);
      return withTimeout(new Promise((resolve, reject) => {
        storageArea.set(items, () => {
          const error = chrome.runtime && chrome.runtime.lastError;
          if (error) {
            reject(normalizeRuntimeError(error, 'Storage write failed'));
            return;
          }
          resolve();
        });
      }), resolvedTimeout, 'Storage write timed out');
    },

    storageRemove: function (area, keys, timeoutMs) {
      const storageArea = getStorageArea(area);
      if (!storageArea || typeof storageArea.remove !== 'function') {
        return Promise.reject(new Error(`Storage area unavailable: ${area}`));
      }
      const resolvedTimeout = getStorageTimeoutMs(timeoutMs);
      return withTimeout(new Promise((resolve, reject) => {
        storageArea.remove(keys, () => {
          const error = chrome.runtime && chrome.runtime.lastError;
          if (error) {
            reject(normalizeRuntimeError(error, 'Storage remove failed'));
            return;
          }
          resolve();
        });
      }), resolvedTimeout, 'Storage remove timed out');
    },

    isPlainObject: function (value) {
      return isPlainObject(value);
    },

    createHostState: function (host, css, enabled) {
      return createHostState(host, css, enabled);
    },

    extractHostStateFromStorage: function (host, data) {
      return extractHostStateFromStorage(host, data);
    },

    getHostStateItems: function (state) {
      return getHostStateItems(state);
    },

    isSameHostState: function (leftState, rightState) {
      return isSameHostState(leftState, rightState);
    },

    getUtf8Size: function (value) {
      return getUtf8Size(value);
    },

    estimateStorageUsage: function (items) {
      return estimateStorageUsage(items);
    },

    countLines: function (value) {
      return countLines(value);
    },

    hasTopLevelCssImport: function (value) {
      return hasTopLevelCssImport(value);
    },

    getErrorMessage: function (error, fallbackMessage) {
      return getErrorMessage(error, fallbackMessage);
    },

    normalizeRuntimeError: function (error, fallbackMessage) {
      return normalizeRuntimeError(error, fallbackMessage);
    }
  };

  root.CSSInjectorUtils = exposedUtils;
  if (typeof window !== 'undefined') {
    window.CSSInjectorUtils = exposedUtils;
  }
})();
