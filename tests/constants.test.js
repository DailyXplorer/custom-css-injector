'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { constants } = require('./load-extension-globals.js');

test('STYLE.DATA_ATTRIBUTE is the css-injector attribute', () => {
  assert.equal(constants.STYLE.DATA_ATTRIBUTE, 'data-css-injector');
});

test('legacy SELECTORS template is gone', () => {
  assert.equal(constants.SELECTORS, undefined);
});
