# Paywall Remover

A Chrome extension that opens the current page (or a link) in archive mirrors with one click.

## Features

- Toolbar action with OA-first resolution and archive fallback.
- Context menu actions for archiving or searching links/pages.
- Toolbar icon context action to open a Wayback snapshot picker anchored to the extension icon.
- Configurable tab placement and tab activation behavior.
- Resolver pipeline with mirror-aware route planning.
- Open-access provider chain (Unpaywall, OpenAlex, Europe PMC, Crossref, CORE).
- Optional preloaded fallback tab for archive actions.
- Instant tab feedback (`about:blank` placeholder while target resolves).
- Automatic text-only reader view on archive snapshot pages.
- Settings UI includes `Refresh Extension` action.
- Shared `chrome.storage.sync` settings.
- Reusable archive URL core for integration into other extensions.

## Installation

1. Clone or download this repository.
2. Open `chrome://extensions/`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this project folder.

## Usage

- Click the toolbar icon to resolve the best target:
  - Open-access target first (when found within wait budget), otherwise archive route.
- Right-click page:
  - `Search archive for this page`
- Right-click link:
  - `Archive -> Archive link`
  - `Archive -> Search link`
- Right-click extension icon:
  - `Wayback Machine versions` (opens icon-anchored version picker + calendar shortcut)

## OA Setup

To enable best open-access results:

1. Open extension options.
2. Enable `Open-Access Providers` and keep provider toggles on.
3. Set `Unpaywall email` (required for Unpaywall API calls).
4. Optionally set `Contact email` for provider polite-use parameters.
5. Optionally set `CORE API key` for CORE API lookups.
6. Tune `Resolver wait budget (ms)` (recommended: `700-2000`).

## Settings

Open extension options from the action menu (`Open settings`) or from `chrome://extensions/` to configure:

- Tab behavior:
  - New tab adjacent
  - New tab at end
  - Active for archive, adjacent for search
- Activation toggles for each entry point (toolbar/page/link).
- Resolver behavior:
  - preferred archive mirror
  - preload archive search fallback
  - open-access wait budget
- Open-access providers:
  - enable/disable provider toggles
  - Unpaywall email
  - optional contact email
  - optional CORE API key
- Utilities:
  - save settings
  - refresh extension from options page

## Testing

Suggested links:

- DOI-backed paper: `https://doi.org/10.1038/s41586-020-2649-2`
- OA source page: `https://arxiv.org/abs/1706.03762`

Expected behavior:

- If OA target resolves within budget, it opens OA target.
- If OA does not resolve in time, archive route opens.
- If archive has no snapshot, archive search page may show no results.
- If archive snapshot loads successfully, extension auto-switches to a text-only reader layout.

## Known Limits

- OA providers do not cover every article.
- Archive mirrors do not contain every page.
- Verification/CAPTCHA on archive mirrors is controlled by those sites and cannot be bypassed by this extension.

## Architecture

- Manifest V3 service worker (`service_worker.js`) now runs as an ES module.
- Shared modules:
  - `src/archive_client.js` for archive URL building/normalization.
  - `src/access_resolver.js` for route planning across mirrors.
  - `src/open_access_resolver.js` for OA target discovery and provider scoring.
  - `src/settings_model.js` for tab option enums and storage defaults.
- Options page script (`options.js`) is an ES module and consumes shared settings.

## File Structure

```text
paywallRemover/
├── manifest.json
├── service_worker.js
├── options.html
├── options.js
├── wayback_picker.html
├── wayback_picker.js
├── src/
│   ├── archive_client.js
│   ├── access_resolver.js
│   ├── open_access_resolver.js
│   └── settings_model.js
└── images/
    └── icon.png
```

## Development Notes

- No build step required.
- Use Chrome or any Chromium browser supporting MV3.
- Keep `LICENSE` intact for redistribution.
- Required permissions include `activeTab`, `scripting`, and provider/archive `host_permissions` (see `manifest.json`).

## License

MIT License. See `LICENSE`.

## Version History

### v0.11.0 (Current)
- Added OA provider resolver chain with configurable timeout budget.
- Added provider settings (Unpaywall/OpenAlex/Europe PMC/Crossref/CORE).
- Added optional DOI extraction from active page metadata via scripting API.
- Added API host permissions for OA provider calls.
- Added instant placeholder tab flow for faster perceived click response.
- Added `Refresh Extension` button in settings UI.

### v0.10.0
- Added archive resolver planning with mirror ordering.
- Added preferred mirror setting.
- Added optional "preload search fallback" behavior.
- Added integration handoff doc (`AGENT_INTEGRATION_GUIDE.md`).

### v0.9.0
- Refactored archive logic into reusable modules.
- Converted service worker and options script to ES modules.
- Removed debug logging and simplified event flow.
- Updated architecture and documentation.

### v0.8.0
- Toolbar/archive actions open `archive.is/newest/...`.
- Canonical URL normalization for archive lookups.
