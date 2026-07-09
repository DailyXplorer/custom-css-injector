(function () {
  'use strict';

  const root = typeof globalThis !== 'undefined'
    ? globalThis
    : (typeof window !== 'undefined' ? window : this);
  const runtimeKey = '__CSSInjectorShadowBridgeRuntime';
  const runtimeVersion = 2;
  const existingRuntime = root[runtimeKey];
  const installedAttachShadow = root.Element && root.Element.prototype
    ? root.Element.prototype.attachShadow
    : null;

  if (existingRuntime &&
      existingRuntime.initialized === true &&
      existingRuntime.version === runtimeVersion &&
      installedAttachShadow &&
      installedAttachShadow.__cssInjectorShadowBridgeWrapped === true &&
      installedAttachShadow.__cssInjectorShadowBridgeVersion === runtimeVersion) {
    return;
  }

  const runtime = existingRuntime && typeof existingRuntime === 'object'
    ? existingRuntime
    : {};
  runtime.initialized = false;
  runtime.version = runtimeVersion;
  root[runtimeKey] = runtime;

  const SHADOW_ATTACHED_EVENT_NAME = '__CSS_INJECTOR_SHADOW_ATTACHED__';

  function getOriginalAttachShadow(candidate) {
    let original = candidate;
    const seen = new Set();

    while (typeof original === 'function' &&
           original.__cssInjectorShadowBridgeWrapped === true &&
           typeof original.__cssInjectorOriginalAttachShadow === 'function' &&
           !seen.has(original)) {
      seen.add(original);
      original = original.__cssInjectorOriginalAttachShadow;
    }

    return original;
  }

  function patchAttachShadow() {
    const elementPrototype = root.Element && root.Element.prototype;
    if (!elementPrototype || typeof elementPrototype.attachShadow !== 'function') {
      return;
    }

    const installedAttachShadow = elementPrototype.attachShadow;
    if (installedAttachShadow.__cssInjectorShadowBridgeWrapped === true &&
        installedAttachShadow.__cssInjectorShadowBridgeVersion === runtimeVersion) {
      return;
    }

    const originalAttachShadow = getOriginalAttachShadow(installedAttachShadow);
    if (typeof originalAttachShadow !== 'function') {
      return;
    }

    const NativeEvent = root.Event;
    const dispatchEvent = root.EventTarget && root.EventTarget.prototype
      ? root.EventTarget.prototype.dispatchEvent
      : null;

    const wrappedAttachShadow = function (...args) {
      const shadowRoot = Reflect.apply(originalAttachShadow, this, args);

      try {
        if (typeof NativeEvent === 'function' && typeof dispatchEvent === 'function') {
          Reflect.apply(dispatchEvent, this, [new NativeEvent(SHADOW_ATTACHED_EVENT_NAME, {
            bubbles: true,
            composed: true
          })]);
        }
      } catch {
      }

      return shadowRoot;
    };

    try {
      Object.defineProperties(wrappedAttachShadow, {
        __cssInjectorShadowBridgeWrapped: {
          value: true,
          configurable: true
        },
        __cssInjectorShadowBridgeVersion: {
          value: runtimeVersion,
          configurable: true
        },
        __cssInjectorOriginalAttachShadow: {
          value: originalAttachShadow,
          configurable: true
        },
        length: {
          value: originalAttachShadow.length,
          configurable: true
        },
        name: {
          value: originalAttachShadow.name,
          configurable: true
        }
      });
    } catch {
    }

    try {
      elementPrototype.attachShadow = wrappedAttachShadow;
    } catch {
    }
  }

  patchAttachShadow();
  runtime.eventName = SHADOW_ATTACHED_EVENT_NAME;
  runtime.initialized = true;
})();
