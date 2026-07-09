(function (root) {
  'use strict';

  function createPersistenceController(options = {}) {
    if (typeof options.write !== 'function') {
      throw new TypeError('Persistence controller requires a write function.');
    }

    const write = options.write;
    const onError = typeof options.onError === 'function' ? options.onError : null;
    const delayMs = Number.isFinite(options.delayMs) && options.delayMs >= 0
      ? options.delayMs
      : 0;
    const scheduleTimer = typeof options.setTimeout === 'function'
      ? options.setTimeout
      : root.setTimeout.bind(root);
    const cancelTimer = typeof options.clearTimeout === 'function'
      ? options.clearTimeout
      : root.clearTimeout.bind(root);

    const pendingByHost = new Map();
    const latestByHost = new Map();
    const persistedRevisionByHost = new Map();
    const invalidatedRevisionByHost = new Map();
    const immediateDispatchRevisionByHost = new Map();

    let nextRevision = 0;
    let timerId = null;
    let drainPromise = null;
    let inFlightPayload = null;
    let drainRequested = false;
    let lastError = null;

    function clonePayload(payload) {
      return payload ? {
        host: payload.host,
        css: payload.css,
        enabled: payload.enabled,
        revision: payload.revision
      } : null;
    }

    function normalizePayload(payload) {
      if (!payload || typeof payload.host !== 'string' || !payload.host) {
        throw new TypeError('Persistence payload requires a host.');
      }
      return {
        host: payload.host,
        css: typeof payload.css === 'string' ? payload.css : '',
        enabled: payload.enabled !== false,
        revision: ++nextRevision
      };
    }

    function getInvalidatedRevision(host) {
      return invalidatedRevisionByHost.get(host) || 0;
    }

    function getPersistedRevision(host) {
      return persistedRevisionByHost.get(host) || 0;
    }

    function isCurrentPayload(payload) {
      if (!payload || payload.revision <= getInvalidatedRevision(payload.host)) {
        return false;
      }
      const latest = latestByHost.get(payload.host);
      return !!latest && latest.revision === payload.revision;
    }

    function getUnpersistedLatest(host) {
      const latest = latestByHost.get(host);
      if (!latest || !isCurrentPayload(latest)) return null;
      if (latest.revision <= getPersistedRevision(host)) return null;
      return latest;
    }

    function clearTimer() {
      if (timerId === null) return;
      cancelTimer(timerId);
      timerId = null;
    }

    function armTimer() {
      if (timerId !== null || drainPromise || pendingByHost.size === 0) return;
      timerId = scheduleTimer(() => {
        timerId = null;
        startDrain();
      }, delayMs);
    }

    function takeNextCurrentPayload() {
      for (const [host, payload] of pendingByHost) {
        pendingByHost.delete(host);
        if (isCurrentPayload(payload)) return payload;
      }
      return null;
    }

    async function runDrain() {
      while (true) {
        const payload = takeNextCurrentPayload();
        if (!payload) {
          lastError = null;
          return true;
        }

        inFlightPayload = payload;
        try {
          await write(clonePayload(payload));
          persistedRevisionByHost.set(
            payload.host,
            Math.max(getPersistedRevision(payload.host), payload.revision)
          );
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          const latest = latestByHost.get(payload.host);
          const hasNewerPayload = !!latest && latest.revision > payload.revision;
          if (!hasNewerPayload && isCurrentPayload(payload)) {
            pendingByHost.set(payload.host, payload);
          }
          if (onError) {
            try {
              onError(lastError, clonePayload(payload));
            } catch {
            }
          }
          return false;
        } finally {
          inFlightPayload = null;
        }
      }
    }

    function startDrain() {
      clearTimer();
      if (drainPromise) return drainPromise;

      drainRequested = false;
      const currentDrain = runDrain();
      drainPromise = currentDrain;
      currentDrain.then((succeeded) => {
        if (drainPromise === currentDrain) {
          drainPromise = null;
        }
        if (pendingByHost.size > 0 && (succeeded || drainRequested)) {
          armTimer();
        }
      });
      return currentDrain;
    }

    function schedule(payload) {
      const nextPayload = normalizePayload(payload);
      latestByHost.set(nextPayload.host, nextPayload);
      pendingByHost.set(nextPayload.host, nextPayload);

      if (drainPromise) {
        drainRequested = true;
      } else {
        clearTimer();
        armTimer();
      }
      return nextPayload.revision;
    }

    async function flush() {
      clearTimer();
      if (drainPromise) return drainPromise;
      if (pendingByHost.size === 0) return true;
      return startDrain();
    }

    function hasPending(host = null) {
      if (typeof host === 'string' && host) {
        return !!getUnpersistedLatest(host);
      }
      for (const candidateHost of latestByHost.keys()) {
        if (getUnpersistedLatest(candidateHost)) return true;
      }
      return false;
    }

    function getPendingPayload(host) {
      if (typeof host !== 'string' || !host) return null;
      return clonePayload(getUnpersistedLatest(host));
    }

    function getRevision(host) {
      if (typeof host !== 'string' || !host) return 0;
      const latest = latestByHost.get(host);
      return Math.max(
        latest ? latest.revision : 0,
        getInvalidatedRevision(host)
      );
    }

    function invalidateHost(host) {
      if (typeof host !== 'string' || !host) return;

      const latest = latestByHost.get(host);
      const inFlightRevision = inFlightPayload && inFlightPayload.host === host
        ? inFlightPayload.revision
        : 0;
      const invalidatedRevision = Math.max(
        ++nextRevision,
        getInvalidatedRevision(host),
        latest ? latest.revision : 0,
        inFlightRevision
      );
      invalidatedRevisionByHost.set(host, invalidatedRevision);
      pendingByHost.delete(host);
      if (pendingByHost.size === 0) clearTimer();
    }

    function invalidateAll() {
      const hosts = new Set([
        ...latestByHost.keys(),
        ...pendingByHost.keys()
      ]);
      if (inFlightPayload) hosts.add(inFlightPayload.host);
      for (const host of hosts) invalidateHost(host);
    }

    async function waitForIdle() {
      while (drainPromise) {
        const currentDrain = drainPromise;
        await currentDrain;
        if (drainPromise === currentDrain) {
          await Promise.resolve();
        }
      }
    }

    function getPendingForImmediateDispatch(host = null) {
      const hosts = typeof host === 'string' && host
        ? [host]
        : Array.from(latestByHost.keys());
      const payloads = [];

      for (const candidateHost of hosts) {
        const payload = getUnpersistedLatest(candidateHost);
        if (!payload) continue;
        if ((immediateDispatchRevisionByHost.get(candidateHost) || 0) >= payload.revision) continue;
        payloads.push(clonePayload(payload));
        immediateDispatchRevisionByHost.set(candidateHost, payload.revision);
      }

      return payloads;
    }

    return Object.freeze({
      schedule,
      flush,
      hasPending,
      getPendingPayload,
      getRevision,
      getLastError: () => lastError,
      invalidateHost,
      invalidateAll,
      waitForIdle,
      getPendingForImmediateDispatch
    });
  }

  root.CSSInjectorPopupPersistence = Object.freeze({
    createPersistenceController
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
