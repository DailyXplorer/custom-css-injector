(function () {
  'use strict';

  const root = typeof globalThis !== 'undefined'
    ? globalThis
    : (typeof window !== 'undefined' ? window : this);
  const runtimeKey = '__CSSInjectorShadowBridgeRuntime';
  const existingRuntime = root[runtimeKey];

  if (existingRuntime && existingRuntime.initialized === true) {
    return;
  }

  const runtime = existingRuntime && typeof existingRuntime === 'object'
    ? existingRuntime
    : {};
  runtime.initialized = false;
  root[runtimeKey] = runtime;

  const BRIDGE_EVENT_NAME = '__CSS_INJECTOR_SHADOW_BRIDGE__';
  const FALLBACK_STYLE_DATA_ATTRIBUTE = 'data-css-injector';
  const BRIDGE_MARKER_ATTRIBUTE = 'data-css-injector-shadow-bridge';

  const trackedShadowRoots = new Set();
  const shadowStyleCache = new WeakMap();
  const shadowRootObservers = new WeakMap();
  const shadowRootDisconnectedSince = new WeakMap();
  const DISCONNECTED_SHADOW_ROOT_RETENTION_MS = 30000;

  let documentObserver = null;
  let recoveryScheduled = false;
  let fullShadowDiscoveryDone = false;
  let currentState = {
    active: false,
    host: '',
    css: '',
    attribute: FALLBACK_STYLE_DATA_ATTRIBUTE
  };

  function isValidAttributeName(attributeName) {
    return typeof attributeName === 'string' && /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(attributeName);
  }

  function getStyleDataAttribute(attributeName) {
    return isValidAttributeName(attributeName) ? attributeName : FALLBACK_STYLE_DATA_ATTRIBUTE;
  }

  function getStyleSelector(attributeName) {
    return `style[${getStyleDataAttribute(attributeName)}]`;
  }

  function isShadowRoot(value) {
    return !!value &&
      value.nodeType === 11 &&
      !!value.host &&
      typeof value.appendChild === 'function';
  }

  function isElementNode(node) {
    return !!node && node.nodeType === 1;
  }

  function isShadowRootConnected(shadowRoot) {
    if (!isShadowRoot(shadowRoot)) return false;
    const host = shadowRoot.host;
    return !host || host.isConnected !== false;
  }

  function cleanupDisconnectedRoots() {
    const now = Date.now();

    for (const shadowRoot of Array.from(trackedShadowRoots)) {
      if (isShadowRootConnected(shadowRoot)) {
        shadowRootDisconnectedSince.delete(shadowRoot);
        continue;
      }

      const disconnectedSince = shadowRootDisconnectedSince.get(shadowRoot);
      if (!disconnectedSince) {
        shadowRootDisconnectedSince.set(shadowRoot, now);
        continue;
      }

      if ((now - disconnectedSince) < DISCONNECTED_SHADOW_ROOT_RETENTION_MS) {
        continue;
      }

      const observer = shadowRootObservers.get(shadowRoot);
      if (observer) {
        observer.disconnect();
        shadowRootObservers.delete(shadowRoot);
      }
      shadowStyleCache.delete(shadowRoot);
      shadowRootDisconnectedSince.delete(shadowRoot);
      trackedShadowRoots.delete(shadowRoot);
    }
  }

  function getInjectedStylesForHost(shadowRoot, host, attributeName) {
    if (!isShadowRoot(shadowRoot) || !host || typeof shadowRoot.querySelectorAll !== 'function') {
      return [];
    }

    const attribute = getStyleDataAttribute(attributeName);
    const styles = shadowRoot.querySelectorAll(getStyleSelector(attribute));
    return Array.from(styles).filter((styleNode) => (
      styleNode &&
      typeof styleNode.getAttribute === 'function' &&
      styleNode.getAttribute(attribute) === host
    ));
  }

  function getManagedStyle(shadowRoot, host, attributeName) {
    const attribute = getStyleDataAttribute(attributeName);
    const cached = shadowStyleCache.get(shadowRoot);

    if (cached &&
        cached.host === host &&
        cached.attribute === attribute &&
        cached.node &&
        cached.node.isConnected &&
        cached.node.getAttribute(attribute) === host) {
      return cached.node;
    }

    const matchingStyles = getInjectedStylesForHost(shadowRoot, host, attribute);
    if (!matchingStyles.length) {
      shadowStyleCache.delete(shadowRoot);
      return null;
    }

    for (let index = 1; index < matchingStyles.length; index += 1) {
      matchingStyles[index].remove();
    }

    const style = matchingStyles[0];
    shadowStyleCache.set(shadowRoot, { host, attribute, node: style });
    return style;
  }

  function attachStyleToShadowRoot(shadowRoot, style) {
    if (!isShadowRoot(shadowRoot) || !style) return;

    if (style.parentNode !== shadowRoot || shadowRoot.lastElementChild !== style) {
      shadowRoot.appendChild(style);
    }
  }

  function ensureManagedStyle(shadowRoot, host, css, attributeName) {
    if (!isShadowRoot(shadowRoot) || !host || typeof css !== 'string') {
      return null;
    }

    const attribute = getStyleDataAttribute(attributeName);
    let style = getManagedStyle(shadowRoot, host, attribute);

    if (!style) {
      style = document.createElement('style');
      style.setAttribute(attribute, host);
      style.setAttribute('data-css-injector-priority', 'user');
      style.setAttribute(BRIDGE_MARKER_ATTRIBUTE, 'true');
      shadowStyleCache.set(shadowRoot, { host, attribute, node: style });
    } else {
      style.setAttribute(attribute, host);
      style.setAttribute(BRIDGE_MARKER_ATTRIBUTE, 'true');
    }

    if (style.textContent !== css) {
      style.textContent = css;
    }

    attachStyleToShadowRoot(shadowRoot, style);
    ensureShadowRootObserver(shadowRoot);
    return style;
  }

  function removeManagedStyles(shadowRoot, host, attributeName) {
    if (!isShadowRoot(shadowRoot) || !host) return;

    const attribute = getStyleDataAttribute(attributeName);
    const cached = shadowStyleCache.get(shadowRoot);
    if (cached && cached.host === host && cached.node) {
      cached.node.remove();
      shadowStyleCache.delete(shadowRoot);
    }

    getInjectedStylesForHost(shadowRoot, host, attribute).forEach((styleNode) => {
      styleNode.remove();
    });
  }

  function nodeContainsStylesheet(node) {
    if (!isElementNode(node)) return false;

    if (typeof node.matches === 'function' && node.matches('style, link[rel="stylesheet"]')) {
      return true;
    }

    return typeof node.querySelector === 'function' &&
      !!node.querySelector('style, link[rel="stylesheet"]');
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
    if (!isShadowRoot(shadowRoot)) return;

    const wasTracked = trackedShadowRoots.has(shadowRoot);
    trackedShadowRoots.add(shadowRoot);

    if (isShadowRootConnected(shadowRoot)) {
      shadowRootDisconnectedSince.delete(shadowRoot);
    } else if (!shadowRootDisconnectedSince.has(shadowRoot)) {
      shadowRootDisconnectedSince.set(shadowRoot, Date.now());
    }

    if (!currentState.active) {
      return;
    }

    ensureManagedStyle(shadowRoot, currentState.host, currentState.css, currentState.attribute);
    ensureShadowRootObserver(shadowRoot);

    if (!wasTracked) {
      discoverShadowRootsInTree(shadowRoot);
    }
  }

  function ensureInitialShadowDiscovery() {
    if (fullShadowDiscoveryDone) return;
    fullShadowDiscoveryDone = true;
    discoverShadowRootsInTree(document);
  }

  function applyCurrentStateToAllShadowRoots() {
    if (!currentState.active) return;

    ensureDocumentObserver();
    ensureInitialShadowDiscovery();
    cleanupDisconnectedRoots();

    for (const shadowRoot of Array.from(trackedShadowRoots)) {
      ensureManagedStyle(shadowRoot, currentState.host, currentState.css, currentState.attribute);
      ensureShadowRootObserver(shadowRoot);
    }
  }

  function removeCurrentHostFromTrackedShadowRoots(host, attributeName) {
    cleanupDisconnectedRoots();

    for (const shadowRoot of Array.from(trackedShadowRoots)) {
      removeManagedStyles(shadowRoot, host, attributeName);
    }
  }

  function queueRecovery() {
    if (recoveryScheduled || !currentState.active) return;

    recoveryScheduled = true;
    queueMicrotask(() => {
      recoveryScheduled = false;
      applyCurrentStateToAllShadowRoots();
    });
  }

  function handleShadowRootMutations(shadowRoot, mutations) {
    let shouldRecover = false;

    for (const mutation of mutations) {
      if (mutation.type !== 'childList') continue;

      for (const addedNode of mutation.addedNodes) {
        discoverShadowRootsFromElement(addedNode);
      }

      if (!currentState.active) continue;

      const cached = shadowStyleCache.get(shadowRoot);
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
      queueRecovery();
    }
  }

  function ensureShadowRootObserver(shadowRoot) {
    if (!isShadowRoot(shadowRoot) || shadowRootObservers.has(shadowRoot) || typeof MutationObserver === 'undefined') {
      return;
    }

    const observer = new MutationObserver((mutations) => handleShadowRootMutations(shadowRoot, mutations));
    observer.observe(shadowRoot, {
      childList: true,
      subtree: true
    });
    shadowRootObservers.set(shadowRoot, observer);
  }

  function handleDocumentMutations(mutations) {
    for (const mutation of mutations) {
      if (mutation.type !== 'childList') continue;
      for (const addedNode of mutation.addedNodes) {
        discoverShadowRootsFromElement(addedNode);
      }
    }
  }

  function ensureDocumentObserver() {
    if (documentObserver || typeof MutationObserver === 'undefined') {
      return;
    }

    const rootNode = document.documentElement || document;
    if (!rootNode) return;

    documentObserver = new MutationObserver(handleDocumentMutations);
    documentObserver.observe(rootNode, {
      childList: true,
      subtree: true
    });
  }

  function disconnectDocumentObserver() {
    if (!documentObserver) return;
    documentObserver.disconnect();
    documentObserver = null;
  }

  function disconnectShadowRootObservers() {
    for (const shadowRoot of Array.from(trackedShadowRoots)) {
      const observer = shadowRootObservers.get(shadowRoot);
      if (!observer) continue;
      observer.disconnect();
      shadowRootObservers.delete(shadowRoot);
    }
  }

  function deactivateCurrentState() {
    fullShadowDiscoveryDone = false;
    disconnectDocumentObserver();
    disconnectShadowRootObservers();
  }

  function patchAttachShadow() {
    const elementPrototype = root.Element && root.Element.prototype;
    if (!elementPrototype || typeof elementPrototype.attachShadow !== 'function') {
      return;
    }

    const originalAttachShadow = elementPrototype.attachShadow;
    if (originalAttachShadow.__cssInjectorShadowBridgeWrapped === true) {
      return;
    }

    const wrappedAttachShadow = function (...args) {
      const shadowRoot = originalAttachShadow.apply(this, args);
      try {
        registerShadowRoot(shadowRoot);
      } catch {
      }
      return shadowRoot;
    };

    try {
      Object.defineProperty(wrappedAttachShadow, '__cssInjectorShadowBridgeWrapped', {
        value: true,
        configurable: true
      });
      Object.defineProperty(wrappedAttachShadow, '__cssInjectorOriginalAttachShadow', {
        value: originalAttachShadow,
        configurable: true
      });
    } catch {
      wrappedAttachShadow.__cssInjectorShadowBridgeWrapped = true;
      wrappedAttachShadow.__cssInjectorOriginalAttachShadow = originalAttachShadow;
    }

    try {
      elementPrototype.attachShadow = wrappedAttachShadow;
    } catch {
    }
  }

  function handleBridgeEvent(event) {
    const detail = event && event.detail;
    if (!detail || detail.source !== 'css-injector' || typeof detail.type !== 'string') {
      return;
    }

    const host = typeof detail.host === 'string' ? detail.host : '';
    const attribute = getStyleDataAttribute(detail.attribute);

    if (!host) return;

    if (detail.type === 'apply') {
      const css = typeof detail.css === 'string' ? detail.css : '';
      if (!css) {
        currentState = { active: false, host, css: '', attribute };
        removeCurrentHostFromTrackedShadowRoots(host, attribute);
        deactivateCurrentState();
        return;
      }

      currentState = { active: true, host, css, attribute };
      applyCurrentStateToAllShadowRoots();
      return;
    }

    if (detail.type === 'clear') {
      if (currentState.host === host) {
        currentState = { active: false, host, css: '', attribute };
        deactivateCurrentState();
      }
      removeCurrentHostFromTrackedShadowRoots(host, attribute);
    }
  }

  patchAttachShadow();
  window.addEventListener(BRIDGE_EVENT_NAME, handleBridgeEvent);

  runtime.initialized = true;
})();
