(function () {
  'use strict';

  const root = typeof globalThis !== 'undefined'
    ? globalThis
    : (typeof window !== 'undefined' ? window : this);
  const runtimeKey = '__CSSInjectorContentScriptRuntime';
  const runtimeVersion = 2;
  const existingRuntime = root[runtimeKey];

  if (existingRuntime &&
      existingRuntime.version !== runtimeVersion &&
      (existingRuntime.initialized === true || existingRuntime.bootstrapping === true)) {
    if (typeof existingRuntime.dispose === 'function') {
      try {
        existingRuntime.dispose();
      } catch {
      }
    } else {
      existingRuntime.requiresReload = true;
      return;
    }
  }

  if (existingRuntime &&
      existingRuntime.version === runtimeVersion &&
      (existingRuntime.initialized === true || existingRuntime.bootstrapping === true)) {
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
  contentScriptRuntime.version = runtimeVersion;
  root[runtimeKey] = contentScriptRuntime;

  let bootstrapCompleted = false;
  let disposed = false;
  try {

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

  function getStyleDataAttributeName() {
    if (typeof CSSInjectorConstants !== 'undefined' &&
        CSSInjectorConstants.STYLE &&
        typeof CSSInjectorConstants.STYLE.DATA_ATTRIBUTE === 'string' &&
        CSSInjectorConstants.STYLE.DATA_ATTRIBUTE) {
      return CSSInjectorConstants.STYLE.DATA_ATTRIBUTE;
    }
    return 'data-css-injector';
  }

  const STYLE_DATA_ATTRIBUTE = getStyleDataAttributeName();
  const STYLE_SELECTOR = `style[${STYLE_DATA_ATTRIBUTE}]`;
  const SHADOW_ATTACHED_EVENT_NAME = '__CSS_INJECTOR_SHADOW_ATTACHED__';
  const LEGACY_SHADOW_BRIDGE_EVENT_NAME = '__CSS_INJECTOR_SHADOW_BRIDGE__';
  const TOP_HOST_CACHE_TTL_MS = 3000;
  const TOP_HOST_RETRY_DELAYS_MS = [500, 1500];
  const extensionRuntimeId = (() => {
    try {
      return chrome.runtime && typeof chrome.runtime.id === 'string' && chrome.runtime.id
        ? chrome.runtime.id
        : 'runtime';
    } catch {
      return 'runtime';
    }
  })();
  const STYLE_OWNER_ATTRIBUTE = 'data-css-injector-owner';
  const STYLE_OWNER_VALUE = `${extensionRuntimeId}:v2`;
  const LEGACY_STYLE_PRIORITY_ATTRIBUTE = 'data-css-injector-priority';
  const LEGACY_SHADOW_STYLE_ATTRIBUTE = 'data-css-injector-shadow-bridge';
  const LEGACY_DISABLED_ATTRIBUTE = 'data-css-injector-legacy-disabled';
  const CONSTRUCTED_SHEET_MARKER_PROPERTY =
    `--__css-injector-${extensionRuntimeId}-managed-sheet-v2`;
  const CONSTRUCTED_SHEET_MARKER_RULE =
    `@media not all { :root { ${CONSTRUCTED_SHEET_MARKER_PROPERTY}: 1; } }`;

  const managedStyleCache = {
    host: null,
    node: null,
    baseUrl: ''
  };

  const topHostCache = {
    host: null,
    source: null,
    timestamp: 0
  };

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

  function cacheTopHostname(hostname, source) {
    if (!hostname || !['top', 'accessible-top', 'ancestor', 'background'].includes(source)) return;
    topHostCache.host = hostname;
    topHostCache.source = source;
    topHostCache.timestamp = Date.now();
  }

  function invalidateTopHostnameCache() {
    topHostCache.host = null;
    topHostCache.source = null;
    topHostCache.timestamp = 0;
  }

  async function resolveManagedHostname(forceRefresh = false) {
    const frameHostname = getFrameHostname();

    if (isTopFrame()) {
      if (!frameHostname) return null;
      cacheTopHostname(frameHostname, 'top');
      resetTopHostResolutionRetry();
      return frameHostname;
    }

    if (forceRefresh) invalidateTopHostnameCache();

    if (!forceRefresh &&
        topHostCache.host &&
        topHostCache.source &&
        (Date.now() - topHostCache.timestamp) < TOP_HOST_CACHE_TTL_MS) {
      return topHostCache.host;
    }

    const accessibleTopHostname = getAccessibleTopHostname();
    if (accessibleTopHostname) {
      cacheTopHostname(accessibleTopHostname, 'accessible-top');
      resetTopHostResolutionRetry();
      return accessibleTopHostname;
    }

    const ancestorTopHostname = getTopHostnameFromAncestorOrigins();
    if (ancestorTopHostname) {
      cacheTopHostname(ancestorTopHostname, 'ancestor');
      resetTopHostResolutionRetry();
      return ancestorTopHostname;
    }

    const topHostname = await requestTopHostnameFromBackground();
    if (!topHostname) return null;

    cacheTopHostname(topHostname, 'background');
    resetTopHostResolutionRetry();
    return topHostname;
  }

  function getInjectedStylesForHostname(hostname) {
    if (!hostname || typeof hostname !== 'string') {
      return [];
    }

    const styles = document.querySelectorAll(STYLE_SELECTOR);
    return Array.from(styles).filter((styleNode) => (
      styleNode &&
      typeof styleNode.getAttribute === 'function' &&
      styleNode.getAttribute(STYLE_DATA_ATTRIBUTE) === hostname &&
      isOwnedManagedStyleNode(styleNode)
    ));
  }

  function getInjectedStyle(hostname) {
    if (managedStyleCache.host === hostname && managedStyleCache.node) {
      if (managedStyleCache.node.isConnected && isOwnedManagedStyleNode(managedStyleCache.node)) {
        return managedStyleCache.node;
      }
      managedStyleCache.node.remove();
      managedStyleCache.node = null;
    }

    const matchingStyles = getInjectedStylesForHostname(hostname);
    if (!matchingStyles.length) return null;

    if (matchingStyles.length > 1) {
      for (let index = 1; index < matchingStyles.length; index++) {
        matchingStyles[index].remove();
      }
    }

    managedStyleCache.host = hostname;
    managedStyleCache.node = matchingStyles[0];
    managedStyleCache.baseUrl = '';
    return matchingStyles[0];
  }

  function getDocumentStyleParent() {
    if (managedStyleMode === 'node' ||
        (managedStyleMode === 'adopted' && managedCssNeedsImportFallback)) {
      return document.body || document.head || document.documentElement || null;
    }
    return document.head || document.documentElement || null;
  }

  function getDocumentCssBaseUrl() {
    const baseUrl = typeof document.baseURI === 'string' ? document.baseURI : '';
    const fragmentIndex = baseUrl.indexOf('#');
    return fragmentIndex === -1 ? baseUrl : baseUrl.slice(0, fragmentIndex);
  }

  function attachManagedStyle(style, retries = 3) {
    if (disposed) return;
    const parentNode = getDocumentStyleParent();
    if (parentNode) {
      if (style.parentNode !== parentNode || parentNode.lastElementChild !== style) {
        parentNode.appendChild(style);
      }
      return;
    }

    if (retries > 0) {
      setTimeout(() => attachManagedStyle(style, retries - 1), 16);
    }
  }

  function ensureManagedStyle(hostname) {
    if (!hostname || typeof hostname !== 'string') return null;

    const cachedStyle = getInjectedStyle(hostname);
    if (cachedStyle) {
      cachedStyle.setAttribute(STYLE_DATA_ATTRIBUTE, hostname);
      normalizeManagedStyleElement(cachedStyle);
      attachManagedStyle(cachedStyle);
      return cachedStyle;
    }

    const style = document.createElement('style');
    style.setAttribute(STYLE_DATA_ATTRIBUTE, hostname);
    normalizeManagedStyleElement(style);
    managedStyleCache.host = hostname;
    managedStyleCache.node = style;
    managedStyleCache.baseUrl = '';
    attachManagedStyle(style);
    return style;
  }

  function cssNeedsImportFallback(cssContent) {
    if (typeof CSSInjectorUtils !== 'undefined' &&
        typeof CSSInjectorUtils.hasTopLevelCssImport === 'function') {
      return CSSInjectorUtils.hasTopLevelCssImport(cssContent);
    }
    // `utils.js` normally provides the lexical scanner. Keep a conservative
    // fallback so a partial programmatic reinjection never drops real imports.
    return /@import\b/i.test(cssContent) || /@[^;{]*\\/.test(cssContent);
  }

  function normalizeManagedStyleElement(style) {
    if (!style || typeof style.removeAttribute !== 'function') return;
    style.setAttribute(STYLE_OWNER_ATTRIBUTE, STYLE_OWNER_VALUE);
    style.removeAttribute('media');
    style.removeAttribute('type');
  }

  function isOwnedManagedStyleNode(style) {
    if (!style || typeof style.getAttribute !== 'function') return false;
    return style.getAttribute(STYLE_OWNER_ATTRIBUTE) === STYLE_OWNER_VALUE;
  }

  function isLegacyManagedStyleNode(style, isShadowScope) {
    if (!style || typeof style.getAttribute !== 'function' ||
        style.hasAttribute(STYLE_OWNER_ATTRIBUTE) ||
        style.getAttribute(LEGACY_STYLE_PRIORITY_ATTRIBUTE) !== 'user' ||
        !style.getAttribute(STYLE_DATA_ATTRIBUTE) ||
        !style.textContent ||
        style.hasAttribute('media') ||
        style.hasAttribute('type')) {
      return false;
    }
    const shadowMarker = style.getAttribute(LEGACY_SHADOW_STYLE_ATTRIBUTE);
    return isShadowScope ? shadowMarker === 'true' : shadowMarker === null;
  }

  function isDisabledLegacyDocumentStyle(style) {
    return !!style &&
      typeof style.getAttribute === 'function' &&
      !style.hasAttribute(STYLE_OWNER_ATTRIBUTE) &&
      !!style.getAttribute(STYLE_DATA_ATTRIBUTE) &&
      style.getAttribute(LEGACY_STYLE_PRIORITY_ATTRIBUTE) === 'user' &&
      style.getAttribute(LEGACY_SHADOW_STYLE_ATTRIBUTE) === null &&
      style.getAttribute(LEGACY_DISABLED_ATTRIBUTE) === 'true' &&
      style.getAttribute('media') === 'not all' &&
      style.getAttribute('type') === 'text/plain';
  }

  function canUseConstructedStylesheet() {
    try {
      return typeof CSSStyleSheet === 'function' &&
        typeof CSSStyleSheet.prototype.replaceSync === 'function' &&
        typeof CSSStyleSheet.prototype.insertRule === 'function' &&
        Array.isArray(document.adoptedStyleSheets);
    } catch {
      return false;
    }
  }

  function normalizeConstructedSheetMedia(sheet) {
    try {
      if (!sheet.media || sheet.media.mediaText === '') return true;
      sheet.media.mediaText = '';
      return sheet.media.mediaText === '';
    } catch {
      return false;
    }
  }

  function writeManagedConstructedSheet(sheet, cssContent) {
    if (!normalizeConstructedSheetMedia(sheet)) {
      throw new Error('Unable to reset constructed stylesheet media.');
    }
    sheet.replaceSync(cssContent);
    sheet.insertRule(CONSTRUCTED_SHEET_MARKER_RULE, sheet.cssRules.length);
  }

  function isManagedConstructedSheet(sheet) {
    if (!sheet) return false;
    try {
      const rules = sheet.cssRules;
      if (rules.length === 0) return false;
      const hasMarker = (rule) => {
        if (!rule || !rule.cssRules || rule.cssRules.length !== 1) {
          return false;
        }
        const markerStyle = rule.cssRules[0] && rule.cssRules[0].style;
        return !!markerStyle && markerStyle.getPropertyValue(CONSTRUCTED_SHEET_MARKER_PROPERTY) === '1';
      };
      if (hasMarker(rules[rules.length - 1])) return true;
      // Transitional development builds briefly put the same marker first.
      return hasMarker(rules[0]);
    } catch {
      return false;
    }
  }

  function sweepManagedConstructedSheetsFromScope(scope, keepSheet = null) {
    if (!scope) return;
    try {
      const currentSheets = scope.adoptedStyleSheets;
      if (!Array.isArray(currentSheets)) return;
      const nextSheets = currentSheets.filter((sheet) => (
        sheet === keepSheet || !isManagedConstructedSheet(sheet)
      ));
      if (nextSheets.length !== currentSheets.length) {
        scope.adoptedStyleSheets = nextSheets;
      }
    } catch {
    }
  }

  function removeConstructedSheetFromScope(scope) {
    if (!managedConstructedSheet || !scope) return;
    try {
      const currentSheets = scope.adoptedStyleSheets;
      if (!Array.isArray(currentSheets) || !currentSheets.includes(managedConstructedSheet)) return;
      scope.adoptedStyleSheets = currentSheets.filter((sheet) => sheet !== managedConstructedSheet);
    } catch {
    }
  }

  function ensureConstructedSheetInScope(scope) {
    if (managedStyleMode !== 'adopted' || !managedConstructedSheet || !scope) return false;
    try {
      if (!sweptConstructedSheetScopes.has(scope)) {
        sweepManagedConstructedSheetsFromScope(scope, managedConstructedSheet);
        sweptConstructedSheetScopes.add(scope);
      }
      const currentSheets = scope.adoptedStyleSheets;
      if (!Array.isArray(currentSheets)) return false;
      if (currentSheets[currentSheets.length - 1] === managedConstructedSheet) return true;
      scope.adoptedStyleSheets = [
        ...currentSheets.filter((sheet) => sheet !== managedConstructedSheet),
        managedConstructedSheet
      ];
      return true;
    } catch {
      return false;
    }
  }

  function getConstructedSheetFingerprint(sheet) {
    try {
      const rules = sheet.cssRules;
      const length = rules.length;
      let hash = 2166136261;
      let textLength = 0;
      for (let index = 0; index < length; index += 1) {
        const ruleText = rules[index].cssText;
        textLength += ruleText.length;
        for (let characterIndex = 0; characterIndex < ruleText.length; characterIndex += 1) {
          hash ^= ruleText.charCodeAt(characterIndex);
          hash = Math.imul(hash, 16777619);
        }
        hash ^= 10;
        hash = Math.imul(hash, 16777619);
      }
      return {
        length,
        textLength,
        hash: hash >>> 0
      };
    } catch {
      return null;
    }
  }

  function isConstructedSheetQuickStateCurrent() {
    if (!managedConstructedSheet || !managedConstructedFingerprint) return false;
    if (managedConstructedSheet.disabled === true) return false;
    if (!normalizeConstructedSheetMedia(managedConstructedSheet)) return false;
    try {
      return managedConstructedSheet.cssRules.length === managedConstructedFingerprint.length &&
        isManagedConstructedSheet(managedConstructedSheet);
    } catch {
      return false;
    }
  }

  function isConstructedSheetFingerprintCurrent() {
    if (!isConstructedSheetQuickStateCurrent()) return false;
    const current = getConstructedSheetFingerprint(managedConstructedSheet);
    return !!current &&
      current.length === managedConstructedFingerprint.length &&
      current.textLength === managedConstructedFingerprint.textLength &&
      current.hash === managedConstructedFingerprint.hash;
  }

  function repairConstructedSheetContents(forceFullCheck = false) {
    if (managedStyleMode !== 'adopted' || !managedConstructedSheet) return;
    const now = Date.now();
    const shouldRunFullCheck = forceFullCheck ||
      managedConstructedCss.length <= CONSTRUCTED_SHEET_SMALL_CSS_BYTES ||
      (now - managedConstructedLastFullCheck) >= CONSTRUCTED_SHEET_FULL_CHECK_DELAY_MS;
    if (isConstructedSheetQuickStateCurrent() && !shouldRunFullCheck) return;
    if (shouldRunFullCheck) {
      managedConstructedLastFullCheck = now;
      if (isConstructedSheetFingerprintCurrent()) return;
    }
    try {
      const previousSheet = managedConstructedSheet;
      let repairedSheet = previousSheet;
      try {
        repairedSheet.disabled = false;
        writeManagedConstructedSheet(repairedSheet, managedConstructedCss);
      } catch {
        repairedSheet = new CSSStyleSheet();
        writeManagedConstructedSheet(repairedSheet, managedConstructedCss);
      }
      if (repairedSheet !== previousSheet) {
        removeConstructedSheetEverywhere();
        managedConstructedSheet = repairedSheet;
        sweepManagedConstructedSheetsFromScope(document, repairedSheet);
        ensureConstructedSheetInScope(document);
        for (const shadowRoot of Array.from(trackedShadowRoots)) {
          ensureConstructedSheetInScope(shadowRoot);
        }
        scheduleAdoptedSheetGuard();
      }
      managedConstructedFingerprint = getConstructedSheetFingerprint(repairedSheet);
      managedConstructedLastFullCheck = now;
    } catch {
    }
  }

  function stopAdoptedSheetGuard() {
    if (adoptedSheetGuardTimer !== null) {
      clearTimeout(adoptedSheetGuardTimer);
      adoptedSheetGuardTimer = null;
    }
  }

  function stopNodeFallbackGuard() {
    if (nodeFallbackGuardTimer !== null) {
      clearTimeout(nodeFallbackGuardTimer);
      nodeFallbackGuardTimer = null;
    }
  }

  function scheduleNodeFallbackGuard() {
    if (disposed || managedStyleMode !== 'node' || nodeFallbackGuardTimer !== null) return;
    nodeFallbackGuardTimer = setTimeout(() => {
      nodeFallbackGuardTimer = null;
      if (disposed || managedStyleMode !== 'node' || !shadowState.active) return;
      applyDocumentCSS(shadowState.css, shadowState.host);
      for (const shadowRoot of Array.from(trackedShadowRoots)) {
        ensureShadowManagedStyle(shadowRoot, shadowState.host, shadowState.css);
      }
      scheduleNodeFallbackGuard();
    }, NODE_FALLBACK_GUARD_DELAY_MS);
  }

  function scheduleAdoptedSheetGuard() {
    if (disposed || managedStyleMode !== 'adopted' || adoptedSheetGuardTimer !== null) return;
    adoptedSheetGuardTimer = setTimeout(() => {
      adoptedSheetGuardTimer = null;
      if (disposed || managedStyleMode !== 'adopted' || !shadowState.active) return;
      refreshConstructedSheetBaseIfNeeded();
      repairConstructedSheetContents();
      applyDocumentCSS(managedConstructedCss, shadowState.host);
      for (const shadowRoot of Array.from(trackedShadowRoots)) {
        ensureShadowManagedStyle(shadowRoot, shadowState.host, managedConstructedCss);
      }
      scheduleAdoptedSheetGuard();
    }, ADOPTED_SHEET_GUARD_DELAY_MS);
  }

  function removeConstructedSheetEverywhere() {
    stopAdoptedSheetGuard();
    removeConstructedSheetFromScope(document);
    for (const shadowRoot of Array.from(trackedShadowRoots)) {
      removeConstructedSheetFromScope(shadowRoot);
    }
  }

  function removeDocumentManagedStyleNodes(hostname) {
    if (managedStyleCache.host === hostname && managedStyleCache.node) {
      managedStyleCache.node.remove();
    }
    if (!documentManagedNodesSwept) {
      getInjectedStylesForHostname(hostname).forEach((styleNode) => styleNode.remove());
      documentManagedNodesSwept = true;
    }
    if (managedStyleCache.host === hostname) {
      managedStyleCache.host = null;
      managedStyleCache.node = null;
      managedStyleCache.baseUrl = '';
    }
  }

  function prepareManagedStyleMode(cssContent, hostname) {
    managedCssNeedsImportFallback = cssNeedsImportFallback(cssContent);
    if (canUseConstructedStylesheet()) {
      const currentBaseUrl = getDocumentCssBaseUrl();
      const canReuseSheet = managedStyleMode === 'adopted' &&
        managedConstructedSheet &&
        managedConstructedBaseUrl === currentBaseUrl;
      const previousSheet = managedConstructedSheet;
      let nextSheet = canReuseSheet ? managedConstructedSheet : null;
      try {
        if (nextSheet) {
          try {
            nextSheet.disabled = false;
            writeManagedConstructedSheet(nextSheet, cssContent);
          } catch {
            nextSheet = null;
          }
        }
        if (!nextSheet) {
          nextSheet = new CSSStyleSheet();
          nextSheet.disabled = false;
          writeManagedConstructedSheet(nextSheet, cssContent);
        }
      } catch {
        nextSheet = null;
      }

      if (nextSheet) {
        stopNodeFallbackGuard();
        if (previousSheet && previousSheet !== nextSheet) {
          removeConstructedSheetEverywhere();
        }
        if (managedStyleMode !== 'adopted') {
          removeDocumentManagedStyleNodes(hostname);
          for (const shadowRoot of Array.from(trackedShadowRoots)) {
            removeShadowManagedStyles(shadowRoot, hostname);
          }
        }
        managedConstructedSheet = nextSheet;
        managedConstructedCss = cssContent;
        managedConstructedBaseUrl = currentBaseUrl;
        managedConstructedFingerprint = getConstructedSheetFingerprint(nextSheet);
        managedConstructedLastFullCheck = Date.now();
        managedStyleMode = 'adopted';
        sweptConstructedSheetScopes.add(document);
        sweepManagedConstructedSheetsFromScope(document, nextSheet);
        ensureConstructedSheetInScope(document);
        scheduleAdoptedSheetGuard();
        return true;
      }
    }

    if (managedStyleMode === 'adopted') {
      removeConstructedSheetEverywhere();
    }
    managedConstructedSheet = null;
    managedConstructedCss = '';
    managedConstructedBaseUrl = '';
    managedConstructedFingerprint = null;
    managedConstructedLastFullCheck = 0;
    managedStyleMode = 'node';
    return false;
  }

  function refreshConstructedSheetBaseIfNeeded() {
    if (managedStyleMode !== 'adopted' || managedConstructedBaseUrl === getDocumentCssBaseUrl()) return false;
    const hostname = shadowState.host || lastApplied.host;
    prepareManagedStyleMode(managedConstructedCss, hostname);
    applyDocumentCSS(managedConstructedCss, hostname);
    for (const shadowRoot of Array.from(trackedShadowRoots)) {
      ensureShadowManagedStyle(shadowRoot, hostname, managedConstructedCss);
    }
    return true;
  }

  function dispatchLegacyShadowBridgeClear(hostname) {
    if (!hostname || typeof hostname !== 'string') return;
    try {
      if (typeof window.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
      window.dispatchEvent(new CustomEvent(LEGACY_SHADOW_BRIDGE_EVENT_NAME, {
        detail: {
          source: 'css-injector',
          type: 'clear',
          host: hostname,
          css: '',
          attribute: STYLE_DATA_ATTRIBUTE
        }
      }));
    } catch {
    }
  }

  function removeInjectedStyles(hostname) {
    dispatchLegacyShadowBridgeClear(hostname);
    removeConstructedSheetEverywhere();
    stopNodeFallbackGuard();
    removeDocumentManagedStyleNodes(hostname);

    clearShadowCSS(hostname);
    managedConstructedSheet = null;
    managedConstructedCss = '';
    managedConstructedBaseUrl = '';
    managedConstructedFingerprint = null;
    managedConstructedLastFullCheck = 0;
    managedCssNeedsImportFallback = false;
    managedStyleMode = 'none';
  }

  function injectCSS(cssContent, hostname, forceShadowRescan = false) {
    if (!cssContent || typeof cssContent !== 'string' || !hostname || typeof hostname !== 'string') {
      return;
    }

    try {
      dispatchLegacyShadowBridgeClear(hostname);
      prepareManagedStyleMode(cssContent, hostname);
      applyDocumentCSS(cssContent, hostname);
      applyShadowCSS(hostname, cssContent, forceShadowRescan);
    } catch (error) {
      console.error('[CSS Injector] Failed to inject CSS:', error);
    }
  }

  function canReuseManagedStyleState(cssContent, hostname) {
    if (!cssContent || !hostname || lastApplied.host !== hostname || lastApplied.css !== cssContent) {
      return false;
    }
    if (managedStyleMode === 'adopted') {
      return !!managedConstructedSheet &&
        managedConstructedCss === cssContent &&
        managedConstructedBaseUrl === getDocumentCssBaseUrl();
    }
    return managedStyleMode === 'node';
  }

  function reassertInjectedCSS(cssContent, hostname, forceShadowRescan = false) {
    if (!canReuseManagedStyleState(cssContent, hostname)) {
      injectCSS(cssContent, hostname, forceShadowRescan);
      return;
    }

    if (managedStyleMode === 'adopted' && !isConstructedSheetQuickStateCurrent()) {
      repairConstructedSheetContents();
    }
    applyDocumentCSS(cssContent, hostname);
    applyShadowCSS(hostname, cssContent, forceShadowRescan);
  }

  function applyDocumentCSS(cssContent, hostname) {
    if (managedStyleMode === 'adopted') {
      if (managedCssNeedsImportFallback) {
        const importCarrier = ensureManagedStyle(hostname);
        documentManagedNodesSwept = false;
        if (importCarrier &&
            (importCarrier.textContent !== cssContent || managedStyleCache.baseUrl !== getDocumentCssBaseUrl())) {
          if (importCarrier.textContent === cssContent) importCarrier.textContent = '';
          importCarrier.textContent = cssContent;
          managedStyleCache.baseUrl = getDocumentCssBaseUrl();
        }
        try {
          if (importCarrier && importCarrier.sheet && importCarrier.sheet.disabled) {
            importCarrier.sheet.disabled = false;
          }
        } catch {
        }
        if (importCarrier) attachManagedStyle(importCarrier);
      } else {
        removeDocumentManagedStyleNodes(hostname);
      }
      ensureConstructedSheetInScope(document);
      scheduleAdoptedSheetGuard();
      return;
    }
    const style = ensureManagedStyle(hostname);
    documentManagedNodesSwept = false;
    if (!style) return;
    if (style.textContent !== cssContent) {
      style.textContent = cssContent;
    }
    if (managedStyleCache.baseUrl !== getDocumentCssBaseUrl()) {
      if (style.textContent === cssContent) style.textContent = '';
      style.textContent = cssContent;
      managedStyleCache.baseUrl = getDocumentCssBaseUrl();
    }
    try {
      if (style.sheet && style.sheet.disabled) style.sheet.disabled = false;
    } catch {
    }
    attachManagedStyle(style);
    syncManagedStyleNodeObserver();
    scheduleNodeFallbackGuard();
  }

  function isElementNode(node) {
    return !!node && node.nodeType === 1;
  }

  function isShadowRoot(node) {
    return !!node &&
      node.nodeType === 11 &&
      !!node.host &&
      typeof node.appendChild === 'function';
  }

  function getOpenOrClosedShadowRoot(element) {
    if (!isElementNode(element)) return null;

    try {
      if (chrome.dom && typeof chrome.dom.openOrClosedShadowRoot === 'function') {
        const shadowRoot = chrome.dom.openOrClosedShadowRoot(element);
        if (isShadowRoot(shadowRoot)) return shadowRoot;
      }
    } catch {
    }

    try {
      return isShadowRoot(element.shadowRoot) ? element.shadowRoot : null;
    } catch {
      return null;
    }
  }

  function getShadowStylesForHost(shadowRoot, hostname) {
    if (!isShadowRoot(shadowRoot) || !hostname || typeof shadowRoot.querySelectorAll !== 'function') {
      return [];
    }

    try {
      return Array.from(shadowRoot.querySelectorAll(STYLE_SELECTOR)).filter((styleNode) => (
        styleNode &&
        typeof styleNode.getAttribute === 'function' &&
        styleNode.getAttribute(STYLE_DATA_ATTRIBUTE) === hostname &&
        isOwnedManagedStyleNode(styleNode)
      ));
    } catch {
      return [];
    }
  }

  function getShadowManagedStyle(shadowRoot, hostname) {
    const cached = shadowStyleCache.get(shadowRoot);
    if (cached && cached.host === hostname && cached.node) {
      if (cached.node.parentNode === shadowRoot && isOwnedManagedStyleNode(cached.node)) {
        return cached.node;
      }
      cached.node.remove();
      shadowStyleCache.delete(shadowRoot);
    }

    const matchingStyles = getShadowStylesForHost(shadowRoot, hostname);
    if (!matchingStyles.length) {
      shadowStyleCache.delete(shadowRoot);
      return null;
    }

    for (let index = 1; index < matchingStyles.length; index += 1) {
      matchingStyles[index].remove();
    }

    const style = matchingStyles[0];
    shadowStyleCache.set(shadowRoot, { host: hostname, node: style, baseUrl: '' });
    return style;
  }

  function ensureShadowManagedStyle(shadowRoot, hostname, cssContent) {
    if (!isShadowRoot(shadowRoot) || !hostname || typeof cssContent !== 'string' || !cssContent) {
      return null;
    }

    if (managedStyleMode === 'adopted') {
      ensureConstructedSheetInScope(shadowRoot);
      ensureShadowRootObserver(shadowRoot);
      scheduleAdoptedSheetGuard();
      if (!managedCssNeedsImportFallback) {
        if (shadowStyleCache.has(shadowRoot)) {
          removeShadowManagedStyleNode(shadowRoot, hostname);
        }
        return null;
      }
    }

    let style = getShadowManagedStyle(shadowRoot, hostname);
    if (!style) {
      style = document.createElement('style');
      shadowStyleCache.set(shadowRoot, { host: hostname, node: style, baseUrl: '' });
    }

    style.setAttribute(STYLE_DATA_ATTRIBUTE, hostname);
    normalizeManagedStyleElement(style);
    const cachedState = shadowStyleCache.get(shadowRoot);
    if (style.textContent !== cssContent || !cachedState || cachedState.baseUrl !== getDocumentCssBaseUrl()) {
      if (style.textContent === cssContent) style.textContent = '';
      style.textContent = cssContent;
      shadowStyleCache.set(shadowRoot, {
        host: hostname,
        node: style,
        baseUrl: getDocumentCssBaseUrl()
      });
    }

    if (style.parentNode !== shadowRoot || shadowRoot.lastElementChild !== style) {
      shadowRoot.appendChild(style);
    }
    try {
      if (style.sheet && style.sheet.disabled) style.sheet.disabled = false;
    } catch {
    }

    ensureShadowRootObserver(shadowRoot);
    syncShadowStyleObserver(shadowRoot, style);
    return style;
  }

  function removeShadowManagedStyleNode(shadowRoot, hostname) {
    if (!isShadowRoot(shadowRoot) || !hostname) return;

    const cached = shadowStyleCache.get(shadowRoot);
    if (cached && cached.host === hostname && cached.node) {
      cached.node.remove();
      shadowStyleCache.delete(shadowRoot);
    }

    const styleObserverState = shadowStyleObservers.get(shadowRoot);
    if (styleObserverState) {
      styleObserverState.observer.disconnect();
      shadowStyleObservers.delete(shadowRoot);
    }

    getShadowStylesForHost(shadowRoot, hostname).forEach((styleNode) => styleNode.remove());
  }

  function removeShadowManagedStyles(shadowRoot, hostname) {
    if (!isShadowRoot(shadowRoot) || !hostname) return;

    removeConstructedSheetFromScope(shadowRoot);
    removeShadowManagedStyleNode(shadowRoot, hostname);
  }

  function registerShadowRoot(shadowRoot) {
    if (!shadowState.active || !isShadowRoot(shadowRoot)) return;

    const wasTracked = trackedShadowRoots.has(shadowRoot);
    trackedShadowRoots.add(shadowRoot);
    if (!wasTracked && managedStyleMode === 'adopted') {
      getShadowStylesForHost(shadowRoot, shadowState.host).forEach((styleNode) => styleNode.remove());
    }
    ensureShadowManagedStyle(shadowRoot, shadowState.host, shadowState.css);
    ensureShadowRootObserver(shadowRoot);
  }

  function discoverShadowRootsFromNode(startNode) {
    if (!shadowState.active || !startNode) return;

    const containers = [startNode];
    const visitedContainers = new Set();

    while (containers.length > 0) {
      const container = containers.pop();
      if (!container || visitedContainers.has(container)) continue;
      visitedContainers.add(container);

      const inspectElement = (element) => {
        const shadowRoot = getOpenOrClosedShadowRoot(element);
        if (!shadowRoot) return;

        registerShadowRoot(shadowRoot);
        if (!visitedContainers.has(shadowRoot)) {
          containers.push(shadowRoot);
        }
      };

      if (isElementNode(container)) inspectElement(container);

      if (typeof container.querySelectorAll === 'function') {
        try {
          for (const element of container.querySelectorAll('*')) {
            inspectElement(element);
          }
        } catch {
        }
      }
    }
  }

  function queueShadowDiscovery(startNode) {
    if (disposed || !shadowState.active) return;
    if (startNode !== document && !isElementNode(startNode) && !isShadowRoot(startNode)) return;

    pendingShadowDiscoveryTargets.add(startNode || document);
    if (shadowDiscoveryScheduled) return;

    shadowDiscoveryScheduled = true;
    queueMicrotask(() => {
      shadowDiscoveryScheduled = false;
      const candidates = Array.from(pendingShadowDiscoveryTargets);
      pendingShadowDiscoveryTargets.clear();

      if (disposed || !shadowState.active) return;
      if (candidates.includes(document)) {
        discoverShadowRootsFromNode(document);
        return;
      }

      const candidateSet = new Set(candidates);
      const queuedAncestorMemo = new WeakMap();
      const getDiscoveryParent = (node) => {
        try {
          if (node.parentNode) return node.parentNode;
          if (isShadowRoot(node)) return node.host || null;
        } catch {
        }
        return null;
      };
      const hasQueuedAncestor = (candidate) => {
        const path = [];
        let ancestor = getDiscoveryParent(candidate);
        let covered = false;

        while (ancestor) {
          if (candidateSet.has(ancestor)) {
            covered = true;
            break;
          }
          if (queuedAncestorMemo.has(ancestor)) {
            covered = queuedAncestorMemo.get(ancestor);
            break;
          }
          path.push(ancestor);
          ancestor = getDiscoveryParent(ancestor);
        }

        for (const pathNode of path) {
          queuedAncestorMemo.set(pathNode, covered);
        }
        return covered;
      };

      // Path-compressed ancestor lookup makes connected nested construction
      // linear, even when queued elements are separated by detached spacers.
      // Sibling batches remain individual roots, avoiding a rescan of their
      // already-large parent.
      const targets = [];
      for (const candidate of candidates) {
        if (!hasQueuedAncestor(candidate)) targets.push(candidate);
      }

      for (const target of targets) {
        discoverShadowRootsFromNode(target);
      }
    });
  }

  function queueShadowRootRecovery(shadowRoot) {
    if (disposed || !shadowState.active || !trackedShadowRoots.has(shadowRoot)) return;

    pendingShadowRootRecoveries.add(shadowRoot);
    if (shadowRecoveryScheduled) return;

    shadowRecoveryScheduled = true;
    const now = Date.now();
    if (now - shadowRecoveryWindowStart > STYLE_GUARD_RECOVERY_WINDOW_MS) {
      shadowRecoveryWindowStart = now;
      shadowRecoveryCount = 0;
    }
    shadowRecoveryCount += 1;

    const runRecovery = () => {
      shadowRecoveryTimer = null;
      shadowRecoveryScheduled = false;
      const roots = Array.from(pendingShadowRootRecoveries);
      pendingShadowRootRecoveries.clear();

      if (disposed || !shadowState.active) return;
      for (const rootToRepair of roots) {
        if (!trackedShadowRoots.has(rootToRepair)) continue;
        ensureShadowManagedStyle(rootToRepair, shadowState.host, shadowState.css);
        if (managedStyleMode === 'node') {
          const cached = shadowStyleCache.get(rootToRepair);
          getShadowStylesForHost(rootToRepair, shadowState.host).forEach((styleNode) => {
            if (!cached || styleNode !== cached.node) styleNode.remove();
          });
        }
      }
    };

    if (shadowRecoveryCount > STYLE_GUARD_MAX_RECOVERIES_PER_WINDOW) {
      shadowRecoveryTimer = setTimeout(runRecovery, STYLE_GUARD_RECOVERY_WINDOW_MS);
    } else {
      queueMicrotask(runRecovery);
    }
  }

  function cleanupDisconnectedShadowRoots() {
    shadowCleanupTimer = null;

    for (const shadowRoot of Array.from(trackedShadowRoots)) {
      if (shadowRoot.host &&
          shadowRoot.host.isConnected &&
          shadowRoot.host.ownerDocument === document) continue;

      removeShadowManagedStyles(shadowRoot, shadowState.host);
      const observer = shadowRootObservers.get(shadowRoot);
      if (observer) observer.disconnect();
      shadowRootObservers.delete(shadowRoot);
      shadowStyleCache.delete(shadowRoot);
      trackedShadowRoots.delete(shadowRoot);
    }
  }

  function scheduleShadowRootCleanup() {
    if (shadowCleanupTimer !== null) return;
    shadowCleanupTimer = setTimeout(cleanupDisconnectedShadowRoots, SHADOW_ROOT_CLEANUP_DELAY_MS);
  }

  function handleShadowRootMutations(shadowRoot, mutations) {
    if (!shadowState.active || !trackedShadowRoots.has(shadowRoot)) return;

    let removedNodes = false;
    let addedStylesheet = false;
    let addedManagedStyle = false;
    for (const mutation of mutations) {
      if (mutation.type !== 'childList') continue;

      if (mutation.addedNodes.length > SHADOW_DISCOVERY_COALESCE_THRESHOLD) {
        for (const addedNode of mutation.addedNodes) {
          if (!isElementNode(addedNode)) continue;
          queueShadowDiscovery(addedNode);
          if (managedStyleMode === 'adopted' && nodeContainsManagedStyle(addedNode)) {
            addedManagedStyle = true;
          }
        }
        if (managedStyleMode === 'node') addedStylesheet = true;
      } else {
        for (const addedNode of mutation.addedNodes) {
          if (!isElementNode(addedNode)) continue;
          queueShadowDiscovery(addedNode);
          if (managedStyleMode === 'node' && nodeContainsStylesheet(addedNode)) {
            addedStylesheet = true;
          }
          if (managedStyleMode === 'adopted' && nodeContainsManagedStyle(addedNode)) {
            addedManagedStyle = true;
          }
        }
      }
      if (mutation.removedNodes.length > 0) removedNodes = true;
    }

    if (removedNodes) scheduleShadowRootCleanup();
    if (managedStyleMode === 'adopted') {
      if (addedManagedStyle) {
        const cached = shadowStyleCache.get(shadowRoot);
        getShadowStylesForHost(shadowRoot, shadowState.host).forEach((styleNode) => {
          if (!cached || styleNode !== cached.node) styleNode.remove();
        });
      }
      ensureShadowManagedStyle(shadowRoot, shadowState.host, shadowState.css);
      return;
    }

    const cached = shadowStyleCache.get(shadowRoot);
    if (!cached ||
        cached.host !== shadowState.host ||
        !cached.node ||
        cached.node.parentNode !== shadowRoot ||
        cached.node.getAttribute(STYLE_DATA_ATTRIBUTE) !== shadowState.host ||
        cached.node.getAttribute(STYLE_OWNER_ATTRIBUTE) !== STYLE_OWNER_VALUE ||
        cached.node.hasAttribute('media') ||
        cached.node.hasAttribute('type') ||
        cached.node.textContent !== shadowState.css ||
        (addedStylesheet && shadowRoot.lastElementChild !== cached.node)) {
      queueShadowRootRecovery(shadowRoot);
    }
  }

  function handleShadowStyleMutations(shadowRoot) {
    const maintainsNode = managedStyleMode === 'node' ||
      (managedStyleMode === 'adopted' && managedCssNeedsImportFallback);
    if (!maintainsNode || !shadowState.active || !trackedShadowRoots.has(shadowRoot)) return;

    const cached = shadowStyleCache.get(shadowRoot);
    if (!cached ||
        cached.host !== shadowState.host ||
        !cached.node ||
        cached.node.parentNode !== shadowRoot ||
        cached.node.getAttribute(STYLE_DATA_ATTRIBUTE) !== shadowState.host ||
        cached.node.getAttribute(STYLE_OWNER_ATTRIBUTE) !== STYLE_OWNER_VALUE ||
        cached.node.hasAttribute('media') ||
        cached.node.hasAttribute('type') ||
        cached.node.textContent !== shadowState.css ||
        cached.baseUrl !== getDocumentCssBaseUrl()) {
      queueShadowRootRecovery(shadowRoot);
    }
  }

  function syncShadowStyleObserver(shadowRoot, style) {
    if (typeof MutationObserver === 'undefined') return;

    const existing = shadowStyleObservers.get(shadowRoot);
    if (existing && existing.node === style) return;
    if (existing) existing.observer.disconnect();

    const observer = new MutationObserver(() => handleShadowStyleMutations(shadowRoot));
    observer.observe(style, {
      attributes: true,
      attributeFilter: [STYLE_DATA_ATTRIBUTE, STYLE_OWNER_ATTRIBUTE, 'media', 'type'],
      childList: true,
      characterData: true,
      subtree: true
    });
    shadowStyleObservers.set(shadowRoot, { node: style, observer });
  }

  function ensureShadowRootObserver(shadowRoot) {
    if (!isShadowRoot(shadowRoot) ||
        shadowRootObservers.has(shadowRoot) ||
        typeof MutationObserver === 'undefined') {
      return;
    }

    const observer = new MutationObserver((mutations) => {
      handleShadowRootMutations(shadowRoot, mutations);
    });
    observer.observe(shadowRoot, {
      childList: true,
      subtree: true
    });
    shadowRootObservers.set(shadowRoot, observer);
  }

  function applyShadowCSS(hostname, cssContent, forceRescan = false) {
    if (!hostname || typeof cssContent !== 'string' || !cssContent) return;

    const wasActive = shadowState.active;
    const hostChanged = wasActive && shadowState.host !== hostname;
    if (hostChanged) {
      clearShadowCSS(shadowState.host);
    }

    shadowState = { active: true, host: hostname, css: cssContent };

    for (const shadowRoot of Array.from(trackedShadowRoots)) {
      ensureShadowManagedStyle(shadowRoot, hostname, cssContent);
    }

    const currentDocumentElement = document.documentElement;
    if (!wasActive ||
        hostChanged ||
        forceRescan ||
        shadowScannedDocumentElement !== currentDocumentElement) {
      discoverShadowRootsFromNode(document);
      shadowScannedDocumentElement = currentDocumentElement;
    }
  }

  function clearShadowCSS(hostname) {
    if (!hostname) return;

    for (const shadowRoot of Array.from(trackedShadowRoots)) {
      removeShadowManagedStyles(shadowRoot, hostname);
    }

    if (!shadowState.active || shadowState.host !== hostname) return;

    if (shadowCleanupTimer !== null) {
      clearTimeout(shadowCleanupTimer);
      shadowCleanupTimer = null;
    }
    pendingShadowDiscoveryTargets.clear();
    pendingShadowRootRecoveries.clear();
    shadowDiscoveryScheduled = false;
    shadowRecoveryScheduled = false;
    if (shadowRecoveryTimer !== null) {
      clearTimeout(shadowRecoveryTimer);
      shadowRecoveryTimer = null;
    }

    for (const shadowRoot of Array.from(trackedShadowRoots)) {
      const observer = shadowRootObservers.get(shadowRoot);
      if (observer) observer.disconnect();
      shadowRootObservers.delete(shadowRoot);
      shadowStyleCache.delete(shadowRoot);
    }
    trackedShadowRoots.clear();
    shadowState = { active: false, host: '', css: '' };
    shadowScannedDocumentElement = null;
  }

  const storageConfig = typeof CSSInjectorConstants !== 'undefined' ? (CSSInjectorConstants.STORAGE || {}) : {};
  const storageCacheExpiryMs = typeof storageConfig.CACHE_EXPIRY_MS === 'number' ? storageConfig.CACHE_EXPIRY_MS : 120000;
  const storageTimeoutMs = typeof storageConfig.TIMEOUT_MS === 'number' ? storageConfig.TIMEOUT_MS : 5000;
  const debounceConfig = typeof CSSInjectorConstants !== 'undefined' ? (CSSInjectorConstants.DEBOUNCE || {}) : {};
  const debounceDelay = typeof debounceConfig.NAVIGATION_DELAY === 'number' ? debounceConfig.NAVIGATION_DELAY : 100;

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
  let pendingScheduleTimer = null;
  let pendingForcedLoad = false;
  let pendingForcedStorageRead = false;
  let pendingForcedDomReassert = false;
  let latestLoadRequestId = 0;
  let topHostRetryTimer = null;
  let topHostRetryIndex = 0;
  let styleGuardScheduled = false;
  let styleGuardRecoveryTimer = null;
  let styleGuardObserver = null;
  let managedStyleNodeObserver = null;
  let legacyStyleSuppressionObserver = null;
  const suppressedLegacyHosts = new Set();
  let documentManagedNodesSwept = false;
  let boundDocumentElement = null;
  let styleGuardRecoveryWindowStart = 0;
  let styleGuardRecoveryCount = 0;
  const trackedShadowRoots = new Set();
  const sweptConstructedSheetScopes = new WeakSet();
  const shadowStyleCache = new WeakMap();
  const shadowRootObservers = new WeakMap();
  const shadowStyleObservers = new WeakMap();
  const pendingShadowDiscoveryTargets = new Set();
  const pendingShadowRootRecoveries = new Set();
  let shadowDiscoveryScheduled = false;
  let shadowCleanupTimer = null;
  let shadowRecoveryScheduled = false;
  let shadowRecoveryTimer = null;
  let shadowRecoveryWindowStart = 0;
  let shadowRecoveryCount = 0;
  let shadowScannedDocumentElement = null;
  let shadowState = { active: false, host: '', css: '' };
  let managedStyleMode = 'none';
  let managedConstructedSheet = null;
  let managedConstructedCss = '';
  let managedConstructedBaseUrl = '';
  let managedConstructedFingerprint = null;
  let managedConstructedLastFullCheck = 0;
  let managedCssNeedsImportFallback = false;
  let adoptedSheetGuardTimer = null;
  let nodeFallbackGuardTimer = null;
  const STYLE_GUARD_RECOVERY_WINDOW_MS = 1000;
  const STYLE_GUARD_MAX_RECOVERIES_PER_WINDOW = 5;
  const SHADOW_ROOT_CLEANUP_DELAY_MS = 1000;
  const ADOPTED_SHEET_GUARD_DELAY_MS = 2000;
  const CONSTRUCTED_SHEET_SMALL_CSS_BYTES = 64 * 1024;
  const CONSTRUCTED_SHEET_FULL_CHECK_DELAY_MS = 15000;
  const NODE_FALLBACK_GUARD_DELAY_MS = 2000;
  const SHADOW_DISCOVERY_COALESCE_THRESHOLD = 64;

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

  function shouldMaintainManagedStyleNode(hostname) {
    return shouldMaintainManagedStyle(hostname) &&
      (managedStyleMode === 'node' || managedCssNeedsImportFallback);
  }

  function queueManagedStyleRecovery() {
    if (disposed || styleGuardScheduled) {
      return;
    }

    styleGuardScheduled = true;
    const now = Date.now();
    if (now - styleGuardRecoveryWindowStart > STYLE_GUARD_RECOVERY_WINDOW_MS) {
      styleGuardRecoveryWindowStart = now;
      styleGuardRecoveryCount = 0;
    }
    styleGuardRecoveryCount += 1;

    const runRecovery = () => {
      styleGuardRecoveryTimer = null;
      styleGuardScheduled = false;

      if (disposed) return;

      const hostname = lastApplied.host;
      if (!shouldMaintainManagedStyle(hostname)) {
        return;
      }

      if (lastApplied.css) {
        applyDocumentCSS(lastApplied.css, hostname);
        const managedStyle = managedStyleCache.host === hostname ? managedStyleCache.node : null;
        getInjectedStylesForHostname(hostname).forEach((styleNode) => {
          if (styleNode !== managedStyle) styleNode.remove();
        });
        return;
      }

      scheduleInjection(true, true);
    };

    if (styleGuardRecoveryCount > STYLE_GUARD_MAX_RECOVERIES_PER_WINDOW) {
      styleGuardRecoveryTimer = setTimeout(runRecovery, STYLE_GUARD_RECOVERY_WINDOW_MS);
    } else {
      queueMicrotask(runRecovery);
    }
  }

  function nodeContainsStylesheet(node) {
    if (!isElementNode(node)) return false;
    if (typeof node.matches === 'function' && node.matches('style, link[rel="stylesheet"]')) {
      return true;
    }
    return typeof node.querySelector === 'function' &&
      !!node.querySelector('style, link[rel="stylesheet"]');
  }

  function nodeContainsManagedStyle(node) {
    if (!isElementNode(node)) return false;
    return typeof node.matches === 'function' &&
      node.matches(STYLE_SELECTOR) &&
      isOwnedManagedStyleNode(node);
  }

  function handleManagedStyleMutations(mutations) {
    ensureDomEventListeners();

    let documentAddedManagedStyle = false;
    if (shadowState.active) {
      if (shadowScannedDocumentElement !== document.documentElement) {
        shadowScannedDocumentElement = document.documentElement;
        queueShadowDiscovery(document);
        scheduleShadowRootCleanup();
      }
      let removedNodes = false;
      for (const mutation of mutations) {
        if (mutation.type !== 'childList') continue;
        if (mutation.addedNodes.length > SHADOW_DISCOVERY_COALESCE_THRESHOLD) {
          for (const addedNode of mutation.addedNodes) {
            if (!isElementNode(addedNode)) continue;
            queueShadowDiscovery(addedNode);
            if (nodeContainsManagedStyle(addedNode)) documentAddedManagedStyle = true;
          }
        } else {
          for (const addedNode of mutation.addedNodes) {
            if (!isElementNode(addedNode)) continue;
            queueShadowDiscovery(addedNode);
            if (nodeContainsManagedStyle(addedNode)) documentAddedManagedStyle = true;
          }
        }
        if (mutation.removedNodes.length > 0) removedNodes = true;
      }
      if (documentAddedManagedStyle) documentManagedNodesSwept = false;
      if (removedNodes) scheduleShadowRootCleanup();
    }

    if (managedStyleMode === 'adopted') {
      refreshConstructedSheetBaseIfNeeded();
      ensureConstructedSheetInScope(document);
      if (managedCssNeedsImportFallback) {
        applyDocumentCSS(lastApplied.css, lastApplied.host);
      } else if (documentAddedManagedStyle) {
        applyDocumentCSS(lastApplied.css, lastApplied.host);
      }
      if (!managedCssNeedsImportFallback) return;
    }

    const hostname = lastApplied.host;
    if (!shouldMaintainManagedStyle(hostname)) {
      return;
    }

    const cachedStyle = managedStyleCache.host === hostname ? managedStyleCache.node : null;

    for (const mutation of mutations) {
      if (mutation.type !== 'childList') {
        continue;
      }

      if (!cachedStyle || !cachedStyle.isConnected) {
        queueManagedStyleRecovery();
        return;
      }

      const desiredParent = getDocumentStyleParent();
      if (desiredParent && cachedStyle.parentNode !== desiredParent) {
        queueManagedStyleRecovery();
        return;
      }
      if (desiredParent &&
          desiredParent.lastElementChild !== cachedStyle &&
          Array.from(mutation.addedNodes).some(nodeContainsStylesheet)) {
        queueManagedStyleRecovery();
        return;
      }
    }
  }

  function handleManagedStyleNodeMutations() {
    const hostname = lastApplied.host;
    const style = managedStyleCache.host === hostname ? managedStyleCache.node : null;
    if (!shouldMaintainManagedStyleNode(hostname) || !style) return;

    if (!style.isConnected ||
        style.getAttribute(STYLE_DATA_ATTRIBUTE) !== hostname ||
        style.getAttribute(STYLE_OWNER_ATTRIBUTE) !== STYLE_OWNER_VALUE ||
        style.hasAttribute('media') ||
        style.hasAttribute('type') ||
        style.textContent !== lastApplied.css) {
      queueManagedStyleRecovery();
    }
  }

  function ensureManagedStyleObserver() {
    if (styleGuardObserver || typeof MutationObserver === 'undefined') {
      return;
    }

    styleGuardObserver = new MutationObserver(handleManagedStyleMutations);
    styleGuardObserver.observe(document, {
      childList: true,
      subtree: true
    });
  }

  function syncManagedStyleNodeObserver() {
    if (managedStyleNodeObserver) {
      managedStyleNodeObserver.disconnect();
      managedStyleNodeObserver = null;
    }

    const hostname = lastApplied.host;
    const style = managedStyleCache.host === hostname ? managedStyleCache.node : null;
    if (!shouldMaintainManagedStyleNode(hostname) || !style || !style.isConnected ||
        typeof MutationObserver === 'undefined') {
      return;
    }

    managedStyleNodeObserver = new MutationObserver(handleManagedStyleNodeMutations);
    managedStyleNodeObserver.observe(style, {
      attributes: true,
      attributeFilter: [STYLE_DATA_ATTRIBUTE, STYLE_OWNER_ATTRIBUTE, 'media', 'type'],
      childList: true,
      characterData: true,
      subtree: true
    });
  }

  function disconnectManagedStyleObserver() {
    if (styleGuardObserver) {
      styleGuardObserver.disconnect();
      styleGuardObserver = null;
    }

    if (managedStyleNodeObserver) {
      managedStyleNodeObserver.disconnect();
      managedStyleNodeObserver = null;
    }
  }

  function syncManagedStyleObserver() {
    if (shouldMaintainManagedStyle(lastApplied.host)) {
      ensureManagedStyleObserver();
      if (shouldMaintainManagedStyleNode(lastApplied.host)) {
        syncManagedStyleNodeObserver();
      } else if (managedStyleNodeObserver) {
        managedStyleNodeObserver.disconnect();
        managedStyleNodeObserver = null;
      }
      return;
    }

    disconnectManagedStyleObserver();
  }

  function isExtensionContextValid() {
    try {
      return chrome.runtime && !!chrome.runtime.id;
    } catch {
      return false;
    }
  }

  function resetTopHostResolutionRetry() {
    topHostRetryIndex = 0;
    if (topHostRetryTimer !== null) {
      clearTimeout(topHostRetryTimer);
      topHostRetryTimer = null;
    }
  }

  function scheduleTopHostResolutionRetry() {
    if (disposed || isTopFrame() || !isExtensionContextValid() || topHostRetryTimer !== null) return;
    if (topHostRetryIndex >= TOP_HOST_RETRY_DELAYS_MS.length) return;

    const delayMs = TOP_HOST_RETRY_DELAYS_MS[topHostRetryIndex];
    topHostRetryIndex += 1;
    topHostRetryTimer = setTimeout(() => {
      topHostRetryTimer = null;
      if (disposed || !isExtensionContextValid()) return;
      scheduleInjection(true, true, false);
    }, delayMs);
  }

  async function loadAndApplyCSS(forceStorageRead = false, forceDomReassert = false) {
    if (disposed) return;
    const requestId = ++latestLoadRequestId;
    if (!isExtensionContextValid()) return;

    const hostname = await resolveManagedHostname(forceStorageRead);
    if (!hostname) {
      scheduleTopHostResolutionRetry();
      return;
    }

    try {
      let data;
      let shouldUpdateStorageCache = false;

      if (!forceStorageRead && storageCache.isValid(hostname)) {
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
        shouldUpdateStorageCache = true;
      }

      const effectiveState = extractHostStateFromStorage(hostname, data);
      const css = effectiveState.css;
      const isEnabled = effectiveState.enabled;

      const currentManagedHostname = await resolveManagedHostname(false);
      if (disposed || requestId !== latestLoadRequestId || currentManagedHostname !== hostname) {
        return;
      }
      if (shouldUpdateStorageCache) {
        storageCache.set(hostname, data);
      }

      const effectKey = buildEffectKey(hostname, css, isEnabled);
      if (effectKey === lastApplied.effectKey && hostname === lastApplied.host) {
        const documentElementChanged = shadowScannedDocumentElement !== document.documentElement;
        const managedBaseUrlChanged = managedStyleMode === 'adopted'
          ? managedConstructedBaseUrl !== getDocumentCssBaseUrl()
          : managedStyleMode === 'node' && managedStyleCache.baseUrl !== getDocumentCssBaseUrl();
        if (forceDomReassert || documentElementChanged || managedBaseUrlChanged) {
          if (css && isEnabled) {
            reassertInjectedCSS(css, hostname, forceDomReassert || documentElementChanged);
          } else {
            removeInjectedStyles(hostname);
          }
          syncManagedStyleObserver();
        }
        commitLastAppliedState(hostname, css, isEnabled);
        return;
      }

      const previousHost = lastApplied.host;
      if (previousHost && previousHost !== hostname) {
        removeInjectedStyles(previousHost);
      }

      if (css && isEnabled) {
        injectCSS(css, hostname);
      } else {
        removeInjectedStyles(hostname);
      }

      commitLastAppliedState(hostname, css, isEnabled);
      syncManagedStyleObserver();
    } catch (error) {
      if (error?.message?.includes('Extension context invalidated')) return;
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

  function scheduleInjection(force = false, forceStorageRead = false, forceDomReassert = false) {
    if (disposed) return;
    if (force) {
      pendingForcedLoad = true;
      pendingForcedStorageRead = pendingForcedStorageRead || forceStorageRead;
      pendingForcedDomReassert = pendingForcedDomReassert || forceDomReassert;
    }

    if (pendingScheduleTimer !== null) return;

    pendingScheduleTimer = setTimeout(() => {
      pendingScheduleTimer = null;

      const shouldForceLoad = pendingForcedLoad;
      const shouldForceStorageRead = pendingForcedStorageRead;
      const shouldForceDomReassert = pendingForcedDomReassert;
      pendingForcedLoad = false;
      pendingForcedStorageRead = false;
      pendingForcedDomReassert = false;
      const meaningfulUrlChange = hasMeaningfulUrlChange();

      if (shouldForceLoad) {
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          pendingTimer = null;
        }
        loadAndApplyCSS(shouldForceStorageRead, shouldForceDomReassert);
        return;
      }

      if (meaningfulUrlChange) {
        debouncedLoad();
      }
    }, 0);
  }

  contentScriptRuntime.requestRefresh = (force = false, forceStorageRead = false) => {
    ensureDomEventListeners(true);
    scheduleInjection(force, forceStorageRead, true);
  };

  function checkAndInject(force = false, forceDomReassert = false) {
    try {
      scheduleInjection(force, false, forceDomReassert);
    } catch (error) {
      console.error('[CSS Injector] Failed to check and inject CSS:', error);
    }
  }

  function handleHistoryNavigation() {
    checkAndInject();
  }

  function handlePageShow() {
    checkAndInject(true, true);
  }

  function handleDomContentLoaded() {
    checkAndInject(true, true);
  }

  function handleWindowLoad() {
    checkAndInject(true, true);
  }

  function handleVisibilityChange() {
    if (document.visibilityState !== 'visible') return;
    repairConstructedSheetContents(true);
    ensureConstructedSheetInScope(document);
    for (const shadowRoot of Array.from(trackedShadowRoots)) {
      ensureConstructedSheetInScope(shadowRoot);
    }
    checkAndInject(true);
  }

  function handleNavigationApiNavigate() {
    checkAndInject();
  }

  function handleShadowAttached(event) {
    if (disposed || !shadowState.active) return;
    if (!event || !isElementNode(event.target)) return;
    const target = event.target;
    if (!getOpenOrClosedShadowRoot(target)) return;
    queueShadowDiscovery(target);
  }

  function isSuppressibleLegacyDocumentStyle(styleNode) {
    if (!styleNode || typeof styleNode.getAttribute !== 'function' ||
        isOwnedManagedStyleNode(styleNode) ||
        styleNode.getAttribute(LEGACY_STYLE_PRIORITY_ATTRIBUTE) !== 'user' ||
        styleNode.getAttribute(LEGACY_SHADOW_STYLE_ATTRIBUTE) !== null) {
      return false;
    }
    const host = styleNode.getAttribute(STYLE_DATA_ATTRIBUTE);
    return !!host && suppressedLegacyHosts.has(host);
  }

  function suppressLegacyDocumentStyle(styleNode) {
    if (!isSuppressibleLegacyDocumentStyle(styleNode)) return false;
    if (styleNode.getAttribute('media') !== 'not all') {
      styleNode.setAttribute('media', 'not all');
    }
    if (styleNode.getAttribute('type') !== 'text/plain') {
      styleNode.setAttribute('type', 'text/plain');
    }
    if (styleNode.getAttribute(LEGACY_DISABLED_ATTRIBUTE) !== 'true') {
      styleNode.setAttribute(LEGACY_DISABLED_ATTRIBUTE, 'true');
    }
    dispatchLegacyShadowBridgeClear(styleNode.getAttribute(STYLE_DATA_ATTRIBUTE));
    return true;
  }

  function ensureLegacyStyleSuppressionObserver() {
    if (legacyStyleSuppressionObserver ||
        suppressedLegacyHosts.size === 0 ||
        typeof MutationObserver === 'undefined') {
      return;
    }

    legacyStyleSuppressionObserver = new MutationObserver((mutations) => {
      const candidates = new Set();
      for (const mutation of mutations) {
        if (isElementNode(mutation.target) && mutation.target.matches?.(STYLE_SELECTOR)) {
          candidates.add(mutation.target);
        }
        for (const addedNode of mutation.addedNodes || []) {
          if (!isElementNode(addedNode)) continue;
          if (addedNode.matches?.(STYLE_SELECTOR)) candidates.add(addedNode);
        }
      }
      for (const styleNode of candidates) {
        suppressLegacyDocumentStyle(styleNode);
      }
    });
    legacyStyleSuppressionObserver.observe(document, {
      attributes: true,
      attributeFilter: [
        STYLE_DATA_ATTRIBUTE,
        STYLE_OWNER_ATTRIBUTE,
        LEGACY_STYLE_PRIORITY_ATTRIBUTE,
        LEGACY_SHADOW_STYLE_ATTRIBUTE,
        LEGACY_DISABLED_ATTRIBUTE,
        'media',
        'type'
      ],
      childList: true,
      subtree: true
    });
  }

  function sweepLegacyAndOrphanManagedStyles() {
    const legacyHosts = new Set();
    const visitedScopes = new Set();
    const pendingScopes = [document];
    const shouldSweepLegacyDomNodes = contentScriptRuntime.legacyDomSweepCompleted !== true;
    const currentNodesToRemove = [];
    const legacyDocumentNodesToDisable = [];
    const legacyShadowNodesToRemove = [];

    const cleanScope = (scope) => {
      sweepManagedConstructedSheetsFromScope(scope);
      sweptConstructedSheetScopes.add(scope);
      if (typeof scope.querySelectorAll !== 'function') return;
      try {
        for (const styleNode of scope.querySelectorAll(STYLE_SELECTOR)) {
          const isCurrentNode = isOwnedManagedStyleNode(styleNode);
          const isLegacyNode = shouldSweepLegacyDomNodes &&
            (isLegacyManagedStyleNode(styleNode, scope !== document) ||
              (scope === document && isDisabledLegacyDocumentStyle(styleNode)));
          if (!isCurrentNode && !isLegacyNode) continue;
          const host = styleNode.getAttribute(STYLE_DATA_ATTRIBUTE);
          if (host) legacyHosts.add(host);
          if (isCurrentNode) {
            currentNodesToRemove.push(styleNode);
          } else if (scope === document) {
            legacyDocumentNodesToDisable.push(styleNode);
          } else {
            legacyShadowNodesToRemove.push(styleNode);
          }
        }
      } catch {
      }
    };

    while (pendingScopes.length > 0) {
      const scope = pendingScopes.pop();
      if (!scope || visitedScopes.has(scope)) continue;
      visitedScopes.add(scope);
      cleanScope(scope);

      if (typeof scope.querySelectorAll !== 'function') continue;
      try {
        for (const element of scope.querySelectorAll('*')) {
          const shadowRoot = getOpenOrClosedShadowRoot(element);
          if (shadowRoot && !visitedScopes.has(shadowRoot)) {
            pendingScopes.push(shadowRoot);
          }
        }
      } catch {
      }
    }

    for (const host of legacyHosts) {
      dispatchLegacyShadowBridgeClear(host);
    }
    for (const styleNode of currentNodesToRemove) {
      styleNode.remove();
    }
    for (const styleNode of legacyDocumentNodesToDisable) {
      const host = styleNode.getAttribute(STYLE_DATA_ATTRIBUTE);
      if (host) suppressedLegacyHosts.add(host);
    }
    for (const styleNode of legacyDocumentNodesToDisable) {
      suppressLegacyDocumentStyle(styleNode);
    }
    for (const styleNode of legacyShadowNodesToRemove) {
      styleNode.remove();
    }
    contentScriptRuntime.legacyDomSweepCompleted = true;
    ensureLegacyStyleSuppressionObserver();
    documentManagedNodesSwept = true;
  }

  function removeDomEventListeners() {
    window.removeEventListener('popstate', handleHistoryNavigation);
    window.removeEventListener('hashchange', handleHistoryNavigation);
    window.removeEventListener('pageshow', handlePageShow);
    window.removeEventListener('load', handleWindowLoad);
    window.removeEventListener(SHADOW_ATTACHED_EVENT_NAME, handleShadowAttached, true);
    document.removeEventListener('DOMContentLoaded', handleDomContentLoaded);
    document.removeEventListener('visibilitychange', handleVisibilityChange);

    if ('navigation' in window &&
        typeof window.navigation.removeEventListener === 'function') {
      window.navigation.removeEventListener('navigate', handleNavigationApiNavigate);
    }
    boundDocumentElement = null;
  }

  function ensureDomEventListeners(force = false) {
    if (disposed) return;
    const currentDocumentElement = document.documentElement;
    if (!force && boundDocumentElement === currentDocumentElement) return;

    removeDomEventListeners();

    window.addEventListener('popstate', handleHistoryNavigation);
    window.addEventListener('hashchange', handleHistoryNavigation);
    window.addEventListener('pageshow', handlePageShow);
    window.addEventListener('load', handleWindowLoad);
    window.addEventListener(SHADOW_ATTACHED_EVENT_NAME, handleShadowAttached, true);
    document.addEventListener('DOMContentLoaded', handleDomContentLoaded);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    if ('navigation' in window &&
        typeof window.navigation.addEventListener === 'function' &&
        typeof window.navigation.removeEventListener === 'function') {
      window.navigation.removeEventListener('navigate', handleNavigationApiNavigate);
      window.navigation.addEventListener('navigate', handleNavigationApiNavigate);
    }

    boundDocumentElement = currentDocumentElement;
  }

  sweepLegacyAndOrphanManagedStyles();
  ensureDomEventListeners(true);
  checkAndInject(true);

  function isStorageChangeRelevant(changes) {
    const candidateHosts = new Set();

    const frameHostname = getFrameHostname();
    if (frameHostname) candidateHosts.add(frameHostname);
    if (lastApplied.host) candidateHosts.add(lastApplied.host);
    if (topHostCache.host) candidateHosts.add(topHostCache.host);

    if (!isTopFrame()) {
      const fastTopHostname = getAccessibleTopHostname() || getTopHostnameFromAncestorOrigins();
      if (fastTopHostname) {
        candidateHosts.add(fastTopHostname);
      } else {
        // Cross-origin subframe whose top host is only resolvable asynchronously:
        // even a "fresh" topHostCache may be wrong (e.g. the parent navigated and
        // nothing invalidated the cache), so never filter here. The async
        // resolveManagedHostname(true) in handleStorageChanges is authoritative
        // and only re-applies CSS when the change matches the resolved host.
        return true;
      }
    }

    if (candidateHosts.size === 0) return true;

    for (const host of candidateHosts) {
      if (changes[host] || changes[`${host}_enabled`]) {
        return true;
      }
    }

    return false;
  }

  async function handleStorageChanges(changes, namespace) {
    if (disposed) return;
    if (namespace !== 'local') return;
    if (!isStorageChangeRelevant(changes)) return;

    ensureDomEventListeners();
    const hostname = await resolveManagedHostname(true);
    if (!hostname) {
      scheduleTopHostResolutionRetry();
      return;
    }

    if (changes[hostname] || changes[`${hostname}_enabled`]) {
      storageCache.invalidate();
      scheduleInjection(true, true, false);
    }
  }

  function handleStorageChangedEvent(changes, namespace) {
    if (disposed) return;
    handleStorageChanges(changes, namespace).catch((error) => {
      console.error('[CSS Injector] Failed to handle storage changes:', error);
    });
  }

  chrome.storage.onChanged.addListener(handleStorageChangedEvent);

  function isTrustedSender(sender) {
    try {
      return !!sender && sender.id === chrome.runtime.id;
    } catch {
      return false;
    }
  }

  const VALID_MESSAGE_TYPES = new Set(['css:apply', 'css:clear', 'context:getHost']);

  async function handleRuntimeMessage(msg, sender) {
    if (disposed) return { ok: false, error: 'Runtime disposed' };
    if (!msg || typeof msg.type !== 'string') {
      return { ok: false, error: 'Invalid message' };
    }
    if (!VALID_MESSAGE_TYPES.has(msg.type)) {
      return { ok: false, error: `Unsupported message type: ${msg.type}` };
    }
    if (!isTrustedSender(sender)) {
      return { ok: false, error: 'Untrusted sender' };
    }

    if (msg.type === 'context:getHost') {
      ensureDomEventListeners();
      const frameHostname = getFrameHostname();
      return frameHostname
        ? { ok: true, host: frameHostname }
        : { ok: false, error: 'Missing hostname' };
    }

    if (msg.delivery !== undefined && msg.delivery !== 'subframes') {
      return { ok: false, error: 'Invalid delivery' };
    }
    if (msg.delivery === 'subframes' && isTopFrame()) {
      return { ok: true, skipped: true };
    }

    if (msg.type === 'css:apply') {
      const isValidPayload =
        typeof msg.host === 'string' &&
        msg.host.length > 0 &&
        msg.host.trim() === msg.host &&
        typeof msg.css === 'string' &&
        (msg.enabled === undefined || typeof msg.enabled === 'boolean');

      if (!isValidPayload) {
        return { ok: false, error: 'Invalid payload' };
      }
    }

    if (msg.type === 'css:clear' && msg.host !== undefined) {
      const isValidClearHost = typeof msg.host === 'string' &&
        msg.host.length > 0 &&
        msg.host.trim() === msg.host;
      if (!isValidClearHost) {
        return { ok: false, error: 'Invalid payload' };
      }
    }

    ensureDomEventListeners();
    const messageRequestId = ++latestLoadRequestId;
    storageCache.invalidate();

    const hostname = await resolveManagedHostname(true);
    if (disposed || messageRequestId !== latestLoadRequestId) {
      return { ok: false, error: 'Superseded' };
    }
    if (!hostname) {
      scheduleTopHostResolutionRetry();
      return { ok: false, error: 'Missing hostname' };
    }

    if (msg.type === 'css:apply') {
      const targetHostname = msg.host || hostname;
      if (msg.host && msg.host !== hostname) {
        return { ok: false, error: 'Host mismatch' };
      }
      const previousHost = lastApplied.host;
      if (previousHost && previousHost !== targetHostname) {
        removeInjectedStyles(previousHost);
      }
      if (msg.css && msg.enabled !== false) {
        injectCSS(msg.css, targetHostname);
      } else {
        removeInjectedStyles(targetHostname);
      }
      commitLastAppliedState(targetHostname, msg.css, msg.enabled !== false);
      storageCache.set(targetHostname, {
        [targetHostname]: msg.css,
        [`${targetHostname}_enabled`]: msg.enabled !== false
      });
      syncManagedStyleObserver();
      return { ok: true };
    }

    if (msg.type === 'css:clear') {
      if (msg.host && msg.host !== hostname) {
        return { ok: false, error: 'Host mismatch' };
      }
      const targetHostname = msg.host || lastApplied.host || hostname;
      removeInjectedStyles(targetHostname);
      commitLastAppliedState(targetHostname, '', true);
      storageCache.set(targetHostname, {
        [targetHostname]: '',
        [`${targetHostname}_enabled`]: true
      });
      syncManagedStyleObserver();
      return { ok: true };
    }

    return { ok: false, error: `Unhandled message type: ${msg.type}` };
  }

  function handleRuntimeMessageEvent(msg, sender, sendResponse) {
    if (disposed) return false;
    Promise.resolve()
      .then(() => handleRuntimeMessage(msg, sender))
      .then((response) => {
        sendResponse(response);
      })
      .catch((error) => {
        sendResponse({ ok: false, error: getErrorMessage(error, 'Message handling failed') });
      });

    return true;
  }

  chrome.runtime.onMessage.addListener(handleRuntimeMessageEvent);

  function disposeRuntime() {
    if (disposed) return;
    disposed = true;
    latestLoadRequestId += 1;

    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (pendingScheduleTimer !== null) {
      clearTimeout(pendingScheduleTimer);
      pendingScheduleTimer = null;
    }
    if (topHostRetryTimer !== null) {
      clearTimeout(topHostRetryTimer);
      topHostRetryTimer = null;
    }
    if (styleGuardRecoveryTimer !== null) {
      clearTimeout(styleGuardRecoveryTimer);
      styleGuardRecoveryTimer = null;
    }
    if (shadowCleanupTimer !== null) {
      clearTimeout(shadowCleanupTimer);
      shadowCleanupTimer = null;
    }
    if (shadowRecoveryTimer !== null) {
      clearTimeout(shadowRecoveryTimer);
      shadowRecoveryTimer = null;
    }

    pendingForcedLoad = false;
    pendingForcedStorageRead = false;
    pendingForcedDomReassert = false;
    pendingShadowDiscoveryTargets.clear();
    pendingShadowRootRecoveries.clear();
    styleGuardScheduled = false;
    shadowDiscoveryScheduled = false;
    shadowRecoveryScheduled = false;

    if (lastApplied.host) {
      removeInjectedStyles(lastApplied.host);
    } else {
      removeConstructedSheetEverywhere();
      if (managedStyleCache.host) {
        removeDocumentManagedStyleNodes(managedStyleCache.host);
      }
      if (shadowState.active) {
        clearShadowCSS(shadowState.host);
      }
    }
    stopAdoptedSheetGuard();
    stopNodeFallbackGuard();
    disconnectManagedStyleObserver();
    if (legacyStyleSuppressionObserver) {
      legacyStyleSuppressionObserver.disconnect();
      legacyStyleSuppressionObserver = null;
    }
    if (suppressedLegacyHosts.size > 0) {
      contentScriptRuntime.legacyDomSweepCompleted = false;
    }
    suppressedLegacyHosts.clear();
    removeDomEventListeners();

    try {
      chrome.storage.onChanged.removeListener(handleStorageChangedEvent);
    } catch {
    }
    try {
      chrome.runtime.onMessage.removeListener(handleRuntimeMessageEvent);
    } catch {
    }

    contentScriptRuntime.initialized = false;
    contentScriptRuntime.bootstrapping = false;
  }

  contentScriptRuntime.dispose = disposeRuntime;

  bootstrapCompleted = true;
  } finally {
    contentScriptRuntime.bootstrapping = false;
    contentScriptRuntime.initialized = bootstrapCompleted;
  }
})();
