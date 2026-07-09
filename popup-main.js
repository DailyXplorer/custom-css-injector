const cssInjectorUtils = typeof CSSInjectorUtils !== 'undefined' ? CSSInjectorUtils : null;
const STORAGE_AREA = 'local';
const MAX_RENDERED_LINE_NUMBERS = 20000;

function createLineNumberGutterState(lineCount, maxRenderedLines = MAX_RENDERED_LINE_NUMBERS) {
  const normalizedLineCount = Number.isFinite(lineCount)
    ? Math.max(1, Math.floor(lineCount))
    : 1;
  const normalizedLimit = Number.isFinite(maxRenderedLines) && maxRenderedLines > 0
    ? Math.floor(maxRenderedLines)
    : MAX_RENDERED_LINE_NUMBERS;

  if (normalizedLineCount > normalizedLimit) {
    return { text: '', suppressed: true };
  }

  const parts = new Array(normalizedLineCount);
  for (let index = 0; index < normalizedLineCount; index += 1) {
    parts[index] = String(index + 1);
  }
  return { text: parts.join('\n'), suppressed: false };
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function getHostname(url) {
  return cssInjectorUtils ? cssInjectorUtils.getHostname(url) : null;
}

function getProtocol(url) {
  return cssInjectorUtils ? cssInjectorUtils.getProtocol(url) : null;
}

function isScriptableUrl(url) {
  return cssInjectorUtils ? cssInjectorUtils.isScriptableUrl(url) : false;
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
  let uiMutationEpoch = 0;
  let activeContextRefreshTimer = null;
  let activeContextRefreshPending = false;
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
    MAX_IMPORT_FILE_BYTES: typeof saveConstants.MIN_IMPORT_FILE_BYTES === 'number' ? saveConstants.MIN_IMPORT_FILE_BYTES : (1024 * 1024),
    WRITE_CHUNK_SIZE: 80,
    REMOVE_CHUNK_SIZE: 150
  };

  const storageHelpers = typeof CSSInjectorPopupStorageHelpers !== 'undefined'
    ? CSSInjectorPopupStorageHelpers
    : null;
  const persistenceHelpers = typeof CSSInjectorPopupPersistence !== 'undefined'
    ? CSSInjectorPopupPersistence
    : null;

  if (!storageHelpers || !persistenceHelpers || !cssInjectorUtils) {
    console.error('[CSS Injector] Missing popup dependencies.');
    return;
  }
  configTransfer.MAX_IMPORT_FILE_BYTES = storageHelpers.getImportFileSizeLimit(
    LOCAL_QUOTA_BYTES,
    configTransfer.MAX_IMPORT_FILE_BYTES
  );

  let configToastTimer = null;
  let configTransferInProgress = false;
  const SHADOW_BRIDGE_SCRIPT_FILES = ['shadow-dom-bridge.js'];
  const CONTENT_SCRIPT_FILES = ['utils.js', 'constants.js', 'content-script.js'];
  const CONTENT_SCRIPT_RUNTIME_KEY = '__CSSInjectorContentScriptRuntime';
  const CONTENT_SCRIPT_RUNTIME_VERSION = 2;
  const SHADOW_BRIDGE_RUNTIME_KEY = '__CSSInjectorShadowBridgeRuntime';
  const SHADOW_BRIDGE_RUNTIME_VERSION = 2;
  const contentScriptInjectionTasks = new Map();

  const lastPersistedByHost = Object.create(null);

  let applyTimer = null;

  function countEditorLines(value) {
    return cssInjectorUtils.countLines(value);
  }

  function setLineNumbersText(lineCount) {
    const gutterState = createLineNumberGutterState(lineCount);
    lineNumbers.textContent = gutterState.text;
    lineNumbers.classList.toggle('is-suppressed', gutterState.suppressed);
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

  function markActiveContextRefreshPending() {
    activeContextRefreshPending = true;
    if (!uiMutationLocked && !configTransferInProgress) {
      scheduleActiveContextRefresh();
    }
  }

  function setUiMutationLocked(isLocked) {
    const nextLocked = isLocked === true;
    if (uiMutationLocked !== nextLocked) {
      uiMutationLocked = nextLocked;
      uiMutationEpoch += 1;
    }
    if (uiMutationLocked && activeContextRefreshTimer !== null) {
      clearTimeout(activeContextRefreshTimer);
      activeContextRefreshTimer = null;
      markActiveContextRefreshPending();
    }
    applyUiMutationState();
    if (!uiMutationLocked && activeContextRefreshPending) {
      markActiveContextRefreshPending();
    }
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

  const buttonFeedbackState = new WeakMap();

  function flashButtonSuccess(buttonElement, iconElement, fallbackSource) {
    if (!buttonElement || !iconElement) return;

    let feedback = buttonFeedbackState.get(buttonElement);
    if (feedback) {
      clearTimeout(feedback.timer);
    } else {
      feedback = { originalSource: getIconSource(iconElement) || fallbackSource || '' };
      buttonFeedbackState.set(buttonElement, feedback);
    }

    buttonElement.setAttribute('aria-pressed', 'true');
    setIconSource(iconElement, 'assets/icons/check.svg');
    buttonElement.style.color = 'var(--success-color)';

    feedback.timer = setTimeout(() => {
      buttonFeedbackState.delete(buttonElement);
      if (feedback.originalSource) {
        setIconSource(iconElement, feedback.originalSource);
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

  function isUiMutationContextCurrent(mutation) {
    return mutation &&
      mutation.host === currentHost &&
      mutation.loadRequestId === loadRequestId &&
      mutation.tabContext.id === currentTabId &&
      mutation.tabContext.url === currentTabUrl;
  }

  async function probeContentScriptRuntime(tabContext, options = {}) {
    const targetContext = tabContext || getCurrentTabContext();
    const probeAllFrames = options.allFrames !== false;
    if (!targetContext || typeof targetContext.id !== 'number' || !targetContext.scriptable) {
      return { ready: false, url: null, allFramesReady: false };
    }

    if (!chrome.scripting || typeof chrome.scripting.executeScript !== 'function') {
      return { ready: false, url: null, allFramesReady: false };
    }

    try {
      const probeRuntime = (runtimeKey, runtimeVersion, requireBridgeWrapper) => {
        const runtime = globalThis[runtimeKey];
        const attachShadow = globalThis.Element && globalThis.Element.prototype
          ? globalThis.Element.prototype.attachShadow
          : null;
        return {
          ready: !!runtime &&
            runtime.initialized === true &&
            runtime.version === runtimeVersion &&
            (!requireBridgeWrapper || (
              attachShadow &&
              attachShadow.__cssInjectorShadowBridgeWrapped === true &&
              attachShadow.__cssInjectorShadowBridgeVersion === runtimeVersion
            )),
          url: window.location.href
        };
      };
      const probeTarget = probeAllFrames
        ? { tabId: targetContext.id, allFrames: true }
        : { tabId: targetContext.id };
      const [contentProbeResults, bridgeProbeResults] = await Promise.all([
        chrome.scripting.executeScript({
          target: probeTarget,
          func: probeRuntime,
          args: [CONTENT_SCRIPT_RUNTIME_KEY, CONTENT_SCRIPT_RUNTIME_VERSION, false]
        }),
        chrome.scripting.executeScript({
          target: probeTarget,
          world: 'MAIN',
          func: probeRuntime,
          args: [SHADOW_BRIDGE_RUNTIME_KEY, SHADOW_BRIDGE_RUNTIME_VERSION, true]
        })
      ]);

      const contentResults = Array.isArray(contentProbeResults) ? contentProbeResults : [];
      const bridgeResults = Array.isArray(bridgeProbeResults) ? bridgeProbeResults : [];
      const topContentResult = contentResults.find((result) => result && result.frameId === 0) || contentResults[0];
      const topBridgeResult = bridgeResults.find((result) => result && result.frameId === 0) || bridgeResults[0];
      const contentFramesReady = contentResults.length > 0 && contentResults.every((result) => (
        result && result.result && result.result.ready === true
      ));
      const bridgeFramesReady = bridgeResults.length > 0 && bridgeResults.every((result) => (
        result && result.result && result.result.ready === true
      ));

      return {
        ready: !!(
          topContentResult && topContentResult.result && topContentResult.result.ready === true &&
          topBridgeResult && topBridgeResult.result && topBridgeResult.result.ready === true
        ),
        allFramesReady: contentFramesReady && bridgeFramesReady,
        url: topContentResult && topContentResult.result ? topContentResult.result.url : null
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
        const postInjectionProbe = await probeContentScriptRuntime(targetContext, { allFrames: false });
        return postInjectionProbe.ready === true && postInjectionProbe.url === targetContext.url;
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
    return cssInjectorUtils.createHostState(host, css, enabled);
  }

  function extractHostStateFromStorage(host, data) {
    return cssInjectorUtils.extractHostStateFromStorage(host, data);
  }

  function getHostStateItems(state) {
    return cssInjectorUtils.getHostStateItems(state);
  }

  function isSameSavedState(leftState, rightState) {
    return cssInjectorUtils.isSameHostState(leftState, rightState);
  }

  function getErrorMessage(error) {
    return cssInjectorUtils.getErrorMessage(error);
  }

  function storageGet(keys) {
    return cssInjectorUtils.storageGet(STORAGE_AREA, keys, STORAGE_TIMEOUT_MS);
  }

  function storageSet(items) {
    return cssInjectorUtils.storageSet(STORAGE_AREA, items, STORAGE_TIMEOUT_MS);
  }

  function storageRemove(keys) {
    return cssInjectorUtils.storageRemove(STORAGE_AREA, keys, STORAGE_TIMEOUT_MS);
  }

  const persistenceController = persistenceHelpers.createPersistenceController({
    delayMs: PERSIST_DELAY_MS,
    async write(payload) {
      const state = createHostState(payload.host, payload.css, payload.enabled);
      await storageSet(getHostStateItems(state));
      lastPersistedByHost[payload.host] = {
        css: state.css,
        enabled: state.enabled
      };
    },
    onError(error) {
      errorHandler.logError('persistence', error);
      showConfigToast(getErrorMessage(error), 'error');
    }
  });

  function hasPendingPersistence(host = null) {
    return persistenceController.hasPending(host);
  }

  function cancelScheduledPersistence(host = currentHost) {
    if (applyTimer !== null) {
      clearTimeout(applyTimer);
      applyTimer = null;
    }
    if (host) {
      persistenceController.invalidateHost(host);
    } else {
      persistenceController.invalidateAll();
    }
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

  async function waitForPersistQueue() {
    await persistenceController.waitForIdle();
  }

  function schedulePersistence(host, css, enabled) {
    persistenceController.schedule({ host, css, enabled });
    scheduleApplyToTab(host, css, enabled);
  }

  async function flushPersistence() {
    if (applyTimer !== null) {
      clearTimeout(applyTimer);
      applyTimer = null;
    }

    const host = currentHost;
    const tabContext = getCurrentTabContext();
    const payloadBeforeFlush = host
      ? persistenceController.getPendingPayload(host)
      : null;
    const succeeded = await persistenceController.flush();
    if (!succeeded) return false;

    if (payloadBeforeFlush &&
        host === currentHost &&
        tabContext.id === currentTabId &&
        tabContext.url === currentTabUrl &&
        tabContext.scriptable) {
      const persisted = lastPersistedByHost[host] || payloadBeforeFlush;
      await notifyActiveTab({
        type: 'css:apply',
        host,
        css: persisted.css,
        enabled: persisted.enabled
      }, { tabContext });
    }
    return true;
  }

  function persistPendingStateImmediately() {
    const payloads = persistenceController.getPendingForImmediateDispatch();
    if (!payloads.length) return;

    try {
      if (typeof chrome !== 'undefined' &&
          chrome.storage &&
          chrome.storage.local &&
          typeof chrome.storage.local.set === 'function') {
        const items = Object.create(null);
        for (const payload of payloads) {
          items[payload.host] = payload.css;
          items[`${payload.host}_enabled`] = payload.enabled;
        }
        const writeResult = chrome.storage.local.set(items);
        if (writeResult && typeof writeResult.catch === 'function') {
          writeResult.catch((error) => errorHandler.logError('persistPendingStateImmediately', error));
        }
      }
    } catch (error) {
      errorHandler.logError('persistPendingStateImmediately', error);
    }
  }

  async function refreshCurrentHostState(options = {}) {
    const host = typeof options.host === 'string' && options.host ? options.host : currentHost;
    const allowDuringUiMutation = options.allowDuringUiMutation === true;
    if (uiMutationLocked && !allowDuringUiMutation) {
      markActiveContextRefreshPending();
      return null;
    }
    if (!host || !currentTabScriptable) {
      return null;
    }

    const requestId = typeof options.requestId === 'number' ? options.requestId : null;
    const mutationEpochAtRead = uiMutationEpoch;

    if (hasPendingPersistence(host)) {
      return null;
    }

    const revisionAtRead = persistenceController.getRevision(host);
    const items = await storageGet([host, `${host}_enabled`]);
    if (requestId !== null && requestId !== loadRequestId) {
      return null;
    }
    if (host !== currentHost) {
      return null;
    }
    if (!allowDuringUiMutation &&
        (uiMutationLocked || mutationEpochAtRead !== uiMutationEpoch)) {
      markActiveContextRefreshPending();
      return null;
    }
    if (revisionAtRead !== persistenceController.getRevision(host) || hasPendingPersistence(host)) {
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

  function requestTopFrameHost(tabId) {
    return new Promise((resolve) => {
      if (typeof tabId !== 'number') {
        resolve(null);
        return;
      }

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

  async function resolveActiveTabContext() {
    const context = createTabContext(await getActiveTab());
    if (!context.url && typeof context.id === 'number') {
      const fallbackHost = await requestTopFrameHost(context.id);
      if (fallbackHost) {
        context.host = fallbackHost;
        context.scriptable = true;
      }
    }
    return context;
  }

  function tabContextMatches(actual, expected) {
    return !!actual && !!expected &&
      actual.id === expected.id &&
      actual.url === expected.url &&
      actual.host === expected.host &&
      actual.scriptable === true;
  }

  const loadCssForCurrentSite = async (options = {}) => {
    const {
      tabContext = null,
      flushPending = true,
      allowDuringUiMutation = false
    } = options;
    if (uiMutationLocked && !allowDuringUiMutation) {
      markActiveContextRefreshPending();
      return;
    }
    const mutationEpochAtStart = uiMutationEpoch;
    const requestId = ++loadRequestId;
    const loadIsStale = () => {
      if (requestId !== loadRequestId) return true;
      if (!allowDuringUiMutation &&
          (uiMutationLocked || mutationEpochAtStart !== uiMutationEpoch)) {
        markActiveContextRefreshPending();
        return true;
      }
      return false;
    };
    try {
      if (flushPending) {
        const flushed = await flushPersistence();
        if (!flushed) return;
      }
      if (loadIsStale()) return;
      const resolvedTabContext = tabContext || await resolveActiveTabContext();
      if (loadIsStale()) return;

      if (!resolvedTabContext.url && !resolvedTabContext.host) {
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
        placeholder: getEditablePlaceholder(),
        allowDuringUiMutation
      });
    } catch (error) {
      if (requestId !== loadRequestId ||
          (!allowDuringUiMutation && mutationEpochAtStart !== uiMutationEpoch)) {
        if (requestId === loadRequestId) markActiveContextRefreshPending();
        return;
      }
      errorHandler.logError('loadCssForCurrentSite', error);
      updateUI({
        disabled: true,
        scriptable: false,
        placeholder: 'Error loading data'
      });
    }
  };

  function broadcastToSubframes(tabId, message) {
    if (typeof tabId !== 'number' || !message || !['css:apply', 'css:clear'].includes(message.type)) {
      return;
    }

    try {
      const broadcastResult = chrome.tabs.sendMessage(
        tabId,
        Object.assign({}, message, { delivery: 'subframes' })
      );
      if (broadcastResult && typeof broadcastResult.catch === 'function') {
        broadcastResult.catch(() => {});
      }
    } catch {
    }
  }

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

      const response = await chrome.tabs.sendMessage(targetTabId, message, { frameId: 0 });
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
      broadcastToSubframes(targetTabId, message);
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
    if (configTransferInProgress || uiMutationLocked) {
      markActiveContextRefreshPending();
      if (activeContextRefreshTimer !== null) {
        clearTimeout(activeContextRefreshTimer);
        activeContextRefreshTimer = null;
      }
      return;
    }
    activeContextRefreshPending = false;
    clearTimeout(activeContextRefreshTimer);
    activeContextRefreshTimer = setTimeout(() => {
      activeContextRefreshTimer = null;
      if (configTransferInProgress || uiMutationLocked) {
        markActiveContextRefreshPending();
        return;
      }
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
      if (!await flushPersistence()) {
        throw persistenceController.getLastError() || new Error('Pending CSS could not be saved.');
      }
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
    let rollbackSucceeded = null;
    let backupManagedItems = Object.create(null);
    let attemptedImportItems = Object.create(null);

    try {
      if (!await flushPersistence()) {
        throw persistenceController.getLastError() || new Error('Pending CSS could not be saved.');
      }

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
      const postImportItems = storageHelpers.buildPostImportStorage(snapshotBeforeImport, itemsToSet);
      storageHelpers.assertStorageLimits(postImportItems, storageLimits);
      const canWriteBeforeCleanup = storageHelpers.canWriteImportBeforeCleanup(
        snapshotBeforeImport,
        itemsToSet,
        storageLimits
      );
      if (!canWriteBeforeCleanup) {
        throw new Error(
          'Import needs temporary free space to remain recoverable. Export a backup, remove some saved sites, then retry.'
        );
      }

      cancelScheduledPersistence();

      if (Object.keys(itemsToSet).length) {
        localMutated = true;
        await setLocalStorageChunked(itemsToSet);
      }
      if (keysToRemove.length) {
        localMutated = true;
        await removeLocalStorageKeysChunked(keysToRemove);
      }

      await loadCssForCurrentSite({
        flushPending: false,
        allowDuringUiMutation: true
      });

      flashButtonSuccess(importBtn, importIcon, 'assets/icons/upload.svg');
      showConfigToast(`Import completed (${importedHosts.size} site${importedHosts.size === 1 ? '' : 's'}).`, 'success');
      errorHandler.logSuccess(`Import completed for ${importedHosts.size} site(s)`);
    } catch (error) {
      if (localMutated) {
        try {
          await restoreManagedLocalState(backupManagedItems, attemptedImportItems);
          rollbackSucceeded = true;
        } catch (restoreError) {
          rollbackSucceeded = false;
          errorHandler.logError('restoreManagedLocalState', restoreError);
        }
      }
      errorHandler.logError('importConfig', error);
      const importErrorMessage = error && error.message ? error.message : 'Import failed.';
      showConfigToast(storageHelpers.getImportFailureMessage(
        importErrorMessage,
        localMutated,
        rollbackSucceeded === true
      ), 'error');
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
      const hasPendingWriteForCurrentHost = hasPendingPersistence(currentHost);

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
      persistPendingStateImmediately();
      flushPersistence().catch((error) => {
        errorHandler.logError('persistPendingStateOnClose', error);
      });
    }

    editor.addEventListener('input', () => {
      if (!currentHost || !currentTabScriptable || uiMutationLocked) return;
      applyEditorMutation(editor.value);
      scheduleScrollbarMetricsUpdate();
    });

    editor.addEventListener('blur', () => {
      if (uiMutationLocked) return;
      if (skipNextBlurFlush) {
        skipNextBlurFlush = false;
        return;
      }
      flushPersistence().catch((error) => {
        errorHandler.logError('editorBlurFlush', error);
      });
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
      if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, '  ')) {
        return;
      }

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
      const mutation = {
        host: currentHost,
        css: currentCss,
        enabled: toggleCss.checked,
        previousEnabled: !toggleCss.checked,
        previousLabel: toggleLabel.textContent,
        tabContext: getCurrentTabContext(),
        loadRequestId
      };
      let togglePayloadScheduled = false;
      setUiMutationLocked(true);

      try {
        if (!await flushPersistence()) {
          throw persistenceController.getLastError() || new Error('Pending CSS could not be saved.');
        }
        if (!isUiMutationContextCurrent(mutation)) {
          scheduleActiveContextRefresh();
          return;
        }
        const activeContext = await resolveActiveTabContext();
        if (!isUiMutationContextCurrent(mutation) ||
            !tabContextMatches(activeContext, mutation.tabContext)) {
          scheduleActiveContextRefresh();
          return;
        }

        schedulePersistence(mutation.host, mutation.css, mutation.enabled);
        togglePayloadScheduled = true;
        if (!await flushPersistence()) {
          throw persistenceController.getLastError() || new Error('The setting could not be saved.');
        }
        if (!isUiMutationContextCurrent(mutation)) {
          scheduleActiveContextRefresh();
          return;
        }
        toggleLabel.textContent = mutation.enabled ? 'Enabled' : 'Disabled';
      } catch (error) {
        if (togglePayloadScheduled) {
          persistenceController.invalidateHost(mutation.host);
        }
        if (!isUiMutationContextCurrent(mutation)) {
          errorHandler.logError('toggleCss', error);
          scheduleActiveContextRefresh();
          return;
        }
        toggleCss.checked = mutation.previousEnabled;
        toggleLabel.textContent = mutation.previousLabel;
        errorHandler.logError('toggleCss', error);
        showConfigToast(getErrorMessage(error), 'error');
      } finally {
        setUiMutationLocked(false);
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
      const hostToReset = currentHost;
      const tabContext = getCurrentTabContext();
      const resetLoadRequestId = loadRequestId;
      const uiSnapshot = {
        css: currentCss,
        editorValue: editor.value,
        enabled: toggleCss.checked,
        label: toggleLabel.textContent,
        selectionStart: editor.selectionStart,
        selectionEnd: editor.selectionEnd,
        scrollTop: editor.scrollTop,
        scrollLeft: editor.scrollLeft
      };
      let resetPersistenceInvalidated = false;
      setUiMutationLocked(true);

      try {
        const activeContext = await resolveActiveTabContext();
        if (!tabContextMatches(activeContext, tabContext) || activeContext.host !== hostToReset) {
          scheduleActiveContextRefresh();
          return;
        }

        cancelScheduledPersistence(hostToReset);
        resetPersistenceInvalidated = true;
        await waitForPersistQueue();
        applyEditorMutation('', { shouldScheduleSave: false });
        toggleCss.checked = true;
        toggleLabel.textContent = 'Enabled';

        await storageRemove([hostToReset, `${hostToReset}_enabled`]);
        delete lastPersistedByHost[hostToReset];
        const clearResult = await notifyActiveTab({
          type: 'css:clear',
          host: hostToReset
        }, { tabContext });
        if (!clearResult.ok &&
            clearResult.reason === 'unreachable' &&
            tabContext.url &&
            isScriptableUrl(tabContext.url)) {
          showConfigToast('CSS removed from storage. Reload the page if styles remain applied.', 'warning');
        } else if (!clearResult.ok && clearResult.reason === 'stale-context') {
          scheduleActiveContextRefresh();
        } else if (!clearResult.ok && clearResult.reason === 'host-mismatch') {
          scheduleActiveContextRefresh();
        }
      } catch (error) {
        const resetContextIsCurrent = currentHost === hostToReset &&
          currentTabId === tabContext.id &&
          currentTabUrl === tabContext.url &&
          loadRequestId === resetLoadRequestId;
        if (!resetContextIsCurrent) {
          errorHandler.logError('resetCss', error);
          scheduleActiveContextRefresh();
          return;
        }
        if (resetPersistenceInvalidated) {
          schedulePersistence(hostToReset, uiSnapshot.css, uiSnapshot.enabled);
        }
        currentCss = uiSnapshot.css;
        setEditorValue(uiSnapshot.editorValue);
        toggleCss.checked = uiSnapshot.enabled;
        toggleLabel.textContent = uiSnapshot.label;
        editor.selectionStart = uiSnapshot.selectionStart;
        editor.selectionEnd = uiSnapshot.selectionEnd;
        editor.scrollTop = uiSnapshot.scrollTop;
        editor.scrollLeft = uiSnapshot.scrollLeft;
        updateLineNumbers(true);
        errorHandler.logError('resetCss', error);
        showConfigToast(getErrorMessage(error), 'error');
      } finally {
        setUiMutationLocked(false);
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
      if (hasPendingPersistence(currentHost)) {
        return;
      }
      if (!changes[currentHost] && !changes[`${currentHost}_enabled`]) {
        return;
      }
      if (uiMutationLocked) {
        markActiveContextRefreshPending();
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
