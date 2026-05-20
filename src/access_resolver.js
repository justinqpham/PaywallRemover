import { buildNewestSnapshotUrl, buildSearchUrl } from './archive_client.js';

export const DEFAULT_ARCHIVE_MIRRORS = Object.freeze([
    'https://archive.ph',
    'https://archive.is',
    'https://archive.today'
]);

function normalizeMirror(mirror) {
    return String(mirror || '').trim().replace(/\/+$/, '');
}

function buildOrderedMirrorList(preferredMirror, mirrors = DEFAULT_ARCHIVE_MIRRORS) {
    const seen = new Set();
    const ordered = [];

    const pushMirror = (mirror) => {
        const normalized = normalizeMirror(mirror);
        if (!normalized || seen.has(normalized)) {
            return;
        }
        seen.add(normalized);
        ordered.push(normalized);
    };

    pushMirror(preferredMirror);
    mirrors.forEach(pushMirror);
    return ordered;
}

export function buildArchiveRoutePlan(uri, options = {}) {
    const orderedMirrors = buildOrderedMirrorList(options.preferredMirror, options.mirrors);
    const includeSearchFallback = options.includeSearchFallback !== false;

    if (orderedMirrors.length === 0) {
        return [];
    }

    const [primaryMirror, ...fallbackMirrors] = orderedMirrors;
    const plan = [{
        kind: 'newest',
        mirror: primaryMirror,
        url: buildNewestSnapshotUrl(uri, primaryMirror)
    }];

    if (includeSearchFallback) {
        plan.push({
            kind: 'search',
            mirror: primaryMirror,
            url: buildSearchUrl(uri, primaryMirror)
        });
    }

    fallbackMirrors.forEach((mirror) => {
        plan.push({
            kind: 'newest',
            mirror,
            url: buildNewestSnapshotUrl(uri, mirror)
        });
    });

    if (includeSearchFallback) {
        fallbackMirrors.forEach((mirror) => {
            plan.push({
                kind: 'search',
                mirror,
                url: buildSearchUrl(uri, mirror)
            });
        });
    }

    return plan;
}

export function buildPrimarySearchRoute(uri, options = {}) {
    const orderedMirrors = buildOrderedMirrorList(options.preferredMirror, options.mirrors);
    if (orderedMirrors.length === 0) {
        return null;
    }

    const mirror = orderedMirrors[0];
    return {
        kind: 'search',
        mirror,
        url: buildSearchUrl(uri, mirror)
    };
}

