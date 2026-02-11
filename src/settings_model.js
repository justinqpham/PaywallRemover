export const TAB_OPTION = Object.freeze({
    ADJACENT: 0,
    END: 1,
    ACTIVE_ARCHIVE: 2
});

export const MIRROR_BASE = Object.freeze({
    ARCHIVE_IS: 'https://archive.is',
    ARCHIVE_PH: 'https://archive.ph',
    ARCHIVE_TODAY: 'https://archive.today'
});

export const DEFAULT_SETTINGS = Object.freeze({
    tabOption: TAB_OPTION.ADJACENT,
    activateButtonNew: true,
    activatePageNew: true,
    activateArchiveNew: true,
    activateSearchNew: true,
    preferredMirror: MIRROR_BASE.ARCHIVE_IS,
    preloadSearchFallback: false,
    openAccessEnabled: true,
    openAccessWaitMs: 900,
    unpaywallEnabled: true,
    openAlexEnabled: true,
    europePmcEnabled: true,
    crossrefEnabled: true,
    coreEnabled: true,
    unpaywallEmail: '',
    contactEmail: '',
    coreApiKey: ''
});
