/**
 * TunnelVision Activity Feed — View Modules
 *
 * Contains all four panel views: World State, Timeline, Arcs, Health.
 * Each view follows an enter/exit/toggle/render pattern.
 * A unified `switchToView` dispatcher handles the mutual-exclusion logic.
 *
 * Extracted from activity-feed.js to keep the main file focused on orchestration.
 */

import { getPanelEl, getPanelBody, getPanelTabs,
    getShowingWorldState, setShowingWorldState,
    getShowingTimeline, setShowingTimeline,
    getShowingArcs, setShowingArcs,
    getShowingHealth, setShowingHealth,
    LOREBOOK_STATS_CACHE_TTL, getLorebookStatsCache, setLorebookStatsCache,
    getLorebookStatsCacheTime, setLorebookStatsCacheTime,
} from './feed-state.js';
import { truncate } from './feed-helpers.js';
import { getWorldStateText, updateWorldState, clearWorldState, isWorldStateUpdating, hasPreviousWorldState, revertWorldState } from './world-state.js';
import { getAllArcs, removeArc } from './arc-tracker.js';
import { countStaleEntries, buildHealthReport } from './entry-scoring.js';
import { getActiveTunnelVisionBooks } from './tool-registry.js';
import { isSummaryTitle, isTrackerTitle } from './tree-store.js';
import { getCachedWorldInfo, getEntryTemporal, persistWorldInfo } from './entry-manager.js';
import { getContext } from '../../../st-context.js';
import { formatShortDateTime } from './shared-utils.js';

//── DOM Helpers (local) ──────────────────────────────────────────

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

// ── Callback registration ────────────────────────────────────────
// The main activity-feed.js registers its renderAllItems function here
// so that exit-view functions can switch back to the feed without a
// circular import.

let _renderAllItems = () => {};

/**
 * Called once from activity-feed.js to wire up the renderAllItems callback.
 */
export function registerViewCallbacks({ renderAllItems }) {
    _renderAllItems = renderAllItems;
}

// ── View button CSS class names ──────────────────────────────────

const VIEW_BUTTONS = {
    worldState: { selector: '.tv-ws-btn', activeClass: 'tv-ws-active' },
    timeline:   { selector: '.tv-timeline-btn', activeClass: 'tv-timeline-active' },
    arcs:       { selector: '.tv-arcs-btn', activeClass: 'tv-arcs-active' },
    health:     { selector: '.tv-health-btn', activeClass: 'tv-health-active' },
};

/**
 * Deactivate all view button highlights except the given one.
 */
function setActiveViewButton(activeView) {
    const panelEl = getPanelEl();
    if (!panelEl) return;
    for (const [name, cfg] of Object.entries(VIEW_BUTTONS)) {
        const btn = panelEl.querySelector(cfg.selector);
        if (!btn) continue;
        if (name === activeView) {
            btn.classList.add(cfg.activeClass);
        } else {
            btn.classList.remove(cfg.activeClass);
        }
    }
}

/**
 * Clear all view button highlights.
 */
function clearAllViewButtons() {
    const panelEl = getPanelEl();
    if (!panelEl) return;
    for (const cfg of Object.values(VIEW_BUTTONS)) {
        panelEl.querySelector(cfg.selector)?.classList.remove(cfg.activeClass);
    }
}

// ══════════════════════════════════════════════════════════════════
// World State View
// ══════════════════════════════════════════════════════════════════

export function toggleWorldStateView() {
    if (getShowingWorldState()) {
        exitWorldStateView();
    } else {
        enterWorldStateView();
    }
}

export function enterWorldStateView() {
    setShowingWorldState(true);
    setShowingTimeline(false);
    setShowingArcs(false);
    setShowingHealth(false);
    const panelTabs = getPanelTabs();
    if (panelTabs) panelTabs.style.display = 'none';
    setActiveViewButton('worldState');
    renderWorldStateView();
}

export function exitWorldStateView() {
    setShowingWorldState(false);
    const panelTabs = getPanelTabs();
    if (panelTabs) panelTabs.style.display = '';
    clearAllViewButtons();
    if (getShowingTimeline()) {
        renderTimelineView();
    } else {
        _renderAllItems();
    }
}

export function renderWorldStateView() {
    const panelBody = getPanelBody();
    if (!panelBody) return;
    panelBody.replaceChildren();

    const text = getWorldStateText();
    const container = el('div', 'tv-ws-view');
    container.style.cssText = 'padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; height: 100%;';

    // Header row
    const headerRow = el('div', '');
    headerRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between;';

    const titleEl = el('span', '','Rolling World State');
    titleEl.style.cssText = 'font-weight: 600; font-size: 0.9em;';
    headerRow.appendChild(titleEl);

    const backBtn = el('button', 'tv-float-panel-btn', 'Back to Feed');
    backBtn.style.cssText = 'font-size: 0.8em; padding: 2px 8px;';
    backBtn.addEventListener('click', exitWorldStateView);
    headerRow.appendChild(backBtn);
    container.appendChild(headerRow);

    if (!text) {
        // Empty state
        const emptyMsg = el('div', 'tv-float-empty');
        emptyMsg.style.cssText = 'flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;';
        emptyMsg.appendChild(icon('fa-globe'));
        emptyMsg.appendChild(el('span', null, 'No world state yet'));
        emptyMsg.appendChild(el('span', 'tv-float-empty-sub', 'Enable Rolling World State in settings, or click Refresh to generate one now.'));

        const refreshBtn = el('button', 'tv-float-panel-btn');
        refreshBtn.style.cssText = 'margin-top: 8px; padding: 4px 12px; font-size: 0.85em; border: 1px solid rgba(255,255,255,0.15); border-radius: 4px;';
        refreshBtn.textContent = 'Refresh Now';
        refreshBtn.addEventListener('click', () => onWorldStateRefreshFromFeed(refreshBtn));
        emptyMsg.appendChild(refreshBtn);

        container.appendChild(emptyMsg);
    } else {
        // Content display
        const contentEl = el('div', 'tv-ws-content');
        contentEl.style.cssText = 'flex: 1 1 auto; min-height: 0; overflow-y: auto; white-space: pre-wrap; font-size: 0.85em; line-height: 1.5; padding: 8px; border: 1px solid rgba(255,255,255,0.08); border-radius: 6px; background: rgba(0,0,0,0.1);';
        contentEl.textContent = text;
        container.appendChild(contentEl);

        // Action buttons
        const actions = el('div', '');
        actions.style.cssText = 'display: flex; gap: 6px; flex-wrap: wrap; flex-shrink: 0;';

        const editBtn = el('button', 'tv-float-panel-btn');
        editBtn.style.cssText = 'padding: 3px 10px; font-size: 0.82em; border: 1px solid rgba(255,255,255,0.15); border-radius: 4px;';
        editBtn.appendChild(icon('fa-pen-to-square'));
        editBtn.append(' Edit');
        editBtn.addEventListener('click', () => renderWorldStateEditor(text));
        actions.appendChild(editBtn);

        const refreshBtn = el('button', 'tv-float-panel-btn');
        refreshBtn.style.cssText = 'padding: 3px 10px; font-size: 0.82em; border: 1px solid rgba(255,255,255,0.15); border-radius: 4px;';
        refreshBtn.appendChild(icon('fa-arrows-rotate'));
        refreshBtn.append(' Refresh');
        refreshBtn.addEventListener('click', () => onWorldStateRefreshFromFeed(refreshBtn));
        actions.appendChild(refreshBtn);

        if (hasPreviousWorldState()) {
            const revertBtn = el('button', 'tv-float-panel-btn');
            revertBtn.style.cssText = 'padding: 3px 10px; font-size: 0.82em; border: 1px solid rgba(255,255,255,0.15); border-radius: 4px; color: #e17055;';
            revertBtn.appendChild(icon('fa-rotate-left'));
            revertBtn.append(' Revert');
            revertBtn.addEventListener('click', () => {
                if (revertWorldState()) {
                    toastr.info('World state reverted to previous version', 'TunnelVision');
                    renderWorldStateView();
                } else {
                    toastr.warning('No previous version available', 'TunnelVision');
                }
            });
            actions.appendChild(revertBtn);
        }

        const clearBtn = el('button', 'tv-float-panel-btn');
        clearBtn.style.cssText = 'padding: 3px 10px; font-size: 0.82em; border: 1px solid rgba(255,255,255,0.15); border-radius: 4px; color: #ef4444;';
        clearBtn.appendChild(icon('fa-trash-can'));
        clearBtn.append(' Clear');
        clearBtn.addEventListener('click', () => {
            clearWorldState();
            toastr.info('World state cleared', 'TunnelVision');
            renderWorldStateView();
        });
        actions.appendChild(clearBtn);

        container.appendChild(actions);
    }

    panelBody.appendChild(container);
}

function renderWorldStateEditor(currentText) {
    const panelBody = getPanelBody();
    if (!panelBody) return;
    panelBody.replaceChildren();

    const container = el('div', 'tv-ws-editor');
    container.style.cssText = 'padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; height: 100%;';

    const headerRow = el('div', '');
    headerRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between;';
    const titleEl = el('span', '', 'Edit World State');
    titleEl.style.cssText = 'font-weight: 600; font-size: 0.9em;';
    headerRow.appendChild(titleEl);
    container.appendChild(headerRow);

    const textarea = document.createElement('textarea');
    textarea.className = 'tv-ws-textarea';
    textarea.style.cssText = 'flex: 1 1 auto; min-height: 0; width: 100%; box-sizing: border-box; resize: vertical; font-size: 0.85em; line-height: 1.5; padding: 8px; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; background: rgba(0,0,0,0.2); color: inherit; font-family: inherit;';
    textarea.value = currentText;
    container.appendChild(textarea);

    const actions = el('div', '');
    actions.style.cssText = 'display: flex; gap: 6px; flex-shrink: 0;';

    const saveBtn = el('button', 'tv-float-panel-btn');
    saveBtn.style.cssText = 'padding: 4px 14px; font-size: 0.85em; border: 1px solid rgba(255,255,255,0.2); border-radius: 4px; background: rgba(108,92,231,0.3);';
    saveBtn.textContent = 'Save';
    saveBtn.addEventListener('click', () => {
        const newText = textarea.value.trim();
        if (newText) {
            saveWorldStateFromEditor(newText);
            toastr.success('World state saved', 'TunnelVision');
        } else {
            clearWorldState();
            toastr.info('World state cleared', 'TunnelVision');
        }
        renderWorldStateView();
    });
    actions.appendChild(saveBtn);

    const cancelBtn = el('button', 'tv-float-panel-btn');
    cancelBtn.style.cssText = 'padding: 4px 14px; font-size: 0.85em; border: 1px solid rgba(255,255,255,0.1); border-radius: 4px;';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', renderWorldStateView);
    actions.appendChild(cancelBtn);

    container.appendChild(actions);
    panelBody.appendChild(container);

    textarea.focus();
}

function saveWorldStateFromEditor(text) {
    try {
        const context = getContext();
        if (!context.chatMetadata) return;
        const key = 'tunnelvision_worldstate';
        const existing = context.chatMetadata[key] || {};
        context.chatMetadata[key] = {
            ...existing,
            lastUpdated: Date.now(),
            lastUpdateMsgIdx: existing.lastUpdateMsgIdx ?? ((context.chat?.length || 1) - 1),
            text,
        };
        context.saveMetadataDebounced?.();
    } catch { /* metadata not available */ }
}

async function onWorldStateRefreshFromFeed(btn) {
    if (isWorldStateUpdating()) {
        toastr.info('World state update already in progress', 'TunnelVision');
        return;
    }

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Updating...';

    try {
        const result = await updateWorldState(true);
        if (result) {
            toastr.success('World state updated', 'TunnelVision');
        } else {
            toastr.warning('No result. Ensure you have an active chat with enough messages.', 'TunnelVision');
        }
    } catch (e) {
        toastr.error(`Update failed: ${e.message}`, 'TunnelVision');
    } finally {
        btn.disabled = false;
        btn.textContent = originalText;
        if (getShowingWorldState()) renderWorldStateView();
    }
}

// ══════════════════════════════════════════════════════════════════
// Timeline View
// ══════════════════════════════════════════════════════════════════

export function toggleTimelineView() {
    if (getShowingTimeline()) {
        exitTimelineView();
    } else {
        enterTimelineView();
    }
}

export function enterTimelineView() {
    setShowingTimeline(true);
    setShowingWorldState(false);
    setShowingArcs(false);
    setShowingHealth(false);
    const panelTabs = getPanelTabs();
    if (panelTabs) panelTabs.style.display = 'none';
    setActiveViewButton('timeline');
    renderTimelineView();
}

export function exitTimelineView() {
    setShowingTimeline(false);
    const panelTabs = getPanelTabs();
    if (panelTabs) panelTabs.style.display = '';
    clearAllViewButtons();
    _renderAllItems();
}

/**
 * Parse a leading bracket timestamp tag from entry content.
 * Supports forms like:
 *   [Day 6, Sunday 16 March 2025, around 13:10-13:20]
 *   [Sunday, 16 March 2025, morning]
 *   [Day 6, evening]
 *   [Day 6]
 *
 * Returns:
 * {
 *   day: number|null,
 *   dateKey: string|null,     // YYYY-MM-DD when parseable
 *   dateLabel: string,        // Human-readable date fragment (best effort)
 *   timeLabel: string,        // Original bracket tag
 *   groupKey: string,         // `date:YYYY-MM-DD` | `day:N` | `undated`
 *   groupLabel: string,       // Display label for timeline section
 *   rest: string
 * }
 */
export function parseTimestamp(content) {
    if (!content) {
        return {
            day: null,
            dateKey: null,
            dateLabel: '',
            timeLabel: '',
            groupKey: 'undated',
            groupLabel: 'Undated',
            rest: content || '',
        };
    }

    const match = content.match(/^\[([^\]]+)\]\s*/);
    if (!match) {
        return {
            day: null,
            dateKey: null,
            dateLabel: '',
            timeLabel: '',
            groupKey: 'undated',
            groupLabel: 'Undated',
            rest: content,
        };
    }

    const tag = match[1].trim();
    const dayMatch = tag.match(/\bDay\s+(\d+)\b/i);
    const day = dayMatch ? parseInt(dayMatch[1], 10) : null;

    // Try to capture a date-like fragment:
    // - Sunday 16 March 2025
    // - Sunday, 16 March 2025
    // - 16 March 2025
    let dateLabel = '';
    const dateFragmentMatch = tag.match(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)?\,?\s*\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/i);
    if (dateFragmentMatch) {
        dateLabel = dateFragmentMatch[0].replace(/\s+/g, ' ').trim().replace(/\s+,/g, ',');
    }

    let dateKey = null;
    if (dateLabel) {
        const normalized = dateLabel.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
        const dateObj = new Date(normalized);
        if (!Number.isNaN(dateObj.getTime())) {
            const yyyy = dateObj.getFullYear();
            const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
            const dd = String(dateObj.getDate()).padStart(2, '0');
            dateKey = `${yyyy}-${mm}-${dd}`;
        }
    }

    let groupKey = 'undated';
    let groupLabel = 'Undated';
    if (dateKey) {
        groupKey = `date:${dateKey}`;
        groupLabel = dateLabel || dateKey;
        if (day != null) groupLabel = `${groupLabel} (Day ${day})`;
    } else if (day != null) {
        groupKey = `day:${day}`;
        groupLabel = `Day ${day}`;
    }

    const rest = content.slice(match[0].length);
    return { day, dateKey, dateLabel, timeLabel: tag, groupKey, groupLabel, rest };
}

function parseTimestampTag(tag) {
    if (!tag || !String(tag).trim()) {
        return {
            day: null,
            dateKey: null,
            dateLabel: '',
            timeLabel: '',
            groupKey: 'undated',
            groupLabel: 'Undated',
        };
    }
    const parsed = parseTimestamp(`[${String(tag).trim()}] __TEMP__`);
    return {
        day: parsed.day,
        dateKey: parsed.dateKey,
        dateLabel: parsed.dateLabel,
        timeLabel: parsed.timeLabel,
        groupKey: parsed.groupKey,
        groupLabel: parsed.groupLabel,
    };
}

function hasTemporalOrdering(temporal) {
    return Number.isFinite(temporal?.turnIndex) || Number.isFinite(temporal?.createdAt);
}

function mergeTimelineTemporal(parsedTemporal, parsedFromContent) {
    if (!parsedTemporal || parsedTemporal.groupKey === 'undated') {
        return parsedFromContent;
    }

    const mergedTimeLabel = parsedFromContent.timeLabel
        && parsedFromContent.groupKey === parsedTemporal.groupKey
        && parsedFromContent.timeLabel.length > parsedTemporal.timeLabel.length
        ? parsedFromContent.timeLabel
        : (parsedTemporal.timeLabel || parsedFromContent.timeLabel);

    return {
        ...parsedFromContent,
        ...parsedTemporal,
        timeLabel: mergedTimeLabel,
    };
}

function hasLeadingTimestamp(content) {
    return /^\[[^\]]+\]\s*/.test(content || '');
}

function prependTimestamp(content, when) {
    return `[${when}] ${(content || '').trim()}`.trim();
}

async function enrichFactsFromTemporalData() {
    const activeBooks = getActiveTunnelVisionBooks();
    let updated = 0;
    let skippedNoTemporal = 0;
    let skippedHasTimestamp = 0;
    let skippedInvalid = 0;

    for (const bookName of activeBooks) {
        const bookData = await getCachedWorldInfo(bookName);
        if (!bookData?.entries) continue;

        let changed = false;
        for (const key of Object.keys(bookData.entries)) {
            const entry = bookData.entries[key];
            if (!entry || entry.disable) continue;
            if (!Number.isFinite(entry.uid)) { skippedInvalid++; continue; }

            const temporal = getEntryTemporal(bookName, entry.uid);
            const when = temporal?.when ? String(temporal.when).trim() : '';
            if (!when) { skippedNoTemporal++; continue; }

            const content = String(entry.content || '');
            if (hasLeadingTimestamp(content)) { skippedHasTimestamp++; continue; }

            entry.content = prependTimestamp(content, when);
            changed = true;
            updated++;
        }

        if (changed) {
            // eslint-disable-next-line no-await-in-loop
            await persistWorldInfo(bookName, bookData);
        }
    }

    return { updated, skippedNoTemporal, skippedHasTimestamp, skippedInvalid };
}

/**
 * Load all fact/summary entries from active TV lorebooks and group chronologically.
 * Grouping priority:
 *   1) Calendar date (when parseable from timestamp)
 *   2) Story day (Day X)
 *   3) Undated
 *
 * Returns a sorted array of { groupKey, groupLabel, day, dateKey, entries[] } groups.
 */
export async function loadTimelineEntries() {
    const activeBooks = getActiveTunnelVisionBooks();
    const items = [];

    for (const bookName of activeBooks) {
        try {
            const bookData = await getCachedWorldInfo(bookName);
            if (!bookData?.entries) continue;
            for (const key of Object.keys(bookData.entries)) {
                const entry = bookData.entries[key];
                if (entry.disable) continue;
                const title = entry.comment || '';
                if (isTrackerTitle(title)) continue;

                const isSummary = isSummaryTitle(title);
                const temporal = Number.isFinite(entry.uid) ? getEntryTemporal(bookName, entry.uid) : null;
                const temporalWhen = temporal?.when ? String(temporal.when).trim() : '';
                const parsedFromContent = parseTimestamp(entry.content || '');
                const parsedTemporal = temporalWhen ? parseTimestampTag(temporalWhen) : null;
                const parsed = mergeTimelineTemporal(parsedTemporal, parsedFromContent);

                items.push({
                    uid: entry.uid ?? null,
                    title,
                    content: parsedFromContent.rest,
                    timeLabel: parsed.timeLabel,
                    day: parsed.day,
                    dateKey: parsed.dateKey,
                    dateLabel: parsed.dateLabel,
                    groupKey: parsed.groupKey,
                    groupLabel: parsed.groupLabel,
                    isSummary,
                    lorebook: bookName,
                    sortTurnIndex: Number.isFinite(temporal?.turnIndex) ? temporal.turnIndex : null,
                    sortCreatedAt: Number.isFinite(temporal?.createdAt) ? temporal.createdAt : null,
                });
            }
        } catch { /* skip unavailable books */ }
    }

    // Sort chronologically:
    // - dated groups first by date asc
    // - then day-only groups by day asc
    // - undated last
    items.sort((a, b) => {
        const aHasDate = !!a.dateKey;
        const bHasDate = !!b.dateKey;
        if (aHasDate && bHasDate) return a.dateKey.localeCompare(b.dateKey);
        if (aHasDate) return -1;
        if (bHasDate) return 1;

        const aHasDay = a.day != null;
        const bHasDay = b.day != null;
        if (aHasDay && bHasDay) return a.day - b.day;
        if (aHasDay) return -1;
        if (bHasDay) return 1;

        const aHasTemporalOrder = a.sortTurnIndex != null || a.sortCreatedAt != null;
        const bHasTemporalOrder = b.sortTurnIndex != null || b.sortCreatedAt != null;
        if (aHasTemporalOrder && bHasTemporalOrder) {
            const turnDelta = (a.sortTurnIndex ?? Number.MAX_SAFE_INTEGER) - (b.sortTurnIndex ?? Number.MAX_SAFE_INTEGER);
            if (turnDelta !== 0) return turnDelta;

            const createdDelta = (a.sortCreatedAt ?? Number.MAX_SAFE_INTEGER) - (b.sortCreatedAt ?? Number.MAX_SAFE_INTEGER);
            if (createdDelta !== 0) return createdDelta;
        } else if (aHasTemporalOrder) {
            return -1;
        } else if (bHasTemporalOrder) {
            return 1;
        }

        return 0;
    });

    // Group by normalized key
    const groups = [];
    const byKey = new Map();

    for (const item of items) {
        if (!byKey.has(item.groupKey)) {
            const group = {
                groupKey: item.groupKey,
                groupLabel: item.groupLabel,
                day: item.day ?? null,
                dateKey: item.dateKey ?? null,
                entries: [],
            };
            byKey.set(item.groupKey, group);
            groups.push(group);
        }
        byKey.get(item.groupKey).entries.push(item);
    }

    for (const group of groups) {
        group.entries.sort((left, right) => {
            const turnDelta = (left.sortTurnIndex ?? Number.MAX_SAFE_INTEGER) - (right.sortTurnIndex ?? Number.MAX_SAFE_INTEGER);
            if (turnDelta !== 0) return turnDelta;

            const createdDelta = (left.sortCreatedAt ?? Number.MAX_SAFE_INTEGER) - (right.sortCreatedAt ?? Number.MAX_SAFE_INTEGER);
            if (createdDelta !== 0) return createdDelta;

            return String(left.title || '').localeCompare(String(right.title || ''));
        });
    }

    return groups;
}

export async function renderTimelineView() {
    const panelBody = getPanelBody();
    if (!panelBody) return;
    panelBody.replaceChildren();

    const container = el('div', 'tv-timeline-view');

    // Header row
    const headerRow = el('div', 'tv-timeline-header');
    const titleEl = el('span', 'tv-timeline-title');
    titleEl.appendChild(icon('fa-clock-rotate-left'));
    titleEl.append(' Timeline');
    headerRow.appendChild(titleEl);

    const enrichBtn = el('button', 'tv-float-panel-btn', 'Enrich from Temporal');
    enrichBtn.style.cssText = 'font-size: 0.8em; padding: 2px 8px; margin-right: 6px;';
    enrichBtn.addEventListener('click', async () => {
        enrichBtn.disabled = true;
        const originalText = enrichBtn.textContent;
        enrichBtn.textContent = 'Enriching...';
        try {
            const result = await enrichFactsFromTemporalData();
            console.log(`[TunnelVision] Temporal enrich complete: updated=${result.updated}, skippedNoTemporal=${result.skippedNoTemporal}, skippedHasTimestamp=${result.skippedHasTimestamp}, skippedInvalid=${result.skippedInvalid}`);
            await renderTimelineView();
        } catch (err) {
            console.warn('[TunnelVision] Temporal enrich failed:', err);
            enrichBtn.textContent = 'Failed';
            setTimeout(() => { enrichBtn.textContent = originalText; enrichBtn.disabled = false; }, 1200);
            return;
        }
        enrichBtn.textContent = originalText;
        enrichBtn.disabled = false;
    });
    headerRow.appendChild(enrichBtn);

    const backBtn = el('button', 'tv-float-panel-btn', 'Back to Feed');
    backBtn.style.cssText = 'font-size: 0.8em; padding: 2px 8px;';
    backBtn.addEventListener('click', exitTimelineView);
    headerRow.appendChild(backBtn);
    container.appendChild(headerRow);

    // Loading state
    const loadingEl = el('div', 'tv-timeline-loading');
    loadingEl.appendChild(el('span', 'tv_loading'));
    loadingEl.appendChild(el('span', null, 'Loading entries...'));
    container.appendChild(loadingEl);
    panelBody.appendChild(container);

    try {
        const groups = await loadTimelineEntries();
        loadingEl.remove();

        if (groups.length === 0) {
            const emptyEl = el('div', 'tv-float-empty');
            emptyEl.style.cssText = 'flex: 1;';
            emptyEl.appendChild(icon('fa-clock-rotate-left'));
            emptyEl.appendChild(el('span', null, 'No facts or summaries yet'));
            emptyEl.appendChild(el('span', 'tv-float-empty-sub', 'Facts and summaries will appear here grouped chronologically by date (when available) and Day labels'));
            container.appendChild(emptyEl);
            return;
        }

        // Stats line
        let totalFacts = 0, totalSummaries = 0;
        for (const g of groups) {
            for (const e of g.entries) {
                e.isSummary ? totalSummaries++ : totalFacts++;
            }
        }
        const statsEl = el('div', 'tv-timeline-stats');
        statsEl.textContent = `${totalFacts} fact${totalFacts !== 1 ? 's' : ''}, ${totalSummaries} summar${totalSummaries !== 1 ? 'ies' : 'y'} across ${groups.length} group${groups.length !== 1 ? 's' : ''}`;
        container.appendChild(statsEl);

        // Timeline body
        const timelineBody = el('div', 'tv-timeline-body');

        for (const group of groups) {
            // Day header
            const dayHeader = el('div', 'tv-timeline-day-header');
            const dayDot = el('div', 'tv-timeline-day-dot');
            dayHeader.appendChild(dayDot);
            const dayLabel = group.groupLabel || (group.day != null ? `Day ${group.day}` : 'Undated');
            dayHeader.appendChild(el('span', 'tv-timeline-day-label', dayLabel));
            dayHeader.appendChild(el('span', 'tv-timeline-day-count', `${group.entries.length}`));
            timelineBody.appendChild(dayHeader);

            // Entries for this day
            const entriesContainer = el('div', 'tv-timeline-entries');
            for (const entry of group.entries) {
                entriesContainer.appendChild(buildTimelineEntry(entry));
            }
            timelineBody.appendChild(entriesContainer);
        }

        container.appendChild(timelineBody);
    } catch (err) {
        loadingEl.remove();
        container.appendChild(el('div', 'tv-feed-expand-empty', `Failed to load timeline: ${err.message}`));
    }
}

function buildTimelineEntry(entry) {
    const row = el('div', `tv-timeline-entry${entry.isSummary ? ' tv-timeline-summary' : ''}`);

    // Timeline connector
    const connector = el('div', 'tv-timeline-connector');
    const dot = el('div', 'tv-timeline-dot');
    if (entry.isSummary) {
        dot.classList.add('tv-timeline-dot-summary');
    }
    connector.appendChild(dot);
    row.appendChild(connector);

    // Entry content
    const body = el('div', 'tv-timeline-entry-body');

    // Title bar
    const titleRow = el('div', 'tv-timeline-entry-title-row');
    const entryIcon = entry.isSummary
        ? icon('fa-file-lines')
        : icon('fa-brain');
    entryIcon.classList.add('tv-timeline-entry-icon');
    entryIcon.style.color = entry.isSummary ? '#fdcb6e' : '#6c5ce7';
    titleRow.appendChild(entryIcon);
    titleRow.appendChild(el('span', 'tv-timeline-entry-title', truncate(entry.title, 60)));
    if (entry.timeLabel) {
        titleRow.appendChild(el('span', 'tv-timeline-entry-time', entry.timeLabel));
    }
    body.appendChild(titleRow);

    // Content preview (collapsible)
    const preview = el('div', 'tv-timeline-entry-preview');
    preview.textContent = truncate(entry.content, 120);
    body.appendChild(preview);

    // Expandable full content (hidden by default)
    const fullContent = el('div', 'tv-timeline-entry-full');
    fullContent.textContent = entry.content;
    fullContent.style.display = 'none';
    body.appendChild(fullContent);

    // Click to toggle expand
    row.addEventListener('click', () => {
        const isExpanded = row.classList.toggle('tv-timeline-expanded');
        preview.style.display = isExpanded ? 'none' : '';fullContent.style.display = isExpanded ? '' : 'none';
    });

    row.appendChild(body);
    return row;
}

// ══════════════════════════════════════════════════════════════════
// Arcs View
// ══════════════════════════════════════════════════════════════════

const ARC_STATUS_COLORS = {
    active: '#00b894',
    stalled: '#fdcb6e',
    resolved: '#636e72',
    abandoned: '#d63031',
};

const ARC_STATUS_ICONS = {
    active: 'fa-circle-play',
    stalled: 'fa-circle-pause',
    resolved: 'fa-circle-check',
    abandoned: 'fa-circle-xmark',
};

export function toggleArcsView() {
    if (getShowingArcs()) {
        exitArcsView();
    } else {
        enterArcsView();
    }
}

export function enterArcsView() {
    setShowingArcs(true);
    setShowingWorldState(false);
    setShowingTimeline(false);
    setShowingHealth(false);
    const panelTabs = getPanelTabs();
    if (panelTabs) panelTabs.style.display = 'none';
    setActiveViewButton('arcs');
    renderArcsView();
}

export function exitArcsView() {
    setShowingArcs(false);
    const panelTabs = getPanelTabs();
    if (panelTabs) panelTabs.style.display = '';
    clearAllViewButtons();
    _renderAllItems();
}

function renderArcsView() {
    const panelBody = getPanelBody();
    if (!panelBody) return;
    panelBody.replaceChildren();

    const container = el('div', 'tv-arcs-view');

    // Header
    const headerRow = el('div', 'tv-arcs-header');
    const titleEl = el('span', 'tv-arcs-title');
    titleEl.appendChild(icon('fa-diagram-project'));
    titleEl.append(' Narrative Arcs');
    headerRow.appendChild(titleEl);

    const backBtn = el('button', 'tv-float-panel-btn', 'Back to Feed');
    backBtn.style.cssText = 'font-size: 0.8em; padding: 2px 8px;';
    backBtn.addEventListener('click', exitArcsView);
    headerRow.appendChild(backBtn);
    container.appendChild(headerRow);

    const arcs = getAllArcs();

    if (arcs.length === 0) {
        const emptyEl = el('div', 'tv-float-empty');
        emptyEl.style.cssText = 'flex: 1;';
        emptyEl.appendChild(icon('fa-diagram-project'));
        emptyEl.appendChild(el('span', null, 'No narrative arcs yet'));
        emptyEl.appendChild(el('span', 'tv-float-empty-sub', 'Story arcs will be detected and tracked automatically by the post-turn processor as the narrative progresses'));
        container.appendChild(emptyEl);
        panelBody.appendChild(container);
        return;
    }

    // Stats
    const active = arcs.filter(a => a.status === 'active').length;
    const stalled = arcs.filter(a => a.status === 'stalled').length;
    const resolved = arcs.filter(a => a.status === 'resolved' || a.status === 'abandoned').length;
    const statsEl = el('div', 'tv-arcs-stats');
    statsEl.textContent = `${active} active, ${stalled} stalled, ${resolved} resolved`;
    container.appendChild(statsEl);

    // Arc list
    const arcList = el('div', 'tv-arcs-list');

    const statusOrder = { active: 0, stalled: 1, resolved: 2, abandoned: 3 };
    const sorted = [...arcs].sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9));

    for (const arc of sorted) {
        arcList.appendChild(buildArcCard(arc));
    }

    container.appendChild(arcList);
    panelBody.appendChild(container);
}

function buildArcCard(arc) {
    const card = el('div', `tv-arc-card tv-arc-${arc.status}`);

    const statusColor = ARC_STATUS_COLORS[arc.status] || '#636e72';
    const statusIcon = ARC_STATUS_ICONS[arc.status] || 'fa-circle-question';

    // Title row
    const titleRow = el('div', 'tv-arc-title-row');
    const arcIcon = icon(statusIcon);
    arcIcon.style.color = statusColor;
    titleRow.appendChild(arcIcon);
    titleRow.appendChild(el('span', 'tv-arc-title', arc.title));
    const statusBadge = el('span', 'tv-arc-status');
    statusBadge.textContent = arc.status;
    statusBadge.style.color = statusColor;
    titleRow.appendChild(statusBadge);
    
    // Delete button
    const deleteBtn = el('button', 'tv-arc-delete-btn');
    deleteBtn.title = 'Remove this arc';
    deleteBtn.style.cssText = 'background: none; border: none; cursor: pointer; color: #d63031; font-size: 0.9em; padding: 4px 8px; margin-left: auto;';
    const deleteIcon = icon('fa-trash');
    deleteIcon.style.cssText = 'margin-right: 4px;';
    deleteBtn.appendChild(deleteIcon);
    deleteBtn.append('Remove');
    deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Remove arc "${arc.title}"?`)) {
            removeArc(arc.id);
            renderArcsView();
        }
    });
    titleRow.appendChild(deleteBtn);
    
    card.appendChild(titleRow);

    // Progression
    if (arc.progression) {
        const progEl = el('div', 'tv-arc-progression');
        progEl.textContent = arc.progression;
        card.appendChild(progEl);
    }

    // Timestamp
    const timeEl = el('div', 'tv-arc-time');
    const updatedDate = new Date(arc.updatedAt);
    timeEl.textContent = `Updated ${formatShortDateTime(updatedDate)}`;
    card.appendChild(timeEl);

    // Click to expand history
    if (arc.history && arc.history.length > 0) {
        card.classList.add('tv-feed-clickable');
        card.addEventListener('click', () => {
            const existing = card.querySelector('.tv-arc-history');
            if (existing) {
                existing.remove();
                card.classList.remove('expanded');
                return;
            }
            card.classList.add('expanded');
            const historyEl = el('div', 'tv-arc-history');
            const histHeader = el('div', 'tv-arc-history-header', 'History');
            historyEl.appendChild(histHeader);

            for (const h of [...arc.history].reverse()) {
                const hRow = el('div', 'tv-arc-history-item');
                const hStatus = el('span', 'tv-arc-history-status');
                hStatus.textContent = h.status;
                hStatus.style.color = ARC_STATUS_COLORS[h.status] || '#636e72';
                hRow.appendChild(hStatus);
                hRow.appendChild(el('span', 'tv-arc-history-text', h.progression || '(no note)'));
                if (h.timestamp) {
                    const hTime = new Date(h.timestamp);
                    hRow.appendChild(el('span', 'tv-arc-history-time', formatShortDateTime(hTime)));
                }
                historyEl.appendChild(hRow);
            }
            card.appendChild(historyEl);
        });
    }

    return card;
}

// ══════════════════════════════════════════════════════════════════
// Health Dashboard View
// ══════════════════════════════════════════════════════════════════

export function toggleHealthView() {
    if (getShowingHealth()) {
        exitHealthView();
    } else {
        enterHealthView();
    }
}

export function enterHealthView() {
    setShowingHealth(true);
    setShowingWorldState(false);
    setShowingTimeline(false);
    setShowingArcs(false);
    const panelTabs = getPanelTabs();
    if (panelTabs) panelTabs.style.display = 'none';
    setActiveViewButton('health');
    renderHealthView();
}

export function exitHealthView() {
    setShowingHealth(false);
    const panelTabs = getPanelTabs();
    if (panelTabs) panelTabs.style.display = '';
    clearAllViewButtons();
    _renderAllItems();
}

async function renderHealthView() {
    const panelBody = getPanelBody();
    if (!panelBody) return;
    panelBody.replaceChildren();

    const container = el('div', 'tv-health-view');

    // Header
    const headerRow = el('div', 'tv-health-header');
    const titleEl = el('span', 'tv-health-title');
    titleEl.appendChild(icon('fa-heart-pulse'));
    titleEl.append(' Lorebook Health');
    headerRow.appendChild(titleEl);

    const backBtn = el('button', 'tv-float-panel-btn', 'Back to Feed');
    backBtn.style.cssText = 'font-size: 0.8em; padding: 2px 8px;';
    backBtn.addEventListener('click', exitHealthView);
    headerRow.appendChild(backBtn);
    container.appendChild(headerRow);

    // Loading
    const loadingEl = el('div', 'tv-health-loading');
    loadingEl.appendChild(el('span', 'tv_loading'));
    loadingEl.appendChild(el('span', null, 'Analyzing lorebook health...'));
    container.appendChild(loadingEl);
    panelBody.appendChild(container);

    try {
        const activeBooks = getActiveTunnelVisionBooks();
        if (activeBooks.length === 0) {
            loadingEl.remove();
            const emptyEl = el('div', 'tv-float-empty');
            emptyEl.style.cssText = 'flex: 1;';
            emptyEl.appendChild(icon('fa-heart-pulse'));
            emptyEl.appendChild(el('span', null, 'No active lorebooks'));
            emptyEl.appendChild(el('span', 'tv-float-empty-sub', 'Enable a lorebook in TunnelVision settings to see health metrics'));
            container.appendChild(emptyEl);
            return;
        }

        // Merge reports across all active books
        const mergedReport = {
            totalEntries: 0, facts: 0, summaries: 0, trackers: 0, disabled: 0,
            categoryDistribution: [],
            staleEntries: [], orphanedEntries: [], noTimestamp: [],avgLength: 0, outlierEntries: [], duplicateCandidates: [],growthRate: 0, duplicateDensity: 0, compressionRatio: 1.0,
            neverReferencedCount: 0, metadataSizes: [],
        };
        let totalLength = 0;
        let totalDupUids = 0, totalForDensity = 0;
        let compressionSum = 0, compressionCount = 0;

        for (const bookName of activeBooks) {
            try {
                const bookData = await getCachedWorldInfo(bookName);
                if (!bookData?.entries) continue;
                const report = buildHealthReport(bookName, bookData);
                mergedReport.totalEntries += report.totalEntries;
                mergedReport.facts += report.facts;
                mergedReport.summaries += report.summaries;
                mergedReport.trackers += report.trackers;
                mergedReport.disabled += report.disabled;
                mergedReport.categoryDistribution.push(...report.categoryDistribution);
                mergedReport.staleEntries.push(...report.staleEntries);
                mergedReport.orphanedEntries.push(...report.orphanedEntries);
                mergedReport.noTimestamp.push(...report.noTimestamp);
                mergedReport.outlierEntries.push(...report.outlierEntries);
                mergedReport.duplicateCandidates.push(...report.duplicateCandidates);
                totalLength += report.avgLength * report.totalEntries;
                mergedReport.neverReferencedCount += report.neverReferencedCount || 0;

                if (report.growthRate > mergedReport.growthRate) mergedReport.growthRate = report.growthRate;
                if (report.duplicateDensity > 0) {
                    totalDupUids += report.duplicateDensity * report.totalEntries;
                    totalForDensity += report.totalEntries;
                }
                if (report.compressionRatio !==1.0) {
                    compressionSum += report.compressionRatio;
                    compressionCount++;
                }
                if (report.metadataSizes?.length > 0 && mergedReport.metadataSizes.length === 0) {
                    mergedReport.metadataSizes = report.metadataSizes;
                }
            } catch { /* skip unavailable books */ }
        }

        mergedReport.avgLength = mergedReport.totalEntries > 0 ? Math.round(totalLength / mergedReport.totalEntries) : 0;
        mergedReport.categoryDistribution.sort((a, b) => b.count - a.count);
        mergedReport.duplicateCandidates.sort((a, b) => b.similarity - a.similarity);
        mergedReport.outlierEntries.sort((a, b) => b.length - a.length);
        if (totalForDensity > 0) mergedReport.duplicateDensity = Math.round((totalDupUids / totalForDensity) * 100) / 100;
        if (compressionCount > 0) mergedReport.compressionRatio = Math.round((compressionSum / compressionCount) * 100) / 100;

        loadingEl.remove();

        // Build dashboard content
        const body = el('div', 'tv-health-body');

        // ── Entry type breakdown ──
        const typeSection = el('div', 'tv-health-section');
        typeSection.appendChild(el('div', 'tv-health-section-title', 'Entry Breakdown'));
        const typeGrid = el('div', 'tv-health-type-grid');
        addHealthStat(typeGrid, 'Total', mergedReport.totalEntries, '#a29bfe');
        addHealthStat(typeGrid, 'Facts', mergedReport.facts, '#6c5ce7');
        addHealthStat(typeGrid, 'Summaries', mergedReport.summaries, '#fdcb6e');
        addHealthStat(typeGrid, 'Trackers', mergedReport.trackers, '#00b894');
        if (mergedReport.disabled > 0) addHealthStat(typeGrid, 'Disabled', mergedReport.disabled, '#636e72');
        typeSection.appendChild(typeGrid);

        const avgLine = el('div', 'tv-health-avg');
        avgLine.textContent = `Average entry length: ${mergedReport.avgLength} chars`;
        typeSection.appendChild(avgLine);
        body.appendChild(typeSection);

        // ── Scalability Metrics ──
        const scaleSection = el('div', 'tv-health-section');
        scaleSection.appendChild(el('div', 'tv-health-section-title', 'Scalability Metrics'));
        const scaleGrid = el('div', 'tv-health-type-grid');

        addHealthStat(scaleGrid, 'Growth', `${mergedReport.growthRate}`, '#a29bfe');
        scaleGrid.lastElementChild.title = `${mergedReport.growthRate} entries per100 chat turns`;
        scaleGrid.lastElementChild.querySelector('.tv-health-stat-label').textContent = '/100 turns';

        const dupPctNum = mergedReport.duplicateDensity * 100;
        const dupPct = dupPctNum.toFixed(0);
        addHealthStat(scaleGrid, 'Dup Density', `${dupPct}%`, dupPctNum > 15 ? '#e17055' : dupPctNum > 5 ? '#fdcb6e' : '#00b894');
        scaleGrid.lastElementChild.title = `${dupPct}% of entries share >70% similarity with another entry`;

        const compRatio = mergedReport.compressionRatio;
        const compLabel = `${(compRatio * 100).toFixed(0)}%`;
        addHealthStat(scaleGrid, 'Compression', compLabel, compRatio < 0.8 ? '#00b894' : compRatio > 1.2 ? '#e17055' : '#fdcb6e');
        scaleGrid.lastElementChild.title = `Current avg length is ${compLabel} of original avg length`;

        addHealthStat(scaleGrid, 'Never Ref\'d', String(mergedReport.neverReferencedCount),
            mergedReport.neverReferencedCount > 20 ? '#e17055' : mergedReport.neverReferencedCount > 5 ? '#fdcb6e' : '#636e72');
        scaleGrid.lastElementChild.title = `${mergedReport.neverReferencedCount} entries have been injected but never referenced by the AI`;

        scaleSection.appendChild(scaleGrid);

        // Metadata size breakdown
        if (mergedReport.metadataSizes?.length > 0) {
            const metaRow = el('div', 'tv-health-meta-sizes');
            const metaLabel = el('div', 'tv-health-avg');
            const totalMeta = mergedReport.metadataSizes.reduce((s, m) => s + m.size, 0);
            metaLabel.textContent = `Metadata: ${(totalMeta / 1024).toFixed(1)} KB total`;
            metaRow.appendChild(metaLabel);

            const metaColors = ['var(--tv-color-primary)', '#6c5ce7', '#00b894', '#fdcb6e', '#0984e3', '#e17055', '#a29bfe'];

            const metaBar = el('div', 'tv-budget-bar');
            metaBar.style.marginTop = '4px';
            for (let i = 0; i < mergedReport.metadataSizes.length; i++) {
                const m = mergedReport.metadataSizes[i];
                const pct = Math.max((m.size / totalMeta) * 100, 2);
                const seg = el('div', 'tv-budget-seg');
                seg.style.width = `${pct}%`;
                seg.style.background = metaColors[i % metaColors.length];
                seg.title = `${m.key}: ${(m.size / 1024).toFixed(1)} KB`;
                metaBar.appendChild(seg);
            }
            metaRow.appendChild(metaBar);

            const metaLegend = el('div', 'tv-budget-legend');
            metaLegend.style.marginTop = '2px';
            for (let i = 0; i < mergedReport.metadataSizes.length; i++) {
                const m = mergedReport.metadataSizes[i];
                const item = el('span', 'tv-budget-legend-item');
                const dot = el('span', 'tv-budget-legend-dot');
                dot.style.background = metaColors[i % metaColors.length];
                item.appendChild(dot);
                item.appendChild(document.createTextNode(`${m.key} ${(m.size / 1024).toFixed(1)}K`));
                metaLegend.appendChild(item);
            }
            metaRow.appendChild(metaLegend);scaleSection.appendChild(metaRow);
        }

        body.appendChild(scaleSection);

        // ── Category distribution ──
        if (mergedReport.categoryDistribution.length > 0) {
            const catSection = el('div', 'tv-health-section');
            catSection.appendChild(el('div', 'tv-health-section-title', 'Category Distribution'));
            const maxCount = mergedReport.categoryDistribution[0]?.count || 1;
            const catList = el('div', 'tv-health-cat-list');
            for (const cat of mergedReport.categoryDistribution.slice(0, 12)) {
                const catRow = el('div', 'tv-health-cat-row');
                const catLabel = el('span', 'tv-health-cat-label', truncate(cat.label, 25));
                catRow.appendChild(catLabel);
                const barWrap = el('div', 'tv-health-cat-bar-wrap');
                const bar = el('div', 'tv-health-cat-bar');
                bar.style.width = `${(cat.count / maxCount) * 100}%`;
                barWrap.appendChild(bar);
                catRow.appendChild(barWrap);
                catRow.appendChild(el('span', 'tv-health-cat-count', String(cat.count)));
                catList.appendChild(catRow);
            }
            if (mergedReport.categoryDistribution.length > 12) {
                catList.appendChild(el('div', 'tv-health-more', `+${mergedReport.categoryDistribution.length - 12} more categories`));
            }
            catSection.appendChild(catList);
            body.appendChild(catSection);
        }

        // ── Issues ──
        const issues = [];
        if (mergedReport.staleEntries.length > 0) {
            issues.push({
                title: `${mergedReport.staleEntries.length} Stale Entries`,
                icon: 'fa-ghost',
                color: '#e17055',
                desc: 'Injected 3+ times but never referenced by the AI',
                items: mergedReport.staleEntries.slice(0, 10),
            });
        }
        if (mergedReport.orphanedEntries.length > 0) {
            issues.push({
                title: `${mergedReport.orphanedEntries.length} Orphaned Entries`,
                icon: 'fa-link-slash',
                color: '#fdcb6e',
                desc: 'Not assigned to any tree category',
                items: mergedReport.orphanedEntries.slice(0, 10),
            });
        }
        if (mergedReport.noTimestamp.length > 0) {
            issues.push({
                title: `${mergedReport.noTimestamp.length} Without Timestamps`,
                icon: 'fa-calendar-xmark',
                color: '#74b9ff',
                desc: 'Fact entries missing [Day X] prefix',
                items: mergedReport.noTimestamp.slice(0, 10),
            });
        }
        if (mergedReport.outlierEntries.length > 0) {
            issues.push({
                title: `${mergedReport.outlierEntries.length} Oversized Entries`,
                icon: 'fa-weight-hanging',
                color: '#a29bfe',
                desc: `Significantly longer than average (${mergedReport.avgLength} chars)`,
                items: mergedReport.outlierEntries.slice(0, 10).map(e => ({
                    ...e, title: `${e.title} (${e.length} chars)`,
                })),
            });
        }
        if (mergedReport.duplicateCandidates.length > 0) {
            issues.push({
                title: `${mergedReport.duplicateCandidates.length} Duplicate Candidates`,
                icon: 'fa-clone',
                color: 'var(--tv-color-primary)',
                desc: 'Entries with high content similarity',
                items: mergedReport.duplicateCandidates.slice(0, 10).map(d => ({
                    uid: d.uidA,
                    title: `${truncate(d.titleA, 20)} ↔ ${truncate(d.titleB, 20)} (${(d.similarity * 100).toFixed(0)}%)`,
                    bookName: d.bookName,
                })),
            });
        }

        if (issues.length === 0) {
            const healthyEl = el('div', 'tv-health-healthy');
            healthyEl.appendChild(icon('fa-circle-check'));
            healthyEl.appendChild(el('span', null, 'Lorebook looks healthy!'));
            healthyEl.appendChild(el('span', 'tv-float-empty-sub', 'No stale entries, orphans, or duplicates detected'));
            body.appendChild(healthyEl);
        } else {
            for (const issue of issues) {
                body.appendChild(buildIssueSection(issue));
            }
        }

        container.appendChild(body);
    } catch (err) {
        loadingEl.remove();
        container.appendChild(el('div', 'tv-feed-expand-empty', `Health analysis failed: ${err.message}`));
    }
}

function addHealthStat(container, label, value, color) {
    const stat = el('div', 'tv-health-stat');
    const valEl = el('div', 'tv-health-stat-value');
    valEl.textContent = String(value);
    valEl.style.color = color;
    stat.appendChild(valEl);
    stat.appendChild(el('div', 'tv-health-stat-label', label));
    container.appendChild(stat);
}

function buildIssueSection(issue) {
    const section = el('div', 'tv-health-issue');

    const header = el('div', 'tv-health-issue-header');
    const issueIcon = icon(issue.icon);
    issueIcon.style.color = issue.color;
    header.appendChild(issueIcon);
    header.appendChild(el('span', 'tv-health-issue-title', issue.title));
    section.appendChild(header);

    section.appendChild(el('div', 'tv-health-issue-desc', issue.desc));

    const list = el('div', 'tv-health-issue-list');
    for (const item of issue.items) {
        const row = el('div', 'tv-health-issue-item');
        row.appendChild(el('span', 'tv-health-issue-uid', `#${item.uid}`));
        row.appendChild(el('span', 'tv-health-issue-name', truncate(item.title, 45)));
        list.appendChild(row);
    }
    const remaining = (issue.items.length < 10) ? 0 : 0;
    section.appendChild(list);

    section.classList.add('tv-feed-clickable');
    const listEl = list;
    listEl.style.display = 'none';
    section.addEventListener('click', () => {
        const expanded = section.classList.toggle('expanded');
        listEl.style.display = expanded ? '' : 'none';
    });

    return section;
}