(function () {
  'use strict';

  window.CSSInjectorConstants = {
    DEBOUNCE: {
      NAVIGATION_DELAY: 100
    },

    STORAGE: {
      CACHE_EXPIRY_MS: 120000,
      TIMEOUT_MS: 5000
    },

    UI: {
      EDITOR_HEIGHT: '240px',
      LINE_NUMBERS_WIDTH: '28px',
      ICON_SIZE_SMALL: '18px',
      ICON_SIZE_NORMAL: '20px'
    },

    SAVE: {
      LIVE_APPLY_DELAY_MS: 200,
      PERSIST_DELAY_MS: 350,
      MAX_IMPORT_FILE_BYTES: 1048576
    },

    COLORS: {
      PRIMARY: '#5383ec',
      PRIMARY_HOVER: '#4a72d3',
      SUCCESS: '#27ae60',
      ERROR: '#e74c3c'
    },

    SELECTORS: {
      CSS_INJECTOR_STYLE: 'style[data-css-injector="{hostname}"]'
    }
  };
})();
