'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { helpers } = require('./load-extension-globals.js');

const meta = {
  fileType: 'custom-css-injector-config',
  schemaVersion: 1,
  extensionVersion: '2.1.3'
};

test('normalizeHostname trims and lowercases hosts', () => {
  assert.equal(helpers.normalizeHostname('  WWW.Example.COM '), 'www.example.com');
});

test('normalizeHostname rejects hosts with paths', () => {
  assert.equal(helpers.normalizeHostname('example.com/path'), null);
});

test('normalizeHostname rejects query characters', () => {
  assert.equal(helpers.normalizeHostname('a?b'), null);
});

test('normalizeHostname rejects hash characters', () => {
  assert.equal(helpers.normalizeHostname('a#b'), null);
});

test('normalizeHostname rejects backslashes', () => {
  assert.equal(helpers.normalizeHostname('a\\b'), null);
});

test('normalizeHostname rejects empty strings', () => {
  assert.equal(helpers.normalizeHostname(''), null);
});

test('normalizeHostname rejects whitespace-only strings', () => {
  assert.equal(helpers.normalizeHostname('   '), null);
});

test('normalizeHostname rejects non-string input', () => {
  assert.equal(helpers.normalizeHostname(42), null);
});

test('normalizeHostname rejects enabled-suffix hosts', () => {
  assert.equal(helpers.normalizeHostname('foo_enabled'), null);
});

test('normalizeHostname accepts IP hosts', () => {
  assert.equal(helpers.normalizeHostname('127.0.0.1'), '127.0.0.1');
});

test('normalizeHostname returns URL punycode hostnames', () => {
  assert.equal(helpers.normalizeHostname('münchen.de'), 'xn--mnchen-3ya.de');
});

test('parseImportPayload accepts a valid payload', () => {
  const result = helpers.parseImportPayload({
    type: meta.fileType,
    schemaVersion: meta.schemaVersion,
    entries: [
      { host: 'Example.com', css: 'body{}' },
      { host: 'disabled.test', css: 'html{}', enabled: false }
    ]
  }, meta);

  assert.equal(Object.getPrototypeOf(result.itemsToSet), null);
  assert.deepEqual(Object.fromEntries(Object.entries(result.itemsToSet)), {
    'example.com': 'body{}',
    'example.com_enabled': true,
    'disabled.test': 'html{}',
    'disabled.test_enabled': false
  });
  assert.deepEqual(Array.from(result.importedHosts).sort(), ['disabled.test', 'example.com']);
});

test('parseImportPayload rejects non-object payloads', () => {
  assert.throws(() => helpers.parseImportPayload(null, meta), /Invalid file format\./);
});

test('parseImportPayload rejects unsupported config types', () => {
  assert.throws(() => helpers.parseImportPayload({
    type: 'other',
    schemaVersion: meta.schemaVersion,
    entries: []
  }, meta), /Unsupported config type\./);
});

test('parseImportPayload rejects unsupported config versions', () => {
  assert.throws(() => helpers.parseImportPayload({
    type: meta.fileType,
    schemaVersion: 99,
    entries: []
  }, meta), /Unsupported config version\./);
});

test('parseImportPayload rejects non-array entries', () => {
  assert.throws(() => helpers.parseImportPayload({
    type: meta.fileType,
    schemaVersion: meta.schemaVersion,
    entries: {}
  }, meta), /Invalid entries format\./);
});

test('parseImportPayload rejects non-object entries', () => {
  assert.throws(() => helpers.parseImportPayload({
    type: meta.fileType,
    schemaVersion: meta.schemaVersion,
    entries: [null]
  }, meta), /Invalid entry at index 1\./);
});

test('parseImportPayload rejects invalid hosts', () => {
  assert.throws(() => helpers.parseImportPayload({
    type: meta.fileType,
    schemaVersion: meta.schemaVersion,
    entries: [{ host: 'example.com/path', css: '' }]
  }, meta), /Invalid host at entry 1\./);
});

test('parseImportPayload rejects non-string CSS', () => {
  assert.throws(() => helpers.parseImportPayload({
    type: meta.fileType,
    schemaVersion: meta.schemaVersion,
    entries: [{ host: 'example.com', css: 42 }]
  }, meta), /Invalid CSS at entry 1\./);
});

test('parseImportPayload rejects non-boolean enabled values', () => {
  assert.throws(() => helpers.parseImportPayload({
    type: meta.fileType,
    schemaVersion: meta.schemaVersion,
    entries: [{ host: 'example.com', css: '', enabled: 'yes' }]
  }, meta), /Invalid enabled value at entry 1\./);
});

test('parseImportPayload lets later duplicate hosts win', () => {
  const result = helpers.parseImportPayload({
    type: meta.fileType,
    schemaVersion: meta.schemaVersion,
    entries: [
      { host: 'example.com', css: 'old', enabled: false },
      { host: 'EXAMPLE.com', css: 'new', enabled: true }
    ]
  }, meta);

  assert.equal(result.itemsToSet['example.com'], 'new');
  assert.equal(result.itemsToSet['example.com_enabled'], true);
});

test('parseImportPayload handles __proto__ without prototype pollution', () => {
  const result = helpers.parseImportPayload({
    type: meta.fileType,
    schemaVersion: meta.schemaVersion,
    entries: [{ host: '__proto__', css: 'body{}' }]
  }, meta);

  assert.equal(Object.getPrototypeOf(result.itemsToSet), null);
  assert.equal(result.itemsToSet.__proto__, 'body{}');
  assert.equal(Object.prototype.css, undefined);
});

test('assertStorageLimits allows items under limits', () => {
  assert.doesNotThrow(() => helpers.assertStorageLimits({ a: 'b' }, {
    maxItems: 2,
    quotaBytes: 100
  }));
});

test('assertStorageLimits rejects too many keys', () => {
  assert.throws(() => helpers.assertStorageLimits({ a: 'b', c: 'd' }, {
    maxItems: 1,
    quotaBytes: 100
  }), /Import too large/);
});

test('assertStorageLimits rejects total bytes over quota', () => {
  assert.throws(() => helpers.assertStorageLimits({ a: 'b' }, {
    maxItems: 2,
    quotaBytes: 1
  }), /Import too large/);
});

test('assertStorageLimits ignores non-finite limits', () => {
  assert.doesNotThrow(() => helpers.assertStorageLimits({ a: 'b' }, {
    maxItems: Infinity,
    quotaBytes: Infinity
  }));
});

test('getHostEntriesFromStorage filters internal and non-host items', () => {
  const entries = helpers.getHostEntriesFromStorage({
    '__internal': 'x',
    'draft:example.com': 'x',
    'example.com_enabled': false,
    'not-string.test': 42,
    'z.test': 'z',
    'z.test_enabled': false,
    'a.test': 'a'
  });

  assert.deepEqual(entries, [
    { host: 'a.test', storageKey: 'a.test', css: 'a', enabled: true },
    { host: 'z.test', storageKey: 'z.test', css: 'z', enabled: false }
  ]);
});

test('buildExportPayload deduplicates and sorts hosts', () => {
  const payload = helpers.buildExportPayload([
    { host: 'b.test', css: 'b', enabled: true },
    { host: 'a.test', css: 'old', enabled: false },
    { host: 'a.test', css: 'new', enabled: true }
  ], meta);

  assert.equal(payload.type, meta.fileType);
  assert.equal(payload.schemaVersion, meta.schemaVersion);
  assert.equal(payload.extensionVersion, meta.extensionVersion);
  assert.deepEqual(payload.entries, [
    { host: 'a.test', css: 'new', enabled: true },
    { host: 'b.test', css: 'b', enabled: true }
  ]);
  assert.match(payload.exportedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('chunkObjectEntries chunks entries into null-prototype objects', () => {
  const chunks = helpers.chunkObjectEntries({ a: 1, b: 2, c: 3, d: 4, e: 5 }, 2);

  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.map((chunk) => Object.keys(chunk)), [['a', 'b'], ['c', 'd'], ['e']]);
  assert.equal(Object.getPrototypeOf(chunks[0]), null);
});

test('chunkObjectEntries returns no chunks for empty input', () => {
  assert.deepEqual(helpers.chunkObjectEntries({}, 2), []);
});

test('buildKeysToRemove removes existing hosts absent from import', () => {
  const keys = helpers.buildKeysToRemove({
    'keep.test': 'keep',
    'remove.test': 'remove',
    'remove.test_enabled': false
  }, new Set(['keep.test']));

  assert.deepEqual(keys, ['remove.test', 'remove.test_enabled']);
});

test('extractManagedHostItems returns only managed host storage keys', () => {
  const items = helpers.extractManagedHostItems({
    '__internal': 'x',
    'draft:a.test': 'x',
    'a.test': 'a',
    'a.test_enabled': false
  });

  assert.equal(Object.getPrototypeOf(items), null);
  assert.deepEqual(Object.fromEntries(Object.entries(items)), {
    'a.test': 'a',
    'a.test_enabled': false
  });
});

test('canWriteImportBeforeCleanup returns true when transient items fit', () => {
  assert.equal(helpers.canWriteImportBeforeCleanup({ a: 'b' }, { c: 'd' }, {
    maxItems: 4,
    quotaBytes: 100
  }), true);
});

test('canWriteImportBeforeCleanup returns false when transient items exceed limits', () => {
  assert.equal(helpers.canWriteImportBeforeCleanup({ a: 'b' }, { c: 'd' }, {
    maxItems: 1,
    quotaBytes: 100
  }), false);
});
