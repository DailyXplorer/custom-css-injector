'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  REASONS,
  COMMENT_MIN_LENGTH,
  MESSAGES,
  isCommentRequired,
  isCommentValid,
  extractHostname,
  detectEnvironment
} = require('../site/uninstall/uninstall-core.js');

test('every reason except temporary requires a comment', () => {
  assert.deepEqual(
    REASONS.filter((reason) => !isCommentRequired(reason)),
    ['temporary']
  );
  assert.equal(isCommentRequired(''), false);
});

test('required comments need at least 15 characters after trimming', () => {
  assert.equal(COMMENT_MIN_LENGTH, 15);
  assert.equal(isCommentValid('didnt_work', 'It doesnt work Lad'), true);
  assert.equal(isCommentValid('didnt_work', 'It doesnt work'), false);
  assert.equal(isCommentValid('slow', `   ${'a'.repeat(14)}   `), false);
  assert.equal(isCommentValid('slow', 'a'.repeat(15)), true);
  assert.equal(isCommentValid('other', ''), false);
});

test('the temporary reason accepts an empty comment', () => {
  assert.equal(isCommentValid('temporary', ''), true);
  assert.equal(isCommentValid('temporary', 'ok'), true);
});

test('every locale has the same keys and a prompt for every reason', () => {
  const englishKeys = Object.keys(MESSAGES.en).sort();
  for (const [language, messages] of Object.entries(MESSAGES)) {
    assert.deepEqual(Object.keys(messages).sort(), englishKeys, language);
    assert.deepEqual(Object.keys(messages.prompts).sort(), [...REASONS].sort(), language);
    for (const prompt of Object.values(messages.prompts)) {
      assert.ok(prompt.label && prompt.placeholder, language);
    }
    assert.match(messages.commentTooShort, /\{min\}/, language);
  }
});

test('extractHostname keeps a bare hostname', () => {
  assert.equal(extractHostname('youtube.com'), 'youtube.com');
  assert.equal(extractHostname('  WWW.YouTube.com  '), 'www.youtube.com');
  assert.equal(extractHostname('youtube'), 'youtube');
});

test('extractHostname strips path, query, fragment, port, and credentials from URLs', () => {
  assert.equal(extractHostname('https://www.youtube.com/watch?v=abc#t=10'), 'www.youtube.com');
  assert.equal(extractHostname('http://user:secret@example.org:8080/private/page'), 'example.org');
  assert.equal(extractHostname('reddit.com/r/css?sort=new'), 'reddit.com');
  assert.equal(extractHostname('localhost:3000/app'), 'localhost');
  assert.equal(extractHostname('https://bücher.de/'), 'xn--bcher-kva.de');
});

test('extractHostname returns an empty string for garbage', () => {
  for (const input of ['', '   ', 'the youtube site', 'https://', '!!!', 'javascript:alert(1)', 'file:///home/me/page.html', '-', 'a'.repeat(300), null, undefined]) {
    assert.equal(extractHostname(input), '', String(input));
  }
});

test('detectEnvironment prefers userAgentData brands and platform', () => {
  assert.deepEqual(detectEnvironment({
    userAgentData: {
      brands: [
        { brand: 'Not_A Brand', version: '8' },
        { brand: 'Chromium', version: '131' },
        { brand: 'Google Chrome', version: '131' }
      ],
      platform: 'Windows'
    },
    userAgent: 'ignored'
  }), { browser: 'Chrome 131', os: 'Windows' });

  assert.deepEqual(detectEnvironment({
    userAgentData: { brands: [{ brand: 'Chromium', version: '130' }, { brand: 'Microsoft Edge', version: '130' }], platform: 'macOS' }
  }), { browser: 'Edge 130', os: 'macOS' });

  assert.deepEqual(detectEnvironment({
    userAgentData: { brands: [{ brand: 'Chromium', version: '129' }], platform: 'Chrome OS' }
  }), { browser: 'Chromium 129', os: 'ChromeOS' });

  assert.equal(detectEnvironment({ userAgentData: { brands: [], platform: 'Android' } }).os, 'other');
});

test('detectEnvironment parses the user agent into coarse values when userAgentData is missing', () => {
  const cases = [
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Safari/537.36', 'Chrome 131', 'Windows'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.80', 'Edge 130', 'macOS'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36', 'Chrome 128', 'ChromeOS'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0', 'Firefox 132', 'Linux'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36', 'Chrome 131', 'other'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 'Safari 18', 'macOS'],
    ['', 'unknown', 'other']
  ];
  for (const [userAgent, browser, os] of cases) {
    assert.deepEqual(detectEnvironment({ userAgent }), { browser, os }, userAgent);
  }
  assert.deepEqual(detectEnvironment(undefined), { browser: 'unknown', os: 'other' });
});
