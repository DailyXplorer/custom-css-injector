const cssInjectorUtils = typeof CSSInjectorUtils !== 'undefined' ? CSSInjectorUtils : null;
const STORAGE_AREA = 'local';

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function getHostname(url) {
  if (cssInjectorUtils && typeof cssInjectorUtils.getHostname === 'function') {
    return cssInjectorUtils.getHostname(url);
  }
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function getProtocol(url) {
  if (cssInjectorUtils && typeof cssInjectorUtils.getProtocol === 'function') {
    return cssInjectorUtils.getProtocol(url);
  }
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

function isScriptableUrl(url) {
  if (cssInjectorUtils && typeof cssInjectorUtils.isScriptableUrl === 'function') {
    return cssInjectorUtils.isScriptableUrl(url);
  }
  if (!url) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname;
    const p = u.pathname;
    if (h === 'chrome.google.com' && p.startsWith('/webstore')) return false;
    if (h === 'chromewebstore.google.com') return false;
    if (h === 'microsoftedge.microsoft.com' && p.includes('/addons')) return false;
    return true;
  } catch {
    return false;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const editor = document.getElementById('css-editor');
  const lineNumbers = document.getElementById('line-numbers');
  const toggleCss = document.getElementById('toggle-css');
  const resetBtn = document.getElementById('reset-btn');
  const copyBtn = document.getElementById('copy-btn');
  const exportBtn = document.getElementById('export-btn');
  const importBtn = document.getElementById('import-btn');
  const copyIcon = document.getElementById('copy-icon');
  const exportIcon = document.getElementById('export-icon');
  const importIcon = document.getElementById('import-icon');
  const importFileInput = document.getElementById('import-file');
  const configToast = document.getElementById('config-toast');
  const toggleLabel = document.querySelector('.toggle-label');
  const versionText = document.getElementById('version-text');
  const whatsNewBtn = document.getElementById('whats-new-btn');
  const extensionConstants = typeof CSSInjectorConstants !== 'undefined' ? CSSInjectorConstants : {};
  const saveConstants = extensionConstants.SAVE || {};
  const uiConstants = extensionConstants.UI || {};
  const colorConstants = extensionConstants.COLORS || {};
  const STORAGE_TIMEOUT_MS = typeof (extensionConstants.STORAGE || {}).TIMEOUT_MS === 'number'
    ? extensionConstants.STORAGE.TIMEOUT_MS
    : 5000;

  const LIVE_APPLY_DELAY_MS = typeof saveConstants.LIVE_APPLY_DELAY_MS === 'number' ? saveConstants.LIVE_APPLY_DELAY_MS : 200;
  const PERSIST_DELAY_MS = typeof saveConstants.PERSIST_DELAY_MS === 'number' ? saveConstants.PERSIST_DELAY_MS : 350;

  if ((versionText && !versionText.textContent) || whatsNewBtn) {
    try {
      const data = chrome.runtime.getManifest();
      if (versionText && !versionText.textContent) {
        versionText.textContent = `v${data.version}`;
      }
      if (whatsNewBtn) {
        whatsNewBtn.textContent = `New v${data.version}`;
      }
    } catch {
    }
  }

  const LOCAL_QUOTA_BYTES = (chrome.storage && chrome.storage.local && chrome.storage.local.QUOTA_BYTES) || (10 * 1024 * 1024);
  const LOCAL_MAX_ITEMS = (chrome.storage && chrome.storage.local && Number.isFinite(chrome.storage.local.MAX_ITEMS))
    ? chrome.storage.local.MAX_ITEMS
    : null;

  let currentHost = null;
  let currentTabId = null;
  let currentTabUrl = null;
  let currentTabScriptable = false;
  let currentCss = '';
  let loadRequestId = 0;
  let uiMutationLocked = false;
  let activeContextRefreshTimer = null;
  let lastLineCount = 0;
  let lineNumberUpdateTimer = null;
  let pendingForceLineNumberRebuild = false;
  let scrollbarMetricsTimerId = null;
  let lastReservedScrollbarWidth = -1;
  let lastReservedScrollbarHeight = -1;
  let scrollbarMetricsRemeasureCount = 0;

  const configTransfer = {
    FILE_TYPE: 'custom-css-injector-config',
    SCHEMA_VERSION: 1,
    TOAST_DURATION_MS: 3500,
    BUTTON_FEEDBACK_MS: 1000,
    MAX_IMPORT_FILE_BYTES: typeof saveConstants.MAX_IMPORT_FILE_BYTES === 'number' ? saveConstants.MAX_IMPORT_FILE_BYTES : (1024 * 1024),
    WRITE_CHUNK_SIZE: 80,
    REMOVE_CHUNK_SIZE: 150
  };

  const storageHelpers = typeof CSSInjectorPopupStorageHelpers !== 'undefined'
    ? CSSInjectorPopupStorageHelpers
    : null;

  if (!storageHelpers) {
    console.error('[CSS Injector] Missing CSSInjectorPopupStorageHelpers (popup-storage-helpers.js).');
    return;
  }

  let configToastTimer = null;
  let configTransferInProgress = false;
  const SHADOW_BRIDGE_SCRIPT_FILES = ['shadow-dom-bridge.js'];
  const CONTENT_SCRIPT_FILES = ['utils.js', 'constants.js', 'content-script.js'];
  const CONTENT_SCRIPT_RUNTIME_KEY = '__CSSInjectorContentScriptRuntime';
  const contentScriptInjectionTasks = new Map();

  const lastPersistedByHost = Object.create(null);

  let persistTimer = null;
  let applyTimer = null;
  let pendingPayload = null;
  let persistPromise = null;
  let persistQueue = Promise.resolve();
  let queuedPersistWriteCount = 0;

  function countEditorLines(value) {
    if (cssInjectorUtils && typeof cssInjectorUtils.countLines === 'function') {
      return cssInjectorUtils.countLines(value);
    }
    const text = typeof value === 'string' ? value : '';
    let lineCount = 1;
    for (let index = 0; index < text.length; index++) {
      if (text.charCodeAt(index) === 10) {
        lineCount += 1;
      }
    }
    return lineCount;
  }

  function setLineNumbersText(lineCount) {
    const n = Math.max(1, lineCount | 0);
    const parts = new Array(n);
    for (let i = 0; i < n; i += 1) {
      parts[i] = String(i + 1);
    }
    lineNumbers.textContent = parts.join('\n');
  }

  function updateLineNumbers(forceFullRebuild = false) {
    pendingForceLineNumberRebuild = pendingForceLineNumberRebuild || forceFullRebuild;
    clearTimeout(lineNumberUpdateTimer);
    lineNumberUpdateTimer = setTimeout(() => {
      lineNumberUpdateTimer = null;
      const lineCount = countEditorLines(editor.value);
      const shouldForceFullRebuild = pendingForceLineNumberRebuild;
      pendingForceLineNumberRebuild = false;

      if (!shouldForceFullRebuild && lineCount === lastLineCount) {
        return;
      }

      setLineNumbersText(lineCount);
      lastLineCount = lineCount;
      syncScroll();
      scheduleScrollbarMetricsUpdate(true);
    }, forceFullRebuild ? 0 : 50);
  }

  function setEditorValue(nextValue) {
    const normalizedValue = typeof nextValue === 'string' ? nextValue : '';
    if (editor.value === normalizedValue) {
      return false;
    }
    editor.value = normalizedValue;
    return true;
  }

  function updateScrollbarMetrics(followUpMeasurement = false) {
    const MIN_VERTICAL_SCROLLBAR_WIDTH = 14;
    const MIN_HORIZONTAL_SCROLLBAR_HEIGHT = 10;
    const styles = window.getComputedStyle(editor);
    const borderLeft = parseFloat(styles.borderLeftWidth) || 0;
    const borderRight = parseFloat(styles.borderRightWidth) || 0;
    const borderTop = parseFloat(styles.borderTopWidth) || 0;
    const borderBottom = parseFloat(styles.borderBottomWidth) || 0;

    const scrollbarWidth = Math.max(
      0,
      editor.offsetWidth - editor.clientWidth - borderLeft - borderRight
    );
    const scrollbarHeight = Math.max(
      0,
      editor.offsetHeight - editor.clientHeight - borderTop - borderBottom
    );

    const hasVerticalOverflow = editor.scrollHeight > (editor.clientHeight + 1);
    const hasHorizontalOverflow = editor.scrollWidth > (editor.clientWidth + 1);
    const needsRightSafeArea = hasVerticalOverflow || hasHorizontalOverflow;

    const reservedScrollbarWidth = needsRightSafeArea
      ? Math.max(scrollbarWidth, MIN_VERTICAL_SCROLLBAR_WIDTH)
      : 0;
    const reservedScrollbarHeight = hasHorizontalOverflow
      ? Math.max(scrollbarHeight, MIN_HORIZONTAL_SCROLLBAR_HEIGHT)
      : 0;

    const metricsChanged = (
      reservedScrollbarWidth !== lastReservedScrollbarWidth ||
      reservedScrollbarHeight !== lastReservedScrollbarHeight
    );

    if (!metricsChanged) {
      if (followUpMeasurement) {
        scrollbarMetricsRemeasureCount = 0;
      }
      return;
    }

    lastReservedScrollbarWidth = reservedScrollbarWidth;
    lastReservedScrollbarHeight = reservedScrollbarHeight;

    document.documentElement.style.setProperty('--editor-scrollbar-width', `${reservedScrollbarWidth}px`);
    document.documentElement.style.setProperty('--editor-scrollbar-height', `${reservedScrollbarHeight}px`);

    if (scrollbarMetricsRemeasureCount >= 1) {
      scrollbarMetricsRemeasureCount = 0;
      return;
    }

    scrollbarMetricsRemeasureCount += 1;
    scheduleScrollbarMetricsUpdate(false, { followUp: true });
  }

  function scheduleScrollbarMetricsUpdate(immediate = false, options = {}) {
    const followUp = options.followUp === true;
    if (!followUp) {
      scrollbarMetricsRemeasureCount = 0;
    }

    if (immediate) {
      if (scrollbarMetricsTimerId !== null) {
        clearTimeout(scrollbarMetricsTimerId);
        scrollbarMetricsTimerId = null;
      }
      updateScrollbarMetrics(followUp);
      return;
    }

    clearTimeout(scrollbarMetricsTimerId);
    scrollbarMetricsTimerId = setTimeout(() => {
      scrollbarMetricsTimerId = null;
      updateScrollbarMetrics(followUp);
    }, 80);
  }

  function syncScroll() {
    lineNumbers.scrollTop = editor.scrollTop;
  }

  function updateEditor(state) {
    currentTabScriptable = state.scriptable === true;

    if (state.disabled) {
      setEditorValue('');
      currentCss = '';
      editor.placeholder = state.placeholder || 'No active tab detected.';
      editor.disabled = true;
      currentHost = null;
      currentTabId = null;
      currentTabUrl = null;
      updateLineNumbers(true);
      scheduleScrollbarMetricsUpdate();
      return;
    }

    editor.disabled = false;
    editor.placeholder = state.placeholder || 'Enter your CSS here…';
    currentCss = state.css || '';
    setEditorValue(currentCss);
    updateLineNumbers(true);
    scheduleScrollbarMetricsUpdate();
  }

  function updateToggle(state) {
    if (state.disabled) {
      toggleCss.disabled = true;
      toggleCss.checked = false;
      toggleLabel.textContent = 'Disabled';
      return;
    }

    toggleCss.disabled = false;
    toggleCss.checked = state.enabled !== false;
    toggleLabel.textContent = state.enabled !== false ? 'Enabled' : 'Disabled';
  }

  function updateUI(state) {
    updateEditor(state);
    updateToggle(state);
    applyUiMutationState();
  }

  function applyUiMutationState() {
    const baseUiDisabled = editor.disabled || !currentHost || !currentTabScriptable;

    editor.readOnly = uiMutationLocked || editor.disabled;
    toggleCss.disabled = baseUiDisabled || uiMutationLocked;
    resetBtn.disabled = baseUiDisabled || uiMutationLocked;
    copyBtn.disabled = baseUiDisabled || uiMutationLocked;

    if (exportBtn) {
      exportBtn.disabled = uiMutationLocked;
    }
    if (importBtn) {
      importBtn.disabled = uiMutationLocked;
    }
  }

  function setUiMutationLocked(isLocked) {
    uiMutationLocked = isLocked === true;
    applyUiMutationState();
  }

  function applyUiConstants() {
    const rootStyle = document.documentElement.style;
    const setCssVar = (name, value) => {
      if (typeof value !== 'string' || !value) return;
      rootStyle.setProperty(name, value);
    };

    setCssVar('--editor-height', uiConstants.EDITOR_HEIGHT);
    setCssVar('--line-numbers-width', uiConstants.LINE_NUMBERS_WIDTH);
    setCssVar('--icon-size-small', uiConstants.ICON_SIZE_SMALL);
    setCssVar('--icon-size-normal', uiConstants.ICON_SIZE_NORMAL);
    setCssVar('--primary-color', colorConstants.PRIMARY);
    setCssVar('--primary-hover', colorConstants.PRIMARY_HOVER);
    setCssVar('--success-color', colorConstants.SUCCESS);
    setCssVar('--error-color', colorConstants.ERROR);
  }

  const errorHandler = {
    logError(context, error) {
      console.error(`[CSS Injector] ${context}:`, error);
    },
    logSuccess(message) {
      console.log(`[CSS Injector] ${message}`);
    }
  };

  function clearConfigToast() {
    clearTimeout(configToastTimer);
    configToastTimer = null;
    if (!configToast) return;
    configToast.textContent = '';
    configToast.className = 'config-toast';
  }

  function showConfigToast(message, state = 'info', options = {}) {
    if (!configToast) return;
    const { persistent = false } = options;

    clearConfigToast();
    configToast.textContent = message;
    configToast.className = 'config-toast';
    configToast.classList.add('is-visible');

    if (state === 'success') {
      configToast.classList.add('is-success');
    } else if (state === 'error') {
      configToast.classList.add('is-error');
    } else if (state === 'warning') {
      configToast.classList.add('is-warning');
    }

    if (persistent) {
      return;
    }

    configToastTimer = setTimeout(() => {
      clearConfigToast();
    }, configTransfer.TOAST_DURATION_MS);
  }

  function getIconSource(iconElement) {
    if (!iconElement) return '';
    return iconElement.getAttribute('src') || iconElement.getAttribute('data-src') || '';
  }

  function setIconSource(iconElement, source) {
    if (!iconElement || !source) return;
    iconElement.setAttribute('src', source);
    iconElement.removeAttribute('data-src');
  }

  function flashButtonSuccess(buttonElement, iconElement, fallbackSource) {
    if (!buttonElement || !iconElement) return;

    const originalSource = getIconSource(iconElement) || fallbackSource || '';
    buttonElement.setAttribute('aria-pressed', 'true');
    setIconSource(iconElement, 'assets/icons/check.svg');
    buttonElement.style.color = 'var(--success-color)';

    setTimeout(() => {
      if (originalSource) {
        setIconSource(iconElement, originalSource);
      }
      buttonElement.style.color = '';
      buttonElement.setAttribute('aria-pressed', 'false');
    }, configTransfer.BUTTON_FEEDBACK_MS);
  }

  function createTabContext(tab) {
    const url = tab && typeof tab.url === 'string' ? tab.url : null;
    return {
      id: tab && typeof tab.id === 'number' ? tab.id : null,
      url,
      host: url ? getHostname(url) : null,
      scriptable: isScriptableUrl(url)
    };
  }

  function getCurrentTabContext() {
    return {
      id: currentTabId,
      url: currentTabUrl,
      host: currentHost,
      scriptable: currentTabScriptable
    };
  }

  async function probeContentScriptRuntime(tabContext) {
    const targetContext = tabContext || getCurrentTabContext();
    if (!targetContext || typeof targetContext.id !== 'number' || !targetContext.scriptable) {
      return { ready: false, url: null, allFramesReady: false };
    }

    if (!chrome.scripting || typeof chrome.scripting.executeScript !== 'function') {
      return { ready: false, url: null, allFramesReady: false };
    }

    try {
      const probeResults = await chrome.scripting.executeScript({
        target: { tabId: targetContext.id, allFrames: true },
        func: (runtimeKey) => {
          const runtime = globalThis[runtimeKey];
          return {
            ready: !!runtime && runtime.initialized === true,
            url: window.location.href
          };
        },
        args: [CONTENT_SCRIPT_RUNTIME_KEY]
      });

      const normalizedResults = Array.isArray(probeResults) ? probeResults : [];
      const topFrameResult = normalizedResults.find((result) => result && result.frameId === 0) || normalizedResults[0];
      const allFramesReady = normalizedResults.length > 0 && normalizedResults.every((result) => (
        result && result.result && result.result.ready === true
      ));

      return {
        ready: !!(topFrameResult && topFrameResult.result && topFrameResult.result.ready === true),
        allFramesReady,
        url: topFrameResult && topFrameResult.result ? topFrameResult.result.url : null
      };
    } catch {
      return { ready: false, url: null, allFramesReady: false };
    }
  }

  function getContentScriptInjectionTaskKey(tabContext) {
    const tabId = tabContext && typeof tabContext.id === 'number' ? tabContext.id : 'unknown';
    const tabUrl = tabContext && typeof tabContext.url === 'string' ? tabContext.url : '';
    return `${tabId}:${tabUrl}`;
  }

  async function ensureActiveTabContentScript(tabContext) {
    const targetContext = tabContext || getCurrentTabContext();
    if (!targetContext || typeof targetContext.id !== 'number' || !targetContext.scriptable) {
      return false;
    }

    if (!chrome.scripting || typeof chrome.scripting.executeScript !== 'function') {
      return false;
    }

    const injectionTaskKey = getContentScriptInjectionTaskKey(targetContext);
    const existingTask = contentScriptInjectionTasks.get(injectionTaskKey);
    if (existingTask) {
      return existingTask;
    }

    const injectionTask = (async () => {
      try {
        const activeTab = await getActiveTab();
        const activeTabId = activeTab && typeof activeTab.id === 'number' ? activeTab.id : null;
        const activeTabUrl = activeTab && typeof activeTab.url === 'string' ? activeTab.url : null;
        if (activeTabId !== targetContext.id || activeTabUrl !== targetContext.url) {
          return false;
        }

        const runtimeProbe = await probeContentScriptRuntime(targetContext);
        if (runtimeProbe.ready === true && runtimeProbe.allFramesReady === true && runtimeProbe.url === targetContext.url) {
          return true;
        }

        try {
          await chrome.scripting.executeScript({
            target: { tabId: targetContext.id, allFrames: true },
            injectImmediately: true,
            world: 'MAIN',
            files: SHADOW_BRIDGE_SCRIPT_FILES
          });
        } catch (error) {
          errorHandler.logError('ensureActiveTabShadowBridgeAllFrames', error);
          try {
            await chrome.scripting.executeScript({
              target: { tabId: targetContext.id },
              injectImmediately: true,
              world: 'MAIN',
              files: SHADOW_BRIDGE_SCRIPT_FILES
            });
          } catch (fallbackError) {
            errorHandler.logError('ensureActiveTabShadowBridge', fallbackError);
          }
        }

        try {
          await chrome.scripting.executeScript({
            target: { tabId: targetContext.id, allFrames: true },
            injectImmediately: true,
            files: CONTENT_SCRIPT_FILES
          });
        } catch (error) {
          errorHandler.logError('ensureActiveTabContentScriptAllFrames', error);
          await chrome.scripting.executeScript({
            target: { tabId: targetContext.id },
            injectImmediately: true,
            files: CONTENT_SCRIPT_FILES
          });
        }
        return true;
      } catch (error) {
        errorHandler.logError('ensureActiveTabContentScript', error);
        return false;
      } finally {
        contentScriptInjectionTasks.delete(injectionTaskKey);
      }
    })();

    contentScriptInjectionTasks.set(injectionTaskKey, injectionTask);
    return injectionTask;
  }

  function getEditablePlaceholder() {
    return 'Enter your CSS here…';
  }

  function getBlockedUrlPlaceholder(url) {
    const protocol = getProtocol(url);
    if (!protocol) {
      return 'Invalid URL';
    }
    return 'This URL cannot be scripted by the extension.';
  }

  const storageLimits = { maxItems: LOCAL_MAX_ITEMS, quotaBytes: LOCAL_QUOTA_BYTES };

  async function setLocalStorageChunked(items) {
    const chunks = storageHelpers.chunkObjectEntries(items, configTransfer.WRITE_CHUNK_SIZE);
    for (const chunkItems of chunks) {
      await storageSet(chunkItems);
    }
  }

  async function removeLocalStorageKeysChunked(keys) {
    const chunks = storageHelpers.chunkArray(keys, configTransfer.REMOVE_CHUNK_SIZE);
    for (const chunkKeys of chunks) {
      await storageRemove(chunkKeys);
    }
  }

  async function restoreManagedLocalState(backupItems, attemptedItems) {
    const keysToClear = storageHelpers.createRestoreKeySet(backupItems, attemptedItems);
    if (keysToClear.length) {
      await removeLocalStorageKeysChunked(keysToClear);
    }
    if (Object.keys(backupItems || {}).length) {
      await setLocalStorageChunked(backupItems);
    }
  }

  function createHostState(host, css, enabled) {
    if (cssInjectorUtils && typeof cssInjectorUtils.createHostState === 'function') {
      return cssInjectorUtils.createHostState(host, css, enabled);
    }
    return {
      host,
      css: typeof css === 'string' ? css : '',
      enabled: enabled !== false
    };
  }

  function extractHostStateFromStorage(host, data) {
    if (cssInjectorUtils && typeof cssInjectorUtils.extractHostStateFromStorage === 'function') {
      return cssInjectorUtils.extractHostStateFromStorage(host, data);
    }
    const items = storageHelpers.isPlainObject(data) ? data : {};
    return createHostState(
      host,
      typeof items[host] === 'string' ? items[host] : '',
      items[`${host}_enabled`] !== false
    );
  }

  function getHostStateItems(state) {
    if (cssInjectorUtils && typeof cssInjectorUtils.getHostStateItems === 'function') {
      return cssInjectorUtils.getHostStateItems(state);
    }
    return {
      [state.host]: state.css,
      [`${state.host}_enabled`]: state.enabled
    };
  }

  function isSameSavedState(leftState, rightState) {
    if (cssInjectorUtils && typeof cssInjectorUtils.isSameHostState === 'function') {
      return cssInjectorUtils.isSameHostState(leftState, rightState);
    }
    return !!leftState &&
      !!rightState &&
      leftState.css === rightState.css &&
      leftState.enabled === rightState.enabled;
  }

  function getErrorMessage(error) {
    if (cssInjectorUtils && typeof cssInjectorUtils.getErrorMessage === 'function') {
      return cssInjectorUtils.getErrorMessage(error);
    }
    if (error && typeof error.message === 'string' && error.message.trim()) {
      return error.message.trim();
    }
    return 'Unknown error';
  }

  async function storageGet(keys) {
    if (cssInjectorUtils && typeof cssInjectorUtils.storageGet === 'function') {
      return cssInjectorUtils.storageGet(STORAGE_AREA, keys, STORAGE_TIMEOUT_MS);
    }
    return new Promise((resolve, reject) => {
      chrome.storage.local.get(keys, (items) => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(err);
          return;
        }
        resolve(items || {});
      });
    });
  }

  async function storageSet(items) {
    if (cssInjectorUtils && typeof cssInjectorUtils.storageSet === 'function') {
      return cssInjectorUtils.storageSet(STORAGE_AREA, items, STORAGE_TIMEOUT_MS);
    }
    return new Promise((resolve, reject) => {
      chrome.storage.local.set(items, () => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  async function storageRemove(keys) {
    if (cssInjectorUtils && typeof cssInjectorUtils.storageRemove === 'function') {
      return cssInjectorUtils.storageRemove(STORAGE_AREA, keys, STORAGE_TIMEOUT_MS);
    }
    return new Promise((resolve, reject) => {
      chrome.storage.local.remove(keys, () => {
        const err = chrome.runtime.lastError;
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  function hasPendingPersistence() {
    return pendingPayload !== null || persistTimer !== null;
  }

  function cancelScheduledPersistence() {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (applyTimer !== null) {
      clearTimeout(applyTimer);
      applyTimer = null;
    }
    pendingPayload = null;
  }

  function scheduleApplyToTab(host, css, enabled) {
    if (applyTimer !== null) {
      clearTimeout(applyTimer);
      applyTimer = null;
    }
    applyTimer = setTimeout(() => {
      applyTimer = null;
      const ctx = getCurrentTabContext();
      if (ctx.host !== host || !ctx.scriptable) return;
      notifyActiveTab({
        type: 'css:apply',
        host,
        css,
        enabled
      }).catch((error) => {
        errorHandler.logError('scheduleApplyToTab', error);
      });
    }, LIVE_APPLY_DELAY_MS);
  }

  async function writeHostState(host, css, enabled) {
    const state = createHostState(host, css, enabled);
    const items = getHostStateItems(state);
    queuedPersistWriteCount += 1;

    const writeTask = persistQueue
      .catch(() => {})
      .then(async () => {
        await storageSet(items);
        lastPersistedByHost[host] = { css: state.css, enabled: state.enabled };
      })
      .finally(() => {
        queuedPersistWriteCount = Math.max(0, queuedPersistWriteCount - 1);
      });

    persistQueue = writeTask.catch(() => {});
    await writeTask;
  }

  async function waitForPersistQueue() {
    await persistQueue.catch(() => {});
  }

  function schedulePersistence(host, css, enabled) {
    pendingPayload = { host, css, enabled };

    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }

    persistTimer = setTimeout(() => {
      persistTimer = null;
      const payload = pendingPayload;
      if (!payload) return;

      persistPromise = (async () => {
        try {
          await writeHostState(payload.host, payload.css, payload.enabled);
          if (pendingPayload &&
              pendingPayload.host === payload.host &&
              pendingPayload.css === payload.css &&
              pendingPayload.enabled === payload.enabled) {
            pendingPayload = null;
          }
        } catch (error) {
          errorHandler.logError('schedulePersistence', error);
          showConfigToast(getErrorMessage(error), 'error');
        } finally {
          persistPromise = null;
        }
      })();
    }, PERSIST_DELAY_MS);

    scheduleApplyToTab(host, css, enabled);
  }

  async function flushPersistence() {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (applyTimer !== null) {
      clearTimeout(applyTimer);
      applyTimer = null;
    }

    const payload = pendingPayload;
    pendingPayload = null;

    if (persistPromise) {
      await persistPromise.catch(() => {});
    }

    await waitForPersistQueue();

    if (!payload || !payload.host) {
      return true;
    }

    try {
      await writeHostState(payload.host, payload.css, payload.enabled);
      const ctx = getCurrentTabContext();
      if (ctx.host === payload.host && ctx.scriptable) {
        await notifyActiveTab({
          type: 'css:apply',
          host: payload.host,
          css: payload.css,
          enabled: payload.enabled
        });
      }
      return true;
    } catch (error) {
      errorHandler.logError('flushPersistence', error);
      showConfigToast(getErrorMessage(error), 'error');
      return false;
    }
  }

  async function refreshCurrentHostState(options = {}) {
    const host = typeof options.host === 'string' && options.host ? options.host : currentHost;
    if (!host || !currentTabScriptable) {
      return null;
    }

    const requestId = typeof options.requestId === 'number' ? options.requestId : null;

    if (hasPendingPersistence() && pendingPayload && pendingPayload.host === host) {
      return null;
    }

    const items = await storageGet([host, `${host}_enabled`]);
    if (requestId !== null && requestId !== loadRequestId) {
      return null;
    }
    if (host !== currentHost) {
      return null;
    }

    const state = extractHostStateFromStorage(host, items);
    lastPersistedByHost[host] = { css: state.css, enabled: state.enabled };

    updateUI({
      disabled: false,
      scriptable: true,
      placeholder: options.placeholder || getEditablePlaceholder(),
      css: state.css,
      enabled: state.enabled
    });

    return state;
  }

  const loadCssForCurrentSite = async (options = {}) => {
    const { tabContext = null, flushPending = true } = options;
    const requestId = ++loadRequestId;
    try {
      if (flushPending) {
        await flushPersistence();
      }
      const resolvedTabContext = tabContext || createTabContext(await getActiveTab());
      if (requestId !== loadRequestId) return;

      if (!resolvedTabContext.url) {
        updateUI({
          disabled: true,
          scriptable: false,
          placeholder: 'No active tab detected.'
        });
        return;
      }

      currentTabId = resolvedTabContext.id;
      currentTabUrl = resolvedTabContext.url;
      currentTabScriptable = resolvedTabContext.scriptable;

      if (!resolvedTabContext.scriptable || !resolvedTabContext.host) {
        cancelScheduledPersistence();
        currentHost = null;
        updateUI({
          disabled: true,
          scriptable: false,
          placeholder: resolvedTabContext.host ? getBlockedUrlPlaceholder(resolvedTabContext.url) : 'Invalid URL'
        });
        return;
      }

      if (currentHost && currentHost !== resolvedTabContext.host) {
        cancelScheduledPersistence();
      }
      currentHost = resolvedTabContext.host;
      await refreshCurrentHostState({
        requestId,
        placeholder: getEditablePlaceholder()
      });
    } catch (error) {
      errorHandler.logError('loadCssForCurrentSite', error);
      updateUI({
        disabled: true,
        scriptable: false,
        placeholder: 'Error loading data'
      });
    }
  };

  async function notifyActiveTab(message, options = {}) {
    const tabContext = options.tabContext || null;
    const allowReinject = options.allowReinject !== false;
    const targetTabId = tabContext && typeof tabContext.id === 'number'
      ? tabContext.id
      : currentTabId;
    const targetTabUrl = tabContext && typeof tabContext.url === 'string'
      ? tabContext.url
      : currentTabUrl;

    if (typeof targetTabId !== 'number') {
      return { ok: false, reason: 'missing-tab' };
    }

    try {
      if (tabContext) {
        if (tabContext.id !== currentTabId || tabContext.url !== currentTabUrl) {
          return { ok: false, reason: 'stale-context' };
        }
      } else {
        const activeTab = await getActiveTab();
        const activeTabId = activeTab && typeof activeTab.id === 'number' ? activeTab.id : null;
        const activeTabUrl = activeTab && typeof activeTab.url === 'string' ? activeTab.url : null;

        if (activeTabId !== targetTabId || activeTabUrl !== targetTabUrl) {
          return { ok: false, reason: 'stale-context' };
        }
      }

      const response = await chrome.tabs.sendMessage(targetTabId, message);
      if (response && response.ok === false) {
        const responseError = typeof response.error === 'string' ? response.error : 'Message rejected';
        if (responseError === 'Host mismatch') {
          return { ok: false, reason: 'host-mismatch', response };
        }
        return {
          ok: false,
          reason: 'rejected',
          response,
          error: new Error(responseError)
        };
      }
      return { ok: true, response };
    } catch (error) {
      if (error.message?.includes('Could not establish connection') ||
          error.message?.includes('Receiving end does not exist')) {
        if (allowReinject && isScriptableUrl(targetTabUrl)) {
          const reinjected = await ensureActiveTabContentScript({
            id: targetTabId,
            url: targetTabUrl,
            host: tabContext && typeof tabContext.host === 'string' ? tabContext.host : getHostname(targetTabUrl),
            scriptable: true
          });
          if (reinjected) {
            return notifyActiveTab(message, Object.assign({}, options, { allowReinject: false }));
          }
        }
        return { ok: false, reason: 'unreachable' };
      }
      errorHandler.logError('notifyActiveTab', error);
      return { ok: false, reason: 'error', error };
    }
  }

  function scheduleActiveContextRefresh() {
    if (configTransferInProgress) return;
    clearTimeout(activeContextRefreshTimer);
    activeContextRefreshTimer = setTimeout(() => {
      activeContextRefreshTimer = null;
      if (configTransferInProgress) return;
      loadCssForCurrentSite().catch((error) => {
        errorHandler.logError('scheduleActiveContextRefresh', error);
      });
    }, 60);
  }

  function triggerDownload(filename, content, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(blobUrl);
  }

  async function handleConfigExport() {
    if (configTransferInProgress) return;

    configTransferInProgress = true;
    setUiMutationLocked(true);
    try {
      await flushPersistence();
      const allItems = await storageGet(null);
      const entries = storageHelpers.getHostEntriesFromStorage(allItems);
      const payload = storageHelpers.buildExportPayload(entries, {
        fileType: configTransfer.FILE_TYPE,
        schemaVersion: configTransfer.SCHEMA_VERSION,
        extensionVersion: storageHelpers.getExtensionVersion()
      });
      const exportJson = JSON.stringify(payload, null, 2);
      triggerDownload(storageHelpers.createExportFilename(), exportJson, 'application/json');

      flashButtonSuccess(exportBtn, exportIcon, 'assets/icons/download.svg');
      showConfigToast(`Export completed (${entries.length} site${entries.length === 1 ? '' : 's'}).`, 'success');
      errorHandler.logSuccess(`Export completed for ${entries.length} site(s)`);
    } catch (error) {
      errorHandler.logError('exportConfig', error);
      const exportErrorMessage = error && error.message ? error.message : 'Export failed. Please try again.';
      showConfigToast(exportErrorMessage, 'error');
    } finally {
      configTransferInProgress = false;
      setUiMutationLocked(false);
    }
  }

  async function handleConfigImport(file) {
    if (!file) return;
    if (configTransferInProgress) return;

    configTransferInProgress = true;
    setUiMutationLocked(true);
    let localMutated = false;
    let backupManagedItems = Object.create(null);
    let attemptedImportItems = Object.create(null);

    try {
      await flushPersistence();

      if (file.size > configTransfer.MAX_IMPORT_FILE_BYTES) {
        throw new Error(`Import file too large (max ${Math.floor(configTransfer.MAX_IMPORT_FILE_BYTES / 1024)} KB).`);
      }

      const fileContent = await file.text();
      const parsedPayload = JSON.parse(fileContent);
      const { itemsToSet, importedHosts } = storageHelpers.parseImportPayload(parsedPayload, {
        fileType: configTransfer.FILE_TYPE,
        schemaVersion: configTransfer.SCHEMA_VERSION
      });
      storageHelpers.assertStorageLimits(itemsToSet, storageLimits);
      attemptedImportItems = storageHelpers.cloneStorageItems(itemsToSet);

      const snapshotBeforeImport = await storageGet(null);
      backupManagedItems = storageHelpers.extractManagedHostItems(snapshotBeforeImport);
      const keysToRemove = storageHelpers.buildKeysToRemove(snapshotBeforeImport, importedHosts);
      const canWriteBeforeCleanup = storageHelpers.canWriteImportBeforeCleanup(
        snapshotBeforeImport,
        itemsToSet,
        storageLimits
      );

      cancelScheduledPersistence();

      if (canWriteBeforeCleanup) {
        if (Object.keys(itemsToSet).length) {
          localMutated = true;
          await setLocalStorageChunked(itemsToSet);
        }
        if (keysToRemove.length) {
          localMutated = true;
          await removeLocalStorageKeysChunked(keysToRemove);
        }
      } else {
        if (Object.keys(backupManagedItems).length) {
          localMutated = true;
          await removeLocalStorageKeysChunked(Object.keys(backupManagedItems));
        }
        if (Object.keys(itemsToSet).length) {
          localMutated = true;
          await setLocalStorageChunked(itemsToSet);
        }
      }

      await loadCssForCurrentSite({ flushPending: false });

      flashButtonSuccess(importBtn, importIcon, 'assets/icons/upload.svg');
      showConfigToast(`Import completed (${importedHosts.size} site${importedHosts.size === 1 ? '' : 's'}).`, 'success');
      errorHandler.logSuccess(`Import completed for ${importedHosts.size} site(s)`);
    } catch (error) {
      if (localMutated) {
        try {
          await restoreManagedLocalState(backupManagedItems, attemptedImportItems);
        } catch (restoreError) {
          errorHandler.logError('restoreManagedLocalState', restoreError);
        }
      }
      errorHandler.logError('importConfig', error);
      const importErrorMessage = error && error.message ? error.message : 'Import failed.';
      const restoredMessage = localMutated
        ? `${importErrorMessage} Previous state restored when possible.`
        : importErrorMessage;
      showConfigToast(restoredMessage, 'error');
    } finally {
      configTransferInProgress = false;
      setUiMutationLocked(false);
      if (importFileInput) {
        importFileInput.value = '';
      }
    }
  }

  function applyEditorMutation(nextCss, options = {}) {
    const {
      selectionStart = null,
      selectionEnd = null,
      shouldScheduleSave = true
    } = options;

    if (typeof nextCss === 'string') {
      setEditorValue(nextCss);
    }

    currentCss = editor.value;
    updateLineNumbers();
    if (typeof selectionStart === 'number' && typeof selectionEnd === 'number') {
      editor.selectionStart = selectionStart;
      editor.selectionEnd = selectionEnd;
    }

    if (shouldScheduleSave && currentHost && !editor.disabled && currentTabScriptable) {
      const last = lastPersistedByHost[currentHost];
      const nextState = createHostState(currentHost, currentCss, toggleCss.checked);
      const hasPendingWriteForCurrentHost =
        (pendingPayload && pendingPayload.host === currentHost) ||
        persistPromise !== null ||
        queuedPersistWriteCount > 0;

      if (last &&
          !hasPendingWriteForCurrentHost &&
          isSameSavedState(createHostState(currentHost, last.css, last.enabled), nextState)) {
        scheduleApplyToTab(currentHost, currentCss, toggleCss.checked);
        return;
      }
      schedulePersistence(currentHost, currentCss, toggleCss.checked);
    }
  }

  let skipNextBlurFlush = false;

  function setupEventHandlers() {
    function persistPendingStateOnClose() {
      flushPersistence().catch((error) => {
        errorHandler.logError('persistPendingStateOnClose', error);
      });
    }

    editor.addEventListener('input', () => {
      if (!currentHost || !currentTabScriptable || uiMutationLocked) return;
      applyEditorMutation(editor.value);
    });

    editor.addEventListener('paste', (e) => {
      if (uiMutationLocked || editor.readOnly || editor.disabled) return;
      if (!currentHost || !currentTabScriptable) return;
      const clip = e.clipboardData || window.clipboardData;
      if (!clip) return;
      const text = clip.getData('text/plain');
      if (text == null) return;
      e.preventDefault();
      const normalized = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      const nextCss = editor.value.slice(0, start) + normalized + editor.value.slice(end);
      const cursor = start + normalized.length;
      applyEditorMutation(nextCss, {
        selectionStart: cursor,
        selectionEnd: cursor
      });
      scheduleScrollbarMetricsUpdate(true);
    });

    editor.addEventListener('blur', () => {
      if (uiMutationLocked) return;
      if (skipNextBlurFlush) {
        skipNextBlurFlush = false;
        return;
      }
      persistPendingStateOnClose();
    });

    editor.addEventListener('scroll', () => {
      syncScroll();
      scheduleScrollbarMetricsUpdate();
    });

    editor.addEventListener('wheel', (e) => {
      const horizontalDelta = Math.abs(e.deltaX) > Math.abs(e.deltaY)
        ? e.deltaX
        : (e.shiftKey ? e.deltaY : 0);

      if (!horizontalDelta) return;

      editor.scrollLeft += horizontalDelta;
      syncScroll();
      scheduleScrollbarMetricsUpdate();
      e.preventDefault();
    }, { passive: false });

    editor.addEventListener('keydown', (e) => {
      if (uiMutationLocked || editor.readOnly) return;
      if (e.key !== 'Tab') return;

      e.preventDefault();
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      const nextCss = editor.value.substring(0, start) + '  ' + editor.value.substring(end);
      const nextCursor = start + 2;

      applyEditorMutation(nextCss, {
        selectionStart: nextCursor,
        selectionEnd: nextCursor
      });
    });

    toggleCss.addEventListener('change', async () => {
      if (!currentHost || !currentTabScriptable || uiMutationLocked) return;
      await flushPersistence();
      if (!currentHost || !currentTabScriptable || uiMutationLocked) return;
      const wasChecked = toggleCss.checked;
      toggleLabel.textContent = wasChecked ? 'Enabled' : 'Disabled';

      try {
        cancelScheduledPersistence();
        await writeHostState(currentHost, currentCss, wasChecked);
        await notifyActiveTab({
          type: 'css:apply',
          host: currentHost,
          css: currentCss,
          enabled: wasChecked
        });
        lastPersistedByHost[currentHost] = { css: currentCss, enabled: wasChecked };
      } catch (error) {
        toggleCss.checked = !wasChecked;
        toggleLabel.textContent = !wasChecked ? 'Enabled' : 'Disabled';
        errorHandler.logError('toggleCss', error);
        showConfigToast(getErrorMessage(error), 'error');
      }
    });

    resetBtn.addEventListener('pointerdown', () => {
      skipNextBlurFlush = true;
    });

    resetBtn.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        skipNextBlurFlush = true;
      }
    });

    resetBtn.addEventListener('click', async () => {
      if (!currentHost || !currentTabScriptable || uiMutationLocked) return;
      const tab = await getActiveTab();
      const ctx = createTabContext(tab);
      if (ctx.id !== currentTabId || ctx.url !== currentTabUrl || ctx.host !== currentHost) {
        await loadCssForCurrentSite({ tabContext: ctx });
        return;
      }

      const hostToReset = currentHost;
      cancelScheduledPersistence();
      await waitForPersistQueue();
      applyEditorMutation('', { shouldScheduleSave: false });
      toggleCss.checked = true;
      toggleLabel.textContent = 'Enabled';

      try {
        await storageRemove([hostToReset, `${hostToReset}_enabled`]);
        delete lastPersistedByHost[hostToReset];
        const clearResult = await notifyActiveTab({ type: 'css:clear' });
        if (!clearResult.ok &&
            clearResult.reason === 'unreachable' &&
            currentTabUrl &&
            isScriptableUrl(currentTabUrl)) {
          showConfigToast('CSS removed from storage. Reload the page if styles remain applied.', 'warning');
        } else if (!clearResult.ok && clearResult.reason === 'stale-context') {
          scheduleActiveContextRefresh();
        }
      } catch (error) {
        errorHandler.logError('resetCss', error);
      }
    });

    copyBtn.addEventListener('click', async () => {
      if (!currentTabScriptable || editor.disabled) {
        return;
      }

      const cssContent = editor.value;

      if (!cssContent.trim()) {
        return;
      }

      try {
        await navigator.clipboard.writeText(cssContent);
        flashButtonSuccess(copyBtn, copyIcon, 'assets/icons/copy.svg');
        errorHandler.logSuccess('CSS copied to clipboard');
      } catch (error) {
        errorHandler.logError('copyCSS', error);
      }
    });

    if (exportBtn) {
      exportBtn.addEventListener('click', handleConfigExport);
    }

    if (importBtn && importFileInput) {
      importBtn.addEventListener('click', () => {
        importFileInput.click();
      });

      importFileInput.addEventListener('change', (event) => {
        const selectedFile = event.target && event.target.files ? event.target.files[0] : null;
        handleConfigImport(selectedFile);
      });
    }

    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace !== 'local' || !currentHost || !currentTabScriptable || configTransferInProgress) {
        return;
      }
      if (hasPendingPersistence() && pendingPayload && pendingPayload.host === currentHost) {
        return;
      }
      if (!changes[currentHost] && !changes[`${currentHost}_enabled`]) {
        return;
      }

      refreshCurrentHostState({
        host: currentHost,
        placeholder: getEditablePlaceholder()
      }).catch((error) => {
        errorHandler.logError('storageChangeRefresh', error);
      });
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        scheduleActiveContextRefresh();
        return;
      }
      persistPendingStateOnClose();
    });

    window.addEventListener('pagehide', () => {
      persistPendingStateOnClose();
    });

    window.addEventListener('focus', () => {
      scheduleActiveContextRefresh();
    });

    if (chrome.tabs?.onActivated?.addListener) {
      chrome.tabs.onActivated.addListener(() => {
        scheduleActiveContextRefresh();
      });
    }

    if (chrome.tabs?.onUpdated?.addListener) {
      chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (!tab || tab.active !== true) return;
        if (typeof currentTabId === 'number' && tabId !== currentTabId && typeof tab.id === 'number') return;
        if (!changeInfo.url && !changeInfo.status) return;
        scheduleActiveContextRefresh();
      });
    }

    window.addEventListener('beforeunload', () => {
      persistPendingStateOnClose();
    });
  }

  async function initialize() {
    applyUiConstants();
    setupEventHandlers();
    window.addEventListener('resize', () => {
      scheduleScrollbarMetricsUpdate();
    });
    if (document.fonts?.ready) {
      document.fonts.ready.then(() => {
        scheduleScrollbarMetricsUpdate(true);
      }).catch(() => {
      });
    }
    await loadCssForCurrentSite();
    scheduleScrollbarMetricsUpdate();
    applyUiMutationState();
  }

  await initialize();
});
