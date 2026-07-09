'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const popupMainSource = fs.readFileSync(
  path.join(__dirname, '..', 'popup-main.js'),
  'utf8'
);

function createGutterState(lineCount, maxRenderedLines) {
  const context = {
    document: {
      addEventListener() {}
    }
  };
  vm.createContext(context);
  vm.runInContext(
    `${popupMainSource}\n;globalThis.__gutterState = createLineNumberGutterState(${JSON.stringify(lineCount)}, ${JSON.stringify(maxRenderedLines)});`,
    context
  );
  return context.__gutterState;
}

test('line-number gutter renders ordinary documents', () => {
  const state = createGutterState(4, 20000);
  assert.equal(state.text, '1\n2\n3\n4');
  assert.equal(state.suppressed, false);
});

test('line-number gutter suppresses rendering above its allocation cap', () => {
  const state = createGutterState(10000000, 20000);
  assert.equal(state.text, '');
  assert.equal(state.suppressed, true);
});

test('line-number gutter keeps the configured boundary visible', () => {
  const state = createGutterState(3, 3);
  assert.equal(state.text, '1\n2\n3');
  assert.equal(state.suppressed, false);
});
