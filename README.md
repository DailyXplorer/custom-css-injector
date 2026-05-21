# Custom CSS Injector

Chrome extension (Manifest V3) to inject custom CSS per domain — including iframes and Shadow DOM where supported.

**Version:** 2.1.2

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
- SPA navigation and Shadow DOM support (v2.1+)

## Repository

https://github.com/DailyXplorer/custom-css-injector

## Contact

Contact me on X: https://x.com/DailyXplorer

## License

[PolyForm Noncommercial License 1.0.0](LICENSE) — you may copy, modify, and redistribute this software for **noncommercial** purposes. **Commercial use is not allowed** (selling the code, paid redistribution, or using it as part of a commercial product or service without permission from the author).
