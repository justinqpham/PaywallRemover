import { buildArchiveRoutePlan, buildPrimarySearchRoute } from './src/access_resolver.js';
import { resolveOpenAccessTarget } from './src/open_access_resolver.js';
import { DEFAULT_SETTINGS, TAB_OPTION } from './src/settings_model.js';

const MENU_ID = Object.freeze({
    PAGE_SEARCH: 'page_search_archive',
    LINK_ROOT: 'link_archive_root',
    LINK_ARCHIVE: 'link_archive_open',
    LINK_SEARCH: 'link_archive_search'
});

function isSupportedUrl(url) {
    return typeof url === 'string' && /^https?:\/\//i.test(url);
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

async function createTabNearCurrent(url, shouldActivate, placeAtEnd) {
    const createdTab = await createPlaceholderTab(shouldActivate, placeAtEnd);
    if (typeof createdTab?.id === 'number') {
        await chrome.tabs.update(createdTab.id, { url });
        return createdTab;
    }

    // Fallback in case Chrome does not return a tab id
    await chrome.tabs.create({ url, active: shouldActivate });
    return null;
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

    if (tabOption === TAB_OPTION.ACTIVE_ARCHIVE) {
        await chrome.tabs.update({ url: finalUrl });
    } else {
        const slotTab = await createPlaceholderTab(shouldActivate, tabOption === TAB_OPTION.END);
        if (typeof slotTab?.id === 'number') {
            await chrome.tabs.update(slotTab.id, { url: finalUrl });
        } else {
            await createTabNearCurrent(finalUrl, shouldActivate, tabOption === TAB_OPTION.END);
        }
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
