import { buildWaybackCalendarUrl } from './src/archive_client.js';

const WAYBACK_BASE = 'https://web.archive.org';
const MESSAGE_TYPE = {
    WAYBACK_PICKER_READY: 'wayback_picker_ready'
};

const elements = {
    targetUrl: document.getElementById('targetUrl'),
    snapshotSelect: document.getElementById('snapshotSelect'),
    openSnapshot: document.getElementById('openSnapshot'),
    openCalendar: document.getElementById('openCalendar'),
    refreshList: document.getElementById('refreshList'),
    status: document.getElementById('status')
};

const params = new URLSearchParams(window.location.search);
const parsedTabId = Number.parseInt(params.get('tabId') || '', 10);
let sourceUrl = String(params.get('url') || '');
let targetTabId = Number.isInteger(parsedTabId) ? parsedTabId : null;
let resizeTimer = null;
let blurCloseTimer = null;

function isSupportedUrl(url) {
    return /^https?:\/\//i.test(url);
}

function setStatus(message) {
    elements.status.textContent = message || '';
    queueWindowFit();
}

async function fitWindowToContent() {
    if (!chrome.windows?.getCurrent || !chrome.windows?.update) {
        return;
    }

    try {
        const current = await chrome.windows.getCurrent();
        if (typeof current?.id !== 'number' || current.type !== 'popup') {
            return;
        }

        const contentWidth = Math.ceil(document.documentElement.scrollWidth);
        const contentHeight = Math.ceil(document.documentElement.scrollHeight);
        const targetWidth = Math.min(500, Math.max(360, contentWidth + 22));
        const targetHeight = Math.min(560, Math.max(320, contentHeight + 106));

        await chrome.windows.update(current.id, {
            width: targetWidth,
            height: targetHeight
        });
    } catch (error) {
        // Best-effort resize only.
    }
}

function queueWindowFit() {
    if (resizeTimer !== null) {
        clearTimeout(resizeTimer);
    }

    resizeTimer = setTimeout(() => {
        resizeTimer = null;
        fitWindowToContent().catch(() => {});
    }, 30);
}

function queueCloseOnBlur() {
    if (blurCloseTimer !== null) {
        clearTimeout(blurCloseTimer);
    }

    blurCloseTimer = setTimeout(() => {
        blurCloseTimer = null;
        if (!document.hasFocus()) {
            window.close();
        }
    }, 120);
}

function setupAutoCloseOnBlur() {
    window.addEventListener('blur', () => {
        queueCloseOnBlur();
    });

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            queueCloseOnBlur();
        }
    });

    window.addEventListener('focus', () => {
        if (blurCloseTimer !== null) {
            clearTimeout(blurCloseTimer);
            blurCloseTimer = null;
        }
    });
}

async function resolveSourceContext() {
    if (isSupportedUrl(sourceUrl)) {
        return;
    }

    try {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (isSupportedUrl(activeTab?.url)) {
            sourceUrl = String(activeTab.url);
            if (Number.isInteger(activeTab.id)) {
                targetTabId = activeTab.id;
            }
        }
    } catch (error) {
        // Leave source context empty if tab lookup fails.
    }
}

function formatTimestamp(timestamp) {
    if (!/^\d{14}$/.test(timestamp)) {
        return timestamp;
    }

    const yyyy = timestamp.slice(0, 4);
    const mm = timestamp.slice(4, 6);
    const dd = timestamp.slice(6, 8);
    const hh = timestamp.slice(8, 10);
    const min = timestamp.slice(10, 12);
    const ss = timestamp.slice(12, 14);
    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss} UTC`;
}

function buildSnapshotUrl(snapshot) {
    return `${WAYBACK_BASE}/web/${snapshot.timestamp}/${snapshot.original || sourceUrl}`;
}

function setLoadingState(isLoading) {
    elements.refreshList.disabled = isLoading;

    if (isLoading) {
        elements.snapshotSelect.disabled = true;
        elements.openSnapshot.disabled = true;
    }
}

function parseSnapshotRows(payload) {
    if (!Array.isArray(payload) || payload.length < 2) {
        return [];
    }

    return payload
        .slice(1)
        .map((row) => ({
            timestamp: Array.isArray(row) ? String(row[0] || '') : '',
            original: Array.isArray(row) ? String(row[1] || sourceUrl) : sourceUrl,
            status: Array.isArray(row) ? String(row[2] || '') : ''
        }))
        .filter((entry) => /^\d{14}$/.test(entry.timestamp));
}

function renderSnapshots(snapshots) {
    elements.snapshotSelect.innerHTML = '';

    if (!snapshots.length) {
        const option = document.createElement('option');
        option.textContent = 'No snapshots found';
        option.value = '';
        elements.snapshotSelect.append(option);
        elements.snapshotSelect.disabled = true;
        elements.openSnapshot.disabled = true;
        setStatus('No archived versions were found for this URL.');
        queueWindowFit();
        return;
    }

    for (const snapshot of snapshots) {
        const option = document.createElement('option');
        option.value = buildSnapshotUrl(snapshot);
        option.textContent = `${formatTimestamp(snapshot.timestamp)}${snapshot.status ? ` (${snapshot.status})` : ''}`;
        elements.snapshotSelect.append(option);
    }

    elements.snapshotSelect.disabled = false;
    elements.openSnapshot.disabled = false;
    setStatus(`Found ${snapshots.length} archived versions.`);
    queueWindowFit();
}

async function fetchSnapshots(url) {
    const endpoint = new URL(`${WAYBACK_BASE}/cdx/search/cdx`);
    endpoint.searchParams.set('url', url);
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
    return parseSnapshotRows(payload);
}

async function openTarget(url) {
    if (!isSupportedUrl(url)) {
        return;
    }

    if (targetTabId !== null) {
        try {
            await chrome.tabs.update(targetTabId, { url, active: true });
            window.close();
            return;
        } catch (error) {
            // If source tab no longer exists, fallback to opening a new tab.
        }
    }

    await chrome.tabs.create({ url, active: true });
    window.close();
}

async function loadSnapshotOptions() {
    if (!isSupportedUrl(sourceUrl)) {
        elements.snapshotSelect.innerHTML = '';
        const option = document.createElement('option');
        option.textContent = 'Unsupported page URL';
        option.value = '';
        elements.snapshotSelect.append(option);
        elements.snapshotSelect.disabled = true;
        elements.openSnapshot.disabled = true;
        elements.openCalendar.disabled = true;
        setStatus('Open a normal http(s) page and try again.');
        queueWindowFit();
        return;
    }

    setLoadingState(true);
    setStatus('Fetching versions from Wayback Machine...');

    try {
        const snapshots = await fetchSnapshots(sourceUrl);
        renderSnapshots(snapshots);
    } catch (error) {
        elements.snapshotSelect.innerHTML = '';
        const option = document.createElement('option');
        option.textContent = 'Unable to fetch snapshots';
        option.value = '';
        elements.snapshotSelect.append(option);
        elements.snapshotSelect.disabled = true;
        elements.openSnapshot.disabled = true;
        setStatus('Could not load versions right now. Try refresh.');
        queueWindowFit();
    } finally {
        setLoadingState(false);
        queueWindowFit();
    }
}

function init() {
    chrome.runtime.sendMessage({ type: MESSAGE_TYPE.WAYBACK_PICKER_READY }).catch(() => {});
    setupAutoCloseOnBlur();
    elements.targetUrl.textContent = sourceUrl;

    elements.openSnapshot.addEventListener('click', async () => {
        const value = elements.snapshotSelect.value;
        if (!value) {
            return;
        }
        await openTarget(value);
    });

    elements.snapshotSelect.addEventListener('dblclick', async () => {
        const value = elements.snapshotSelect.value;
        if (!value) {
            return;
        }
        await openTarget(value);
    });

    elements.openCalendar.addEventListener('click', async () => {
        await openTarget(buildWaybackCalendarUrl(sourceUrl));
    });

    elements.refreshList.addEventListener('click', async () => {
        await loadSnapshotOptions();
    });

    resolveSourceContext()
        .then(() => {
            elements.targetUrl.textContent = sourceUrl;
            return loadSnapshotOptions();
        })
        .catch(() => {
            setStatus('Could not load versions right now.');
        });

    queueWindowFit();
}

init();
