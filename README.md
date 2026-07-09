# Custom CSS Injector

Chrome extension (Manifest V3) to inject custom CSS per domain — including iframes and Shadow DOM where supported.

**Version:** 2.2.0

## Compatibility

- Chrome 111 or newer is required.
- Custom CSS is stored per exact hostname, so `example.com` and `www.example.com` can have separate styles.

## Install (Chrome Web Store)

[Install Custom CSS Injector on the Chrome Web Store](https://chromewebstore.google.com/detail/jafljompklilfgjfcdcmmkgdamolfpbi)

## Install (development)

1. Clone this repository
2. Open `chrome://extensions` (or your Chromium browser’s extensions page)
3. Enable **Developer mode**
4. **Load unpacked** → select this folder (must contain `manifest.json`)

## Features

- Per-host CSS editor with enable/disable toggle
- Live apply while editing
- Import / export JSON configuration
- SPA navigation and same/cross-origin iframe support
- Open, closed, imperative, declarative, and nested author Shadow DOM support
- One shared, self-repairing stylesheet per frame instead of one DOM node per component
- Local-only configuration storage with no account or remote service

## Styling deeply nested components

The same CSS is adopted by the document, matching frames, and every author-created Shadow Root. CSS scoping still applies: a selector such as `body` cannot match elements inside a Shadow Root, and pseudo-elements such as placeholders must be selected explicitly.

For a broad typography override, adapt this pattern:

```css
:root,
body,
body *,
:host,
:host *,
button,
input,
select,
textarea,
input::placeholder,
textarea::placeholder {
  font-family: "Your Font", sans-serif !important;
}
```

Browser-internal (user-agent) Shadow DOM is intentionally inaccessible. The extension does not rewrite selectors or add `!important` automatically because either can change the meaning of user CSS.

Normal CSS is parsed once per frame and does not add children to the page or its components. Because the browser excludes `@import` from constructable stylesheets, CSS containing `@import` also uses small compatibility `<style>` carriers. Imported rules therefore remain subject to the page's own CSP and, at equal specificity, a site stylesheet adopted later can outrank them; add specificity or `!important` when that matters.

## Privacy

CSS and hostnames stay in `chrome.storage.local`. See [PRIVACY.md](PRIVACY.md) for the complete policy. Custom CSS can itself reference remote fonts, images, or stylesheets; those requests are made by the styled page at the user's direction.

## Development checks

```sh
npm ci
npm test
npm run test:e2e
bash scripts/release.sh check
```

## Repository

https://github.com/DailyXplorer/custom-css-injector

## Contact

Contact me on X: https://x.com/DailyXplorer

## License

[PolyForm Noncommercial License 1.0.0](LICENSE) — you may copy, modify, and redistribute this software for **noncommercial** purposes. **Commercial use is not allowed** (selling the code, paid redistribution, or using it as part of a commercial product or service without permission from the author).
