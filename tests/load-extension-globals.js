'use strict';

globalThis.window = globalThis;
require('../utils.js');
require('../constants.js');
require('../popup-storage-helpers.js');

module.exports = {
  utils: globalThis.CSSInjectorUtils,
  constants: globalThis.window.CSSInjectorConstants,
  helpers: globalThis.CSSInjectorPopupStorageHelpers
};
