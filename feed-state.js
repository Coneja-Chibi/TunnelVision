/**
 * TunnelVision Activity Feed — Shared State
 *
 * Centralised mutable state that every feed sub-module imports.
 * Using getter/setter functions keeps the mutation surface explicit
 * and avoids issues with ES-module live-binding semantics for primitives.
 */

//── Constants ────────────────────────────────────────────────────

export const DEFAULT_MAX_FEED_ITEMS = 100;
export const MIN_FEED_ITEMS = 20;
export const MAX_FEED_ITEMS = 1000;
export const MAX_RENDERED_RETRIEVED_ENTRIES = 5;
export const LOREBOOK_STATS_CACHE_TTL = 30000;

export const TRACKER_SUGGESTION_NAME_RE = /^"([^"]+)"/;

/** Display config for each known tool name. */
export const TOOL_DISPLAY = {
    'TunnelVision_Search':{ icon: 'fa-magnifying-glass', verb: 'Searched', color: 'var(--tv-color-primary)' },
    'TunnelVision_Remember':   { icon: 'fa-brain',verb: 'Remembered', color: '#6c5ce7' },
    'TunnelVision_Update':     { icon: 'fa-pen',             verb: 'Updated', color: 'var(--tv-color-secondary)' },
    'TunnelVision_Forget':     { icon: 'fa-eraser',          verb: 'Forgot', color: '#ef4444' },
    'TunnelVision_Reorganize': { icon: 'fa-arrows-rotate',   verb: 'Reorganized', color: '#00b894' },
    'TunnelVision_Summarize':  { icon: 'fa-file-lines',      verb: 'Summarized', color: '#fdcb6e' },
    'TunnelVision_MergeSplit': { icon: 'fa-code-merge',       verb: 'Merged/Split', color: '#0984e3' },
    'TunnelVision_Notebook':   { icon: 'fa-note-sticky',verb: 'Noted', color: '#a29bfe' },
    // BlackBox
    'BlackBox_Pick':           { icon: 'fa-cube',            verb: 'Picked', color: '#00cec9' },
};

// ── Private state store ──────────────────────────────────────────

const _state = {
    /** Track which chatId the current feedItems belong to. */
    activeChatId: null,

    /** @type {import('./activity-feed.js').FeedItem[]} */
    feedItems: [],
    nextId: 0,
    feedInitialized: false,

    /** @type {HTMLElement|null} */
    triggerEl: null,
    /** @type {HTMLElement|null} */
    panelEl: null,
    /** @type {HTMLElement|null} */
    panelBody: null,
    /** @type {HTMLElement|null} */
    panelTabs: null,

    /** Whether the panel is currently showing the world state view. */
    showingWorldState: false,
    /** Whether the panel is currently showing the timeline view. */
    showingTimeline: false,
    /** Whether the panel is currently showing the arcs view. */
    showingArcs: false,
    /** Whether the panel is currently showing the health dashboard view. */
    showingHealth: false,

    /** Cached lorebook stats for the stats bar. */
    _lorebookStatsCache: null,
    _lorebookStatsCacheTime: 0,

    /** Turn-level tool call accumulator for console summary.
     *  @type {Array<{name: string, verb: string, summary: string}>} */
    turnToolCalls: [],

    hiddenToolCallRefreshTimer: null,
    hiddenToolCallRefreshNeedsSync: false,
};

// ── Getters / Setters ────────────────────────────────────────────

export function getActiveChatId() { return _state.activeChatId; }
export function setActiveChatId(v) { _state.activeChatId = v; }

export function getFeedItemsRaw() { return _state.feedItems; }
export function setFeedItems(v) { _state.feedItems = v; }

export function getNextId() { return _state.nextId; }
export function setNextId(v) { _state.nextId = v; }
export function bumpNextId() { return _state.nextId++; }

export function getFeedInitialized() { return _state.feedInitialized; }
export function setFeedInitialized(v) { _state.feedInitialized = v; }

export function getTriggerEl() { return _state.triggerEl; }
export function setTriggerEl(v) { _state.triggerEl = v; }

export function getPanelEl() { return _state.panelEl; }
export function setPanelEl(v) { _state.panelEl = v; }

export function getPanelBody() { return _state.panelBody; }
export function setPanelBody(v) { _state.panelBody = v; }

export function getPanelTabs() { return _state.panelTabs; }
export function setPanelTabs(v) { _state.panelTabs = v; }

export function getShowingWorldState() { return _state.showingWorldState; }
export function setShowingWorldState(v) { _state.showingWorldState = v; }

export function getShowingTimeline() { return _state.showingTimeline; }
export function setShowingTimeline(v) { _state.showingTimeline = v; }

export function getShowingArcs() { return _state.showingArcs; }
export function setShowingArcs(v) { _state.showingArcs = v; }

export function getShowingHealth() { return _state.showingHealth; }
export function setShowingHealth(v) { _state.showingHealth = v; }

export function getLorebookStatsCache() { return _state._lorebookStatsCache; }
export function setLorebookStatsCache(v) { _state._lorebookStatsCache = v; }

export function getLorebookStatsCacheTime() { return _state._lorebookStatsCacheTime; }
export function setLorebookStatsCacheTime(v) { _state._lorebookStatsCacheTime = v; }

export function getTurnToolCalls() { return _state.turnToolCalls; }
export function setTurnToolCalls(v) { _state.turnToolCalls = v; }

export function getHiddenToolCallRefreshTimer() { return _state.hiddenToolCallRefreshTimer; }
export function setHiddenToolCallRefreshTimer(v) { _state.hiddenToolCallRefreshTimer = v; }

export function getHiddenToolCallRefreshNeedsSync() { return _state.hiddenToolCallRefreshNeedsSync; }
export function setHiddenToolCallRefreshNeedsSync(v) { _state.hiddenToolCallRefreshNeedsSync = v; }