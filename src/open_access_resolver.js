const DOI_PATTERN = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i;
const DEFAULT_TIMEOUT_MS = 1800;
const DOI_URL_PREFIX_PATTERN = /^(https?:\/\/)?(dx\.)?doi\.org\//i;

function normalizeDoi(value) {
    if (!value) {
        return null;
    }

    const cleaned = String(value)
        .trim()
        .replace(DOI_URL_PREFIX_PATTERN, '')
        .replace(/^doi:\s*/i, '')
        .replace(/[)\].,;]+$/, '');

    return DOI_PATTERN.test(cleaned) ? cleaned : null;
}

function extractDoiFromText(value) {
    if (!value) {
        return null;
    }

    const match = String(value).match(DOI_PATTERN);
    return match ? normalizeDoi(match[0]) : null;
}

function extractDoiFromUrl(url) {
    if (!url) {
        return null;
    }

    const direct = extractDoiFromText(url);
    if (direct) {
        return direct;
    }

    try {
        return extractDoiFromText(decodeURIComponent(url));
    } catch (error) {
        return null;
    }
}

function sanitizeEmail(value) {
    const email = String(value || '').trim();
    return email.includes('@') ? email : '';
}

function createProviderUrl(url, params = {}) {
    const resolved = new URL(url);
    Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== '') {
            resolved.searchParams.set(key, value);
        }
    });
    return resolved.toString();
}

async function fetchJson(url, timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            method: 'GET',
            signal: controller.signal,
            headers: {
                Accept: 'application/json',
                ...headers
            }
        });

        if (!response.ok) {
            return null;
        }

        return response.json();
    } catch (error) {
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}

function buildCandidate(provider, url, rank, type = 'landing') {
    if (!url || !/^https?:\/\//i.test(url)) {
        return null;
    }

    return {
        provider,
        url,
        rank,
        type
    };
}

function rankBonus(type) {
    return type === 'pdf' ? 8 : 0;
}

async function resolveFromUnpaywall(doi, settings) {
    if (!settings.unpaywallEnabled) {
        return null;
    }

    const email = sanitizeEmail(settings.unpaywallEmail);
    if (!email) {
        return null;
    }

    const data = await fetchJson(
        createProviderUrl(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}`, { email }),
        DEFAULT_TIMEOUT_MS
    );
    if (!data) {
        return null;
    }

    const bestLocation = data.best_oa_location || (Array.isArray(data.oa_locations) ? data.oa_locations[0] : null);
    const pdfUrl = bestLocation?.url_for_pdf || '';
    const landingUrl = bestLocation?.url || '';

    return buildCandidate('unpaywall', pdfUrl || landingUrl, 100 + rankBonus(pdfUrl ? 'pdf' : 'landing'), pdfUrl ? 'pdf' : 'landing');
}

async function resolveFromOpenAlex(doi, settings) {
    if (!settings.openAlexEnabled) {
        return null;
    }

    const mailto = sanitizeEmail(settings.contactEmail);
    const data = await fetchJson(
        createProviderUrl(`https://api.openalex.org/works/${encodeURIComponent(`https://doi.org/${doi}`)}`, { mailto }),
        DEFAULT_TIMEOUT_MS
    );
    if (!data) {
        return null;
    }

    const best = data.best_oa_location || data.primary_location || {};
    const pdfUrl = best.pdf_url || '';
    const landingUrl = best.landing_page_url || data.primary_location?.landing_page_url || '';

    return buildCandidate('openalex', pdfUrl || landingUrl, 92 + rankBonus(pdfUrl ? 'pdf' : 'landing'), pdfUrl ? 'pdf' : 'landing');
}

async function resolveFromEuropePmc(doi, settings) {
    if (!settings.europePmcEnabled) {
        return null;
    }

    const query = `DOI:"${doi}"`;
    const mailto = sanitizeEmail(settings.contactEmail);
    const data = await fetchJson(
        createProviderUrl('https://www.ebi.ac.uk/europepmc/webservices/rest/search', {
            query,
            format: 'json',
            pageSize: 1,
            email: mailto
        }),
        DEFAULT_TIMEOUT_MS
    );
    if (!data || !data.resultList || !Array.isArray(data.resultList.result) || data.resultList.result.length === 0) {
        return null;
    }

    const record = data.resultList.result[0];
    const fullTextUrls = record.fullTextUrlList?.fullTextUrl || [];
    const pdfEntry = fullTextUrls.find((item) => /pdf/i.test(item.documentStyle || item.url || ''));
    const firstEntry = fullTextUrls[0];
    const pdfUrl = pdfEntry?.url || '';
    const landingUrl = firstEntry?.url || (record.pmcid ? `https://europepmc.org/article/PMC/${record.pmcid}` : '');

    return buildCandidate('europepmc', pdfUrl || landingUrl, 84 + rankBonus(pdfUrl ? 'pdf' : 'landing'), pdfUrl ? 'pdf' : 'landing');
}

async function resolveFromCrossref(doi, settings) {
    if (!settings.crossrefEnabled) {
        return null;
    }

    const mailto = sanitizeEmail(settings.contactEmail);
    const data = await fetchJson(
        createProviderUrl(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, { mailto }),
        DEFAULT_TIMEOUT_MS
    );
    if (!data || !data.message) {
        return null;
    }

    const links = Array.isArray(data.message.link) ? data.message.link : [];
    const pdfLink = links.find((item) => /pdf/i.test(item['content-type'] || item.URL || ''));
    const anyLink = links[0];

    const pdfUrl = pdfLink?.URL || '';
    const landingUrl = anyLink?.URL || data.message.URL || '';

    return buildCandidate('crossref', pdfUrl || landingUrl, 74 + rankBonus(pdfUrl ? 'pdf' : 'landing'), pdfUrl ? 'pdf' : 'landing');
}

async function resolveFromCore(doi, settings) {
    if (!settings.coreEnabled || !doi) {
        return null;
    }

    const apiKey = String(settings.coreApiKey || '').trim();
    if (apiKey) {
        const data = await fetchJson(
            createProviderUrl('https://api.core.ac.uk/v3/search/works', {
                q: `doi:${doi}`,
                limit: 1
            }),
            DEFAULT_TIMEOUT_MS,
            { Authorization: `Bearer ${apiKey}` }
        );

        const first = Array.isArray(data?.results) ? data.results[0] : null;
        const downloadUrl = first?.downloadUrl || first?.fullTextIdentifier || (Array.isArray(first?.sourceFulltextUrls) ? first.sourceFulltextUrls[0] : '');
        const coreApiCandidate = buildCandidate('core', downloadUrl, 66 + rankBonus(/\.pdf($|\?)/i.test(downloadUrl) ? 'pdf' : 'landing'), /\.pdf($|\?)/i.test(downloadUrl) ? 'pdf' : 'landing');
        if (coreApiCandidate) {
            return coreApiCandidate;
        }
    }

    const query = encodeURIComponent(`doi:${doi}`);
    const searchUrl = `https://core.ac.uk/search?q=${query}`;
    return buildCandidate('core', searchUrl, 56, 'search');
}

async function resolveDoiFromCrossrefTitle(title, settings) {
    if (!settings.crossrefEnabled || !title || title.length < 12) {
        return null;
    }

    const mailto = sanitizeEmail(settings.contactEmail);
    const data = await fetchJson(
        createProviderUrl('https://api.crossref.org/works', {
            'query.title': title,
            rows: 1,
            select: 'DOI,score',
            mailto
        }),
        DEFAULT_TIMEOUT_MS
    );
    if (!data?.message?.items?.length) {
        return null;
    }

    const first = data.message.items[0];
    if (typeof first.score === 'number' && first.score < 40) {
        return null;
    }

    return normalizeDoi(first.DOI);
}

function pickBestCandidate(candidates) {
    if (!candidates.length) {
        return null;
    }

    const dedupe = new Map();
    candidates.forEach((candidate) => {
        const existing = dedupe.get(candidate.url);
        if (!existing || existing.rank < candidate.rank) {
            dedupe.set(candidate.url, candidate);
        }
    });

    return Array.from(dedupe.values()).sort((a, b) => b.rank - a.rank)[0] || null;
}

export async function resolveOpenAccessTarget(context, settings) {
    if (!settings.openAccessEnabled) {
        return null;
    }

    const doiFromContext = normalizeDoi(context.doi)
        || extractDoiFromUrl(context.url)
        || extractDoiFromText(context.title);
    const doi = doiFromContext || await resolveDoiFromCrossrefTitle(context.title, settings);

    if (!doi) {
        return null;
    }

    const providerTasks = [
        resolveFromUnpaywall(doi, settings),
        resolveFromOpenAlex(doi, settings),
        resolveFromEuropePmc(doi, settings),
        resolveFromCrossref(doi, settings),
        resolveFromCore(doi, settings)
    ];

    const settled = await Promise.allSettled(providerTasks);
    const candidates = settled
        .filter((result) => result.status === 'fulfilled')
        .map((result) => result.value)
        .filter(Boolean);

    const best = pickBestCandidate(candidates);
    if (!best) {
        return null;
    }

    return {
        ...best,
        doi
    };
}
