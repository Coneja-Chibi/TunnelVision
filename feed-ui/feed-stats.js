/**
 * TunnelVision Activity Feed — Stats UI Module
 *
 * Renders the feed stats bar, lorebook summary, and TunnelVision
 * context-usage budget bar. Extracted from activity-feed.js to keep
 * orchestration separate from display concerns.
 */

import { getActiveTunnelVisionBooks } from '../tool-registry.js';
import { isSummaryTitle, isTrackerTitle } from '../tree-store.js';
import { getCachedWorldInfo } from '../entry-manager.js';
import { countStaleEntries } from '../entry-scoring.js';
import { CHARS_PER_TOKEN } from '../constants.js';
import { getInjectionSizes, getMaxContextTokens } from '../agent-utils.js';
import {
    getFeedItemsRaw,
    getLorebookStatsCache,
    setLorebookStatsCache,
    getLorebookStatsCacheTime,
    setLorebookStatsCacheTime,
    LOREBOOK_STATS_CACHE_TTL,
} from '../feed-state.js';

// ── DOM helpers ──────────────────────────────────────────────────

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
}

function icon(iconClass) {
    const i = document.createElement('i');
    i.className = `fa-solid ${iconClass}`;
    return i;
}

// ── Public API ───────────────────────────────────────────────────

export function renderStatsBar() {
    const feedItems = getFeedItemsRaw();
    const bar = el('div', 'tv-feed-stats');

    let nativeEntries = 0;
    let postTurnEntries = 0;
    let worldStateEntries = 0;
    let tvEntries = 0;
    let toolCount = 0;
    let bgCount = 0;

    for (const item of feedItems) {
        if (item.type === 'entry') {
            if (item.source === 'native') nativeEntries++;
            else if (item.source === 'post-turn') postTurnEntries++;
            else if (item.source === 'world-state') worldStateEntries++;
            else tvEntries++;
        } else if (item.type === 'tool') {
            toolCount++;
        } else if (item.type === 'background') {
            bgCount++;
        }
    }

    const triggeredEntries = nativeEntries + postTurnEntries + worldStateEntries;

    addStatPair(
        bar,
        'fa-book-open',
        triggeredEntries + tvEntries,
        `Entries (${nativeEntries} native, ${postTurnEntries} post-turn, ${worldStateEntries} world-state, ${tvEntries} TV)`,
        'var(--tv-color-primary)',
    );
    addStatPair(bar, 'fa-gear', toolCount, 'Tool calls', 'var(--tv-color-secondary)');
    addStatPair(bar, 'fa-robot', bgCount, 'Agent tasks', '#6c5ce7');

    const lbStat = el('div', 'tv-feed-stat');
    lbStat.title = 'Lorebook entries (loading…)';

    const lbIcon = icon('fa-database');
    lbIcon.style.color = '#00b894';
    lbStat.appendChild(lbIcon);

    const lbValue = el('span', 'tv-feed-stat-value', '…');
    lbStat.appendChild(lbValue);
    bar.appendChild(lbStat);

    computeLorebookStats()
        .then(({ facts, summaries, trackers, stale }) => {
            const total = facts + summaries + trackers;
            lbValue.textContent = String(total);

            const staleSuffix = stale > 0 ? `, ${stale} stale` : '';
            lbStat.title = `Lorebook: ${facts} facts, ${summaries} summaries, ${trackers} trackers${staleSuffix}`;

            if (stale > 0) {
                const staleEl = el('div', 'tv-feed-stat');
                staleEl.title = `${stale} entries injected 3+ times but never referenced by the AI`;

                const staleIcon = icon('fa-triangle-exclamation');
                staleIcon.style.color = '#e17055';
                staleEl.appendChild(staleIcon);
                staleEl.appendChild(el('span', 'tv-feed-stat-value', String(stale)));

                bar.appendChild(staleEl);
            }
        })
        .catch(() => {
            lbValue.textContent = '–';
            lbStat.title = 'Lorebook stats unavailable';
        });

    const usageBar = buildContextUsageBar();
    if (usageBar) bar.appendChild(usageBar);

    return bar;
}

export async function computeLorebookStats() {
    const now = Date.now();
    const cache = getLorebookStatsCache();

    if (cache && now - getLorebookStatsCacheTime() < LOREBOOK_STATS_CACHE_TTL) {
        return cache;
    }

    const activeBooks = getActiveTunnelVisionBooks();
    let facts = 0;
    let summaries = 0;
    let trackers = 0;
    let stale = 0;
    let loadedAnyBook = false;

    for (const bookName of activeBooks) {
        try {
            const bookData = await getCachedWorldInfo(bookName);
            if (!bookData?.entries) continue;

            loadedAnyBook = true;

            for (const key of Object.keys(bookData.entries)) {
                const entry = bookData.entries[key];
                if (entry.disable) continue;

                const title = entry.comment || '';
                if (isSummaryTitle(title)) summaries++;
                else if (isTrackerTitle(title)) trackers++;
                else facts++;
            }

            stale += countStaleEntries(bookData);
        } catch {
            // Skip unavailable books unless every active book fails
        }
    }

    if (activeBooks.length > 0 && !loadedAnyBook) {
        throw new Error('Lorebook stats unavailable');
    }

    const result = { facts, summaries, trackers, stale };
    setLorebookStatsCache(result);
    setLorebookStatsCacheTime(now);
    return result;
}

export function buildContextUsageBar() {
    const sizes = getInjectionSizes();
    if (sizes.total === 0) return null;

    const maxTokens = getMaxContextTokens();
    const maxChars = maxTokens > 0 ? maxTokens * CHARS_PER_TOKEN : 0;

    const wrapper = el('div', 'tv-context-usage');

    const labelRow = el('div', 'tv-context-usage-label');
    const labelIcon = icon('fa-microchip');
    labelIcon.style.color = '#a29bfe';
    labelRow.appendChild(labelIcon);

    const tokensUsed = Math.round(sizes.total / CHARS_PER_TOKEN);
    let labelText = `TV: ~${tokensUsed.toLocaleString()} tok`;
    if (maxTokens > 0) {
        const pct = ((sizes.total / maxChars) * 100).toFixed(1);
        labelText += ` / ${maxTokens.toLocaleString()} (${pct}%)`;
    }

    labelRow.appendChild(el('span', 'tv-context-usage-text', labelText));
    wrapper.appendChild(labelRow);

    const SLOT_CONFIG = [
        { key: 'mandatory', label: 'Prompt', color: 'var(--tv-color-primary)' },
        { key: 'worldState', label: 'World State', color: '#00b894' },
        { key: 'smartContext', label: 'Smart Context', color: '#6c5ce7' },
        { key: 'notebook', label: 'Notebook', color: '#fdcb6e' },
    ];

    const barBase = maxChars > 0 ? maxChars : sizes.total;
    const barOuter = el('div', 'tv-budget-bar');

    for (const slot of SLOT_CONFIG) {
        const val = sizes[slot.key] || 0;
        if (val === 0) continue;

        const pct = Math.max((val / barBase) * 100, 0.5);
        const seg = el('div', 'tv-budget-seg');
        seg.style.width = `${Math.min(pct, 100)}%`;
        seg.style.background = slot.color;
        seg.title = `${slot.label}: ${val.toLocaleString()} chars (~${Math.round(val / CHARS_PER_TOKEN)} tok)`;
        barOuter.appendChild(seg);
    }

    if (maxChars > 0 && sizes.total < maxChars) {
        const headroom = maxChars - sizes.total;
        const headPct = (headroom / barBase) * 100;
        const headSeg = el('div', 'tv-budget-seg tv-budget-seg-headroom');
        headSeg.style.width = `${headPct}%`;
        headSeg.title = `Available: ${headroom.toLocaleString()} chars (~${Math.round(headroom / CHARS_PER_TOKEN)} tok)`;
        barOuter.appendChild(headSeg);
    }

    wrapper.appendChild(barOuter);

    const legend = el('div', 'tv-budget-legend');
    for (const slot of SLOT_CONFIG) {
        const val = sizes[slot.key] || 0;
        if (val === 0) continue;

        const item = el('span', 'tv-budget-legend-item');
        const dot = el('span', 'tv-budget-legend-dot');
        dot.style.background = slot.color;
        item.appendChild(dot);
        item.appendChild(document.createTextNode(`${slot.label} ${Math.round(val / CHARS_PER_TOKEN)}`));
        legend.appendChild(item);
    }
    wrapper.appendChild(legend);

    const parts = [];
    if (sizes.mandatory) parts.push(`Prompt: ${sizes.mandatory}`);
    if (sizes.worldState) parts.push(`WS: ${sizes.worldState}`);
    if (sizes.smartContext) parts.push(`SC: ${sizes.smartContext}`);
    if (sizes.notebook) parts.push(`NB: ${sizes.notebook}`);

    wrapper.title = `TunnelVision injection: ${sizes.total} chars (~${tokensUsed} tokens)\n${parts.join(' | ')}`;

    return wrapper;
}

export function addStatPair(container, iconClass, value, tooltip, color) {
    const pair = el('div', 'tv-feed-stat');
    pair.title = tooltip;

    const i = icon(iconClass);
    i.style.color = color;
    pair.appendChild(i);
    pair.appendChild(el('span', 'tv-feed-stat-value', String(value)));

    container.appendChild(pair);
}