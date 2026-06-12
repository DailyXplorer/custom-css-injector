'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { utils } = require('./load-extension-globals.js');

test('getUtf8Size counts ASCII bytes', () => {
  assert.equal(utils.getUtf8Size('abc'), 3);
});

test('getUtf8Size counts multi-byte UTF-8 bytes', () => {
  assert.equal(utils.getUtf8Size('é'), 2);
});

test('getUtf8Size counts emoji surrogate pairs', () => {
  assert.equal(utils.getUtf8Size('😀'), 4);
});

test('getUtf8Size counts mixed multi-byte text', () => {
  assert.equal(utils.getUtf8Size('é😀'), 6);
});

test('getUtf8Size counts an empty string as zero bytes', () => {
  assert.equal(utils.getUtf8Size(''), 0);
});

test('getUtf8Size stringifies non-string input', () => {
  assert.equal(utils.getUtf8Size(123), 3);
});

test('estimateStorageUsage returns zeroes for an empty object', () => {
  assert.deepEqual(utils.estimateStorageUsage({}), { totalBytes: 0, maxItemBytes: 0 });
});

test('estimateStorageUsage counts keys and JSON-serialized values', () => {
  assert.deepEqual(utils.estimateStorageUsage({ a: 'b', x: false }), {
    totalBytes: 10,
    maxItemBytes: 6
  });
});

test('estimateStorageUsage ignores non-object input', () => {
  assert.deepEqual(utils.estimateStorageUsage(null), { totalBytes: 0, maxItemBytes: 0 });
});

test('countLines counts an empty string as one line', () => {
  assert.equal(utils.countLines(''), 1);
});

test('countLines counts newline-separated lines', () => {
  assert.equal(utils.countLines('a\nb'), 2);
});

test('countLines counts a trailing newline as a new line', () => {
  assert.equal(utils.countLines('a\n'), 2);
});

test('countLines treats non-string input as one line', () => {
  assert.equal(utils.countLines(undefined), 1);
});

test('createHostState preserves string CSS and enabled true', () => {
  assert.deepEqual(utils.createHostState('example.com', 'body{}', true), {
    host: 'example.com',
    css: 'body{}',
    enabled: true
  });
});

test('createHostState defaults enabled to true unless explicitly false', () => {
  assert.equal(utils.createHostState('example.com', '', undefined).enabled, true);
});

test('createHostState preserves explicit disabled state', () => {
  assert.equal(utils.createHostState('example.com', '', false).enabled, false);
});

test('createHostState normalizes non-string CSS to empty string', () => {
  assert.equal(utils.createHostState('example.com', null, true).css, '');
});

test('extractHostStateFromStorage reads saved CSS and enabled flag', () => {
  assert.deepEqual(utils.extractHostStateFromStorage('example.com', {
    'example.com': 'body{}',
    'example.com_enabled': false
  }), {
    host: 'example.com',
    css: 'body{}',
    enabled: false
  });
});

test('extractHostStateFromStorage defaults missing enabled flag to true', () => {
  assert.equal(utils.extractHostStateFromStorage('example.com', {
    'example.com': 'body{}'
  }).enabled, true);
});

test('extractHostStateFromStorage normalizes non-string CSS to empty string', () => {
  assert.equal(utils.extractHostStateFromStorage('example.com', {
    'example.com': 42
  }).css, '');
});

test('getHostStateItems returns the storage key shape', () => {
  assert.deepEqual(utils.getHostStateItems({
    host: 'example.com',
    css: 'body{}',
    enabled: false
  }), {
    'example.com': 'body{}',
    'example.com_enabled': false
  });
});

test('isSameHostState returns true for equal css and enabled values', () => {
  assert.equal(utils.isSameHostState(
    { css: 'body{}', enabled: true },
    { css: 'body{}', enabled: true }
  ), true);
});

test('isSameHostState returns false for unequal CSS', () => {
  assert.equal(utils.isSameHostState(
    { css: 'body{}', enabled: true },
    { css: 'html{}', enabled: true }
  ), false);
});

test('isSameHostState returns false for unequal enabled values', () => {
  assert.equal(utils.isSameHostState(
    { css: 'body{}', enabled: true },
    { css: 'body{}', enabled: false }
  ), false);
});

test('isSameHostState returns false for null inputs', () => {
  assert.equal(utils.isSameHostState(null, { css: '', enabled: true }), false);
});

test('isScriptableUrl accepts HTTPS URLs', () => {
  assert.equal(utils.isScriptableUrl('https://example.com'), true);
});

test('isScriptableUrl accepts HTTP URLs', () => {
  assert.equal(utils.isScriptableUrl('http://x.test'), true);
});

test('isScriptableUrl rejects chrome URLs', () => {
  assert.equal(utils.isScriptableUrl('chrome://extensions'), false);
});

test('isScriptableUrl rejects file URLs', () => {
  assert.equal(utils.isScriptableUrl('file:///x'), false);
});

test('isScriptableUrl rejects Chrome Web Store URLs on chromewebstore.google.com', () => {
  assert.equal(utils.isScriptableUrl('https://chromewebstore.google.com/detail/abc'), false);
});

test('isScriptableUrl rejects Chrome Web Store URLs on chrome.google.com', () => {
  assert.equal(utils.isScriptableUrl('https://chrome.google.com/webstore/x'), false);
});

test('isScriptableUrl rejects Microsoft Edge add-ons gallery URLs', () => {
  assert.equal(utils.isScriptableUrl('https://microsoftedge.microsoft.com/fr/addons/x'), false);
});

test('isScriptableUrl rejects malformed URLs', () => {
  assert.equal(utils.isScriptableUrl('not a url'), false);
});

test('withTimeout resolves when the inner promise wins', async () => {
  await assert.doesNotReject(utils.withTimeout(Promise.resolve('ok'), 50, 'too slow'));
});

test('withTimeout rejects with the provided message when the timer wins', async () => {
  await assert.rejects(
    utils.withTimeout(new Promise((resolve) => setTimeout(resolve, 25)), 5, 'too slow'),
    /too slow/
  );
});

test('getErrorMessage reads Error instances', () => {
  assert.equal(utils.getErrorMessage(new Error(' boom '), 'fallback'), 'boom');
});

test('getErrorMessage trims object message properties', () => {
  assert.equal(utils.getErrorMessage({ message: ' x ' }, 'fallback'), 'x');
});

test('getErrorMessage trims plain strings', () => {
  assert.equal(utils.getErrorMessage(' text ', 'fallback'), 'text');
});

test('getErrorMessage serializes plain objects when useful', () => {
  assert.equal(utils.getErrorMessage({ code: 12 }, 'fallback'), '{"code":12}');
});

test('getErrorMessage returns the fallback for unserializable input', () => {
  const circular = {};
  circular.self = circular;
  assert.equal(utils.getErrorMessage(circular, 'fallback'), 'fallback');
});
