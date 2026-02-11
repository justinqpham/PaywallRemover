# Agent Integration Guide

This document is the technical handoff for integrating this extension's archive actions into another Chromium extension (for example, a preview-window header action).

## 1) Current Project Snapshot

- Extension name: `Paywall Remover`
- Manifest: MV3
- Background runtime: ES module service worker
- Entry files:
  - `manifest.json`
  - `service_worker.js`
  - `options.html`
  - `options.js`
  - `wayback_picker.html`
  - `wayback_picker.js`
- Shared core modules:
  - `src/archive_client.js`
  - `src/access_resolver.js`
  - `src/open_access_resolver.js`
  - `src/settings_model.js`

## 2) Runtime Architecture

- UI events trigger from:
  - Toolbar click (`chrome.action.onClicked`)
  - Context menus (`chrome.contextMenus.onClicked`)
- Action context menu includes a Wayback snapshot picker entry (`contexts: ['action']`).
- Wayback picker attempts `chrome.action.openPopup()` first (icon-anchored) and falls back to a positioned popup window.
- Action context menu includes `Open settings`, which opens `options.html` in a new tab.
- Event handlers load persisted settings from `chrome.storage.sync`.
- URL targets are converted into archive URLs through shared core modules.
- Navigation is executed through `chrome.tabs.create` or `chrome.tabs.update`.
- For non-active-tab flows, a placeholder tab opens immediately and is then updated to the resolved target.

## 3) Storage Contract (`chrome.storage.sync`)

Defined defaults are centralized in `src/settings_model.js` via `DEFAULT_SETTINGS`.

Current keys:

- `tabOption` (`number`)
  - `0` adjacent tab
  - `1` tab at end
  - `2` replace current tab for archive actions
- `activateButtonNew` (`boolean`)
- `activatePageNew` (`boolean`)
- `activateArchiveNew` (`boolean`)
- `activateSearchNew` (`boolean`)
- `preferredMirror` (`string`) default `https://archive.is`
- `preloadSearchFallback` (`boolean`) default `false`
- `openAccessEnabled` (`boolean`) default `true`
- `openAccessWaitMs` (`number`) default `900`
- `unpaywallEnabled` (`boolean`) default `true`
- `openAlexEnabled` (`boolean`) default `true`
- `europePmcEnabled` (`boolean`) default `true`
- `crossrefEnabled` (`boolean`) default `true`
- `coreEnabled` (`boolean`) default `true`
- `unpaywallEmail` (`string`) default `''`
- `contactEmail` (`string`) default `''`
- `coreApiKey` (`string`) default `''`

Important: other agents should read defaults from `DEFAULT_SETTINGS` rather than hardcoding fallback values.

## 4) Shared Module APIs

### `src/archive_client.js`

- `normalizeArchiveUri(uri: string): string`
  - Removes query string and hash when possible.
- `buildNewestSnapshotUrl(uri: string, mirrorBase?: string): string`
- `buildSearchUrl(uri: string, mirrorBase?: string): string`
- `createArchiveClient(options?): { ... }`
  - Returns bound builders for a mirror base.

### `src/settings_model.js`

- `TAB_OPTION` enum object
- `MIRROR_BASE` mirror constants
- `DEFAULT_SETTINGS` immutable defaults object

### `src/access_resolver.js`

- `DEFAULT_ARCHIVE_MIRRORS` ordered fallback mirror list
- `buildArchiveRoutePlan(uri, options): Array<{ kind, mirror, url }>`
  - plan order:
    - newest on preferred mirror
    - search on preferred mirror
    - newest on remaining mirrors
    - search on remaining mirrors
- `buildPrimarySearchRoute(uri, options): { kind, mirror, url } | null`

### `src/open_access_resolver.js`

- `resolveOpenAccessTarget(context, settings): Promise<{ provider, url, type, doi } | null>`
- DOI extraction support from URL/title/context DOI.
- Provider candidates are scored and deduplicated before selection.

## 5) Service Worker Responsibilities (`service_worker.js`)

- Validates URLs (`http/https`) before opening archive actions.
- Creates/refreshes context menu tree on install.
- Applies tab placement logic based on `tabOption`.
- Uses activation flags based on action source.
- Uses resolver plan for archive actions and optional preloaded fallback.
- Uses OA resolver with short wait budget before archive fallback.
- Applies automatic reader-mode transform on archive snapshot tabs (text-only render).

Menu IDs currently:

- `page_search_archive`
- `link_archive_root`
- `link_archive_open`
- `link_archive_search`
- `action_wayback_versions`
- `action_open_settings`

If another extension depends on menu IDs, keep these constants stable.

## 6) Options UI Integration Notes

- `options.html` is visual only; behavior hooks rely on element IDs.
- `options.js` imports shared defaults and maps form fields <-> storage.
- Existing required control IDs:
  - `tabAdj`, `tabEnd`, `tabAct`
  - `cbButtonNew`, `cbPageNew`, `cbArchiveNew`, `cbSearchNew`
  - `selPreferredMirror`, `cbPreloadFallback`
  - `cbOpenAccessEnabled`, `inOpenAccessWaitMs`
  - `cbUnpaywallEnabled`, `cbOpenAlexEnabled`, `cbEuropePmcEnabled`, `cbCrossrefEnabled`, `cbCoreEnabled`
  - `inUnpaywallEmail`, `inContactEmail`, `inCoreApiKey`
  - `bSave`, `bReloadExtension`, `status`

If controls are moved/re-skinned, preserve IDs or update `options.js`.

## 7) Manifest Requirements for Reuse

Minimum required permissions for this feature set:

- `tabs`
- `contextMenus`
- `scripting`
- `activeTab`
- `storage`

Background must remain module-enabled:

- `"background": { "service_worker": "service_worker.js", "type": "module" }`
- This project currently has no `options_ui` manifest entry; settings are opened directly via `chrome.runtime.getURL('options.html')`.
- `host_permissions` for provider APIs:
  - `https://web.archive.org/*`
  - `https://archive.is/*`
  - `https://archive.ph/*`
  - `https://archive.today/*`
  - `https://api.unpaywall.org/*`
  - `https://api.openalex.org/*`
  - `https://api.crossref.org/*`
  - `https://www.ebi.ac.uk/*`
  - `https://api.core.ac.uk/*`

## 8) Embedding Into Another Extension (Preview Header Action)

Recommended approach:

1. Copy reusable modules (`src/archive_client.js`, `src/settings_model.js`) into shared library path in the target extension.
   - Include `src/access_resolver.js` if route planning/fallback behavior is needed.
   - Include `src/open_access_resolver.js` for OA-first target selection.
2. In target background module, import:
   - URL builder(s) from `archive_client.js` or resolver helpers from `access_resolver.js`
   - OA resolution helper from `open_access_resolver.js` (optional)
   - `DEFAULT_SETTINGS` from `settings_model.js`
3. On preview-header button click:
   - resolve source URL from preview state
   - fetch settings from `chrome.storage.sync.get(DEFAULT_SETTINGS)`
   - build route plan (or single route) and open with same tab placement policy
4. Keep one source of truth for storage keys to avoid drift.

Pseudo-flow:

```js
const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
const oa = await resolveOpenAccessTarget({ url: sourceUrl, title }, settings);
const target = oa?.url || buildArchiveRoutePlan(sourceUrl, {
  preferredMirror: settings.preferredMirror
})[0]?.url;
// open using same tab strategy as this project
```

## 9) Regression Checklist

- Toolbar click opens archive route.
- Toolbar click should open a tab immediately (placeholder), then navigate to final target.
- Archive snapshot should auto-convert to reader mode (text-only) when content extraction succeeds.
- Page context search works.
- Link archive/search both work.
- Action menu `Wayback Machine versions` opens picker (popup or fallback window).
- Action menu `Open settings` opens `options.html`.
- Options save + reload persists all toggles/radio state.
- `Refresh Extension` button reloads extension runtime.
- No console errors in service worker.

## 10) Files Safe To Rebrand vs Keep

Safe to rebrand:

- `name`, `description`, UI copy, menu titles, docs.

Must keep for compliance:

- `LICENSE` contents and attribution terms.
- Include license notice in redistributions (`NOTICE.md` is provided).
