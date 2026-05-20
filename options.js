import { DEFAULT_SETTINGS, MIRROR_BASE } from './src/settings_model.js';

const LEGACY_SETTING_KEYS = Object.freeze([
    'tabOption',
    'activateButtonNew',
    'activatePageNew',
    'activateArchiveNew',
    'activateSearchNew'
]);

function setActiveSettingsTab(tabName) {
    const buttons = document.querySelectorAll('[data-tab-button]');
    const panels = document.querySelectorAll('[data-tab-panel]');

    buttons.forEach((button) => {
        const active = button.dataset.tabButton === tabName;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    panels.forEach((panel) => {
        const active = panel.dataset.tabPanel === tabName;
        panel.classList.toggle('is-active', active);
        panel.hidden = !active;
    });
}

function initializeSettingsTabs() {
    const buttons = Array.from(document.querySelectorAll('[data-tab-button]'));
    if (buttons.length === 0) {
        return;
    }

    buttons.forEach((button) => {
        button.addEventListener('click', () => {
            setActiveSettingsTab(button.dataset.tabButton || '');
        });
    });

    const initial = buttons.find((button) => button.classList.contains('is-active')) || buttons[0];
    setActiveSettingsTab(initial.dataset.tabButton || '');
}

function readSettingsFromForm() {
    return {
        preferredMirror: document.getElementById('selPreferredMirror').value,
        preloadSearchFallback: document.getElementById('cbPreloadFallback').checked,
        paywallPromptEnabled: document.getElementById('cbPaywallPromptEnabled').checked,
        openAccessEnabled: document.getElementById('cbOpenAccessEnabled').checked,
        openAccessWaitMs: Math.max(0, Number(document.getElementById('inOpenAccessWaitMs').value) || 0),
        unpaywallEnabled: document.getElementById('cbUnpaywallEnabled').checked,
        openAlexEnabled: document.getElementById('cbOpenAlexEnabled').checked,
        europePmcEnabled: document.getElementById('cbEuropePmcEnabled').checked,
        crossrefEnabled: document.getElementById('cbCrossrefEnabled').checked,
        coreEnabled: document.getElementById('cbCoreEnabled').checked,
        unpaywallEmail: document.getElementById('inUnpaywallEmail').value.trim(),
        contactEmail: document.getElementById('inContactEmail').value.trim(),
        coreApiKey: document.getElementById('inCoreApiKey').value.trim()
    };
}

function applySettingsToForm(settings) {
    const preferredMirrorInput = document.getElementById('selPreferredMirror');
    preferredMirrorInput.value = settings.preferredMirror || MIRROR_BASE.ARCHIVE_IS;
    if (!preferredMirrorInput.value) {
        preferredMirrorInput.value = MIRROR_BASE.ARCHIVE_IS;
    }

    document.getElementById('cbPreloadFallback').checked = Boolean(settings.preloadSearchFallback);
    document.getElementById('cbPaywallPromptEnabled').checked = Boolean(settings.paywallPromptEnabled);
    document.getElementById('cbOpenAccessEnabled').checked = Boolean(settings.openAccessEnabled);
    document.getElementById('inOpenAccessWaitMs').value = String(Math.max(0, Number(settings.openAccessWaitMs) || 900));

    document.getElementById('cbUnpaywallEnabled').checked = Boolean(settings.unpaywallEnabled);
    document.getElementById('cbOpenAlexEnabled').checked = Boolean(settings.openAlexEnabled);
    document.getElementById('cbEuropePmcEnabled').checked = Boolean(settings.europePmcEnabled);
    document.getElementById('cbCrossrefEnabled').checked = Boolean(settings.crossrefEnabled);
    document.getElementById('cbCoreEnabled').checked = Boolean(settings.coreEnabled);

    document.getElementById('inUnpaywallEmail').value = settings.unpaywallEmail || '';
    document.getElementById('inContactEmail').value = settings.contactEmail || '';
    document.getElementById('inCoreApiKey').value = settings.coreApiKey || '';
}

function showSavedState() {
    const status = document.getElementById('status');
    status.textContent = 'Options saved.';
    setTimeout(() => {
        status.textContent = '';
    }, 750);
}

async function saveOptions() {
    await chrome.storage.sync.set(readSettingsFromForm());
    await chrome.storage.sync.remove(LEGACY_SETTING_KEYS);
    showSavedState();
}

async function restoreOptions() {
    const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    applySettingsToForm(settings);
}

function refreshExtension() {
    chrome.runtime.reload();
}

document.addEventListener('DOMContentLoaded', () => {
    initializeSettingsTabs();
    restoreOptions();
    document.getElementById('bSave').addEventListener('click', saveOptions);
    document.getElementById('bReloadExtension').addEventListener('click', refreshExtension);
});
