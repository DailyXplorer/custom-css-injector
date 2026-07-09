'use strict';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const EXTENSION_PATH = path.resolve(__dirname, '..');
const MANAGED_HOST = '127.0.0.1';
const FRAME_HOST = 'localhost';
const fixturePort = 4173;
const MIGRATION_FLAG = '__cssInjectorMigratedSyncToLocal';

let browserContext;
let extensionWorker;
let profileDirectory;

function getFixtureHtml(requestUrl) {
  const pathname = new URL(requestUrl, `http://${MANAGED_HOST}`).pathname;

  if (pathname === '/light.html' || pathname === '/csp.html') {
    return '<!doctype html><html><head></head><body><div id="light-target">light</div></body></html>';
  }

  if (pathname === '/namespace.html') {
    return `<!doctype html><html><head></head><body>
      <svg id="namespace-target" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">
        <rect width="10" height="10"></rect>
      </svg>
    </body></html>`;
  }

  if (pathname === '/late-style.html') {
    return `<!doctype html>
      <html>
        <head></head>
        <body>
          <div id="late-target">late</div>
          <script>
            setTimeout(() => {
              const style = document.createElement('style');
              style.id = 'late-author-style';
              style.dataset.siteLateStyle = 'true';
              style.textContent = '#late-target { color: rgb(90, 80, 70); }';
              document.body.appendChild(style);
            }, 50);
          </script>
        </body>
      </html>`;
  }

  if (pathname === '/tamper.html') {
    return '<!doctype html><html><head></head><body><div id="tamper-target">tamper</div></body></html>';
  }

  if (pathname === '/structural.html') {
    return `<!doctype html>
      <html>
        <head></head>
        <body>
          <div id="structural-shadow-host"></div>
          <script>
            window.__structuralRoot = document
              .querySelector('#structural-shadow-host')
              .attachShadow({ mode: 'open' });
            window.__structuralRoot.innerHTML = '<span id="shadow-last">shadow last</span>';
          </script>
          <span id="document-last">document last</span>
        </body>
      </html>`;
  }

  if (pathname === '/ownership-collision.html') {
    return `<!doctype html>
      <html>
        <head>
          <style id="site-collision-style"
            data-css-injector="${MANAGED_HOST}"
            data-css-injector-priority="user">
            #collision-target { color: rgb(90, 80, 70) !important; }
          </style>
        </head>
        <body>
          <span id="collision-target">site-owned marker collision</span>
          <div id="collision-shadow-host"></div>
          <script>
            window.__collisionRoot = document.querySelector('#collision-shadow-host').attachShadow({ mode: 'open' });
            window.__collisionRoot.innerHTML =
              '<style id="site-shadow-collision-style" data-css-injector="${MANAGED_HOST}" ' +
              'data-css-injector-priority="user" data-css-injector-shadow-bridge="true">' +
              '#collision-shadow-target { color: rgb(90, 80, 70) !important; }</style>' +
              '<span id="collision-shadow-target">shadow collision</span>';
          </script>
        </body>
      </html>`;
  }

  if (pathname === '/site-adopted.html') {
    return `<!doctype html>
      <html>
        <head></head>
        <body>
          <div id="adopted-target">document adopted</div>
          <div id="adopted-shadow-host"></div>
          <script>
            window.__adoptedRoot = document.querySelector('#adopted-shadow-host').attachShadow({ mode: 'open' });
            window.__adoptedRoot.innerHTML = '<span id="adopted-shadow-target">shadow adopted</span>';
            window.addSiteAdoptedSheet = () => {
              const siteSheet = new CSSStyleSheet();
              siteSheet.replaceSync(
                '#adopted-target { color: rgb(90, 80, 70); }' +
                '#adopted-shadow-target { color: rgb(90, 80, 70); }'
              );
              window.__siteAdoptedSheet = siteSheet;
              document.adoptedStyleSheets = [...document.adoptedStyleSheets, siteSheet];
              window.__adoptedRoot.adoptedStyleSheets = [...window.__adoptedRoot.adoptedStyleSheets, siteSheet];
            };
          </script>
        </body>
      </html>`;
  }

  if (pathname === '/import.html') {
    return `<!doctype html>
      <html>
        <head></head>
        <body>
          <span id="import-light-target">import light</span>
          <div id="import-open-host"></div>
          <div id="import-closed-host"></div>
          <script>
            window.__importOpenRoot = document.querySelector('#import-open-host').attachShadow({ mode: 'open' });
            window.__importOpenRoot.innerHTML = '<span id="import-open-target">import open</span>';
            window.__importClosedRoot = document.querySelector('#import-closed-host').attachShadow({ mode: 'closed' });
            window.__importClosedRoot.innerHTML = '<span id="import-closed-target">import closed</span>';
          </script>
        </body>
      </html>`;
  }

  if (pathname === '/delayed-parser-shadow.html') {
    return `<!doctype html>
      <html>
        <head>
          <script>
            customElements.define('late-dsd-host', class extends HTMLElement {
              constructor() {
                super();
                this.__lateDsdInternals = this.attachInternals();
              }
            });
          </script>
        </head>
        <body>
          <script src="/delay.js"></script>
          <late-dsd-host id="late-open-dsd-host">
            <template shadowrootmode="open">
              <span id="late-open-dsd-target">late open declarative</span>
            </template>
          </late-dsd-host>
          <late-dsd-host id="late-closed-dsd-host">
            <template shadowrootmode="closed">
              <span id="late-closed-dsd-target">late closed declarative</span>
            </template>
          </late-dsd-host>
          <script>
            window.__lateOpenDsdRoot = document.querySelector('#late-open-dsd-host').__lateDsdInternals.shadowRoot;
            window.__lateClosedDsdRoot = document.querySelector('#late-closed-dsd-host').__lateDsdInternals.shadowRoot;
          </script>
        </body>
      </html>`;
  }

  if (pathname === '/base.html') {
    return `<!doctype html>
      <html>
        <head></head>
        <body>
          <div id="base-target">base document</div>
          <div id="base-shadow-host"></div>
          <script>
            window.__baseRoot = document.querySelector('#base-shadow-host').attachShadow({ mode: 'open' });
            window.__baseRoot.innerHTML = '<span id="base-shadow-target">base shadow</span>';
          </script>
        </body>
      </html>`;
  }

  if (pathname === '/document-open.html') {
    return '<!doctype html><html><head></head><body><div class="document-open-target">before</div></body></html>';
  }

  if (pathname === '/shadow.html') {
    return `<!doctype html>
      <html>
        <body>
          <div id="open-host"></div>
          <div id="closed-host"></div>
          <div id="outer-host"></div>
          <script>
            const openRoot = document.querySelector('#open-host').attachShadow({ mode: 'open' });
            openRoot.innerHTML = '<span id="open-target">open</span>';

            const closedRoot = document.querySelector('#closed-host').attachShadow({ mode: 'closed' });
            closedRoot.innerHTML = '<span id="closed-target">closed</span>';

            const outerRoot = document.querySelector('#outer-host').attachShadow({ mode: 'open' });
            outerRoot.innerHTML = '<section><div id="nested-host"></div></section>';
            const nestedHost = outerRoot.querySelector('#nested-host');
            const nestedRoot = nestedHost.attachShadow({ mode: 'closed' });
            nestedRoot.innerHTML = '<span id="nested-target">nested</span>';
          </script>
        </body>
      </html>`;
  }

  if (pathname === '/declarative-shadow.html') {
    return `<!doctype html>
      <html>
        <body>
          <dsd-test-host id="open-dsd-host">
            <template shadowrootmode="open">
              <span id="open-dsd-target">open declarative</span>
            </template>
          </dsd-test-host>
          <dsd-test-host id="closed-dsd-host">
            <template shadowrootmode="closed">
              <span id="closed-dsd-target">closed declarative</span>
            </template>
          </dsd-test-host>
          <dsd-test-host id="outer-closed-dsd-host">
            <template shadowrootmode="closed">
              <dsd-test-host id="nested-closed-dsd-host">
                <template shadowrootmode="closed">
                  <span id="nested-closed-dsd-target">nested declarative</span>
                </template>
              </dsd-test-host>
            </template>
          </dsd-test-host>
          <script>
            window.__dsdRoots = Object.create(null);
            customElements.define('dsd-test-host', class extends HTMLElement {
              constructor() {
                super();
                window.__dsdRoots[this.id] = this.attachInternals().shadowRoot;
              }
            });
            window.__closedDsdRoot = window.__dsdRoots['closed-dsd-host'];
            window.__outerClosedDsdRoot = window.__dsdRoots['outer-closed-dsd-host'];
            window.__nestedClosedDsdRoot = window.__dsdRoots['nested-closed-dsd-host'];
          </script>
        </body>
      </html>`;
  }

  if (pathname === '/dynamic-shadow.html') {
    return `<!doctype html>
      <html>
        <body>
          <div id="inactive-closed-host"></div>
          <div id="late-closed-host"></div>
          <script>
            const inactiveHost = document.querySelector('#inactive-closed-host');
            window.__inactiveClosedRoot = inactiveHost.attachShadow({ mode: 'closed' });
            window.__inactiveClosedRoot.innerHTML = '<span id="inactive-shadow-target">inactive</span>';

            window.createLateClosedRoot = () => {
              const lateHost = document.querySelector('#late-closed-host');
              window.__lateClosedRoot = lateHost.attachShadow({ mode: 'closed' });
              window.__lateClosedRoot.innerHTML = '<span id="late-shadow-target">late</span>';
            };
          </script>
        </body>
      </html>`;
  }

  if (pathname === '/frame-child.html') {
    return `<!doctype html><html><body>
      <div class="frame-target">frame</div>
      <div id="frame-shadow-host"></div>
      <script>
        window.__frameClosedRoot = document.querySelector('#frame-shadow-host').attachShadow({ mode: 'closed' });
        window.__frameClosedRoot.innerHTML = '<span class="frame-shadow-target">shadow frame</span>';
      </script>
    </body></html>`;
  }

  if (pathname === '/frames.html') {
    const crossOriginUrl = `http://${FRAME_HOST}:${fixturePort}/frame-child.html`;
    const srcdoc = `<!doctype html><html><body>
      <div class='frame-target'>srcdoc</div>
      <div id='frame-shadow-host'></div>
      <script>
        window.__frameClosedRoot = document.querySelector('#frame-shadow-host').attachShadow({ mode: 'closed' });
        window.__frameClosedRoot.innerHTML = '<span class=\"frame-shadow-target\">shadow srcdoc</span>';
      </script>
    </body></html>`;
    return `<!doctype html>
      <html>
        <body>
          <iframe name="same" src="/frame-child.html"></iframe>
          <iframe name="cross" src="${crossOriginUrl}"></iframe>
          <iframe name="srcdoc" srcdoc="${srcdoc.replace(/"/g, '&quot;')}"></iframe>
          <iframe name="hidden" hidden src="/frame-child.html?hidden=1"></iframe>
        </body>
      </html>`;
  }

  return '<!doctype html><html><body>not found</body></html>';
}

async function fulfillFixtureRoute(route) {
  const requestUrl = new URL(route.request().url());
  const pathname = requestUrl.pathname;

  if (pathname === '/delay.js') {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await route.fulfill({
      status: 200,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'text/javascript; charset=utf-8'
      },
      body: `
        window.__delayedParserScriptLoaded = true;
        window.__cssWasActiveBeforeParserResumed =
          getComputedStyle(document.documentElement)
            .getPropertyValue('--late-parser-active')
            .trim() === 'yes';
      `
    });
    return;
  }

  if (pathname === '/import.css' || pathname.endsWith('/relative-import.css')) {
    const importedColor = requestUrl.searchParams.get('variant') === 'escaped'
      ? 'rgb(23, 24, 25)'
      : pathname.startsWith('/other-assets/')
        ? 'rgb(40, 41, 42)'
        : pathname.startsWith('/base-assets/')
          ? 'rgb(30, 31, 32)'
          : 'rgb(20, 21, 22)';
    await route.fulfill({
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
        'content-type': 'text/css; charset=utf-8'
      },
      body: `
        #import-light-target, #import-open-target, #import-closed-target,
        #base-target, #base-shadow-target { color: ${importedColor} !important; }
      `
    });
    return;
  }

  const headers = {
    'cache-control': 'no-store',
    'content-type': 'text/html; charset=utf-8'
  };
  if (pathname === '/csp.html') {
    headers['content-security-policy'] = "default-src 'none'; style-src 'none'";
  }
  await route.fulfill({
    status: 200,
    headers,
    body: getFixtureHtml(requestUrl.href)
  });
}

async function setStoredCss(css, extraItems = {}) {
  await extensionWorker.evaluate(async ({ cssText, host, marker, items }) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set(Object.assign({
      [host]: cssText,
      [`${host}_enabled`]: true,
      [marker]: true
    }, items));
  }, {
    cssText: css,
    host: MANAGED_HOST,
    marker: MIGRATION_FLAG,
    items: extraItems
  });
}

async function updateStoredItems(items) {
  await extensionWorker.evaluate(async (storageItems) => {
    await chrome.storage.local.set(storageItems);
  }, items);
}

async function openFixture(pathname) {
  const page = await browserContext.newPage();
  await page.goto(`http://${MANAGED_HOST}:${fixturePort}${pathname}`, {
    waitUntil: 'domcontentloaded'
  });
  return page;
}

async function closePage(page) {
  if (page && !page.isClosed()) {
    await page.close();
  }
}

async function waitForNamedFrame(page, name, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page.frames().find((candidate) => candidate.name() === name);
    if (frame) return frame;
    await page.waitForTimeout(25);
  }
  return null;
}

async function reinjectTopFrameContentScript(page, options = {}) {
  const cdpSession = await browserContext.newCDPSession(page);
  const executionContexts = [];
  cdpSession.on('Runtime.executionContextCreated', ({ context }) => {
    executionContexts.push(context);
  });
  await cdpSession.send('Runtime.enable');

  try {
    let contentScriptContextId = null;
    const deadline = Date.now() + 2000;
    while (!contentScriptContextId && Date.now() < deadline) {
      for (const context of executionContexts) {
        if (context.auxData && context.auxData.isDefault === true) continue;
        try {
          const probe = await cdpSession.send('Runtime.evaluate', {
            contextId: context.id,
            expression: 'Boolean(globalThis.__CSSInjectorContentScriptRuntime?.initialized)',
            returnByValue: true
          });
          if (probe.result && probe.result.value === true) {
            contentScriptContextId = context.id;
            break;
          }
        } catch {
        }
      }
      if (!contentScriptContextId) await page.waitForTimeout(25);
    }
    assert.ok(contentScriptContextId, 'missing extension isolated-world execution context');

    if (options.resetLegacyDomSweep === true) {
      const resetSweepResult = await cdpSession.send('Runtime.evaluate', {
        contextId: contentScriptContextId,
        expression: 'globalThis.__CSSInjectorContentScriptRuntime.legacyDomSweepCompleted = false'
      });
      assert.equal(resetSweepResult.exceptionDetails, undefined);
    }

    const disposeResult = await cdpSession.send('Runtime.evaluate', {
      contextId: contentScriptContextId,
      expression: 'globalThis.__CSSInjectorContentScriptRuntime.dispose()',
      awaitPromise: true
    });
    assert.equal(disposeResult.exceptionDetails, undefined);
    const injectionResult = await cdpSession.send('Runtime.evaluate', {
      contextId: contentScriptContextId,
      expression: fs.readFileSync(path.join(EXTENSION_PATH, 'content-script.js'), 'utf8'),
      awaitPromise: true
    });
    assert.equal(injectionResult.exceptionDetails, undefined);
  } finally {
    await cdpSession.detach();
  }
}

before(async () => {
  profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'css-injector-e2e-'));
  browserContext = await chromium.launchPersistentContext(profileDirectory, {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`
    ]
  });
  await browserContext.route(
    /^http:\/\/(?:127\.0\.0\.1|localhost):4173\//,
    fulfillFixtureRoute
  );
  browserContext.setDefaultTimeout(5000);

  extensionWorker = browserContext.serviceWorkers()[0] || await browserContext.waitForEvent('serviceworker', {
    timeout: 10000
  });
  assert.match(extensionWorker.url(), /^chrome-extension:\/\/.+\/background\.js$/);
});

after(async () => {
  if (browserContext) {
    await browserContext.close();
  }
  if (profileDirectory) {
    fs.rmSync(profileDirectory, { recursive: true, force: true });
  }
});

test('injects into light DOM under a strict page CSP', async () => {
  await setStoredCss('#light-target { color: rgb(1, 2, 3) !important; }');
  const page = await openFixture('/csp.html');
  try {
    await page.waitForFunction(() => (
      getComputedStyle(document.querySelector('#light-target')).color === 'rgb(1, 2, 3)'
    ));
    const state = await page.evaluate(() => ({
      managedNodes: document.querySelectorAll('style[data-css-injector]').length,
      hasManagedAdoptedSheet: document.adoptedStyleSheets.some((sheet) => (
        Array.from(sheet.cssRules).some((rule) => rule.cssText.includes('#light-target'))
      ))
    }));
    assert.deepEqual(state, {
      managedNodes: 0,
      hasManagedAdoptedSheet: true
    });
  } finally {
    await closePage(page);
  }
});

test('preserves leading @namespace rules while appending the managed marker', async () => {
  await setStoredCss(`
    @namespace svg url(http://www.w3.org/2000/svg);
    svg|svg { fill: rgb(6, 7, 8); }
  `);
  const page = await openFixture('/namespace.html');
  try {
    await page.waitForFunction(() => (
      getComputedStyle(document.querySelector('#namespace-target')).fill === 'rgb(6, 7, 8)'
    ));
    const sheetState = await page.evaluate(() => {
      const sheet = document.adoptedStyleSheets.find((candidate) => (
        Array.from(candidate.cssRules).some((rule) => rule.cssText.includes('svg|svg'))
      ));
      return {
        hasSheet: !!sheet,
        firstRule: sheet ? sheet.cssRules[0].cssText : '',
        lastRule: sheet ? sheet.cssRules[sheet.cssRules.length - 1].cssText : ''
      };
    });
    assert.equal(sheetState.hasSheet, true);
    assert.match(sheetState.firstRule, /^@namespace svg/);
    assert.match(sheetState.lastRule, /managed-sheet-v2/);
  } finally {
    await closePage(page);
  }
});

test('keeps the managed adopted sheet after late author style nodes', async () => {
  await setStoredCss('#late-target { color: rgb(1, 2, 3); }');
  const page = await openFixture('/late-style.html');
  try {
    await page.waitForSelector('#late-author-style', { state: 'attached' });
    await page.waitForFunction(() => {
      const target = document.querySelector('#late-target');
      const lastSheet = document.adoptedStyleSheets.at(-1);
      return !!lastSheet &&
        Array.from(lastSheet.cssRules).some((rule) => rule.cssText.includes('#late-target')) &&
        getComputedStyle(target).color === 'rgb(1, 2, 3)' &&
        document.querySelectorAll('style[data-css-injector]').length === 0;
    });
  } finally {
    await closePage(page);
  }
});

test('adds no DOM children and preserves :last-child in document and shadow DOM', async () => {
  await setStoredCss(`
    #document-last:last-child, #shadow-last:last-child {
      color: rgb(2, 3, 4);
    }
  `);
  const page = await openFixture('/structural.html');
  try {
    await page.waitForFunction(() => (
      getComputedStyle(document.querySelector('#document-last')).color === 'rgb(2, 3, 4)' &&
      getComputedStyle(window.__structuralRoot.querySelector('#shadow-last')).color === 'rgb(2, 3, 4)'
    ));

    const state = await page.evaluate(() => ({
      bodyChildIds: Array.from(document.body.children, (element) => element.id || element.localName),
      shadowChildIds: Array.from(window.__structuralRoot.children, (element) => element.id || element.localName),
      documentLastMatches: document.querySelector('#document-last').matches(':last-child'),
      shadowLastMatches: window.__structuralRoot.querySelector('#shadow-last').matches(':last-child'),
      managedNodes: document.querySelectorAll('style[data-css-injector]').length +
        window.__structuralRoot.querySelectorAll('style[data-css-injector]').length
    }));
    assert.deepEqual(state, {
      bodyChildIds: ['structural-shadow-host', 'script', 'document-last'],
      shadowChildIds: ['shadow-last'],
      documentLastMatches: true,
      shadowLastMatches: true,
      managedNodes: 0
    });
  } finally {
    await closePage(page);
  }
});

test('never commandeers site styles that only resemble legacy injector nodes', async () => {
  await setStoredCss(`
    #collision-target, #collision-shadow-target {
      color: rgb(37, 38, 39) !important;
    }
  `);
  const page = await openFixture('/ownership-collision.html');
  try {
    await page.waitForFunction(() => (
      getComputedStyle(document.querySelector('#collision-target')).color === 'rgb(37, 38, 39)' &&
      getComputedStyle(window.__collisionRoot.querySelector('#collision-shadow-target')).color === 'rgb(37, 38, 39)'
    ));
    await reinjectTopFrameContentScript(page);
    await page.waitForFunction(() => (
      getComputedStyle(document.querySelector('#collision-target')).color === 'rgb(37, 38, 39)' &&
      getComputedStyle(window.__collisionRoot.querySelector('#collision-shadow-target')).color === 'rgb(37, 38, 39)'
    ));
    assert.deepEqual(await page.evaluate(() => ({
      documentStyleStillPresent: !!document.querySelector('#site-collision-style'),
      shadowStyleStillPresent: !!window.__collisionRoot.querySelector('#site-shadow-collision-style'),
      documentStyleOwned: document.querySelector('#site-collision-style')
        .hasAttribute('data-css-injector-owner'),
      shadowStyleOwned: window.__collisionRoot.querySelector('#site-shadow-collision-style')
        .hasAttribute('data-css-injector-owner')
    })), {
      documentStyleStillPresent: true,
      shadowStyleStillPresent: true,
      documentStyleOwned: false,
      shadowStyleOwned: false
    });
  } finally {
    await closePage(page);
  }
});

test('coalesces a large sibling batch and discovers closed roots near its end', async () => {
  await setStoredCss('[id^="bulk-shadow-target-"] { color: rgb(31, 32, 33) !important; }');
  const page = await openFixture('/light.html');
  try {
    await page.evaluate(() => {
      const fragment = document.createDocumentFragment();
      window.__bulkClosedRoots = [];
      for (let index = 0; index < 3000; index += 1) {
        const element = document.createElement('div');
        if (index === 0 || index === 1499 || index === 2999) {
          const root = element.attachShadow({ mode: 'closed' });
          root.innerHTML = `<span id="bulk-shadow-target-${index}">bulk</span>`;
          window.__bulkClosedRoots.push(root);
        }
        fragment.appendChild(element);
      }
      document.body.appendChild(fragment);
    });
    await page.waitForFunction(() => (
      window.__bulkClosedRoots.length === 3 &&
      window.__bulkClosedRoots.every((root) => (
        getComputedStyle(root.firstElementChild).color === 'rgb(31, 32, 33)'
      ))
    ));
  } finally {
    await closePage(page);
  }
});

test('coalesces a deeply nested connected batch without rescanning every ancestor', async () => {
  await setStoredCss('[id^="nested-bulk-target-"] { color: rgb(34, 35, 36) !important; }');
  const page = await openFixture('/light.html');
  try {
    await page.evaluate(() => {
      window.__nestedBulkClosedRoots = [];
      let parent = document.body;
      // Alternating wrapper/spacer nodes exercise ancestor reduction while
      // staying below Chromium's renderer depth ceiling.
      for (let index = 0; index < 192; index += 1) {
        const element = document.createElement('div');
        const detachedSpacer = document.createElement('span');
        element.appendChild(detachedSpacer);
        if (index === 0 || index === 95 || index === 191) {
          const root = element.attachShadow({ mode: 'closed' });
          root.innerHTML = `<span id="nested-bulk-target-${index}">nested bulk</span>`;
          window.__nestedBulkClosedRoots.push(root);
        }
        parent.appendChild(element);
        parent = detachedSpacer;
      }
    });
    await page.waitForFunction(() => (
      window.__nestedBulkClosedRoots.length === 3 &&
      window.__nestedBulkClosedRoots.every((root) => (
        getComputedStyle(root.firstElementChild).color === 'rgb(34, 35, 36)'
      ))
    ));
  } finally {
    await closePage(page);
  }
});

test('reorders a later site-adopted sheet so extension CSS keeps equal-specificity priority', async () => {
  await setStoredCss(`
    #adopted-target { color: rgb(3, 4, 5); }
    #adopted-shadow-target { color: rgb(3, 4, 5); }
  `);
  const page = await openFixture('/site-adopted.html');
  try {
    await page.waitForFunction(() => (
      getComputedStyle(document.querySelector('#adopted-target')).color === 'rgb(3, 4, 5)' &&
      getComputedStyle(window.__adoptedRoot.querySelector('#adopted-shadow-target')).color === 'rgb(3, 4, 5)'
    ));
    await page.evaluate(() => window.addSiteAdoptedSheet());
    await page.waitForFunction(() => (
      document.adoptedStyleSheets.at(-1) === window.__siteAdoptedSheet &&
      window.__adoptedRoot.adoptedStyleSheets.at(-1) === window.__siteAdoptedSheet &&
      getComputedStyle(document.querySelector('#adopted-target')).color === 'rgb(90, 80, 70)' &&
      getComputedStyle(window.__adoptedRoot.querySelector('#adopted-shadow-target')).color === 'rgb(90, 80, 70)'
    ));
    await page.waitForFunction(() => {
      const extensionDocumentSheet = document.adoptedStyleSheets.at(-1);
      const extensionShadowSheet = window.__adoptedRoot.adoptedStyleSheets.at(-1);
      return extensionDocumentSheet !== window.__siteAdoptedSheet &&
        extensionDocumentSheet === extensionShadowSheet &&
        getComputedStyle(document.querySelector('#adopted-target')).color === 'rgb(3, 4, 5)' &&
        getComputedStyle(window.__adoptedRoot.querySelector('#adopted-shadow-target')).color === 'rgb(3, 4, 5)';
    }, undefined, { timeout: 5000 });

    const order = await page.evaluate(() => ({
      documentSiteIndex: document.adoptedStyleSheets.indexOf(window.__siteAdoptedSheet),
      documentExtensionIndex: document.adoptedStyleSheets.length - 1,
      documentSheetCount: document.adoptedStyleSheets.length,
      shadowSiteIndex: window.__adoptedRoot.adoptedStyleSheets.indexOf(window.__siteAdoptedSheet),
      shadowExtensionIndex: window.__adoptedRoot.adoptedStyleSheets.length - 1,
      shadowSheetCount: window.__adoptedRoot.adoptedStyleSheets.length
    }));
    assert.equal(order.documentSheetCount, 2);
    assert.equal(order.shadowSheetCount, 2);
    assert.ok(order.documentSiteIndex >= 0);
    assert.ok(order.shadowSiteIndex >= 0);
    assert.ok(order.documentSiteIndex < order.documentExtensionIndex);
    assert.ok(order.shadowSiteIndex < order.shadowExtensionIndex);
  } finally {
    await closePage(page);
  }
});

test('injects into imperative open, closed, and nested shadow roots', async () => {
  await setStoredCss(`
    :host { --css-injector-e2e: applied; }
    #open-target, #closed-target, #nested-target { color: rgb(4, 5, 6) !important; }
  `);
  const page = await openFixture('/shadow.html');
  try {
    await page.waitForFunction(() => {
      const value = (element) => getComputedStyle(element).getPropertyValue('--css-injector-e2e').trim();
      const outerRoot = document.querySelector('#outer-host').shadowRoot;
      return value(document.querySelector('#open-host')) === 'applied' &&
        value(document.querySelector('#closed-host')) === 'applied' &&
        value(document.querySelector('#outer-host')) === 'applied' &&
        value(outerRoot.querySelector('#nested-host')) === 'applied';
    });

    const state = await page.evaluate(() => {
      const openRoot = document.querySelector('#open-host').shadowRoot;
      const outerRoot = document.querySelector('#outer-host').shadowRoot;
      return {
        openColor: getComputedStyle(openRoot.querySelector('#open-target')).color,
        openStyles: openRoot.querySelectorAll('style[data-css-injector]').length,
        outerStyles: outerRoot.querySelectorAll('style[data-css-injector]').length,
        openHasAdoptedSheet: openRoot.adoptedStyleSheets.some((sheet) => (
          Array.from(sheet.cssRules).some((rule) => rule.cssText.includes('#open-target'))
        )),
        sharedWithDocument: openRoot.adoptedStyleSheets.at(-1) === document.adoptedStyleSheets.at(-1)
      };
    });
    assert.deepEqual(state, {
      openColor: 'rgb(4, 5, 6)',
      openStyles: 0,
      outerStyles: 0,
      openHasAdoptedSheet: true,
      sharedWithDocument: true
    });
  } finally {
    await closePage(page);
  }
});

test('injects into open, closed, and nested declarative shadow roots', async () => {
  await setStoredCss(`
    :host { --css-injector-dsd: applied; }
    #open-dsd-target, #closed-dsd-target, #nested-closed-dsd-target {
      color: rgb(10, 11, 12) !important;
    }
  `);
  const page = await openFixture('/declarative-shadow.html');
  try {
    await page.waitForFunction(() => (
      !!window.__closedDsdRoot &&
      !!window.__outerClosedDsdRoot &&
      !!window.__nestedClosedDsdRoot
    ));
    await page.waitForFunction(() => {
      const roots = [
        document.querySelector('#open-dsd-host').shadowRoot,
        window.__closedDsdRoot,
        window.__outerClosedDsdRoot,
        window.__nestedClosedDsdRoot
      ];
      return roots.every((root) => (
        root.querySelectorAll('style[data-css-injector]').length === 0 &&
        root.adoptedStyleSheets.some((sheet) => (
          Array.from(sheet.cssRules).some((rule) => rule.cssText.includes('#open-dsd-target'))
        ))
      ));
    });

    const state = await page.evaluate(() => {
      const openRoot = document.querySelector('#open-dsd-host').shadowRoot;
      const roots = [openRoot, window.__closedDsdRoot, window.__outerClosedDsdRoot, window.__nestedClosedDsdRoot];
      return {
        colors: [
          getComputedStyle(openRoot.querySelector('#open-dsd-target')).color,
          getComputedStyle(window.__closedDsdRoot.querySelector('#closed-dsd-target')).color,
          getComputedStyle(window.__nestedClosedDsdRoot.querySelector('#nested-closed-dsd-target')).color
        ],
        allShareDocumentSheet: roots.every((root) => (
          root.adoptedStyleSheets.at(-1) === document.adoptedStyleSheets.at(-1)
        ))
      };
    });
    assert.deepEqual(state, {
      colors: ['rgb(10, 11, 12)', 'rgb(10, 11, 12)', 'rgb(10, 11, 12)'],
      allShareDocumentSheet: true
    });
  } finally {
    await closePage(page);
  }
});

test('@import works through light/open/closed carriers and carriers disappear for plain CSS', async () => {
  const importUrl = `http://${MANAGED_HOST}:${fixturePort}/import.css`;
  await setStoredCss(`@import url("${importUrl}");`);
  const page = await openFixture('/import.html');
  try {
    await page.waitForFunction(() => (
      getComputedStyle(document.querySelector('#import-light-target')).color === 'rgb(20, 21, 22)' &&
      getComputedStyle(window.__importOpenRoot.querySelector('#import-open-target')).color === 'rgb(20, 21, 22)' &&
      getComputedStyle(window.__importClosedRoot.querySelector('#import-closed-target')).color === 'rgb(20, 21, 22)'
    ));
    assert.deepEqual(await page.evaluate(() => ({
      documentCarriers: document.querySelectorAll('style[data-css-injector]').length,
      openCarriers: window.__importOpenRoot.querySelectorAll('style[data-css-injector]').length,
      closedCarriers: window.__importClosedRoot.querySelectorAll('style[data-css-injector]').length
    })), {
      documentCarriers: 1,
      openCarriers: 1,
      closedCarriers: 1
    });

    const tamperedCarrierState = await page.evaluate(() => {
      const documentCarrier = document.querySelector('style[data-css-injector]');
      const openCarrier = window.__importOpenRoot.querySelector('style[data-css-injector]');
      const closedCarrier = window.__importClosedRoot.querySelector('style[data-css-injector]');
      documentCarrier.media = 'not all';
      openCarrier.type = 'text/plain';
      closedCarrier.media = 'not all';
      closedCarrier.type = 'text/plain';
      return {
        documentMedia: documentCarrier.getAttribute('media'),
        openType: openCarrier.getAttribute('type'),
        closedMedia: closedCarrier.getAttribute('media'),
        closedType: closedCarrier.getAttribute('type')
      };
    });
    assert.deepEqual(tamperedCarrierState, {
      documentMedia: 'not all',
      openType: 'text/plain',
      closedMedia: 'not all',
      closedType: 'text/plain'
    });
    await page.waitForFunction(() => {
      const carriers = [
        document.querySelector('style[data-css-injector]'),
        window.__importOpenRoot.querySelector('style[data-css-injector]'),
        window.__importClosedRoot.querySelector('style[data-css-injector]')
      ];
      return carriers.every((carrier) => (
        carrier && !carrier.hasAttribute('media') && !carrier.hasAttribute('type')
      )) &&
        getComputedStyle(document.querySelector('#import-light-target')).color === 'rgb(20, 21, 22)' &&
        getComputedStyle(window.__importOpenRoot.querySelector('#import-open-target')).color === 'rgb(20, 21, 22)' &&
        getComputedStyle(window.__importClosedRoot.querySelector('#import-closed-target')).color === 'rgb(20, 21, 22)';
    }, undefined, { timeout: 5000 });

    await page.evaluate(() => {
      document.querySelector('style[data-css-injector]').removeAttribute('data-css-injector-owner');
      window.__importOpenRoot
        .querySelector('style[data-css-injector]')
        .removeAttribute('data-css-injector-owner');
      window.__importClosedRoot
        .querySelector('style[data-css-injector]')
        .removeAttribute('data-css-injector-owner');
    });
    await page.waitForFunction(() => {
      const carriers = [
        ...document.querySelectorAll('style[data-css-injector]'),
        ...window.__importOpenRoot.querySelectorAll('style[data-css-injector]'),
        ...window.__importClosedRoot.querySelectorAll('style[data-css-injector]')
      ];
      return carriers.length === 3 && carriers.every((carrier) => (
        carrier.hasAttribute('data-css-injector-owner')
      ));
    });

    const escapedImportCss = '@' + '\\' + `69 mport url("${importUrl}?variant=escaped");`;
    await updateStoredItems({ [MANAGED_HOST]: escapedImportCss });
    await page.waitForFunction(() => (
      getComputedStyle(document.querySelector('#import-light-target')).color === 'rgb(23, 24, 25)' &&
      getComputedStyle(window.__importOpenRoot.querySelector('#import-open-target')).color === 'rgb(23, 24, 25)' &&
      getComputedStyle(window.__importClosedRoot.querySelector('#import-closed-target')).color === 'rgb(23, 24, 25)'
    ));

    await updateStoredItems({
      [MANAGED_HOST]: `
        #import-light-target, #import-open-target, #import-closed-target {
          color: rgb(26, 27, 28) !important;
        }
      `
    });
    await page.waitForFunction(() => (
      getComputedStyle(document.querySelector('#import-light-target')).color === 'rgb(26, 27, 28)' &&
      getComputedStyle(window.__importOpenRoot.querySelector('#import-open-target')).color === 'rgb(26, 27, 28)' &&
      getComputedStyle(window.__importClosedRoot.querySelector('#import-closed-target')).color === 'rgb(26, 27, 28)' &&
      document.querySelectorAll('style[data-css-injector]').length === 0 &&
      window.__importOpenRoot.querySelectorAll('style[data-css-injector]').length === 0 &&
      window.__importClosedRoot.querySelectorAll('style[data-css-injector]').length === 0
    ));

    await updateStoredItems({
      [MANAGED_HOST]: `
        /* @import url("old-theme.css"); */
        #import-light-target::before { content: "@import"; }
        #import-light-target, #import-open-target, #import-closed-target {
          color: rgb(29, 30, 31) !important;
        }
      `
    });
    await page.waitForFunction(() => (
      getComputedStyle(document.querySelector('#import-light-target')).color === 'rgb(29, 30, 31)' &&
      getComputedStyle(window.__importOpenRoot.querySelector('#import-open-target')).color === 'rgb(29, 30, 31)' &&
      getComputedStyle(window.__importClosedRoot.querySelector('#import-closed-target')).color === 'rgb(29, 30, 31)' &&
      document.querySelectorAll('style[data-css-injector]').length === 0 &&
      window.__importOpenRoot.querySelectorAll('style[data-css-injector]').length === 0 &&
      window.__importClosedRoot.querySelectorAll('style[data-css-injector]').length === 0
    ));
  } finally {
    await closePage(page);
  }
});

test('discovers declarative shadow roots parsed after a blocking delayed script', async () => {
  await setStoredCss(`
    :root { --late-parser-active: yes; }
    #late-open-dsd-target, #late-closed-dsd-target {
      color: rgb(27, 28, 29) !important;
    }
  `);
  const page = await openFixture('/delayed-parser-shadow.html');
  try {
    await page.waitForFunction(() => (
      window.__delayedParserScriptLoaded === true &&
      window.__cssWasActiveBeforeParserResumed === true &&
      !!window.__lateOpenDsdRoot &&
      !!window.__lateClosedDsdRoot &&
      getComputedStyle(window.__lateOpenDsdRoot.querySelector('#late-open-dsd-target')).color === 'rgb(27, 28, 29)' &&
      getComputedStyle(window.__lateClosedDsdRoot.querySelector('#late-closed-dsd-target')).color === 'rgb(27, 28, 29)'
    ));
    assert.equal(await page.evaluate(() => (
      window.__lateOpenDsdRoot.adoptedStyleSheets.at(-1) ===
        window.__lateClosedDsdRoot.adoptedStyleSheets.at(-1)
    )), true);
  } finally {
    await closePage(page);
  }
});

test('activates, repairs, clears, and rediscovers closed shadow roots', async () => {
  const css = '#inactive-shadow-target, #late-shadow-target { color: rgb(13, 14, 15) !important; }';
  await setStoredCss(css, { [`${MANAGED_HOST}_enabled`]: false });
  const page = await openFixture('/dynamic-shadow.html');
  try {
    await page.waitForFunction(() => !!window.__inactiveClosedRoot);
    assert.equal(await page.evaluate(() => (
      window.__inactiveClosedRoot.adoptedStyleSheets.length
    )), 0);

    await updateStoredItems({ [`${MANAGED_HOST}_enabled`]: true });
    await page.waitForFunction(() => (
      window.__inactiveClosedRoot.adoptedStyleSheets.some((sheet) => (
        Array.from(sheet.cssRules).some((rule) => rule.cssText.includes('#inactive-shadow-target'))
      )) &&
      getComputedStyle(window.__inactiveClosedRoot.querySelector('#inactive-shadow-target')).color === 'rgb(13, 14, 15)'
    ));

    await page.evaluate(() => window.createLateClosedRoot());
    await page.waitForFunction(() => (
      !!window.__lateClosedRoot &&
      getComputedStyle(window.__lateClosedRoot.querySelector('#late-shadow-target')).color === 'rgb(13, 14, 15)'
    ));

    await page.evaluate(() => {
      const root = window.__lateClosedRoot;
      const managedSheet = root.adoptedStyleSheets.find((sheet) => (
        Array.from(sheet.cssRules).some((rule) => rule.cssText.includes('#late-shadow-target'))
      ));
      managedSheet.replaceSync('#late-shadow-target { color: rgb(90, 80, 70) !important; }');
      const authorStyle = document.createElement('style');
      authorStyle.textContent = '#late-shadow-target { color: rgb(90, 80, 70); }';
      root.appendChild(authorStyle);
    });
    await page.waitForFunction(() => {
      const root = window.__lateClosedRoot;
      const repairedSheet = root.adoptedStyleSheets.find((sheet) => (
        Array.from(sheet.cssRules).some((rule) => rule.cssText.includes('rgb(13, 14, 15)'))
      ));
      return !!repairedSheet &&
        root.adoptedStyleSheets.at(-1) === repairedSheet &&
        getComputedStyle(root.querySelector('#late-shadow-target')).color === 'rgb(13, 14, 15)';
    }, undefined, { timeout: 5000 });

    await updateStoredItems({ [`${MANAGED_HOST}_enabled`]: false });
    await page.waitForFunction(() => (
      !window.__inactiveClosedRoot.adoptedStyleSheets.some((sheet) => (
        Array.from(sheet.cssRules).some((rule) => rule.cssText.includes('#inactive-shadow-target'))
      )) &&
      !window.__lateClosedRoot.adoptedStyleSheets.some((sheet) => (
        Array.from(sheet.cssRules).some((rule) => rule.cssText.includes('#late-shadow-target'))
      ))
    ));

    await updateStoredItems({ [`${MANAGED_HOST}_enabled`]: true });
    await page.waitForFunction(() => (
      getComputedStyle(window.__inactiveClosedRoot.querySelector('#inactive-shadow-target')).color === 'rgb(13, 14, 15)' &&
      getComputedStyle(window.__lateClosedRoot.querySelector('#late-shadow-target')).color === 'rgb(13, 14, 15)'
    ));

    await page.evaluate(() => {
      window.__detachedClosedHost = document.querySelector('#late-closed-host');
      window.__detachedClosedHost.remove();
    });
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(() => (
      window.__lateClosedRoot.adoptedStyleSheets.some((sheet) => (
        Array.from(sheet.cssRules).some((rule) => rule.cssText.includes('#late-shadow-target'))
      ))
    )), false);

    await page.evaluate(() => document.body.appendChild(window.__detachedClosedHost));
    await page.waitForFunction(() => (
      getComputedStyle(window.__lateClosedRoot.querySelector('#late-shadow-target')).color === 'rgb(13, 14, 15)'
    ));
  } finally {
    await closePage(page);
  }
});

test('repairs middle-rule tampering and removal of the managed adopted sheet', async () => {
  await setStoredCss(`
    #tamper-before { --tamper-edge: before; }
    #tamper-target { color: rgb(4, 5, 6) !important; }
    #tamper-after { --tamper-edge: after; }
  `);
  const page = await openFixture('/tamper.html');
  try {
    await page.waitForFunction(() => (
      getComputedStyle(document.querySelector('#tamper-target')).color === 'rgb(4, 5, 6)'
    ));

    await page.evaluate(() => {
      window.__managedTamperSheet = document.adoptedStyleSheets.find((sheet) => (
        Array.from(sheet.cssRules).some((rule) => rule.cssText.includes('#tamper-target'))
      ));
      const markerRule = window.__managedTamperSheet.cssRules[window.__managedTamperSheet.cssRules.length - 1].cssText;
      window.__managedTamperSheet.replaceSync(`
        #tamper-before { --tamper-edge: before; }
        #tamper-target { color: rgb(90, 80, 70) !important; }
        #tamper-after { --tamper-edge: after; }
        ${markerRule}
      `);
    });
    await page.waitForFunction(() => (
      getComputedStyle(document.querySelector('#tamper-target')).color === 'rgb(90, 80, 70)'
    ));
    await page.waitForFunction(() => {
      return document.adoptedStyleSheets.includes(window.__managedTamperSheet) &&
        Array.from(window.__managedTamperSheet.cssRules).some((rule) => rule.cssText.includes('rgb(4, 5, 6)')) &&
        getComputedStyle(document.querySelector('#tamper-target')).color === 'rgb(4, 5, 6)';
    }, undefined, { timeout: 5000 });

    await page.evaluate(() => {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((sheet) => (
        sheet !== window.__managedTamperSheet
      ));
    });
    await page.waitForFunction(() => (
      document.adoptedStyleSheets.includes(window.__managedTamperSheet) &&
      document.adoptedStyleSheets.at(-1) === window.__managedTamperSheet &&
      getComputedStyle(document.querySelector('#tamper-target')).color === 'rgb(4, 5, 6)'
    ), undefined, { timeout: 5000 });

    await page.evaluate(() => {
      window.__managedTamperSheet.media.mediaText = 'not all';
    });
    assert.equal(await page.evaluate(() => (
      window.__managedTamperSheet.media.mediaText
    )), 'not all');
    await page.waitForFunction(() => (
      window.__managedTamperSheet.media.mediaText === '' &&
      getComputedStyle(document.querySelector('#tamper-target')).color === 'rgb(4, 5, 6)'
    ), undefined, { timeout: 5000 });
  } finally {
    await closePage(page);
  }
});

test('restores document CSS after document.open replaces the tree', async () => {
  await setStoredCss(`
    .document-open-target, #rewritten-dsd-target, #rewritten-imperative-target,
    #rewritten-bulk-target {
      color: rgb(7, 8, 9) !important;
    }
  `);
  const page = await openFixture('/document-open.html');
  try {
    await page.waitForFunction(() => (
      getComputedStyle(document.querySelector('.document-open-target')).color === 'rgb(7, 8, 9)'
    ));
    await page.evaluate(() => {
      const bulkSiblings = '<div></div>'.repeat(2000);
      document.open();
      document.write(`<!doctype html><html><head></head><body>
        <div class="document-open-target">after</div>
        ${bulkSiblings}
        <div id="rewritten-dsd-host">
          <template shadowrootmode="open"><span id="rewritten-dsd-target">declarative</span></template>
        </div>
        <div id="rewritten-imperative-host"></div>
        <div id="rewritten-bulk-host"></div>
      </body></html>`);
      document.close();
      window.__documentOpenClosedRoot = document
        .querySelector('#rewritten-imperative-host')
        .attachShadow({ mode: 'closed' });
      window.__documentOpenClosedRoot.innerHTML = '<span id="rewritten-imperative-target">imperative</span>';
      window.__documentOpenBulkRoot = document
        .querySelector('#rewritten-bulk-host')
        .attachShadow({ mode: 'closed' });
      window.__documentOpenBulkRoot.innerHTML = '<span id="rewritten-bulk-target">bulk</span>';
    });
    await page.waitForFunction(() => {
      const declarativeRoot = document.querySelector('#rewritten-dsd-host').shadowRoot;
      return getComputedStyle(document.querySelector('.document-open-target')).color === 'rgb(7, 8, 9)' &&
        getComputedStyle(declarativeRoot.querySelector('#rewritten-dsd-target')).color === 'rgb(7, 8, 9)' &&
        getComputedStyle(window.__documentOpenClosedRoot.querySelector('#rewritten-imperative-target')).color === 'rgb(7, 8, 9)' &&
        getComputedStyle(window.__documentOpenBulkRoot.querySelector('#rewritten-bulk-target')).color === 'rgb(7, 8, 9)' &&
        document.querySelectorAll('style[data-css-injector]').length === 0 &&
        declarativeRoot.querySelectorAll('style[data-css-injector]').length === 0 &&
        window.__documentOpenClosedRoot.querySelectorAll('style[data-css-injector]').length === 0 &&
        document.adoptedStyleSheets.at(-1) === declarativeRoot.adoptedStyleSheets.at(-1) &&
        document.adoptedStyleSheets.at(-1) === window.__documentOpenClosedRoot.adoptedStyleSheets.at(-1) &&
        document.adoptedStyleSheets.at(-1) === window.__documentOpenBulkRoot.adoptedStyleSheets.at(-1);
    });
  } finally {
    await closePage(page);
  }
});

test('re-resolves relative constructed URLs and @import after base URL changes', async () => {
  await setStoredCss(`
    #base-target, #base-shadow-target {
      background-image: url("relative.svg");
    }
  `);
  const page = await openFixture('/base.html');
  try {
    const initialAssetUrl = `http://${MANAGED_HOST}:${fixturePort}/relative.svg`;
    await page.waitForFunction((expectedUrl) => (
      getComputedStyle(document.querySelector('#base-target')).backgroundImage.includes(expectedUrl) &&
      getComputedStyle(window.__baseRoot.querySelector('#base-shadow-target')).backgroundImage.includes(expectedUrl)
    ), initialAssetUrl);

    await page.evaluate(() => {
      const base = document.createElement('base');
      base.href = '/base-assets/';
      document.head.prepend(base);
    });
    await page.waitForFunction(() => (
      getComputedStyle(document.querySelector('#base-target')).backgroundImage.includes('/base-assets/relative.svg') &&
      getComputedStyle(window.__baseRoot.querySelector('#base-shadow-target')).backgroundImage.includes('/base-assets/relative.svg')
    ), undefined, { timeout: 5000 });

    await updateStoredItems({
      [MANAGED_HOST]: '@import url("relative-import.css");'
    });
    await page.waitForFunction(() => (
      getComputedStyle(document.querySelector('#base-target')).color === 'rgb(30, 31, 32)' &&
      getComputedStyle(window.__baseRoot.querySelector('#base-shadow-target')).color === 'rgb(30, 31, 32)'
    ));

    await page.evaluate(() => {
      document.querySelector('base').href = '/other-assets/';
    });
    await page.waitForFunction(() => (
      getComputedStyle(document.querySelector('#base-target')).color === 'rgb(40, 41, 42)' &&
      getComputedStyle(window.__baseRoot.querySelector('#base-shadow-target')).color === 'rgb(40, 41, 42)'
    ), undefined, { timeout: 5000 });
  } finally {
    await closePage(page);
  }
});

test('uses the top hostname in same-origin, cross-origin, srcdoc, and hidden frames', async () => {
  await setStoredCss('.frame-target, .frame-shadow-target { color: rgb(7, 8, 9) !important; }', {
    [FRAME_HOST]: '.frame-target, .frame-shadow-target { color: rgb(90, 80, 70) !important; }',
    [`${FRAME_HOST}_enabled`]: true
  });
  const page = await openFixture('/frames.html');
  try {
    for (const frameName of ['same', 'cross', 'srcdoc', 'hidden']) {
      const frame = await waitForNamedFrame(page, frameName);
      assert.ok(frame, `missing ${frameName} frame`);
      await frame.waitForFunction(() => (
        getComputedStyle(document.querySelector('.frame-target')).color === 'rgb(7, 8, 9)' &&
        !!window.__frameClosedRoot &&
        getComputedStyle(window.__frameClosedRoot.querySelector('.frame-shadow-target')).color === 'rgb(7, 8, 9)' &&
        document.querySelectorAll('style[data-css-injector]').length === 0 &&
        window.__frameClosedRoot.querySelectorAll('style[data-css-injector]').length === 0 &&
        document.adoptedStyleSheets.at(-1) === window.__frameClosedRoot.adoptedStyleSheets.at(-1)
      ));
    }

    await page.bringToFront();
    const frameZeroResponse = await extensionWorker.evaluate(async ({ host }) => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const message = {
        type: 'css:apply',
        host,
        css: '.frame-target, .frame-shadow-target { color: rgb(20, 21, 22) !important; }',
        enabled: true
      };
      const response = await chrome.tabs.sendMessage(tab.id, message, { frameId: 0 });
      chrome.tabs.sendMessage(tab.id, Object.assign({}, message, { delivery: 'subframes' })).catch(() => {});
      return response;
    }, { host: MANAGED_HOST });
    assert.deepEqual(frameZeroResponse, { ok: true });

    for (const frameName of ['same', 'cross', 'srcdoc', 'hidden']) {
      const frame = await waitForNamedFrame(page, frameName);
      await frame.waitForFunction(() => (
        getComputedStyle(document.querySelector('.frame-target')).color === 'rgb(20, 21, 22)' &&
        getComputedStyle(window.__frameClosedRoot.querySelector('.frame-shadow-target')).color === 'rgb(20, 21, 22)'
      ));
    }
    assert.equal(await page.locator('style[data-css-injector]').count(), 0);
    assert.equal(await page.evaluate(() => (
      document.adoptedStyleSheets.some((sheet) => (
        Array.from(sheet.cssRules).some((rule) => rule.cssText.includes('rgb(20, 21, 22)'))
      ))
    )), true);
  } finally {
    await closePage(page);
  }
});

test('sweeps orphan managed sheets on reinjection and clear removes the replacement', async () => {
  await setStoredCss(`
    #document-last, #shadow-last, #legacy-observer-deep-target {
      color: rgb(50, 51, 52) !important;
    }
  `);
  const page = await openFixture('/structural.html');
  try {
    await page.waitForFunction(() => (
      getComputedStyle(document.querySelector('#document-last')).color === 'rgb(50, 51, 52)' &&
      getComputedStyle(window.__structuralRoot.querySelector('#shadow-last')).color === 'rgb(50, 51, 52)'
    ));

    const extensionId = new URL(extensionWorker.url()).host;
    const markerProperty = `--__css-injector-${extensionId}-managed-sheet-v2`;
    await page.evaluate((host) => {
      const legacyDocumentStyle = document.createElement('style');
      legacyDocumentStyle.id = 'legacy-document-style';
      legacyDocumentStyle.setAttribute('data-css-injector', host);
      legacyDocumentStyle.setAttribute('data-css-injector-priority', 'user');
      legacyDocumentStyle.textContent = '.legacy-document-marker { --legacy: document; }';
      document.head.appendChild(legacyDocumentStyle);

      const legacyShadowStyle = document.createElement('style');
      legacyShadowStyle.id = 'legacy-shadow-style';
      legacyShadowStyle.setAttribute('data-css-injector', host);
      legacyShadowStyle.setAttribute('data-css-injector-priority', 'user');
      legacyShadowStyle.setAttribute('data-css-injector-shadow-bridge', 'true');
      legacyShadowStyle.textContent = '.legacy-shadow-marker { --legacy: shadow; }';
      window.__structuralRoot.appendChild(legacyShadowStyle);
    }, MANAGED_HOST);

    const countManagedSheets = await page.evaluate((marker) => {
      const orphanSheet = new CSSStyleSheet();
      orphanSheet.replaceSync(`
        @media not all { :root { ${marker}: 1; } }
        #document-last, #shadow-last { color: rgb(90, 80, 70) !important; }
      `);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, orphanSheet];
      window.__structuralRoot.adoptedStyleSheets = [
        ...window.__structuralRoot.adoptedStyleSheets,
        orphanSheet
      ];
      const count = (scope) => scope.adoptedStyleSheets.filter((sheet) => (
        Array.from(sheet.cssRules).some((rule) => rule.cssText.includes(marker))
      )).length;
      return [count(document), count(window.__structuralRoot)];
    }, markerProperty);
    assert.deepEqual(countManagedSheets, [2, 2]);

    await reinjectTopFrameContentScript(page, { resetLegacyDomSweep: true });
    await page.waitForFunction((marker) => {
      const managed = (scope) => scope.adoptedStyleSheets.filter((sheet) => (
        Array.from(sheet.cssRules).some((rule) => rule.cssText.includes(marker))
      ));
      const documentSheets = managed(document);
      const shadowSheets = managed(window.__structuralRoot);
      return documentSheets.length === 1 &&
        shadowSheets.length === 1 &&
        document.querySelector('#legacy-document-style')?.media === 'not all' &&
        document.querySelector('#legacy-document-style')?.type === 'text/plain' &&
        document.querySelector('#legacy-document-style')
          ?.getAttribute('data-css-injector-legacy-disabled') === 'true' &&
        !window.__structuralRoot.querySelector('#legacy-shadow-style') &&
        documentSheets[0] === shadowSheets[0] &&
        getComputedStyle(document.querySelector('#document-last')).color === 'rgb(50, 51, 52)' &&
        getComputedStyle(window.__structuralRoot.querySelector('#shadow-last')).color === 'rgb(50, 51, 52)';
    }, markerProperty);

    await page.evaluate((host) => {
      document.querySelector('#legacy-document-style').remove();
      const recreatedLegacyStyle = document.createElement('style');
      recreatedLegacyStyle.id = 'legacy-document-style-recreated';
      recreatedLegacyStyle.setAttribute('data-css-injector', host);
      recreatedLegacyStyle.setAttribute('data-css-injector-priority', 'user');
      recreatedLegacyStyle.textContent = 'body { background: rgb(90, 80, 70) !important; }';
      document.head.appendChild(recreatedLegacyStyle);
    }, MANAGED_HOST);
    await page.waitForFunction(() => {
      const recreated = document.querySelector('#legacy-document-style-recreated');
      return recreated?.media === 'not all' &&
        recreated?.type === 'text/plain' &&
        recreated?.getAttribute('data-css-injector-legacy-disabled') === 'true';
    });

    await page.evaluate(() => {
      let parent = document.body;
      // Two DOM nodes are added per level, so remain below Chromium's
      // renderer depth ceiling while exercising the legacy observer path.
      for (let index = 0; index < 192; index += 1) {
        const wrapper = document.createElement('div');
        const detachedSpacer = document.createElement('span');
        wrapper.appendChild(detachedSpacer);
        if (index === 191) {
          window.__legacyObserverDeepRoot = wrapper.attachShadow({ mode: 'closed' });
          window.__legacyObserverDeepRoot.innerHTML =
            '<span id="legacy-observer-deep-target">legacy observer deep</span>';
        }
        parent.appendChild(wrapper);
        parent = detachedSpacer;
      }
    });
    await page.waitForFunction(() => (
      getComputedStyle(window.__legacyObserverDeepRoot.querySelector('#legacy-observer-deep-target')).color ===
        'rgb(50, 51, 52)'
    ));

    await page.bringToFront();
    const mismatchedClearResponse = await extensionWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return chrome.tabs.sendMessage(tab.id, {
        type: 'css:clear',
        host: 'different.example'
      }, { frameId: 0 });
    });
    assert.deepEqual(mismatchedClearResponse, { ok: false, error: 'Host mismatch' });
    assert.equal(await page.evaluate(() => (
      getComputedStyle(document.querySelector('#document-last')).color
    )), 'rgb(50, 51, 52)');

    const clearResponse = await extensionWorker.evaluate(async (host) => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return chrome.tabs.sendMessage(tab.id, { type: 'css:clear', host }, { frameId: 0 });
    }, MANAGED_HOST);
    assert.deepEqual(clearResponse, { ok: true });
    await page.waitForFunction((marker) => {
      const hasManagedSheet = (scope) => scope.adoptedStyleSheets.some((sheet) => (
        Array.from(sheet.cssRules).some((rule) => rule.cssText.includes(marker))
      ));
      return !hasManagedSheet(document) && !hasManagedSheet(window.__structuralRoot);
    }, markerProperty);
  } finally {
    await closePage(page);
  }
});

test('loads the real popup page without script or console errors', async () => {
  const extensionId = new URL(extensionWorker.url()).host;
  const page = await browserContext.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  try {
    const response = await page.goto(`chrome-extension://${extensionId}/popup.html`, {
      waitUntil: 'domcontentloaded'
    });
    if (response) assert.ok(response.ok());
    await page.waitForSelector('#css-editor');
    await page.waitForFunction(() => (
      document.querySelector('#version-text').textContent.trim().length > 0
    ));
    await page.waitForTimeout(100);
    assert.deepEqual(errors, []);
  } finally {
    await closePage(page);
  }
});
