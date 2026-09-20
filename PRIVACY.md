# Privacy Policy

Last updated: 20 September 2026

Custom CSS Injector does not collect, transmit, sell, or share personal data. It has no account system, analytics, advertising, tracking SDK, or remote backend.

## Data stored by the extension

The extension stores only:

- CSS entered by the user, keyed by website hostname;
- whether that CSS is enabled for the hostname;
- one internal migration marker.

This data is stored in `chrome.storage.local` on the user's browser profile. A one-time upgrade from older versions can read legacy `chrome.storage.sync` entries, copy missing site styles to local storage, and remove the migrated sync entries.

## Website access

The extension runs on HTTP and HTTPS pages so it can apply the CSS explicitly saved for the top-level hostname. This includes eligible embedded frames and author-created Shadow DOM. It does not read page content for analytics or send browsing history anywhere.

Pages can detect the extension's Shadow DOM bridge, its DOM events, and the styles it applies. The Shadow DOM attachment notification contains no saved CSS or hostname. This extension does not hide its presence from websites.

The permissions are used as follows:

- `storage`: save local CSS and enabled state;
- `activeTab`: identify and update the page selected by the user while the popup is open;
- `scripting`: restore unavailable content scripts from the popup and reconnect existing tabs after an extension update;
- HTTP and HTTPS host permissions: reconnect tabs with saved CSS after an extension update, including eligible embedded frames. This uses the same website scope as the declared content scripts.

The extension intentionally does not request the `tabs` permission.

## User-authored remote resources

CSS can contain `url()` or `@import` references to remote fonts, images, or stylesheets. If the user adds such CSS, the styled page may contact those third-party URLs under the page's own browser and security rules. The extension neither adds those references nor controls the third party's privacy practices.

## Configuration files

Export creates a JSON file locally through the browser. Import reads only the file selected by the user. Neither operation uploads configuration data.

## Contact

Questions can be submitted through the [GitHub repository](https://github.com/DailyXplorer/custom-css-injector) or [X](https://x.com/DailyXplorer).
