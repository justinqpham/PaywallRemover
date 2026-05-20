const DEFAULT_MIRROR_BASE = 'https://archive.ph';
const DEFAULT_WAYBACK_BASE = 'https://web.archive.org';

function trimTrailingSlashes(value) {
    return String(value || '').replace(/\/+$/, '');
}

export function normalizeArchiveUri(uri) {
    try {
        const url = new URL(String(uri || ''));
        url.hash = '';
        url.search = '';
        return url.toString();
    } catch (error) {
        return String(uri || '').split('#')[0].split('?')[0];
    }
}

export function buildNewestSnapshotUrl(uri, mirrorBase = DEFAULT_MIRROR_BASE) {
    const base = trimTrailingSlashes(mirrorBase) || DEFAULT_MIRROR_BASE;
    return `${base}/newest/${normalizeArchiveUri(uri)}`;
}

export function buildSearchUrl(uri, mirrorBase = DEFAULT_MIRROR_BASE) {
    const base = trimTrailingSlashes(mirrorBase) || DEFAULT_MIRROR_BASE;
    return `${base}/search/?q=${encodeURIComponent(String(uri || ''))}`;
}

export function buildWaybackCalendarUrl(uri, waybackBase = DEFAULT_WAYBACK_BASE) {
    const base = trimTrailingSlashes(waybackBase) || DEFAULT_WAYBACK_BASE;
    return `${base}/web/*/${normalizeArchiveUri(uri)}`;
}

export function createArchiveClient(options = {}) {
    const mirrorBase = trimTrailingSlashes(options.mirrorBase) || DEFAULT_MIRROR_BASE;

    return Object.freeze({
        mirrorBase,
        normalizeArchiveUri,
        buildNewestSnapshotUrl: (uri) => buildNewestSnapshotUrl(uri, mirrorBase),
        buildSearchUrl: (uri) => buildSearchUrl(uri, mirrorBase),
        buildWaybackCalendarUrl
    });
}
