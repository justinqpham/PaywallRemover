import { buildArchiveRoutePlan, buildPrimarySearchRoute, DEFAULT_ARCHIVE_MIRRORS } from './src/access_resolver.js';
import { resolveOpenAccessTarget } from './src/open_access_resolver.js';
import { DEFAULT_SETTINGS } from './src/settings_model.js';
import { buildWaybackCalendarUrl, buildNewestSnapshotUrl, buildSearchUrl } from './src/archive_client.js';

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
const WAYBACK_MAX_RESULTS = 80;
const WAYBACK_FULL_CACHE_TTL_MS = 5 * 60 * 1000;
const WAYBACK_PARTIAL_CACHE_TTL_MS = 90 * 1000;
const WAYBACK_FAST_TIMEOUT_MS = 1400;
const WAYBACK_FULL_TIMEOUT_MS = 4200;
const waybackCache = new Map();
const waybackInFlight = new Map();

// --- Mirror health rotation ---
const MIRROR_PROBE_TIMEOUT_MS = 2500;
const MIRROR_HEALTH_TTL_MS = 5 * 60 * 1000;
const NGINX_DETECT_PATTERN = /welcome to nginx|<title>\s*nginx\s*<\/title>/i;
const mirrorHealthCache = new Map();
const archiveTabRetries = new Map();
const MAX_MIRROR_RETRIES = 2;

async function probeMirrorHealth(mirrorBase) {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), MIRROR_PROBE_TIMEOUT_MS);
        const response = await fetch(mirrorBase, {
            signal: controller.signal,
            cache: 'no-store'
        });
        clearTimeout(timer);
        if (!response.ok) {
            return false;
        }
        const text = (await response.text()).slice(0, 4000);
        return !NGINX_DETECT_PATTERN.test(text);
    } catch (error) {
        return false;
    }
}

async function isMirrorHealthy(mirrorBase) {
    const cached = mirrorHealthCache.get(mirrorBase);
    if (cached && (Date.now() - cached.checkedAt) < MIRROR_HEALTH_TTL_MS) {
        return cached.healthy;
    }
    const healthy = await probeMirrorHealth(mirrorBase);
    mirrorHealthCache.set(mirrorBase, { healthy, checkedAt: Date.now() });
    return healthy;
}

async function resolveHealthyMirror(preferredMirror) {
    if (await isMirrorHealthy(preferredMirror)) {
        return preferredMirror;
    }
    for (const mirror of DEFAULT_ARCHIVE_MIRRORS) {
        if (mirror === preferredMirror) {
            continue;
        }
        if (await isMirrorHealthy(mirror)) {
            return mirror;
        }
    }
    return preferredMirror;
}

function parseArchiveUrl(url) {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();
        if (!ARCHIVE_READER_HOSTS.has(host)) {
            return null;
        }
        const mirrorBase = `${parsed.protocol}//${parsed.host}`;
        const newestMatch = parsed.pathname.match(/^\/newest\/(.+)$/);
        if (newestMatch) {
            return { mirrorBase, originalUrl: newestMatch[1], kind: 'newest' };
        }
        if (parsed.pathname.startsWith('/search/')) {
            const q = parsed.searchParams.get('q');
            if (q) {
                return { mirrorBase, originalUrl: q, kind: 'search' };
            }
        }
        return null;
    } catch (error) {
        return null;
    }
}

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

async function createPlaceholderTab(shouldActivate) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const createOptions = { url: 'about:blank', active: shouldActivate };

    if (typeof activeTab?.id === 'number') {
        createOptions.openerTabId = activeTab.id;
    }

    if (typeof activeTab?.index === 'number') {
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

        if (snapshots.length >= WAYBACK_MAX_RESULTS) {
            break;
        }
    }

    return snapshots;
}

function normalizeWaybackRequestUrl(url) {
    try {
        const parsed = new URL(String(url || ''));
        parsed.hash = '';
        return parsed.toString();
    } catch (error) {
        return String(url || '');
    }
}

function getWaybackCacheKey(url) {
    return normalizeWaybackRequestUrl(url);
}

function setWaybackCache(originalUrl, snapshots, calendarUrl, complete) {
    const key = getWaybackCacheKey(originalUrl);
    waybackCache.set(key, {
        snapshots: Array.isArray(snapshots) ? snapshots : [],
        calendarUrl: String(calendarUrl || ''),
        complete: Boolean(complete),
        fetchedAt: Date.now()
    });
}

function getFreshWaybackCache(originalUrl, requireComplete = false) {
    const key = getWaybackCacheKey(originalUrl);
    const entry = waybackCache.get(key);
    if (!entry) {
        return null;
    }

    const ttl = entry.complete ? WAYBACK_FULL_CACHE_TTL_MS : WAYBACK_PARTIAL_CACHE_TTL_MS;
    if ((Date.now() - entry.fetchedAt) > ttl) {
        waybackCache.delete(key);
        return null;
    }

    if (requireComplete && !entry.complete) {
        return null;
    }

    return entry;
}

function getAnyWaybackCache(originalUrl) {
    const key = getWaybackCacheKey(originalUrl);
    return waybackCache.get(key) || null;
}

function mergeWaybackSnapshots(...groups) {
    const merged = [];
    const seen = new Set();

    for (const group of groups) {
        if (!Array.isArray(group)) {
            continue;
        }

        for (const snapshot of group) {
            const timestamp = String(snapshot?.timestamp || '');
            if (!/^\d{14}$/.test(timestamp) || seen.has(timestamp)) {
                continue;
            }

            seen.add(timestamp);
            merged.push(snapshot);
        }
    }

    merged.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
    return merged.slice(0, WAYBACK_MAX_RESULTS);
}

async function fetchJsonWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            cache: 'no-store',
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`Wayback request failed (${response.status})`);
        }

        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

function buildWaybackCdxEndpoint(originalUrl, options = {}) {
    const endpoint = new URL('https://web.archive.org/cdx/search/cdx');
    endpoint.searchParams.set('url', originalUrl);
    endpoint.searchParams.set('output', 'json');
    endpoint.searchParams.set('fl', 'timestamp,original,statuscode');
    endpoint.searchParams.set('filter', 'statuscode:200');
    endpoint.searchParams.set('sort', 'reverse');
    endpoint.searchParams.set('limit', String(options.limit || WAYBACK_MAX_RESULTS));

    if (options.collapse) {
        endpoint.searchParams.set('collapse', options.collapse);
    }

    return endpoint;
}

async function fetchWaybackLatestSnapshot(originalUrl) {
    const endpoint = buildWaybackCdxEndpoint(originalUrl, { limit: 1 });
    const payload = await fetchJsonWithTimeout(endpoint.toString(), WAYBACK_FAST_TIMEOUT_MS);
    const snapshots = normalizeWaybackSnapshots(payload, originalUrl);
    return snapshots.slice(0, 1);
}

async function fetchWaybackDetailedSnapshots(originalUrl) {
    const endpoint = buildWaybackCdxEndpoint(originalUrl, {
        limit: WAYBACK_MAX_RESULTS,
        collapse: 'timestamp:10'
    });
    const payload = await fetchJsonWithTimeout(endpoint.toString(), WAYBACK_FULL_TIMEOUT_MS);
    return normalizeWaybackSnapshots(payload, originalUrl);
}

async function fetchWaybackSnapshotsFull(originalUrl) {
    const calendarUrl = buildWaybackCalendarUrl(originalUrl);
    const [latestResult, detailedResult] = await Promise.allSettled([
        fetchWaybackLatestSnapshot(originalUrl),
        fetchWaybackDetailedSnapshots(originalUrl)
    ]);

    const latestSnapshots = latestResult.status === 'fulfilled' ? latestResult.value : [];
    const detailedSnapshots = detailedResult.status === 'fulfilled' ? detailedResult.value : [];
    const snapshots = mergeWaybackSnapshots(latestSnapshots, detailedSnapshots);
    const complete = detailedResult.status === 'fulfilled';

    if (!complete && latestResult.status !== 'fulfilled') {
        throw new Error('Wayback fetch failed');
    }

    setWaybackCache(originalUrl, snapshots, calendarUrl, complete);

    return {
        snapshots,
        calendarUrl,
        complete
    };
}

function ensureWaybackFullRefresh(originalUrl) {
    const key = getWaybackCacheKey(originalUrl);
    const existing = waybackInFlight.get(key);
    if (existing) {
        return existing;
    }

    const task = fetchWaybackSnapshotsFull(originalUrl).finally(() => {
        waybackInFlight.delete(key);
    });
    waybackInFlight.set(key, task);
    return task;
}

async function handleFetchWaybackSnapshots(message) {
    const sourceUrl = normalizeWaybackRequestUrl(String(message?.url || ''));
    const mode = message?.mode === 'full' ? 'full' : 'quick';
    if (!isSupportedUrl(sourceUrl)) {
        return { ok: false, error: 'unsupported_url', snapshots: [] };
    }

    const calendarUrl = buildWaybackCalendarUrl(sourceUrl);

    if (mode === 'quick') {
        const cached = getFreshWaybackCache(sourceUrl, false);
        if (cached) {
            if (!cached.complete) {
                ensureWaybackFullRefresh(sourceUrl).catch(() => {});
            }
            return {
                ok: true,
                snapshots: cached.snapshots,
                calendarUrl: cached.calendarUrl || calendarUrl,
                partial: !cached.complete,
                cached: true
            };
        }

        try {
            const latestSnapshots = await fetchWaybackLatestSnapshot(sourceUrl);
            setWaybackCache(sourceUrl, latestSnapshots, calendarUrl, false);
            ensureWaybackFullRefresh(sourceUrl).catch(() => {});
            return {
                ok: true,
                snapshots: latestSnapshots,
                calendarUrl,
                partial: true,
                cached: false
            };
        } catch (error) {
            ensureWaybackFullRefresh(sourceUrl).catch(() => {});
            const stale = getAnyWaybackCache(sourceUrl);
            if (stale) {
                return {
                    ok: true,
                    snapshots: stale.snapshots,
                    calendarUrl: stale.calendarUrl || calendarUrl,
                    partial: !stale.complete,
                    cached: true,
                    stale: true
                };
            }
            return { ok: false, error: 'wayback_fetch_failed', snapshots: [], calendarUrl };
        }
    }

    const completeCache = getFreshWaybackCache(sourceUrl, true);
    if (completeCache) {
        return {
            ok: true,
            snapshots: completeCache.snapshots,
            calendarUrl: completeCache.calendarUrl || calendarUrl,
            partial: false,
            cached: true
        };
    }

    try {
        const result = await ensureWaybackFullRefresh(sourceUrl);
        return {
            ok: true,
            snapshots: result.snapshots,
            calendarUrl: result.calendarUrl,
            partial: !result.complete,
            cached: false
        };
    } catch (error) {
        const fallback = getFreshWaybackCache(sourceUrl, false) || getAnyWaybackCache(sourceUrl);
        if (fallback) {
            return {
                ok: true,
                snapshots: fallback.snapshots,
                calendarUrl: fallback.calendarUrl || calendarUrl,
                partial: !fallback.complete,
                cached: true,
                stale: true
            };
        }

        return { ok: false, error: 'wayback_fetch_failed', snapshots: [], calendarUrl };
    }
}

async function handleOpenFromPaywallPrompt(message, sender) {
    const sourceUrl = String(message?.url || '');
    if (!isSupportedUrl(sourceUrl)) {
        return { ok: false, error: 'unsupported_url' };
    }

    const settings = await getSettings();
    await openArchivePage(sourceUrl, settings, {
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

async function createTabNearCurrent(url, shouldActivate = true) {
    const createdTab = await createPlaceholderTab(shouldActivate);
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

async function openArchivePage(url, settings, context = {}, options = {}) {
    if (!isSupportedUrl(url)) {
        return;
    }

    const pageDoi = context.source === 'page' ? await extractDoiFromActiveTab(context.tabId) : null;

    const [healthyMirror, openAccessTarget] = await Promise.all([
        resolveHealthyMirror(settings.preferredMirror),
        resolveOpenAccessQuickly({
            url,
            title: context.title || '',
            doi: pageDoi
        }, settings)
    ]);

    const routes = buildArchiveRoutePlan(url, {
        preferredMirror: healthyMirror
    });
    const primaryRoute = routes[0];
    if (!primaryRoute) {
        return;
    }

    const finalUrl = openAccessTarget?.url || primaryRoute.url;

    let archiveTabId = null;
    const openInCurrentTab = options?.openInCurrentTab === true;
    const shouldActivate = options?.shouldActivate !== false;

    if (openInCurrentTab) {
        const activeTab = typeof context.tabId === 'number'
            ? { id: context.tabId }
            : await getActiveTab();
        if (typeof activeTab?.id === 'number') {
            const updatedTab = await chrome.tabs.update(activeTab.id, { url: finalUrl, active: true });
            archiveTabId = updatedTab?.id;
        } else {
            const fallbackTab = await chrome.tabs.create({ url: finalUrl, active: true });
            archiveTabId = fallbackTab?.id;
        }
    } else {
        const targetTab = await createTabNearCurrent(finalUrl, shouldActivate);
        archiveTabId = targetTab?.id;
    }

    if (!openAccessTarget && typeof archiveTabId === 'number') {
        scheduleArchiveReaderMode(archiveTabId);
    }

    if (!openAccessTarget && settings.preloadSearchFallback && routes.length > 1) {
        await createTabNearCurrent(routes[1].url, false);
    }
}

async function openSearchPage(url, settings, options = {}) {
    if (!isSupportedUrl(url)) {
        return;
    }

    const healthyMirror = await resolveHealthyMirror(settings.preferredMirror);
    const route = buildPrimarySearchRoute(url, {
        preferredMirror: healthyMirror
    });
    if (!route) {
        return;
    }

    await createTabNearCurrent(route.url, options?.shouldActivate !== false);
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
        await openArchivePage(tab?.url, settings, {
            source: 'page',
            title: tab?.title || '',
            tabId: tab?.id
        }, {
            openInCurrentTab: true
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
                    const calendarUrl = buildWaybackCalendarUrl(sourceUrl);
                    await createTabNearCurrent(calendarUrl, true);
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
                await openArchivePage(info.linkUrl, settings, {
                    source: 'link',
                    title: tab?.title || '',
                    tabId: tab?.id
                });
                break;
            case MENU_ID.LINK_SEARCH:
                await openSearchPage(info.linkUrl, settings);
                break;
            case MENU_ID.PAGE_SEARCH:
                await openSearchPage(tab?.url, settings);
                break;
            default:
                break;
        }
    });
});

// --- Reactive nginx detection and mirror auto-rotation ---
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete') {
        return;
    }

    const archiveInfo = parseArchiveUrl(tab?.url);
    if (!archiveInfo) {
        return;
    }

    runSafely(async () => {
        const retries = archiveTabRetries.get(tabId) || 0;
        if (retries >= MAX_MIRROR_RETRIES) {
            archiveTabRetries.delete(tabId);
            return;
        }

        let isNginx = false;
        try {
            const [{ result }] = await chrome.scripting.executeScript({
                target: { tabId },
                func: () => {
                    const html = document.documentElement.innerHTML.slice(0, 4000);
                    return /welcome to nginx|<title>\s*nginx\s*<\/title>/i.test(html);
                }
            });
            isNginx = Boolean(result);
        } catch (error) {
            return;
        }

        if (!isNginx) {
            archiveTabRetries.delete(tabId);
            return;
        }

        mirrorHealthCache.set(archiveInfo.mirrorBase, { healthy: false, checkedAt: Date.now() });

        let nextMirror = null;
        for (const mirror of DEFAULT_ARCHIVE_MIRRORS) {
            if (mirror === archiveInfo.mirrorBase) {
                continue;
            }
            if (await isMirrorHealthy(mirror)) {
                nextMirror = mirror;
                break;
            }
        }

        if (!nextMirror) {
            archiveTabRetries.delete(tabId);
            return;
        }

        const newUrl = archiveInfo.kind === 'newest'
            ? buildNewestSnapshotUrl(archiveInfo.originalUrl, nextMirror)
            : buildSearchUrl(archiveInfo.originalUrl, nextMirror);

        archiveTabRetries.set(tabId, retries + 1);
        await chrome.tabs.update(tabId, { url: newUrl });
    });
});

chrome.tabs.onRemoved.addListener((tabId) => {
    archiveTabRetries.delete(tabId);
});

chrome.runtime.onMessage.addListener(onRuntimeMessage);
