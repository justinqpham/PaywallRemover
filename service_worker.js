import { buildArchiveRoutePlan, buildPrimarySearchRoute } from './src/access_resolver.js';
import { resolveOpenAccessTarget } from './src/open_access_resolver.js';
import { DEFAULT_SETTINGS, TAB_OPTION } from './src/settings_model.js';
import { buildWaybackCalendarUrl } from './src/archive_client.js';

const MENU_ID = Object.freeze({
    PAGE_SEARCH: 'page_search_archive',
    LINK_ROOT: 'link_archive_root',
    LINK_ARCHIVE: 'link_archive_open',
    LINK_SEARCH: 'link_archive_search',
    ACTION_WAYBACK: 'action_wayback_versions',
    ACTION_SETTINGS: 'action_open_settings'
});

const MESSAGE_TYPE = Object.freeze({
    OPEN_FROM_PAYWALL_PROMPT: 'open_from_paywall_prompt',
    SHOW_WAYBACK_OVERLAY: 'show_wayback_overlay',
    FETCH_WAYBACK_SNAPSHOTS: 'fetch_wayback_snapshots'
});
const ARCHIVE_READER_HOSTS = Object.freeze(new Set([
    'archive.is',
    'archive.ph',
    'archive.today'
]));

function isSupportedUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function isArchiveSnapshotUrl(url) {
    if (!isSupportedUrl(url)) {
        return false;
    }

    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        if (!ARCHIVE_READER_HOSTS.has(host)) {
            return false;
        }

        const pathname = parsed.pathname.toLowerCase();
        if (!pathname || pathname === '/' || pathname.startsWith('/newest/') || pathname.startsWith('/search/')) {
            return false;
        }

        return true;
    } catch (error) {
        return false;
    }
}

function runSafely(task) {
    task().catch((error) => {
        console.error('Paywall Remover action failed:', error);
    });
}

async function getSettings() {
    return chrome.storage.sync.get(DEFAULT_SETTINGS);
}

async function extractDoiFromActiveTab(tabId) {
    if (typeof tabId !== 'number' || !chrome.scripting?.executeScript) {
        return null;
    }

    try {
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                const doiPattern = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;
                const clean = (value) => {
                    if (!value) {
                        return null;
                    }
                    const match = String(value).match(doiPattern);
                    if (!match) {
                        return null;
                    }
                    return match[0].replace(/[)\].,;]+$/, '');
                };

                const metaNames = [
                    'citation_doi',
                    'dc.identifier',
                    'dc.identifier.doi',
                    'prism.doi',
                    'doi'
                ];

                for (const name of metaNames) {
                    const meta = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
                    const doi = clean(meta?.content);
                    if (doi) {
                        return doi;
                    }
                }

                const canonicalHref = document.querySelector('link[rel="canonical"]')?.href || '';
                const canonicalDoi = clean(canonicalHref);
                if (canonicalDoi) {
                    return canonicalDoi;
                }

                return null;
            }
        });

        return typeof result === 'string' ? result : null;
    } catch (error) {
        return null;
    }
}

function clampResolverWait(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return 900;
    }
    return Math.min(3000, Math.max(0, parsed));
}

async function resolveOpenAccessQuickly(context, settings) {
    if (!settings.openAccessEnabled) {
        return null;
    }

    const waitMs = clampResolverWait(settings.openAccessWaitMs);
    const resolverPromise = resolveOpenAccessTarget(context, settings);
    const timeoutPromise = new Promise((resolve) => {
        setTimeout(() => resolve(null), waitMs);
    });

    return Promise.race([resolverPromise, timeoutPromise]);
}

async function createPlaceholderTab(shouldActivate, placeAtEnd) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const createOptions = { url: 'about:blank', active: shouldActivate };

    if (typeof activeTab?.id === 'number') {
        createOptions.openerTabId = activeTab.id;
    }

    if (placeAtEnd) {
        createOptions.index = 999;
    } else if (typeof activeTab?.index === 'number') {
        createOptions.index = activeTab.index + 1;
    }

    return chrome.tabs.create(createOptions);
}

async function getActiveTab() {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return activeTab || null;
}

function formatWaybackTimestamp(timestamp) {
    const value = String(timestamp || '');
    if (!/^\d{14}$/.test(value)) {
        return value;
    }

    const yyyy = value.slice(0, 4);
    const mm = value.slice(4, 6);
    const dd = value.slice(6, 8);
    const hh = value.slice(8, 10);
    const min = value.slice(10, 12);
    const ss = value.slice(12, 14);
    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss} UTC`;
}

async function showWaybackOverlayOnTab(tab, sourceUrl) {
    const tabId = tab?.id;
    if (typeof tabId !== 'number' || !isSupportedUrl(sourceUrl)) {
        return false;
    }

    const payload = {
        type: MESSAGE_TYPE.SHOW_WAYBACK_OVERLAY,
        url: sourceUrl,
        title: String(tab?.title || '')
    };

    try {
        await chrome.tabs.sendMessage(tabId, payload);
        return true;
    } catch (error) {
        // Existing tabs may not have the content script loaded yet (e.g. extension reloaded).
    }

    if (!chrome.scripting?.executeScript) {
        return false;
    }

    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            files: ['paywall_prompt.js']
        });
        await chrome.tabs.sendMessage(tabId, payload);
        return true;
    } catch (error) {
        return false;
    }
}

function normalizeWaybackSnapshots(payload, originalUrl) {
    if (!Array.isArray(payload) || payload.length < 2) {
        return [];
    }

    const rows = payload.slice(1);
    const snapshots = [];
    const seenTimestamps = new Set();

    for (const row of rows) {
        if (!Array.isArray(row) || row.length < 1) {
            continue;
        }

        const timestamp = String(row[0] || '');
        if (!/^\d{14}$/.test(timestamp) || seenTimestamps.has(timestamp)) {
            continue;
        }
        seenTimestamps.add(timestamp);

        const original = String(row[1] || originalUrl);
        const status = String(row[2] || '');
        const url = `https://web.archive.org/web/${timestamp}/${original}`;
        snapshots.push({
            timestamp,
            status,
            label: `${formatWaybackTimestamp(timestamp)}${status ? ` (${status})` : ''}`,
            url
        });

        if (snapshots.length >= 140) {
            break;
        }
    }

    return snapshots;
}

async function fetchWaybackSnapshots(originalUrl) {
    const endpoint = new URL('https://web.archive.org/cdx/search/cdx');
    endpoint.searchParams.set('url', originalUrl);
    endpoint.searchParams.set('output', 'json');
    endpoint.searchParams.set('fl', 'timestamp,original,statuscode');
    endpoint.searchParams.set('filter', 'statuscode:200');
    endpoint.searchParams.set('collapse', 'timestamp:10');
    endpoint.searchParams.set('limit', '200');
    endpoint.searchParams.set('sort', 'reverse');

    const response = await fetch(endpoint.toString(), { cache: 'no-store' });
    if (!response.ok) {
        throw new Error(`Wayback request failed (${response.status})`);
    }

    const payload = await response.json();
    const snapshots = normalizeWaybackSnapshots(payload, originalUrl);
    return {
        snapshots,
        calendarUrl: buildWaybackCalendarUrl(originalUrl)
    };
}

async function handleFetchWaybackSnapshots(message) {
    const sourceUrl = String(message?.url || '');
    if (!isSupportedUrl(sourceUrl)) {
        return { ok: false, error: 'unsupported_url', snapshots: [] };
    }

    try {
        const result = await fetchWaybackSnapshots(sourceUrl);
        return { ok: true, ...result };
    } catch (error) {
        return { ok: false, error: 'wayback_fetch_failed', snapshots: [], calendarUrl: buildWaybackCalendarUrl(sourceUrl) };
    }
}

async function handleOpenFromPaywallPrompt(message, sender) {
    const sourceUrl = String(message?.url || '');
    if (!isSupportedUrl(sourceUrl)) {
        return { ok: false, error: 'unsupported_url' };
    }

    const settings = await getSettings();
    await openArchivePage(sourceUrl, settings.activateButtonNew, settings.tabOption, settings, {
        source: 'page',
        title: String(message?.title || ''),
        tabId: sender?.tab?.id
    });

    return { ok: true };
}

function onRuntimeMessage(message, sender, sendResponse) {
    switch (message?.type) {
        case MESSAGE_TYPE.OPEN_FROM_PAYWALL_PROMPT:
            (async () => {
                try {
                    const result = await handleOpenFromPaywallPrompt(message, sender);
                    sendResponse(result);
                } catch (error) {
                    console.error('Paywall prompt open failed:', error);
                    sendResponse({ ok: false, error: 'open_failed' });
                }
            })();
            return true;
        case MESSAGE_TYPE.FETCH_WAYBACK_SNAPSHOTS:
            (async () => {
                try {
                    const result = await handleFetchWaybackSnapshots(message);
                    sendResponse(result);
                } catch (error) {
                    sendResponse({ ok: false, error: 'wayback_fetch_failed', snapshots: [] });
                }
            })();
            return true;
        default:
            return;
    }
}

async function createTabNearCurrent(url, shouldActivate, placeAtEnd) {
    const createdTab = await createPlaceholderTab(shouldActivate, placeAtEnd);
    if (typeof createdTab?.id === 'number') {
        await chrome.tabs.update(createdTab.id, { url });
        return createdTab;
    }

    // Fallback in case Chrome does not return a tab id
    return chrome.tabs.create({ url, active: shouldActivate });
}

async function extractArchiveReaderCandidate(tabId) {
    if (typeof tabId !== 'number' || !chrome.scripting?.executeScript) {
        return null;
    }

    try {
        const entries = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: () => {
                const cleanupSelector = [
                    'script',
                    'style',
                    'noscript',
                    'nav',
                    'header',
                    'footer',
                    'aside',
                    'form',
                    'button',
                    'iframe',
                    'svg',
                    'canvas',
                    'video',
                    'audio'
                ].join(',');

                const normalize = (text) => String(text || '').replace(/\s+/g, ' ').trim();
                const chooseRoots = () => {
                    const roots = [];
                    const push = (node) => {
                        if (!node || roots.includes(node)) {
                            return;
                        }
                        roots.push(node);
                    };

                    push(document.querySelector('article'));
                    push(document.querySelector('main'));
                    push(document.querySelector('[role="main"]'));
                    push(document.body);
                    return roots;
                };

                const collectSegments = (root) => {
                    if (!root) {
                        return [];
                    }

                    const clone = root.cloneNode(true);
                    clone.querySelectorAll(cleanupSelector).forEach((node) => node.remove());

                    const raw = [];
                    clone.querySelectorAll('p, li, blockquote').forEach((node) => {
                        const text = normalize(node.innerText);
                        if (text.length >= 70) {
                            raw.push(text);
                        }
                    });

                    if (raw.length < 3) {
                        const fallback = String(clone.innerText || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
                        fallback.split(/\n{2,}/).forEach((chunk) => {
                            const text = normalize(chunk);
                            if (text.length >= 90) {
                                raw.push(text);
                            }
                        });
                    }

                    const seen = new Set();
                    const deduped = [];
                    let chars = 0;

                    for (const segment of raw) {
                        const key = segment.toLowerCase();
                        if (seen.has(key)) {
                            continue;
                        }
                        seen.add(key);
                        deduped.push(segment);
                        chars += segment.length;
                        if (deduped.length >= 180 || chars >= 70000) {
                            break;
                        }
                    }

                    return deduped;
                };

                let bestSegments = [];
                for (const root of chooseRoots()) {
                    const segments = collectSegments(root);
                    if (segments.join('\n\n').length > bestSegments.join('\n\n').length) {
                        bestSegments = segments;
                    }
                }

                const text = bestSegments.join('\n\n');
                const title = String(document.querySelector('meta[property="og:title"]')?.content || document.title || '').trim();

                return {
                    title,
                    sourceUrl: location.href,
                    text,
                    textLength: text.length
                };
            }
        });

        let best = null;
        for (const entry of entries) {
            const candidate = entry?.result;
            if (!candidate || typeof candidate.text !== 'string') {
                continue;
            }
            if (!best || candidate.textLength > best.textLength) {
                best = candidate;
            }
        }

        return best;
    } catch (error) {
        return null;
    }
}

async function renderArchiveReaderCandidate(tabId, candidate) {
    if (typeof tabId !== 'number' || !candidate?.text) {
        return false;
    }

    try {
        const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId },
            args: [candidate],
            func: (payload) => {
                if (!payload || typeof payload.text !== 'string' || payload.text.length < 600) {
                    return false;
                }

                const titleText = String(payload.title || document.title || 'Reader View').trim();
                const sourceText = String(payload.sourceUrl || location.href || '').trim();
                const blocks = payload.text.split(/\n{2,}/).map((line) => line.trim()).filter(Boolean).slice(0, 220);
                if (blocks.length === 0) {
                    return false;
                }

                document.title = `${titleText} - Reader`;
                document.documentElement.innerHTML = '';

                const head = document.createElement('head');
                const metaCharset = document.createElement('meta');
                metaCharset.setAttribute('charset', 'utf-8');
                const metaViewport = document.createElement('meta');
                metaViewport.setAttribute('name', 'viewport');
                metaViewport.setAttribute('content', 'width=device-width, initial-scale=1');
                const title = document.createElement('title');
                title.textContent = `${titleText} - Reader`;
                const style = document.createElement('style');
                style.textContent = `
                    :root { color-scheme: light; }
                    html, body { margin: 0; background: #f5f5f3; color: #111827; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
                    body { padding: clamp(20px, 4vw, 44px) clamp(16px, 4vw, 24px); }
                    main { max-width: 760px; margin: 0 auto; background: #fff; border: 1px solid #e5e7eb; border-radius: 18px; padding: clamp(18px, 4vw, 30px); box-shadow: 0 12px 30px rgba(0,0,0,0.08); }
                    h1 { margin: 0; font-size: clamp(1.45rem, 2.4vw, 2rem); line-height: 1.2; }
                    .meta { margin-top: 10px; color: #6b7280; font-size: 0.82rem; overflow-wrap: anywhere; }
                    article { margin-top: 20px; font-size: clamp(1.02rem, 1.7vw, 1.12rem); line-height: 1.72; }
                    p { margin: 0 0 1.05em; }
                    p:last-child { margin-bottom: 0; }
                `;
                head.append(metaCharset, metaViewport, title, style);

                const body = document.createElement('body');
                const main = document.createElement('main');
                const heading = document.createElement('h1');
                heading.textContent = titleText || 'Reader View';
                main.appendChild(heading);

                if (sourceText) {
                    const meta = document.createElement('p');
                    meta.className = 'meta';
                    meta.textContent = sourceText;
                    main.appendChild(meta);
                }

                const article = document.createElement('article');
                blocks.forEach((block) => {
                    const p = document.createElement('p');
                    p.textContent = block;
                    article.appendChild(p);
                });
                main.appendChild(article);
                body.appendChild(main);

                document.documentElement.append(head, body);
                return true;
            }
        });

        return Boolean(result);
    } catch (error) {
        return false;
    }
}

async function tryApplyArchiveReaderMode(tabId, tabUrl) {
    if (!isArchiveSnapshotUrl(tabUrl)) {
        return false;
    }

    const candidate = await extractArchiveReaderCandidate(tabId);
    if (!candidate || Number(candidate.textLength) < 600) {
        return false;
    }

    return renderArchiveReaderCandidate(tabId, candidate);
}

function scheduleArchiveReaderMode(tabId) {
    if (typeof tabId !== 'number') {
        return;
    }

    const timeout = setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
    }, 30000);

    const onUpdated = (updatedTabId, changeInfo, tab) => {
        if (updatedTabId !== tabId || changeInfo.status !== 'complete') {
            return;
        }

        runSafely(async () => {
            const applied = await tryApplyArchiveReaderMode(tabId, tab?.url);
            if (!applied) {
                return;
            }

            clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(onUpdated);
        });
    };

    chrome.tabs.onUpdated.addListener(onUpdated);

    runSafely(async () => {
        const currentTab = await chrome.tabs.get(tabId);
        if (currentTab?.status !== 'complete') {
            return;
        }

        const applied = await tryApplyArchiveReaderMode(tabId, currentTab.url);
        if (!applied) {
            return;
        }

        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
    });
}

async function openArchivePage(url, shouldActivate, tabOption, settings, context = {}) {
    if (!isSupportedUrl(url)) {
        return;
    }

    const routes = buildArchiveRoutePlan(url, {
        preferredMirror: settings.preferredMirror
    });
    const primaryRoute = routes[0];
    if (!primaryRoute) {
        return;
    }

    const pageDoi = context.source === 'page' ? await extractDoiFromActiveTab(context.tabId) : null;
    const openAccessTarget = await resolveOpenAccessQuickly({
        url,
        title: context.title || '',
        doi: pageDoi
    }, settings);

    const finalUrl = openAccessTarget?.url || primaryRoute.url;

    let archiveTabId = null;

    if (tabOption === TAB_OPTION.ACTIVE_ARCHIVE) {
        const updatedTab = await chrome.tabs.update({ url: finalUrl });
        archiveTabId = typeof updatedTab?.id === 'number' ? updatedTab.id : context.tabId;
    } else {
        const slotTab = await createPlaceholderTab(shouldActivate, tabOption === TAB_OPTION.END);
        if (typeof slotTab?.id === 'number') {
            await chrome.tabs.update(slotTab.id, { url: finalUrl });
            archiveTabId = slotTab.id;
        } else {
            const fallbackTab = await createTabNearCurrent(finalUrl, shouldActivate, tabOption === TAB_OPTION.END);
            archiveTabId = fallbackTab?.id;
        }
    }

    if (!openAccessTarget && typeof archiveTabId === 'number') {
        scheduleArchiveReaderMode(archiveTabId);
    }

    if (!openAccessTarget && settings.preloadSearchFallback && routes.length > 1) {
        await createTabNearCurrent(routes[1].url, false, tabOption === TAB_OPTION.END);
    }
}

async function openSearchPage(url, shouldActivate, tabOption, settings) {
    if (!isSupportedUrl(url)) {
        return;
    }

    const route = buildPrimarySearchRoute(url, {
        preferredMirror: settings.preferredMirror
    });
    if (!route) {
        return;
    }

    await createTabNearCurrent(route.url, shouldActivate, tabOption === TAB_OPTION.END);
}

function createContextMenus() {
    chrome.contextMenus.create({
        id: MENU_ID.PAGE_SEARCH,
        title: 'Search archive for this page',
        contexts: ['page'],
        documentUrlPatterns: ['https://*/*', 'http://*/*']
    });

    chrome.contextMenus.create({
        id: MENU_ID.LINK_ROOT,
        title: 'Archive',
        contexts: ['link']
    }, () => {
        chrome.contextMenus.create({
            id: MENU_ID.LINK_ARCHIVE,
            parentId: MENU_ID.LINK_ROOT,
            title: 'Archive link',
            contexts: ['link']
        });

        chrome.contextMenus.create({
            id: MENU_ID.LINK_SEARCH,
            parentId: MENU_ID.LINK_ROOT,
            title: 'Search link',
            contexts: ['link']
        });
    });

    chrome.contextMenus.create({
        id: MENU_ID.ACTION_WAYBACK,
        title: 'Wayback Machine versions',
        contexts: ['action']
    });

    chrome.contextMenus.create({
        id: MENU_ID.ACTION_SETTINGS,
        title: 'Open settings',
        contexts: ['action']
    });
}

chrome.action.onClicked.addListener((tab) => {
    runSafely(async () => {
        const settings = await getSettings();
        await openArchivePage(tab?.url, settings.activateButtonNew, settings.tabOption, settings, {
            source: 'page',
            title: tab?.title || '',
            tabId: tab?.id
        });
    });
});

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(createContextMenus);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    runSafely(async () => {
        switch (info.menuItemId) {
            case MENU_ID.ACTION_WAYBACK: {
                const sourceTab = tab || await getActiveTab();
                const sourceUrl = sourceTab?.url;

                if (!isSupportedUrl(sourceUrl)) {
                    return;
                }

                const opened = await showWaybackOverlayOnTab(sourceTab, sourceUrl);
                if (!opened) {
                    const settings = await getSettings();
                    const calendarUrl = buildWaybackCalendarUrl(sourceUrl);
                    await createTabNearCurrent(calendarUrl, settings.activateButtonNew, settings.tabOption === TAB_OPTION.END);
                }
                return;
            }
            case MENU_ID.ACTION_SETTINGS:
                await chrome.tabs.create({
                    url: chrome.runtime.getURL('options.html'),
                    active: true
                });
                return;
            default:
                break;
        }

        const settings = await getSettings();

        switch (info.menuItemId) {
            case MENU_ID.LINK_ARCHIVE:
                await openArchivePage(info.linkUrl, settings.activateArchiveNew, settings.tabOption, settings, {
                    source: 'link',
                    title: tab?.title || '',
                    tabId: tab?.id
                });
                break;
            case MENU_ID.LINK_SEARCH:
                await openSearchPage(info.linkUrl, settings.activateSearchNew, settings.tabOption, settings);
                break;
            case MENU_ID.PAGE_SEARCH:
                await openSearchPage(tab?.url, settings.activatePageNew, settings.tabOption, settings);
                break;
            default:
                break;
        }
    });
});

chrome.runtime.onMessage.addListener(onRuntimeMessage);
