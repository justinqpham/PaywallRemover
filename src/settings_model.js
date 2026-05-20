export const MIRROR_BASE = Object.freeze({
    ARCHIVE_IS: 'https://archive.is',
    ARCHIVE_PH: 'https://archive.ph',
    ARCHIVE_TODAY: 'https://archive.today'
});

export const DEFAULT_SETTINGS = Object.freeze({
    preferredMirror: MIRROR_BASE.ARCHIVE_PH,
    preloadSearchFallback: false,
    paywallPromptEnabled: true,
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
