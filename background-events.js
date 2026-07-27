/**
 * TunnelVision Background Events
 *
 * Lightweight event bus for background operations (post-turn processing,
 * world-state updates, auto-summary, lifecycle maintenance).
 *
 * Extracted from activity-feed.js to break circular dependencies:
 * modules that produce background events no longer need to import
 * from the activity-feed (which imports back from them for UI).
 *
 * activity-feed.js registers its UI callbacks during init via
 * _registerFeedCallbacks(), wiring the visual side without a cycle.
 */

// ── UI Callbacks (registered by activity-feed.js at init) ────────

/** @type {((items: Object[]) => void) | null} */
let _addFeedItems = null;
/** @type {((active: boolean) => void) | null} */
let _setTriggerActive = null;
/** @type {(() => void) | null} */
let _refreshTasksUI = null;
/** @type {(() => Object[]) | null} */
let _getFeedItems = null;

/**
 * Called once by activity-feed.js during initActivityFeed().
 * @param {{ addFeedItems: Function, setTriggerActive: Function, refreshTasksUI: Function, getFeedItems?: Function }} cbs
 */
export function _registerFeedCallbacks({ addFeedItems, setTriggerActive, refreshTasksUI, getFeedItems }) {
    _addFeedItems = addFeedItems;
    _setTriggerActive = setTriggerActive;
    _refreshTasksUI = refreshTasksUI;
    if (getFeedItems) _getFeedItems = getFeedItems;
}

// ── Background Active Count ──────────────────────────────────────

let _activeBackgroundCount = 0;

function setBackgroundActive(active) {
    _activeBackgroundCount += active ? 1 : -1;
    if (_activeBackgroundCount < 0) _activeBackgroundCount = 0;
    _setTriggerActive?.(_activeBackgroundCount > 0);
}

// ── Background Events ────────────────────────────────────────────

let _bgEventId = 1_000_000;

/**
 * Log a background agent event to the activity feed.
 * @param {Object} opts
 * @param {string} opts.icon - FontAwesome icon class (e.g. 'fa-brain')
 * @param {string} opts.verb - Action label (e.g. 'Scene archived')
 * @param {string} opts.color - CSS color for the label
 * @param {string} [opts.summary] - Short description text
 * @param {string[]} [opts.details] - Extra detail tags
 * @param {Object} [opts.action] - Optional action button config
 * @param {Object[]} [opts.relatedEntries] - Optional related entry summaries shown on expand
 * @param {string} [opts.preWarmSource] - Optional prewarm source marker for feed styling
 */
export function addBackgroundEvent({ icon, verb, color, summary = '', details = [], action = null, relatedEntries = [], preWarmSource = '' }) {
    const item = {
        id: _bgEventId++,
        type: 'background',
        icon,
        verb,
        color,
        summary,
        timestamp: Date.now(),
        details: details.filter(Boolean),
    };
    if (action) item.action = action;
    if (Array.isArray(relatedEntries) && relatedEntries.length > 0) {
        item.relatedEntries = relatedEntries.filter(entry => entry && typeof entry === 'object');
    }
    if (typeof preWarmSource === 'string' && preWarmSource) {
        item.preWarmSource = preWarmSource;
    }
    _addFeedItems?.([item]);
}

/**
 * Emit entry-style activation items to the activity feed.
 * Used by smart-context and other non-tool, non-native retrieval paths
 * so injected entries appear the same way as native WI activations.
 *
 * @param {Array<{
 *   source?: string,
 *   lorebook?: string,
 *   uid?: number|null,
 *   title?: string,
 *   keys?: string[],
 *   timestamp?: number,
 * }>} entries
 */
export function addEntryActivationEvents(entries) {
    if (!_addFeedItems || !Array.isArray(entries) || entries.length === 0) return;

    const timestamp = Date.now();
    const normalizedEntries = entries.filter(entry => entry && typeof entry === 'object');
    const groupedSource = normalizedEntries[0]?.source || 'smart-context';
    const shouldGroup = normalizedEntries.length > 0
        && normalizedEntries.every(entry => (entry?.source || 'smart-context') === groupedSource)
        && (groupedSource === 'smart-context' || groupedSource === 'fact-driven');

    if (shouldGroup) {
        const isFactDriven = groupedSource === 'fact-driven';
        _addFeedItems?.([{
            id: _bgEventId++,
            type: 'background',
            icon: isFactDriven ? 'fa-brain' : 'fa-wand-magic-sparkles',
            verb: 'Injected',
            color: isFactDriven ? '#e84393' : '#fdcb6e',
            summary: `${normalizedEntries.length} entr${normalizedEntries.length === 1 ? 'y' : 'ies'} injected into the prompt`,
            timestamp,
            details: [isFactDriven ? 'From fact-driven pre-warm' : 'From smart-context pre-warm'],
            relatedEntries: normalizedEntries.map(entry => ({
                lorebook: typeof entry?.lorebook === 'string' ? entry.lorebook : '',
                uid: Number.isFinite(entry?.uid) ? entry.uid : null,
                title: entry?.title || (Number.isFinite(entry?.uid) ? `UID ${entry.uid}` : 'Unknown entry'),
                keys: Array.isArray(entry?.keys) ? entry.keys : [],
            })),
            preWarmSource: groupedSource,
        }]);
        return;
    }

    const items = entries.map((entry, index) => ({
        id: 2_000_000 + timestamp + index,
        type: 'entry',
        source: entry?.source || 'smart-context',
        icon: 'fa-book-open',
        verb: 'Triggered',
        color: '#e84393',
        lorebook: typeof entry?.lorebook === 'string' ? entry.lorebook : '',
        uid: Number.isFinite(entry?.uid) ? entry.uid : null,
        title: entry?.title || (Number.isFinite(entry?.uid) ? `UID ${entry.uid}` : 'Unknown entry'),
        keys: Array.isArray(entry?.keys) ? entry.keys : [],
        timestamp: Number.isFinite(entry?.timestamp) ? entry.timestamp : timestamp,
    }));

    _addFeedItems(items);
}

/**
 * Mark the start of a background operation (shows spinner on trigger button).
 * Returns a function to call when the operation completes.
 * @returns {() => void}
 */
export function markBackgroundStart() {
    setBackgroundActive(true);
    let ended = false;
    return () => {
        if (ended) return;
        ended = true;
        setBackgroundActive(false);
    };
}

// ── Cancellable Background Tasks ─────────────────────────────────

/** @type {Map<number, BackgroundTask>} */
const _activeTasks = new Map();
let _nextTaskId = 0;

/** @type {Map<number, FailedTask>} */
const _failedTasks = new Map();
let _nextFailedTaskId = 0;
// Retained failure entries each pin a retryFn closure over chat/prompt state.
// There is no bound UI to drain this map on its own, so cap it defensively.
const MAX_FAILED_TASKS = 10;

/**
 * @typedef {Object} BackgroundTask
 * @property {number} id
 * @property {string} label
 * @property {string} icon
 * @property {string} color
 * @property {number} startedAt
 * @property {boolean} cancelled - Check this at async boundaries to abort early
 * @property {() => void} end - Call when the task finishes (success, error, or cancel)
 * @property {(error: Error, retryFn: Function) => void} fail - Transition to failed state with retry
 */

/**
 * @typedef {Object} FailedTask
 * @property {number} id
 * @property {string} label
 * @property {string} icon
 * @property {string} color
 * @property {number} failedAt
 * @property {string} errorMessage
 * @property {Function} retryFn - Closure to re-invoke the operation
 * @property {boolean} retrying - Whether a retry is currently in progress
 */

/**
 * Register a cancellable background task. Shows a live indicator in the feed
 * with a cancel button. The caller should check `task.cancelled` at each async
 * boundary and bail out if true.
 *
 * @param {Object} opts
 * @param {string} opts.label - Display label (e.g. 'Post-turn processing')
 * @param {string} [opts.icon='fa-gear'] - FontAwesome icon class
 * @param {string} [opts.color='#6c5ce7'] - CSS color
 * @returns {BackgroundTask}
 */
export function registerBackgroundTask({ label, icon: taskIcon = 'fa-gear', color = '#6c5ce7' }) {
    const id = _nextTaskId++;
    const task = {
        id,
        label,
        icon: taskIcon,
        color,
        startedAt: Date.now(),
        cancelled: false,
        _ended: false,
        end() {
            if (task._ended) return;
            task._ended = true;
            _activeTasks.delete(id);
            setBackgroundActive(false);
            _refreshTasksUI?.();
        },
        fail(error, retryFn) {
            if (task._ended) return;
            task._ended = true;
            _activeTasks.delete(id);
            setBackgroundActive(false);

            if (typeof retryFn === 'function') {
                const failedId = _nextFailedTaskId++;
                _failedTasks.set(failedId, {
                    id: failedId,
                    label,
                    icon: taskIcon,
                    color,
                    failedAt: Date.now(),
                    errorMessage: error?.message || 'Unknown error',
                    retryFn,
                    retrying: false,
                });
                // Drop the oldest entries beyond the cap (Map preserves insertion order).
                while (_failedTasks.size > MAX_FAILED_TASKS) {
                    const oldestKey = _failedTasks.keys().next().value;
                    _failedTasks.delete(oldestKey);
                }
            }
            _refreshTasksUI?.();
        },
    };

    _activeTasks.set(id, task);
    setBackgroundActive(true);
    _refreshTasksUI?.();
    return task;
}

/**
 * Cancel a running background task by ID.
 * Sets the cancelled flag — the processor is responsible for checking it.
 */
export function cancelBackgroundTask(id) {
    const task = _activeTasks.get(id);
    if (task && !task.cancelled) {
        task.cancelled = true;
        console.log(`[TunnelVision] Background task cancelled by user: ${task.label}`);
        _refreshTasksUI?.();
    }
}

/** @returns {ReadonlyMap<number, BackgroundTask>} */
export function getActiveTasks() {
    return _activeTasks;
}

// ── Failed Task Retry ────────────────────────────────────────────

/** @returns {ReadonlyMap<number, FailedTask>} */
export function getFailedTasks() {
    return _failedTasks;
}

/**
 * Retry a failed background task by its failed-task ID.
 * @param {number} failedId
 * @returns {Promise<boolean>} true if retry was initiated
 */
export async function retryFailedTask(failedId) {
    const failedTask = _failedTasks.get(failedId);
    if (!failedTask || failedTask.retrying) return false;

    failedTask.retrying = true;
    _refreshTasksUI?.();

    try {
        await failedTask.retryFn();
        _failedTasks.delete(failedId);
        _refreshTasksUI?.();
        return true;
    } catch (e) {
        failedTask.retrying = false;
        failedTask.failedAt = Date.now();
        failedTask.errorMessage = e?.message || 'Retry failed';
        _refreshTasksUI?.();
        return false;
    }
}

/** Dismiss a failed task without retrying. */
export function dismissFailedTask(failedId) {
    _failedTasks.delete(failedId);
    _refreshTasksUI?.();
}

/**
 * Clear all failed-task entries. Called on chat change so retry closures
 * captured against the previous chat's state don't linger indefinitely.
 */
export function clearFailedTasks() {
    if (_failedTasks.size === 0) return;
    _failedTasks.clear();
    _refreshTasksUI?.();
}

// ── Feed Query Helpers ───────────────────────────────────────────

/**
 * Return lowercased character names for which a tracker suggestion already
 * exists in the feed (pending, completed, or dismissed). Used by
 * post-turn-processor to suppress duplicate suggestions.
 * @returns {string[]}
 */
export function getTrackerSuggestionNames() {
    const items = _getFeedItems?.() || [];
    return items
        .filter(item =>
            item.type === 'background' &&
            item.action?.type === 'create-tracker' &&
            item.action.characterName,
        )
        .map(item => item.action.characterName.toLowerCase());
}
