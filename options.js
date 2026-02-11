import { DEFAULT_SETTINGS, MIRROR_BASE, TAB_OPTION } from './src/settings_model.js';

function readSettingsFromForm() {
    const tabOption = document.getElementById('tabEnd').checked
        ? TAB_OPTION.END
        : (document.getElementById('tabAct').checked ? TAB_OPTION.ACTIVE_ARCHIVE : TAB_OPTION.ADJACENT);

    return {
        tabOption,
        activateButtonNew: document.getElementById('cbButtonNew').checked,
        activatePageNew: document.getElementById('cbPageNew').checked,
        activateArchiveNew: document.getElementById('cbArchiveNew').checked,
        activateSearchNew: document.getElementById('cbSearchNew').checked,
        preferredMirror: document.getElementById('selPreferredMirror').value,
        preloadSearchFallback: document.getElementById('cbPreloadFallback').checked,
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
    switch (settings.tabOption) {
        case TAB_OPTION.END:
            document.getElementById('tabEnd').checked = true;
            break;
        case TAB_OPTION.ACTIVE_ARCHIVE:
            document.getElementById('tabAct').checked = true;
            break;
        default:
            document.getElementById('tabAdj').checked = true;
            break;
    }

    document.getElementById('cbButtonNew').checked = settings.activateButtonNew;
    document.getElementById('cbPageNew').checked = settings.activatePageNew;
    document.getElementById('cbArchiveNew').checked = settings.activateArchiveNew;
    document.getElementById('cbSearchNew').checked = settings.activateSearchNew;

    const preferredMirrorInput = document.getElementById('selPreferredMirror');
    preferredMirrorInput.value = settings.preferredMirror || MIRROR_BASE.ARCHIVE_IS;
    if (!preferredMirrorInput.value) {
        preferredMirrorInput.value = MIRROR_BASE.ARCHIVE_IS;
    }

    document.getElementById('cbPreloadFallback').checked = Boolean(settings.preloadSearchFallback);
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
    restoreOptions();
    document.getElementById('bSave').addEventListener('click', saveOptions);
    document.getElementById('bReloadExtension').addEventListener('click', refreshExtension);
});
