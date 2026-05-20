# Paywall Remover

A Chrome extension that opens the current page (or a link) in archive mirrors with one click.

## Features

- Toolbar action with OA-first resolution and archive fallback.
- Toolbar click opens resolved target in the current tab.
- Context menu actions for archiving or searching links/pages.
- Toolbar icon context action to open an in-page Wayback snapshot popup.
- Resolver pipeline with mirror-aware route planning.
- Open-access provider chain (Unpaywall, OpenAlex, Europe PMC, Crossref, CORE).
- Optional preloaded fallback tab for archive actions.
- Instant tab feedback (`about:blank` placeholder while target resolves).
- Automatic text-only reader view on archive snapshot pages.
- In-page paywall prompt that can open an accessible version in one click.
- Paywall detection ignores LinkPreview preview-window UI so duplicate prompts are avoided when both extensions are installed.
- Settings UI includes `Refresh Extension` action.
- Shared `chrome.storage.sync` settings.
- Reusable archive URL core for integration into other extensions.
- Automatic mirror health probing with 5-minute cache — unhealthy mirrors are skipped before navigation.
- Reactive nginx detection: if a mirror serves a default nginx page after load, the tab is automatically redirected to the next healthy mirror (up to 2 retries per tab).

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
  - `Wayback Machine versions` (opens in-page snapshot popup on the active tab)
- On pages with likely paywall signals:
  - in-page prompt appears with `Open Accessible Version`

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

- Tabs:
  - `General`
  - `Open Access`
- General:
  - preferred archive mirror
  - preload archive search fallback
  - auto-detect paywall prompt (on/off)
- Open Access resolver behavior:
  - open-access wait budget
  - enable/disable OA resolver
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
- If paywall signals are detected and `Auto-detect paywall prompt` is enabled, banner appears with `Open Accessible Version`.
- If `Auto-detect paywall prompt` is disabled, no paywall banner is shown.
- With LinkPreview installed, paywall signals inside LinkPreview preview UI do not trigger this extension's paywall banner.
- If the preferred mirror returns a default nginx page, the tab auto-redirects to the next healthy mirror without user action.

## Known Limits

- OA providers do not cover every article.
- Archive mirrors do not contain every page.
- Verification/CAPTCHA on archive mirrors is controlled by those sites and cannot be bypassed by this extension.

## Architecture

- Manifest V3 service worker (`service_worker.js`) now runs as an ES module.
- Content script (`paywall_prompt.js`) performs client-side paywall signal detection.
- Shared modules:
  - `src/archive_client.js` for archive URL building/normalization.
  - `src/access_resolver.js` for route planning across mirrors.
  - `src/open_access_resolver.js` for OA target discovery and provider scoring.
  - `src/settings_model.js` for shared storage defaults.
- Options page script (`options.js`) is an ES module and consumes shared settings.

## File Structure

```text
paywallRemover/
├── manifest.json
├── service_worker.js
├── options.html
├── options.js
├── paywall_prompt.js
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

### v0.13.0 (Current)

- Default mirror changed from `archive.is` to `archive.ph`.
- Added proactive mirror health probe: before navigating, the preferred mirror is fetched and checked for nginx default page indicators; result cached for 5 minutes.
- Health check runs in parallel with open-access resolution so it adds no extra latency on cached runs.
- Added reactive nginx detection: a `tabs.onUpdated` listener checks archive tabs after load and auto-redirects to the next healthy mirror if nginx is detected (up to 2 retries per tab).
- Exported `DEFAULT_ARCHIVE_MIRRORS` from `access_resolver.js` for use in health rotation.
- Added `buildNewestSnapshotUrl` and `buildSearchUrl` imports to service worker for mirror URL rebuilding.

### v0.12.0

- Simplified settings model by removing tab-placement and activation options.
- Toolbar click now resolves OA/archive target and opens it in the current tab.
- Moved resolver behavior and OA provider controls into the Open Access section.
- Kept existing dark paywall prompt and Wayback popup styling unchanged.

### v0.11.0

- Added OA provider resolver chain with configurable timeout budget.
- Added provider settings (Unpaywall/OpenAlex/Europe PMC/Crossref/CORE).
- Added optional DOI extraction from active page metadata via scripting API.
- Added API host permissions for OA provider calls.
- Added instant placeholder tab flow for faster perceived click response.
- Added `Refresh Extension` button in settings UI.
- Added Wayback snapshot picker action (`Wayback Machine versions`) as an in-page popup.
- Added archive snapshot auto-reader mode (text-only view).
- Added paywall signal detection prompt with one-click accessible open action.
- Added settings toggle for paywall prompt auto-detection.

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
