(function () {
  'use strict';

  const root = typeof globalThis !== 'undefined'
    ? globalThis
    : (typeof window !== 'undefined' ? window : this);
  const runtimeKey = '__CSSInjectorContentScriptRuntime';
  const existingRuntime = root[runtimeKey];

  if (existingRuntime && (existingRuntime.initialized === true || existingRuntime.bootstrapping === true)) {
    if (existingRuntime.initialized === true && typeof existingRuntime.requestRefresh === 'function') {
      existingRuntime.requestRefresh(true, true);
    }
    return;
  }

  const contentScriptRuntime = existingRuntime && typeof existingRuntime === 'object'
    ? existingRuntime
    : {};
  contentScriptRuntime.bootstrapping = true;
  contentScriptRuntime.initialized = false;
  root[runtimeKey] = contentScriptRuntime;

  function getFrameHostname() {
    if (typeof CSSInjectorUtils !== 'undefined') {
      return CSSInjectorUtils.getCurrentHostname();
    }
    try {
      return window.location.hostname;
    } catch {
      return null;
    }
  }

  function getCurrentHostname() {
    return getFrameHostname();
  }

  function getStyleDataAttributeName() {
    if (typeof CSSInjectorConstants === 'undefined' ||
        !CSSInjectorConstants.SELECTORS ||
        typeof CSSInjectorConstants.SELECTORS.CSS_INJECTOR_STYLE !== 'string') {
      return 'data-css-injector';
    }

    const selectorTemplate = CSSInjectorConstants.SELECTORS.CSS_INJECTOR_STYLE;
    const match = selectorTemplate.match(/\[([^=\]]+)=/);
    return match ? match[1] : 'data-css-injector';
  }

  const STYLE_DATA_ATTRIBUTE = getStyleDataAttributeName();
  const STYLE_SELECTOR = `style[${STYLE_DATA_ATTRIBUTE}]`;
  const SHADOW_BRIDGE_EVENT_NAME = '__CSS_INJECTOR_SHADOW_BRIDGE__';
  const TOP_HOST_CACHE_TTL_MS = 3000;

  const managedStyleCache = {
    host: null,
    node: null
  };

  const managedShadowRoots = new Set();
  const managedShadowStyleCache = new WeakMap();
  const managedShadowRootObservers = new WeakMap();

  const topHostCache = {
    host: null,
    timestamp: 0
  };

  let fullShadowDiscoveryDone = false;

  function isTopFrame() {
    try {
      return window.top === window;
    } catch {
      return false;
    }
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      if (!isExtensionContextValid()) {
        reject(new Error('Extension context invalidated'));
        return;
      }

      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(error);
          return;
        }
        resolve(response);
      });
    });
  }

  async function requestTopHostnameFromBackground() {
    try {
      const response = await sendRuntimeMessage({ type: 'context:getTopHost' });
      if (response && response.ok === true && typeof response.host === 'string' && response.host) {
        return response.host;
      }
    } catch {
    }
    return null;
  }

  function getHostnameFromUrlLike(value) {
    if (typeof value !== 'string' || !value) return null;
    try {
      return new URL(value).hostname || null;
    } catch {
      return null;
    }
  }

  function getAccessibleTopHostname() {
    try {
      return window.top && window.top.location
        ? (window.top.location.hostname || null)
        : null;
    } catch {
      return null;
    }
  }

  function getTopHostnameFromAncestorOrigins() {
    try {
      const ancestorOrigins = window.location && window.location.ancestorOrigins;
      if (!ancestorOrigins || typeof ancestorOrigins.length !== 'number' || ancestorOrigins.length < 1) {
        return null;
      }

      const topOrigin = ancestorOrigins[ancestorOrigins.length - 1];
      return getHostnameFromUrlLike(topOrigin);
    } catch {
      return null;
    }
  }

  function cacheTopHostname(hostname) {
    if (!hostname) return;
    topHostCache.host = hostname;
    topHostCache.timestamp = Date.now();
  }

  async function resolveManagedHostname(forceRefresh = false) {
    const frameHostname = getFrameHostname();

    if (isTopFrame()) {
      if (!frameHostname) return null;
      cacheTopHostname(frameHostname);
      return frameHostname;
    }

    if (!forceRefresh &&
        topHostCache.host &&
        (Date.now() - topHostCache.timestamp) < TOP_HOST_CACHE_TTL_MS) {
      return topHostCache.host;
    }

    const fastTopHostname = getAccessibleTopHostname() || getTopHostnameFromAncestorOrigins();
    if (fastTopHostname) {
      cacheTopHostname(fastTopHostname);
      return fastTopHostname;
    }

    const topHostname = await requestTopHostnameFromBackground();
    const resolvedHostname = topHostname || frameHostname;
    if (!resolvedHostname) return null;

    cacheTopHostname(resolvedHostname);
    return resolvedHostname;
  }

  function getInjectedStylesForHostname(hostname, rootNode = document) {
    if (!hostname || typeof hostname !== 'string' || !rootNode || typeof rootNode.querySelectorAll !== 'function') {
      return [];
    }

    const styles = rootNode.querySelectorAll(STYLE_SELECTOR);
    return Array.from(styles).filter((styleNode) => (
      styleNode &&
      typeof styleNode.getAttribute === 'function' &&
      styleNode.getAttribute(STYLE_DATA_ATTRIBUTE) === hostname
    ));
  }

  function getInjectedStyle(hostname) {
    if (managedStyleCache.host === hostname &&
        managedStyleCache.node &&
        managedStyleCache.node.isConnected &&
        managedStyleCache.node.getAttribute(STYLE_DATA_ATTRIBUTE) === hostname) {
      return managedStyleCache.node;
    }

    const matchingStyles = getInjectedStylesForHostname(hostname, document);
    if (!matchingStyles.length) return null;

    if (matchingStyles.length > 1) {
      for (let index = 1; index < matchingStyles.length; index++) {
        matchingStyles[index].remove();
      }
    }

    managedStyleCache.host = hostname;
    managedStyleCache.node = matchingStyles[0];
    return matchingStyles[0];
  }

  function getDocumentStyleParent() {
    return document.head || document.documentElement || null;
  }

  function attachManagedStyle(style, retries = 3) {
    const parentNode = getDocumentStyleParent();
    if (parentNode) {
      if (style.parentNode !== parentNode || parentNode.lastElementChild !== style) {
        parentNode.appendChild(style);
      }
      return;
    }

    if (retries > 0) {
      requestAnimationFrame(() => attachManagedStyle(style, retries - 1));
    }
  }

  function ensureManagedStyle(hostname) {
    if (!hostname || typeof hostname !== 'string') return null;

    const cachedStyle = getInjectedStyle(hostname);
    if (cachedStyle) {
      attachManagedStyle(cachedStyle);
      return cachedStyle;
    }

    const style = document.createElement('style');
    style.setAttribute(STYLE_DATA_ATTRIBUTE, hostname);
    style.setAttribute('data-css-injector-priority', 'user');
    managedStyleCache.host = hostname;
    managedStyleCache.node = style;
    attachManagedStyle(style);
    return style;
  }

  function isElementNode(node) {
    return !!node && node.nodeType === 1;
  }

  function isShadowRoot(rootNode) {
    return !!rootNode &&
      rootNode.nodeType === 11 &&
      !!rootNode.host &&
      typeof rootNode.appendChild === 'function';
  }

  function isShadowRootConnected(shadowRoot) {
    if (!isShadowRoot(shadowRoot)) return false;
    const host = shadowRoot.host;
    return !host || host.isConnected !== false;
  }

  function cleanupManagedShadowRoots() {
    for (const shadowRoot of Array.from(managedShadowRoots)) {
      if (isShadowRootConnected(shadowRoot)) {
        continue;
      }

      const observer = managedShadowRootObservers.get(shadowRoot);
      if (observer) {
        observer.disconnect();
        managedShadowRootObservers.delete(shadowRoot);
      }
      managedShadowStyleCache.delete(shadowRoot);
      managedShadowRoots.delete(shadowRoot);
    }
  }

  function getInjectedShadowStyle(shadowRoot, hostname) {
    if (!isShadowRootConnected(shadowRoot) || !hostname) return null;

    const cached = managedShadowStyleCache.get(shadowRoot);
    if (cached &&
        cached.host === hostname &&
        cached.node &&
        cached.node.isConnected &&
        cached.node.getAttribute(STYLE_DATA_ATTRIBUTE) === hostname) {
      return cached.node;
    }

    const matchingStyles = getInjectedStylesForHostname(hostname, shadowRoot);
    if (!matchingStyles.length) {
      managedShadowStyleCache.delete(shadowRoot);
      return null;
    }

    if (matchingStyles.length > 1) {
      for (let index = 1; index < matchingStyles.length; index++) {
        matchingStyles[index].remove();
      }
    }

    const style = matchingStyles[0];
    managedShadowStyleCache.set(shadowRoot, { host: hostname, node: style });
    return style;
  }

  function attachManagedShadowStyle(shadowRoot, style) {
    if (!isShadowRootConnected(shadowRoot) || !style) return;

    if (style.parentNode !== shadowRoot || shadowRoot.lastElementChild !== style) {
      shadowRoot.appendChild(style);
    }
  }

  function ensureManagedShadowStyle(shadowRoot, hostname, cssContent) {
    if (!isShadowRootConnected(shadowRoot) || !hostname || typeof cssContent !== 'string') {
      return null;
    }

    let style = getInjectedShadowStyle(shadowRoot, hostname);
    if (!style) {
      style = document.createElement('style');
      style.setAttribute(STYLE_DATA_ATTRIBUTE, hostname);
      style.setAttribute('data-css-injector-priority', 'user');
      managedShadowStyleCache.set(shadowRoot, { host: hostname, node: style });
    } else {
      style.setAttribute(STYLE_DATA_ATTRIBUTE, hostname);
    }

    if (style.textContent !== cssContent) {
      style.textContent = cssContent;
    }

    attachManagedShadowStyle(shadowRoot, style);
    ensureManagedShadowRootObserver(shadowRoot);
    return style;
  }

  function removeInjectedStylesFromShadowRoot(shadowRoot, hostname) {
    if (!isShadowRoot(shadowRoot) || !hostname) return;

    const cached = managedShadowStyleCache.get(shadowRoot);
    if (cached && cached.host === hostname && cached.node) {
      cached.node.remove();
      managedShadowStyleCache.delete(shadowRoot);
    }

    getInjectedStylesForHostname(hostname, shadowRoot).forEach((styleNode) => styleNode.remove());
  }

  function discoverShadowRootsFromElement(element) {
    if (!isElementNode(element)) return;

    try {
      if (element.shadowRoot) {
        registerShadowRoot(element.shadowRoot);
      }
    } catch {
    }

    if (typeof element.querySelectorAll !== 'function') return;

    let descendants;
    try {
      descendants = element.querySelectorAll('*');
    } catch {
      return;
    }

    for (const descendant of descendants) {
      try {
        if (descendant.shadowRoot) {
          registerShadowRoot(descendant.shadowRoot);
        }
      } catch {
      }
    }
  }

  function discoverShadowRootsInTree(rootNode) {
    if (!rootNode || typeof rootNode.querySelectorAll !== 'function') return;

    let elements;
    try {
      elements = rootNode.querySelectorAll('*');
    } catch {
      return;
    }

    for (const element of elements) {
      try {
        if (element.shadowRoot) {
          registerShadowRoot(element.shadowRoot);
        }
      } catch {
      }
    }
  }

  function registerShadowRoot(shadowRoot) {
    if (!isShadowRootConnected(shadowRoot)) return;

    const wasTracked = managedShadowRoots.has(shadowRoot);
    managedShadowRoots.add(shadowRoot);

    if (lastApplied.shouldHaveStyle === true && lastApplied.host && lastApplied.css) {
      ensureManagedShadowStyle(shadowRoot, lastApplied.host, lastApplied.css);
    }

    ensureManagedShadowRootObserver(shadowRoot);

    if (!wasTracked) {
      discoverShadowRootsInTree(shadowRoot);
    }
  }

  function ensureInitialShadowDiscovery() {
    if (fullShadowDiscoveryDone) return;
    fullShadowDiscoveryDone = true;
    discoverShadowRootsInTree(document);
  }

  function applyCSSInShadowRoots(hostname, cssContent) {
    cleanupManagedShadowRoots();
    ensureInitialShadowDiscovery();

    for (const shadowRoot of Array.from(managedShadowRoots)) {
      ensureManagedShadowStyle(shadowRoot, hostname, cssContent);
    }
  }

  function dispatchShadowBridgeMessage(type, hostname, cssContent = '') {
    try {
      if (typeof window.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') {
        return;
      }

      window.dispatchEvent(new CustomEvent(SHADOW_BRIDGE_EVENT_NAME, {
        detail: {
          source: 'css-injector',
          type,
          host: hostname,
          css: typeof cssContent === 'string' ? cssContent : '',
          attribute: STYLE_DATA_ATTRIBUTE
        }
      }));
    } catch {
    }
  }

  function removeInjectedStyles(hostname) {
    const matchingStyles = getInjectedStylesForHostname(hostname, document);
    matchingStyles.forEach((styleNode) => styleNode.remove());

    cleanupManagedShadowRoots();
    for (const shadowRoot of Array.from(managedShadowRoots)) {
      removeInjectedStylesFromShadowRoot(shadowRoot, hostname);
    }

    dispatchShadowBridgeMessage('clear', hostname);

    if (managedStyleCache.host === hostname) {
      managedStyleCache.host = null;
      managedStyleCache.node = null;
    }
  }

  function injectCSS(cssContent, hostname) {
    if (!cssContent || typeof cssContent !== 'string' || !hostname || typeof hostname !== 'string') {
      return;
    }

    try {
      const style = ensureManagedStyle(hostname);
      if (!style) return;
      if (style.textContent !== cssContent) {
        style.textContent = cssContent;
      }
      attachManagedStyle(style);
      applyCSSInShadowRoots(hostname, cssContent);
      dispatchShadowBridgeMessage('apply', hostname, cssContent);
    } catch (error) {
      console.error('[CSS Injector] Failed to inject CSS:', error);
    }
  }

  const storageConfig = typeof CSSInjectorConstants !== 'undefined' ? (CSSInjectorConstants.STORAGE || {}) : {};
  const storageCacheExpiryMs = typeof storageConfig.CACHE_EXPIRY_MS === 'number' ? storageConfig.CACHE_EXPIRY_MS : 120000;
  const storageTimeoutMs = typeof storageConfig.TIMEOUT_MS === 'number' ? storageConfig.TIMEOUT_MS : 5000;
  const debounceDelay = typeof CSSInjectorConstants !== 'undefined' ? CSSInjectorConstants.DEBOUNCE.NAVIGATION_DELAY : 100;

  const storageCache = {
    data: null,
    hostname: null,
    timestamp: 0,
    TTL_MS: storageCacheExpiryMs,

    isValid(hostname) {
      return this.hostname === hostname &&
             this.data !== null &&
             (Date.now() - this.timestamp) < this.TTL_MS;
    },

    set(hostname, data) {
      this.hostname = hostname;
      this.data = data;
      this.timestamp = Date.now();
    },

    invalidate() {
      this.data = null;
      this.hostname = null;
      this.timestamp = 0;
    }
  };

  let lastApplied = { href: '', host: '', path: '', css: '', shouldHaveStyle: false, effectKey: '' };
  let pendingTimer = null;
  let pendingFrameId = 0;
  let pendingForcedLoad = false;
  let pendingForcedReload = false;
  let latestLoadRequestId = 0;
  let styleGuardScheduled = false;
  let styleGuardObserver = null;

  function getErrorMessage(error, fallbackMessage) {
    if (typeof CSSInjectorUtils !== 'undefined' &&
        typeof CSSInjectorUtils.getErrorMessage === 'function') {
      return CSSInjectorUtils.getErrorMessage(error, fallbackMessage);
    }

    if (error instanceof Error && typeof error.message === 'string' && error.message.trim()) {
      return error.message.trim();
    }
    if (error && typeof error.message === 'string' && error.message.trim()) {
      return error.message.trim();
    }
    return fallbackMessage || 'Unknown error';
  }

  function createHostState(host, css, enabled) {
    if (typeof CSSInjectorUtils !== 'undefined' &&
        typeof CSSInjectorUtils.createHostState === 'function') {
      return CSSInjectorUtils.createHostState(host, css, enabled);
    }
    return {
      host,
      css: typeof css === 'string' ? css : '',
      enabled: enabled !== false
    };
  }

  function extractHostStateFromStorage(host, data) {
    if (typeof CSSInjectorUtils !== 'undefined' &&
        typeof CSSInjectorUtils.extractHostStateFromStorage === 'function') {
      return CSSInjectorUtils.extractHostStateFromStorage(host, data);
    }
    const items = data && typeof data === 'object' ? data : {};
    return createHostState(
      host,
      typeof items[host] === 'string' ? items[host] : '',
      items[`${host}_enabled`] !== false
    );
  }

  function buildEffectKey(hostname, css, isEnabled) {
    if (!hostname || typeof hostname !== 'string') return '';
    const cssText = typeof css === 'string' ? css : '';
    const injected = Boolean(cssText && isEnabled !== false);
    return `${hostname}\0${cssText}\0${injected ? '1' : '0'}`;
  }

  function commitLastAppliedState(hostname, css, enabledFlag) {
    const cssText = typeof css === 'string' ? css : '';
    const isEnabled = enabledFlag !== false;
    lastApplied.href = window.location.href;
    lastApplied.host = hostname;
    lastApplied.path = window.location.pathname + window.location.search + window.location.hash;
    lastApplied.css = cssText;
    lastApplied.shouldHaveStyle = Boolean(cssText && isEnabled);
    lastApplied.effectKey = buildEffectKey(hostname, cssText, isEnabled);
  }

  function shouldMaintainManagedStyle(hostname) {
    return !!hostname &&
      lastApplied.shouldHaveStyle === true &&
      lastApplied.host === hostname;
  }

  function queueManagedStyleRecovery() {
    if (styleGuardScheduled) {
      return;
    }

    styleGuardScheduled = true;
    queueMicrotask(() => {
      styleGuardScheduled = false;

      const hostname = lastApplied.host;
      if (!shouldMaintainManagedStyle(hostname)) {
        return;
      }

      if (lastApplied.css) {
        injectCSS(lastApplied.css, hostname);
        return;
      }

      scheduleInjection(true, true);
    });
  }

  function nodeContainsStylesheet(node) {
    if (!node || node.nodeType !== 1) {
      return false;
    }

    if (typeof node.matches === 'function' &&
        node.matches('style, link[rel="stylesheet"]')) {
      return true;
    }

    return typeof node.querySelector === 'function' &&
      !!node.querySelector('style, link[rel="stylesheet"]');
  }

  function handleManagedStyleMutations(mutations) {
    const hostname = lastApplied.host;
    const shouldMaintain = shouldMaintainManagedStyle(hostname);
    const cachedStyle = managedStyleCache.host === hostname ? managedStyleCache.node : null;

    for (const mutation of mutations) {
      if (mutation.type !== 'childList') {
        continue;
      }

      for (const addedNode of mutation.addedNodes) {
        discoverShadowRootsFromElement(addedNode);
      }

      if (!shouldMaintain) {
        continue;
      }

      if (!cachedStyle || !cachedStyle.isConnected) {
        queueManagedStyleRecovery();
        return;
      }

      if (mutation.addedNodes.length > 0 &&
          mutation.target === cachedStyle.parentNode &&
          cachedStyle.parentNode &&
          cachedStyle.parentNode.lastElementChild !== cachedStyle &&
          Array.from(mutation.addedNodes).some(nodeContainsStylesheet)) {
        queueManagedStyleRecovery();
        return;
      }
    }
  }

  function ensureManagedStyleObserver() {
    if (styleGuardObserver || typeof MutationObserver === 'undefined') {
      return;
    }

    const rootNode = document.documentElement || document;
    if (!rootNode) {
      return;
    }

    styleGuardObserver = new MutationObserver(handleManagedStyleMutations);
    styleGuardObserver.observe(rootNode, {
      childList: true,
      subtree: true
    });
  }

  function disconnectManagedStyleObserver() {
    if (!styleGuardObserver) {
      return;
    }

    styleGuardObserver.disconnect();
    styleGuardObserver = null;
  }

  function handleManagedShadowRootMutations(shadowRoot, mutations) {
    let shouldRecover = false;

    for (const mutation of mutations) {
      if (mutation.type !== 'childList') {
        continue;
      }

      for (const addedNode of mutation.addedNodes) {
        discoverShadowRootsFromElement(addedNode);
      }

      const hostname = lastApplied.host;
      if (!shouldMaintainManagedStyle(hostname)) {
        continue;
      }

      const cached = managedShadowStyleCache.get(shadowRoot);
      if (!cached || !cached.node || !cached.node.isConnected) {
        shouldRecover = true;
        continue;
      }

      if (mutation.target === shadowRoot &&
          shadowRoot.lastElementChild !== cached.node &&
          Array.from(mutation.addedNodes).some(nodeContainsStylesheet)) {
        shouldRecover = true;
      }
    }

    if (shouldRecover) {
      queueManagedStyleRecovery();
    }
  }

  function ensureManagedShadowRootObserver(shadowRoot) {
    if (!isShadowRootConnected(shadowRoot) || managedShadowRootObservers.has(shadowRoot) || typeof MutationObserver === 'undefined') {
      return;
    }

    const observer = new MutationObserver((mutations) => handleManagedShadowRootMutations(shadowRoot, mutations));
    observer.observe(shadowRoot, {
      childList: true,
      subtree: true
    });
    managedShadowRootObservers.set(shadowRoot, observer);
  }

  function disconnectManagedShadowRootObservers() {
    for (const shadowRoot of Array.from(managedShadowRoots)) {
      const observer = managedShadowRootObservers.get(shadowRoot);
      if (observer) {
        observer.disconnect();
        managedShadowRootObservers.delete(shadowRoot);
      }
    }
  }

  function syncManagedStyleObserver() {
    const hostname = lastApplied.host;
    if (shouldMaintainManagedStyle(hostname)) {
      ensureManagedStyleObserver();
      ensureInitialShadowDiscovery();
      for (const shadowRoot of Array.from(managedShadowRoots)) {
        ensureManagedShadowRootObserver(shadowRoot);
      }
      return;
    }

    disconnectManagedStyleObserver();
    disconnectManagedShadowRootObservers();
  }

  function isExtensionContextValid() {
    try {
      return chrome.runtime && !!chrome.runtime.id;
    } catch {
      return false;
    }
  }

  async function loadAndApplyCSS(forceReload = false) {
    const requestId = ++latestLoadRequestId;
    if (!isExtensionContextValid()) return;

    const hostname = await resolveManagedHostname(forceReload);
    if (!hostname) return;

    try {
      let data;

      if (!forceReload && storageCache.isValid(hostname)) {
        data = storageCache.data;
      } else {
        if (typeof CSSInjectorUtils !== 'undefined' && typeof CSSInjectorUtils.storageGet === 'function') {
          data = await CSSInjectorUtils.storageGet('local', [hostname, `${hostname}_enabled`], storageTimeoutMs);
        } else {
          data = await new Promise((resolve, reject) => {
            if (!isExtensionContextValid()) {
              reject(new Error('Extension context invalidated'));
              return;
            }
            chrome.storage.local.get([hostname, `${hostname}_enabled`], (result) => {
              const error = chrome.runtime.lastError;
              if (error) {
                reject(error);
                return;
              }
              resolve(result);
            });
          });
        }
        storageCache.set(hostname, data);
      }

      const effectiveState = extractHostStateFromStorage(hostname, data);
      const css = effectiveState.css;
      const isEnabled = effectiveState.enabled;

      const currentManagedHostname = await resolveManagedHostname(false);
      if (requestId !== latestLoadRequestId || currentManagedHostname !== hostname) {
        return;
      }

      const currentHref = window.location.href;
      const effectKey = buildEffectKey(hostname, css, isEnabled);
      if (
        effectKey === lastApplied.effectKey &&
        hostname === lastApplied.host &&
        currentHref === lastApplied.href
      ) {
        return;
      }

      if (css && isEnabled) {
        injectCSS(css, hostname);
      } else {
        removeInjectedStyles(hostname);
      }

      commitLastAppliedState(hostname, css, isEnabled);
      syncManagedStyleObserver();
    } catch (error) {
      if (error.message?.includes('Extension context invalidated')) return;
      console.error('[CSS Injector] Failed to load and apply CSS:', error);
    }
  }

  function debounce(fn) {
    return function () {
      if (pendingTimer) clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        fn();
      }, debounceDelay);
    };
  }

  const debouncedLoad = debounce(loadAndApplyCSS);

  function hasMeaningfulUrlChange() {
    const href = window.location.href;
    const host = window.location.hostname;
    const path = window.location.pathname + window.location.search + window.location.hash;
    if (href === lastApplied.href) return false;
    if (host !== lastApplied.host && isTopFrame()) return true;
    if (path !== lastApplied.path) return true;
    return false;
  }

  function scheduleInjection(force = false, forceReload = false) {
    if (force) {
      pendingForcedLoad = true;
      pendingForcedReload = pendingForcedReload || forceReload;
    }

    if (pendingFrameId) return;

    pendingFrameId = requestAnimationFrame(() => {
      pendingFrameId = 0;

      const shouldForceLoad = pendingForcedLoad;
      const shouldForceReload = pendingForcedReload;
      pendingForcedLoad = false;
      pendingForcedReload = false;
      const meaningfulUrlChange = hasMeaningfulUrlChange();

      if (shouldForceLoad) {
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          pendingTimer = null;
        }
        loadAndApplyCSS(shouldForceReload);
        return;
      }

      if (meaningfulUrlChange) {
        debouncedLoad();
      }
    });
  }

  contentScriptRuntime.requestRefresh = scheduleInjection;

  function checkAndInject(force = false) {
    try {
      scheduleInjection(force, false);
    } catch (error) {
      console.error('[CSS Injector] Failed to check and inject CSS:', error);
    }
  }

  checkAndInject(true);

  function hookHistoryMethod(methodName) {
    if (!window.history || typeof window.history[methodName] !== 'function') return;
    if (window.history[methodName]._cssInjectorWrapped) return;

    const original = window.history[methodName];
    const wrapped = function (...args) {
      const result = original.apply(this, args);
      checkAndInject();
      return result;
    };

    wrapped._cssInjectorWrapped = true;
    window.history[methodName] = wrapped;
  }

  hookHistoryMethod('pushState');
  hookHistoryMethod('replaceState');

  window.addEventListener('popstate', () => checkAndInject());
  window.addEventListener('hashchange', () => checkAndInject());

  window.addEventListener('pageshow', () => checkAndInject(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkAndInject(true);
  });

  if ('navigation' in window && typeof window.navigation.addEventListener === 'function') {
    window.navigation.addEventListener('navigate', () => checkAndInject());
  }

  async function handleStorageChanges(changes, namespace) {
    if (namespace !== 'local') return;

    const hostname = await resolveManagedHostname(true);
    if (!hostname) return;

    if (changes[hostname] || changes[`${hostname}_enabled`]) {
      storageCache.invalidate();
      scheduleInjection(true, true);
    }
  }

  chrome.storage.onChanged.addListener((changes, namespace) => {
    handleStorageChanges(changes, namespace).catch((error) => {
      console.error('[CSS Injector] Failed to handle storage changes:', error);
    });
  });

  function isTrustedSender(sender) {
    try {
      return !!sender && sender.id === chrome.runtime.id;
    } catch {
      return false;
    }
  }

  const VALID_MESSAGE_TYPES = new Set(['css:apply', 'css:clear']);

  async function handleRuntimeMessage(msg, sender) {
    if (!msg || typeof msg.type !== 'string') {
      return { ok: false, error: 'Invalid message' };
    }
    if (!VALID_MESSAGE_TYPES.has(msg.type)) {
      return { ok: false, error: `Unsupported message type: ${msg.type}` };
    }
    if (!isTrustedSender(sender)) {
      return { ok: false, error: 'Untrusted sender' };
    }

    const hostname = await resolveManagedHostname(true);
    if (!hostname) {
      return { ok: false, error: 'Missing hostname' };
    }

    if (msg.type === 'css:apply') {
      const isValidPayload =
        typeof msg.host === 'string' &&
        typeof msg.css === 'string' &&
        (msg.enabled === undefined || typeof msg.enabled === 'boolean');

      if (!isValidPayload) {
        return { ok: false, error: 'Invalid payload' };
      }

      const targetHostname = msg.host || hostname;
      if (msg.host && msg.host !== hostname) {
        return { ok: false, error: 'Host mismatch' };
      }
      storageCache.invalidate();
      if (msg.css && msg.enabled !== false) {
        injectCSS(msg.css, targetHostname);
      } else {
        removeInjectedStyles(targetHostname);
      }
      commitLastAppliedState(targetHostname, msg.css, msg.enabled !== false);
      syncManagedStyleObserver();
      return { ok: true };
    }

    if (msg.type === 'css:clear') {
      const targetHostname = lastApplied.host || hostname;
      storageCache.invalidate();
      removeInjectedStyles(targetHostname);
      commitLastAppliedState(targetHostname, '', true);
      syncManagedStyleObserver();
      return { ok: true };
    }

    return { ok: false, error: `Unhandled message type: ${msg.type}` };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    Promise.resolve()
      .then(() => handleRuntimeMessage(msg, sender))
      .then((response) => {
        sendResponse(response);
      })
      .catch((error) => {
        sendResponse({ ok: false, error: getErrorMessage(error, 'Message handling failed') });
      });

    return true;
  });

  contentScriptRuntime.bootstrapping = false;
  contentScriptRuntime.initialized = true;
})();
