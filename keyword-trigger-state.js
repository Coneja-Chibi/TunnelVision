/**
 * TunnelVision Keyword-Trigger State
 *
 * Tracks which entry UIDs were keyword-triggered by SillyTavern's native World
 * Info scan this turn (only populated when `allowKeywordTriggers` is on).
 *
 * Split out of index.js so modules that only need this bit of read-only state
 * (tools/search.js, sidecar-retrieval.js) don't have to import the extension's
 * entry point — importing index.js runs its top-level `await init()`, which
 * requires a live SillyTavern/jQuery environment and breaks in tests.
 */

/** UIDs of entries that were keyword-triggered this turn (when allowKeywordTriggers is on). */
let _keywordTriggeredUids = new Set();

/** Get the set of entry UIDs that were keyword-triggered this turn. */
export function getKeywordTriggeredUids() {
    return _keywordTriggeredUids;
}
