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

test('normalizeHostname rejects the reserved internal namespace', () => {
  assert.equal(helpers.normalizeHostname('__proto__'), null);
  assert.equal(helpers.normalizeHostname('__internal.example'), null);
});

test('normalizeHostname rejects credentials and ports instead of retargeting them', () => {
  assert.equal(helpers.normalizeHostname('user@example.com'), null);
  assert.equal(helpers.normalizeHostname('user:pass@example.com'), null);
  assert.equal(helpers.normalizeHostname('example.com:'), null);
  assert.equal(helpers.normalizeHostname('example.com:80'), null);
  assert.equal(helpers.normalizeHostname('example.com:443'), null);
  assert.equal(helpers.normalizeHostname('[::1]:'), null);
  assert.equal(helpers.normalizeHostname('[::1]:80'), null);
  assert.equal(helpers.normalizeHostname('[::1]:8080'), null);
});

test('normalizeHostname accepts bracketed IPv6 hostnames', () => {
  assert.equal(helpers.normalizeHostname('[::1]'), '[::1]');
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

test('parseImportPayload rejects reserved hosts without prototype pollution', () => {
  assert.throws(() => helpers.parseImportPayload({
    type: meta.fileType,
    schemaVersion: meta.schemaVersion,
    entries: [{ host: '__proto__', css: 'body{}' }]
  }, meta), /Invalid host at entry 1/);

  assert.equal(Object.prototype.css, undefined);
});

test('a valid export larger than one MiB round-trips below local quota', () => {
  const css = `/* large */${'x'.repeat((1024 * 1024) + 4096)}`;
  const exported = helpers.buildExportPayload([
    { host: 'large.example', css, enabled: true }
  ], meta);
  const serialized = JSON.stringify(exported);
  const fileLimit = helpers.getImportFileSizeLimit(10 * 1024 * 1024, 1024 * 1024);

  assert.ok(Buffer.byteLength(serialized) > 1024 * 1024);
  assert.ok(Buffer.byteLength(serialized) < fileLimit);
  const imported = helpers.parseImportPayload(JSON.parse(serialized), meta);
  assert.equal(imported.itemsToSet['large.example'], css);
  assert.doesNotThrow(() => helpers.assertStorageLimits(imported.itemsToSet, {
    quotaBytes: 10 * 1024 * 1024,
    maxItems: Infinity
  }));
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

test('buildKeysToRemove sweeps orphaned enabled keys and noncanonical duplicates', () => {
  const keys = helpers.buildKeysToRemove({
    'keep.test': 'canonical',
    'keep.test_enabled': true,
    'KEEP.test': 'duplicate',
    'KEEP.test_enabled': false,
    'orphan.test_enabled': false
  }, new Set(['keep.test']));

  assert.deepEqual(keys, ['KEEP.test', 'KEEP.test_enabled', 'orphan.test_enabled']);
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

test('extractManagedHostItems preserves exact orphan and missing-enabled state', () => {
  const items = helpers.extractManagedHostItems({
    'plain.test': 'css',
    'orphan.test_enabled': false
  });

  assert.deepEqual(Object.fromEntries(Object.entries(items)), {
    'plain.test': 'css',
    'orphan.test_enabled': false
  });
});

test('buildPostImportStorage preserves internal data and replaces all managed keys', () => {
  const result = helpers.buildPostImportStorage({
    '__marker': true,
    'old.test': 'old',
    'old.test_enabled': false,
    'orphan.test_enabled': true
  }, {
    'new.test': 'new',
    'new.test_enabled': true
  });

  assert.equal(Object.getPrototypeOf(result), null);
  assert.deepEqual(Object.fromEntries(Object.entries(result)), {
    '__marker': true,
    'new.test': 'new',
    'new.test_enabled': true
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

test('canWriteImportBeforeCleanup uses a null-prototype merge', () => {
  const current = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.equal(helpers.canWriteImportBeforeCleanup(current, { safe: 'value' }, {
    maxItems: 5,
    quotaBytes: 1000
  }), true);
  assert.equal(Object.prototype.polluted, undefined);
});

test('getImportFileSizeLimit derives bounded overhead from quota', () => {
  assert.equal(
    helpers.getImportFileSizeLimit(10 * 1024 * 1024, 1024 * 1024),
    164 * 1024 * 1024
  );
  assert.equal(
    helpers.getImportFileSizeLimit(20 * 1024 * 1024, 1024 * 1024),
    192 * 1024 * 1024
  );
  assert.equal(
    helpers.getImportFileSizeLimit(10 * 1024 * 1024, 256 * 1024 * 1024),
    192 * 1024 * 1024
  );
  assert.equal(helpers.getImportFileSizeLimit(Infinity, 2 * 1024 * 1024), 2 * 1024 * 1024);
});

test('getImportFileSizeLimit covers exports dominated by many small hosts', () => {
  const entries = [];
  const storedItems = Object.create(null);
  for (let index = 0; index < 150000; index += 1) {
    const host = `h${index.toString(36)}.x`;
    entries.push({ host, css: '', enabled: true });
    storedItems[host] = '';
  }

  const storageBytes = helpers.estimateStorageUsage(storedItems).totalBytes;
  const exportBytes = Buffer.byteLength(JSON.stringify(
    helpers.buildExportPayload(entries, meta),
    null,
    2
  ));
  assert.ok(exportBytes > storageBytes * 5);
  assert.ok(exportBytes < helpers.getImportFileSizeLimit(storageBytes));
});

test('getImportFailureMessage distinguishes successful and failed rollback', () => {
  assert.equal(
    helpers.getImportFailureMessage('Import failed.', false, false),
    'Import failed.'
  );
  assert.equal(
    helpers.getImportFailureMessage('Import failed.', true, true),
    'Import failed. Previous state was restored.'
  );
  assert.match(
    helpers.getImportFailureMessage('Import failed.', true, false),
    /rollback did not complete/
  );
});
