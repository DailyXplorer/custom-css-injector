'use strict';

// Compares browser CPU cost without the extension, with it but no saved CSS,
// and with active CSS. Run: node scripts/perf-benchmark.js [runs]
const { chromium } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EXTENSION_PATH = path.resolve(__dirname, '..');
const PORT = 4173;
const MAIN_HOST = '127.0.0.1';
const FRAME_HOST = 'localhost';
const RUNS = Number(process.argv[2]) || 5;
const IDLE_MS = Number(process.env.IDLE_MS) || 10000;
const ACTIVE_CSS = 'body { background: rgb(250, 250, 250) !important; } .card, .item { color: rgb(20, 30, 40) !important; }';

const FRAME_DOC = `<!doctype html><html><body>${'<div class="item">frame content</div>'.repeat(30)}</body></html>`;

const PAGES = {
  '/frames.html': `<!doctype html><html><body><h1>40 iframes</h1>
    ${Array.from({ length: 40 }, (_, index) => {
      const host = index % 2 ? FRAME_HOST : MAIN_HOST;
      return `<iframe src="http://${host}:${PORT}/frame.html?i=${index}" width="120" height="60"></iframe>`;
    }).join('')}
  </body></html>`,
  '/frame.html': FRAME_DOC,
  '/shadow.html': `<!doctype html><html><body><div id="root"></div><script>
    customElements.define('x-card', class extends HTMLElement {
      connectedCallback() {
        const root = this.attachShadow({ mode: 'open' });
        root.innerHTML = '<span class="card">card</span>';
      }
    });
    const start = performance.now();
    const root = document.getElementById('root');
    for (let index = 0; index < 2000; index += 1) root.appendChild(document.createElement('x-card'));
    window.__createMs = performance.now() - start;
  </script></body></html>`,
  '/mutations.html': `<!doctype html><html><body><div id="list"></div><script>
    const list = document.getElementById('list');
    let batches = 0;
    const timer = setInterval(() => {
      for (let index = 0; index < 250; index += 1) {
        const node = document.createElement('div');
        node.className = 'item';
        node.textContent = 'row ' + batches + '.' + index;
        list.appendChild(node);
      }
      batches += 1;
      if (batches === 20) { clearInterval(timer); window.__mutationsDone = true; }
    }, 50);
  </script></body></html>`
};

async function launch(mode) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'css-injector-perf-'));
  const args = mode === 'none'
    ? []
    : [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`];
  const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, args });
  await context.route(new RegExp(`^http://(?:${MAIN_HOST.replace(/\./g, '\\.')}|${FRAME_HOST}):${PORT}/`), (route) => {
    const body = PAGES[new URL(route.request().url()).pathname];
    return body
      ? route.fulfill({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body })
      : route.fulfill({ status: 404, body: '' });
  });

  if (mode !== 'none') {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(async ({ css, hosts }) => {
      await chrome.storage.local.clear();
      const items = { __cssInjectorMigratedSyncToLocal: true };
      for (const host of hosts) {
        items[host] = css;
        items[`${host}_enabled`] = true;
      }
      await chrome.storage.local.set(items);
    }, { css: ACTIVE_CSS, hosts: mode === 'active' ? [MAIN_HOST, FRAME_HOST] : [] });
  }

  const browserSession = await context.browser().newBrowserCDPSession();
  return {
    mode,
    context,
    browserSession,
    async close() {
      await context.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  };
}

async function totalCpuSeconds(session) {
  const { processInfo } = await session.send('SystemInfo.getProcessInfo');
  return processInfo.reduce((sum, processEntry) => sum + processEntry.cpuTime, 0);
}

async function measure(browser, pathname) {
  const page = await browser.context.newPage();
  const cpuBefore = await totalCpuSeconds(browser.browserSession);
  const started = Date.now();
  await page.goto(`http://${MAIN_HOST}:${PORT}${pathname}`, { waitUntil: 'load' });
  if (pathname === '/mutations.html') await page.waitForFunction(() => window.__mutationsDone === true);
  const loadMs = Date.now() - started;
  const cpuAfterLoad = await totalCpuSeconds(browser.browserSession);
  const createMs = await page.evaluate(() => window.__createMs ?? null);
  const cssApplied = await page.evaluate(() => getComputedStyle(document.body).backgroundColor === 'rgb(250, 250, 250)');
  if (cssApplied !== (browser.mode === 'active')) throw new Error(`${browser.mode} on ${pathname}: cssApplied=${cssApplied}`);
  await page.waitForTimeout(IDLE_MS);
  const cpuAfterIdle = await totalCpuSeconds(browser.browserSession);
  await page.close();
  return {
    loadMs,
    loadCpuMs: (cpuAfterLoad - cpuBefore) * 1000,
    idleCpuPercent: ((cpuAfterIdle - cpuAfterLoad) / (IDLE_MS / 1000)) * 100,
    createMs
  };
}

function quantile(values, q) {
  const sorted = values.filter((value) => typeof value === 'number').sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
}

function summarize(runs) {
  return Object.fromEntries(['loadMs', 'loadCpuMs', 'idleCpuPercent', 'createMs'].map((key) => {
    const values = runs.map((entry) => entry[key]);
    return [key, { p25: quantile(values, 0.25), median: quantile(values, 0.5), p75: quantile(values, 0.75) }];
  }));
}

// Modes are measured in alternation so machine load drifts hit all of them equally.
async function main() {
  const modes = ['none', 'idle', 'active'];
  const results = {};
  for (const pathname of ['/frames.html', '/shadow.html', '/mutations.html']) {
    const browsers = {};
    for (const mode of modes) browsers[mode] = await launch(mode);
    try {
      const runs = Object.fromEntries(modes.map((mode) => [mode, []]));
      for (const mode of modes) await measure(browsers[mode], pathname);
      for (let run = 0; run < RUNS; run += 1) {
        const order = run % 2 ? [...modes].reverse() : modes;
        for (const mode of order) runs[mode].push(await measure(browsers[mode], pathname));
      }
      results[pathname] = Object.fromEntries(modes.map((mode) => [mode, summarize(runs[mode])]));
    } finally {
      for (const mode of modes) await browsers[mode].close();
    }
    console.error(`done ${pathname}`);
  }
  console.log(JSON.stringify({ runs: RUNS, idleSeconds: IDLE_MS / 1000, results }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
