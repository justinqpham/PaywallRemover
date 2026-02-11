(() => {
    if (window.top !== window) {
        return;
    }

    if (!/^https?:$/i.test(location.protocol)) {
        return;
    }

    const EXCLUDED_HOSTS = new Set([
        'archive.is',
        'archive.ph',
        'archive.today',
        'web.archive.org'
    ]);

    if (EXCLUDED_HOSTS.has(location.hostname.toLowerCase())) {
        return;
    }

    const MESSAGE_TYPE_OPEN = 'open_from_paywall_prompt';
    const BANNER_ID = 'pwr-paywall-banner';
    const DISMISS_KEY = `pwr:dismiss:${location.hostname.toLowerCase()}`;
    const DEFAULT_PAYWALL_PROMPT_ENABLED = true;
    const PAYWALL_PATTERNS = [
        /subscribe to continue/i,
        /sign in to continue/i,
        /create an account to continue/i,
        /already a subscriber/i,
        /for subscribers/i,
        /subscribe now/i,
        /unlock this article/i,
        /remaining this month/i,
        /purchase a subscription/i,
        /subscribe for unlimited access/i,
        /continue reading by subscribing/i,
        /this content is for subscribers/i
    ];
    const PAYWALL_TERMS = [
        'subscribe',
        'subscriber',
        'membership',
        'sign in',
        'log in',
        'unlimited access',
        'continue reading',
        'start your trial',
        'paywall',
        'metered'
    ];

    function hasSessionDismissal() {
        try {
            return sessionStorage.getItem(DISMISS_KEY) === '1';
        } catch (error) {
            return false;
        }
    }

    function setSessionDismissal() {
        try {
            sessionStorage.setItem(DISMISS_KEY, '1');
        } catch (error) {
            // Ignore storage failures.
        }
    }

    function detectTextSignals() {
        const text = String(document.body?.innerText || '').slice(0, 28000);
        if (!text) {
            return { score: 0, hits: 0 };
        }

        let hits = 0;
        for (const pattern of PAYWALL_PATTERNS) {
            if (pattern.test(text)) {
                hits += 1;
            }
        }

        if (hits >= 3) {
            return { score: 4, hits };
        }
        if (hits === 2) {
            return { score: 3, hits };
        }
        if (hits === 1) {
            return { score: 1, hits };
        }
        return { score: 0, hits: 0 };
    }

    function detectOverlaySignals() {
        const nodes = document.querySelectorAll('div, section, aside, article, main');
        const viewportArea = Math.max(1, window.innerWidth * window.innerHeight);
        let checked = 0;

        for (let i = nodes.length - 1; i >= 0 && checked < 140; i -= 1) {
            const node = nodes[i];
            checked += 1;
            const style = window.getComputedStyle(node);
            if (!style || style.display === 'none' || style.visibility === 'hidden') {
                continue;
            }

            const position = style.position;
            if (position !== 'fixed' && position !== 'sticky') {
                continue;
            }

            const rect = node.getBoundingClientRect();
            const area = Math.max(0, rect.width) * Math.max(0, rect.height);
            if (area < viewportArea * 0.35) {
                continue;
            }

            const zIndex = Number.parseInt(style.zIndex || '0', 10);
            if (!Number.isFinite(zIndex) || zIndex < 100) {
                continue;
            }

            const text = String(node.innerText || '').slice(0, 1800).toLowerCase();
            if (!text) {
                continue;
            }

            if (PAYWALL_TERMS.some((term) => text.includes(term))) {
                return { score: 3 };
            }
        }

        return { score: 0 };
    }

    function detectBlockSignals() {
        const bodyStyle = window.getComputedStyle(document.body || document.documentElement);
        const rootStyle = window.getComputedStyle(document.documentElement);
        const bodyLocked = /(hidden|clip)/i.test(bodyStyle?.overflowY || '') || /(hidden|clip)/i.test(rootStyle?.overflowY || '');
        const tallPage = (document.documentElement.scrollHeight || 0) > window.innerHeight * 1.3;
        let score = bodyLocked && tallPage ? 1 : 0;

        const candidates = document.querySelectorAll('article, main, [role="main"], .article, .story, .content');
        let checked = 0;
        for (const node of candidates) {
            checked += 1;
            if (checked > 40) {
                break;
            }
            const style = window.getComputedStyle(node);
            if (!style) {
                continue;
            }

            const hasBlur = /blur\(/i.test(style.filter || '');
            const hasClamp = (style.display || '').includes('-webkit-box') && Number.parseInt(style.webkitLineClamp || '0', 10) > 0;
            if (hasBlur || hasClamp) {
                score += 1;
                break;
            }
        }

        return { score };
    }

    function detectPaywall() {
        const text = detectTextSignals();
        const overlay = detectOverlaySignals();
        const block = detectBlockSignals();
        const score = text.score + overlay.score + block.score;

        return {
            score,
            textHits: text.hits
        };
    }

    function removeBanner() {
        document.getElementById(BANNER_ID)?.remove();
    }

    function openAccessibleVersion(statusEl, buttonEl) {
        if (!chrome.runtime?.sendMessage) {
            statusEl.textContent = 'Extension bridge is unavailable on this page.';
            return;
        }

        buttonEl.disabled = true;
        buttonEl.textContent = 'Opening...';
        statusEl.textContent = '';

        chrome.runtime.sendMessage({
            type: MESSAGE_TYPE_OPEN,
            url: location.href,
            title: document.title || ''
        }, (response) => {
            if (chrome.runtime.lastError) {
                buttonEl.disabled = false;
                buttonEl.textContent = 'Open Accessible Version';
                statusEl.textContent = 'Unable to open right now. Try toolbar click.';
                return;
            }

            if (!response?.ok) {
                buttonEl.disabled = false;
                buttonEl.textContent = 'Open Accessible Version';
                statusEl.textContent = 'No accessible route found for this page.';
                return;
            }

            statusEl.textContent = 'Opening in a new tab...';
            window.setTimeout(() => {
                removeBanner();
            }, 350);
        });
    }

    function showBanner(result) {
        if (document.getElementById(BANNER_ID)) {
            return;
        }

        const wrap = document.createElement('section');
        wrap.id = BANNER_ID;
        wrap.setAttribute('role', 'dialog');
        wrap.setAttribute('aria-live', 'polite');
        wrap.style.cssText = [
            'position:fixed',
            'right:16px',
            'top:16px',
            'max-width:min(92vw, 360px)',
            'z-index:2147483647',
            'background:#111827',
            'color:#f9fafb',
            'border:1px solid rgba(255,255,255,0.14)',
            'border-radius:14px',
            'padding:14px',
            'box-shadow:0 14px 34px rgba(0,0,0,0.35)',
            'font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif'
        ].join(';');

        const title = document.createElement('div');
        title.textContent = 'Paywall likely detected';
        title.style.cssText = 'font-size:14px;font-weight:700;line-height:1.25;margin:0;';

        const body = document.createElement('div');
        body.textContent = result.textHits > 0
            ? 'Open an accessible version using the extension resolver.'
            : 'This page appears restricted. You can try the accessible resolver.';
        body.style.cssText = 'margin-top:8px;font-size:12px;line-height:1.45;color:#cbd5e1;';

        const actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;';

        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.textContent = 'Open Accessible Version';
        openBtn.style.cssText = [
            'border:0',
            'border-radius:10px',
            'padding:8px 10px',
            'cursor:pointer',
            'font-weight:600',
            'font-size:12px',
            'background:#0a66c2',
            'color:#fff'
        ].join(';');

        const dismissBtn = document.createElement('button');
        dismissBtn.type = 'button';
        dismissBtn.textContent = 'Dismiss';
        dismissBtn.style.cssText = [
            'border:1px solid rgba(255,255,255,0.25)',
            'border-radius:10px',
            'padding:8px 10px',
            'cursor:pointer',
            'font-weight:600',
            'font-size:12px',
            'background:transparent',
            'color:#f9fafb'
        ].join(';');

        const status = document.createElement('div');
        status.style.cssText = 'margin-top:8px;font-size:11px;line-height:1.35;color:#cbd5e1;min-height:1em;';

        openBtn.addEventListener('click', () => {
            openAccessibleVersion(status, openBtn);
        });

        dismissBtn.addEventListener('click', () => {
            setSessionDismissal();
            removeBanner();
        });

        actions.append(openBtn, dismissBtn);
        wrap.append(title, body, actions, status);
        document.documentElement.appendChild(wrap);
    }

    function shouldShowPrompt() {
        if (hasSessionDismissal()) {
            return false;
        }

        const result = detectPaywall();
        if (result.score < 3) {
            return false;
        }

        showBanner(result);
        return true;
    }

    function scheduleDetectionPass(delayMs) {
        window.setTimeout(() => {
            if (document.getElementById(BANNER_ID)) {
                return;
            }
            shouldShowPrompt();
        }, delayMs);
    }

    function readPromptEnabledSetting(callback) {
        if (!chrome.storage?.sync?.get) {
            callback(DEFAULT_PAYWALL_PROMPT_ENABLED);
            return;
        }

        chrome.storage.sync.get({ paywallPromptEnabled: DEFAULT_PAYWALL_PROMPT_ENABLED }, (items) => {
            if (chrome.runtime?.lastError) {
                callback(DEFAULT_PAYWALL_PROMPT_ENABLED);
                return;
            }

            callback(Boolean(items.paywallPromptEnabled));
        });
    }

    let started = false;
    function startDetection() {
        if (started) {
            return;
        }
        started = true;
        scheduleDetectionPass(1800);
        scheduleDetectionPass(5200);
    }

    function applyPromptEnabled(enabled) {
        if (!enabled) {
            removeBanner();
            return;
        }
        startDetection();
    }

    readPromptEnabledSetting((enabled) => {
        applyPromptEnabled(enabled);
    });

    if (chrome.storage?.onChanged) {
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName !== 'sync' || !changes.paywallPromptEnabled) {
                return;
            }

            applyPromptEnabled(Boolean(changes.paywallPromptEnabled.newValue));
        });
    }
})();
