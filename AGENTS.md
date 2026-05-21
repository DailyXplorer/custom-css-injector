# AGENTS.md

Guidance for coding agents working in this repository.

## Project summary

Custom CSS Injector is a Manifest V3 Chrome extension that stores custom CSS per domain (hostname) and injects it on matching pages — including embedded frames and Shadow DOM where the platform allows.

## Runtime architecture

### `manifest.json`

- MV3 extension with permissions: `storage`, `tabs`, `scripting`, `activeTab`
- **Two** `content_scripts` entries on `http://*/*` and `https://*/*`, both at `document_start`, with `all_frames: true`, `match_about_blank: true`, `match_origin_as_fallback: true`:
  1. **MAIN world:** `shadow-dom-bridge.js` — closed Shadow DOM and dynamic `attachShadow`
  2. **ISOLATED world (default):** `utils.js` → `constants.js` → `content-script.js`
- Popup: `popup.html`
- Background service worker: `background.js`
- Strict CSP for extension pages (`script-src 'self'`, no remote/eval)

### `background.js`

- Logs installation.
- One-time migration: copies legacy `chrome.storage.sync` host entries into `chrome.storage.local` when local has no CSS for that host, removes migrated keys from sync, strips `draft:*` keys from local, sets `__cssInjectorMigratedSyncToLocal`. Serialized via `migrationChain`.
- Runtime messages (trusted sender only, `return true` + async `sendResponse`):
  - `{ type: 'ping' }` → `{ ok: true }`
  - `{ type: 'context:getTopHost' }` → `{ ok: true, host }` or `{ ok: false, error }` — resolves top-level tab hostname from `sender.tab` / `chrome.tabs.get` for iframe content scripts that cannot read `window.top.location`

### `utils.js`

- Exposes `window.CSSInjectorUtils` (also on `globalThis`):
  - `getCurrentHostname()`, `getHostname(url)`, `getProtocol(url)`, `isScriptableUrl(url)` (http/https only; excludes Chrome Web Store / Edge Add-ons gallery URLs)
  - `storageGet` / `storageSet` / `storageRemove` with optional timeout
  - `createHostState`, `extractHostStateFromStorage`, `getHostStateItems`, `isSameHostState`
  - `getUtf8Size`, `estimateStorageUsage`, `countLines`, `getErrorMessage`, `normalizeRuntimeError`, `isPlainObject`, `withTimeout`

### `constants.js`

- Exposes `window.CSSInjectorConstants`:
  - `DEBOUNCE.NAVIGATION_DELAY`
  - `STORAGE.CACHE_EXPIRY_MS`, `STORAGE.TIMEOUT_MS`
  - `SAVE.LIVE_APPLY_DELAY_MS`, `SAVE.PERSIST_DELAY_MS`, `SAVE.MAX_IMPORT_FILE_BYTES`
  - `UI.*`, `COLORS.*`
  - `SELECTORS.CSS_INJECTOR_STYLE` — template `style[data-css-injector="{hostname}"]` (attribute name parsed in content script; do not rely on interpolating hostname into selectors)

### `shadow-dom-bridge.js` (MAIN world)

- Singleton runtime `__CSSInjectorShadowBridgeRuntime`
- Patches `Element.prototype.attachShadow` to track new shadow roots
- Listens for `CustomEvent` `__CSS_INJECTOR_SHADOW_BRIDGE__` with `detail.source === 'css-injector'`, types `apply` / `clear`
- Injects `<style data-css-injector="{host}">` into tracked shadow roots (including closed shadows reachable only from MAIN world)
- Uses `MutationObserver` on document and shadow roots while CSS is active; deduplicates duplicate style nodes

### `content-script.js` (ISOLATED world)

- Singleton runtime `__CSSInjectorContentScriptRuntime` with `requestRefresh` — guards duplicate init when manifest + `scripting.executeScript` reinject
- Injects CSS into `<style data-css-injector="{hostname}">` on `document` (append to `head`, kept last among stylesheets when observed)
- Open shadow roots: direct injection + discovery via `querySelectorAll('*')` on first activation
- Closed / dynamic shadows: dispatches bridge event `__CSS_INJECTOR_SHADOW_BRIDGE__` after document injection
- **Hostname resolution:** top frame uses `location.hostname`; subframes use 3s cache, `ancestorOrigins`, `window.top` (if accessible), then `context:getTopHost` via background
- Storage: `chrome.storage.local` only; in-memory cache (TTL from constants) invalidated on `chrome.storage.onChanged` for active host keys
- SPA / navigation: wrapped `history.pushState` / `replaceState`, `popstate`, `hashchange`, `pageshow`, `visibilitychange`, Navigation API `navigate` when available
- `MutationObserver` on document (and per shadow root) only while `lastApplied.shouldHaveStyle` is true — recovers if site reorders stylesheets
- Runtime messages (trusted sender only):
  - `{ type: 'css:apply', host, css, enabled? }` — `host` must match resolved managed hostname or returns `{ ok: false, error: 'Host mismatch' }`
  - `{ type: 'css:clear' }` — removes styles for `lastApplied.host` or resolved hostname

### `popup.html`, `styles.css`, `popup-storage-helpers.js`, `popup-main.js`

- `popup-storage-helpers.js`: import/export (schema v1), host entry listing, chunked storage writes, quota checks
- Popup: editor with line numbers, enable toggle, copy, export/import JSON, reset, version badge, what's-new link
- Debounced `chrome.storage.local` persistence (`PERSIST_DELAY_MS`); live tab apply (`LIVE_APPLY_DELAY_MS`); flush on popup close (`visibilitychange`, `pagehide`, `beforeunload`)
- **Tab messaging:** `chrome.tabs.sendMessage` with `css:apply` / `css:clear`; handles `Host mismatch`, stale tab, reinjection on connection failure
- **Programmatic reinjection** (`chrome.scripting.executeScript`, `activeTab`):
  - Probes `__CSSInjectorContentScriptRuntime.initialized` in all frames
  - Injects `shadow-dom-bridge.js` (MAIN, `allFrames: true`, fallback top frame) then `utils.js`, `constants.js`, `content-script.js` (ISOLATED)
- Listens to `chrome.tabs.onActivated` / `onUpdated` and `chrome.storage.onChanged` to refresh editor context

### Performance notes

Baseline cost: dual content scripts × all frames on every http(s) page; heavier work only when CSS is active for the resolved host. Profile with Chrome Task Manager before changing `all_frames` or shadow coverage.

## Storage contract (do not break)

- `chrome.storage.local` only for site data:
  - `{hostname}` => CSS string
  - `{hostname}_enabled` => boolean (`false` disables; missing means enabled)
  - `__cssInjectorMigratedSyncToLocal` => boolean (internal migration marker; not site data)
- No ongoing `chrome.storage.sync` for CSS after migration (sync read/remove only in migration)

If you add new storage keys, document them here and update cache invalidation in `popup-main.js` and `content-script.js`.

## Message contract (do not break)

| Direction | Type | Payload / response |
|-----------|------|-------------------|
| Popup → content script (tab) | `css:apply` | `{ host, css, enabled? }` → `{ ok: true }` or `{ ok: false, error }` (`Host mismatch`, `Invalid payload`, …) |
| Popup → content script (tab) | `css:clear` | `{}` → `{ ok: true }` or error |
| Content script → background | `context:getTopHost` | `{}` → `{ ok: true, host }` |
| Any → background | `ping` | `{}` → `{ ok: true }` |

All handlers: validate `sender.id === chrome.runtime.id`, use `return true` with Promise + `sendResponse`.

Keep message types stable unless all senders/receivers are updated together.

## Editing guardrails

- Vanilla JS without bundler for extension runtime (no import/export in extension scripts). No npm build step in the shipped extension.
- Preserve global fallback behavior (`CSSInjectorUtils` / `CSSInjectorConstants` may be undefined in content script).
- Preserve defensive `chrome.runtime.lastError` handling around storage/tabs/messaging.
- Keep `data-css-injector` attribute contract aligned between `constants.js`, `content-script.js`, and `shadow-dom-bridge.js`.
- If changing UI constants in `constants.js`, verify matching CSS custom properties in `styles.css`.
- SVG icons use `currentColor` in several places unless intentionally redesigning.

## Release checklist

1. Bump `manifest.json` version for user-visible releases.
2. Confirm no unnecessary permission changes were introduced.

## Terminal usage (important)

Use RTK wrappers whenever possible to reduce command-output noise in context.

Preferred commands:

- File listing: `rtk ls .`
- File read: `rtk read <file>`
- Search text: `rtk grep "<pattern>" .`
- Git status/log/diff: `rtk git status`, `rtk git log -n 20`, `rtk git diff`

## Fallback rule

If RTK does not support a command or returns an error:

1. Run the native command.
2. Summarize key results only.
3. Continue with RTK for subsequent commands when possible.

## Change hygiene

- Prefer small diffs.
- Explain the plan before broad refactors.
