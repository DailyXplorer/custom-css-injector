'use strict';

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const SITE_ROOT = path.resolve(__dirname, '..', 'site');
const WEB3FORMS_ENDPOINT = 'https://api.web3forms.com/submit';
const CONTENT_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

let server;
let browser;
let pageUrl;

before(async () => {
  server = http.createServer((request, response) => {
    let pathname = path.posix.normalize(new URL(request.url, 'http://127.0.0.1').pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.join(SITE_ROOT, pathname);
    if (!file.startsWith(SITE_ROOT) || !fs.existsSync(file)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  pageUrl = `http://127.0.0.1:${server.address().port}/uninstall/?v=9.9.9&lang=en`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

async function openFeedbackPage() {
  const context = await browser.newContext();
  const page = await context.newPage();
  const submissions = [];
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (url === WEB3FORMS_ENDPOINT) {
      submissions.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' });
    } else if (url.startsWith('http://127.0.0.1:')) {
      await route.continue();
    } else {
      await route.abort();
    }
  });
  await page.goto(pageUrl);
  return { context, page, submissions };
}

test('didnt_work asks a precise question, blocks short comments, and sends only the hostname', async () => {
  const { context, page, submissions } = await openFeedbackPage();
  try {
    assert.equal(await page.isVisible('#feedback-comment'), false);

    await page.check('input[value="didnt_work"]');
    assert.equal(await page.textContent('#feedback-comment-label'), 'What happened, and what did you expect?');
    assert.equal(await page.getAttribute('#feedback-comment', 'placeholder'), "e.g. my CSS was saved but the page didn't change");
    assert.equal(await page.isVisible('#feedback-site'), true);
    assert.equal(await page.getAttribute('#feedback-comment', 'minlength'), '15');
    assert.equal(await page.$eval('#feedback-comment', (element) => element.required), true);

    await page.fill('#feedback-comment', 'It doesnt work');
    await page.click('.feedback-submit');
    assert.equal(await page.isVisible('#feedback-comment-error'), true);
    assert.match(await page.textContent('#feedback-comment-error'), /at least 15 characters/);
    assert.equal(await page.getAttribute('#feedback-comment', 'aria-invalid'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'feedback-comment');
    assert.equal(submissions.length, 0);

    await page.fill('#feedback-comment', 'My CSS was saved but the page did not change');
    assert.equal(await page.isVisible('#feedback-comment-error'), false);
    await page.fill('#feedback-site', 'https://user:secret@www.youtube.com/watch?v=abc#t=1');
    await page.click('.feedback-submit');
    await page.waitForSelector('#feedback-thanks', { state: 'visible' });

    assert.equal(submissions.length, 1);
    const [payload] = submissions;
    assert.equal(payload.subject, 'Uninstall feedback: didnt_work');
    assert.equal(payload.reason, 'didnt_work');
    assert.equal(payload.comment, 'My CSS was saved but the page did not change');
    assert.equal(payload.site, 'www.youtube.com');
    assert.equal(payload.version, '9.9.9');
    assert.equal(payload.language, 'en');
    assert.match(payload.browser, /^(Chrome|Chromium) \d+$/);
    assert.ok(['Windows', 'macOS', 'Linux', 'ChromeOS', 'other'].includes(payload.os), payload.os);
    assert.equal(JSON.stringify(payload).includes('Mozilla'), false);
  } finally {
    await context.close();
  }
});

test('temporary keeps the comment optional and sends no site', async () => {
  const { context, page, submissions } = await openFeedbackPage();
  try {
    await page.check('input[value="didnt_work"]');
    await page.fill('#feedback-site', 'example.com');
    await page.check('input[value="temporary"]');
    assert.equal(await page.textContent('#feedback-comment-label'), 'Anything else? (optional)');
    assert.equal(await page.isVisible('#feedback-site'), false);
    assert.equal(await page.$eval('#feedback-comment', (element) => element.required), false);
    assert.equal(await page.getAttribute('#feedback-comment', 'minlength'), null);

    await page.click('.feedback-submit');
    await page.waitForSelector('#feedback-thanks', { state: 'visible' });

    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].reason, 'temporary');
    assert.equal(submissions[0].comment, '');
    assert.equal('site' in submissions[0], false);
  } finally {
    await context.close();
  }
});
