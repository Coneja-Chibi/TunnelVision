/**
 * TunnelVision Shared Utilities
 *
 * Centralized utility functions extracted from across the codebase to eliminate
 * duplication. Each function here previously existed as inline code in 2+ modules.
 *
 * Consumers:
 *   - embedding-cache.js   (hashString)
 *   - post-turn-processor.js (hashString, shuffleArray, isSystemEntry, iterActiveEntries)
 *   - memory-lifecycle.js  (shuffleArray, isSystemEntry, iterActiveEntries)
 *   - smart-context.js     (shuffleArray, isSystemEntry, isStorySummaryEntry, isActSummaryEntry)
 *   - tree-builder.js      (chunkBySize)
 *   - entry-scoring.js     (isSystemEntry, iterActiveEntries)
 *   - commands.js           (isSystemEntry)
 *   - tools/remember.js    (isSystemEntry)
 *   - activity-feed.js     (formatShortDateTime)
 *   - ui-controller.js     (formatShortDateTime)
 */

import { isSummaryTitle, isTrackerTitle } from './tree-store.js';
import { isActSummaryTitle, isStorySummaryTitle } from './summary-hierarchy.js';

// ── Hashing ──────────────────────────────────────────────────────

/**
 * DJB2 hash for fast content fingerprinting.
 * Previously duplicated as `simpleHash` in embedding-cache.js (L38-44)
 * and `contentHash` in post-turn-processor.js (L712-718).
 *
 * @param {string} str - The string to hash
 * @returns {number} 32-bit integer hash
 */
export function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return hash;
}

// ── Array Utilities ──────────────────────────────────────────────

/**
 * Fisher-Yates (Knuth) in-place shuffle.
 * Previously inlined in memory-lifecycle.js (L331-334),
 * post-turn-processor.js (L395-398), and smart-context.js (L333-336).
 *
 * @template T
 * @param {T[]} arr - Array to shuffle in place
 * @returns {T[]} The same array, shuffled (for chaining convenience)
 */
export function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// ── Entry Classification ─────────────────────────────────────────

/**
 * Check whether a lorebook entry is a "system" entry (tracker or summary)
 * that should be skipped during fact-oriented processing.
 *
 * This consolidates the inline `startsWith('[tracker') || startsWith('[summary')`
 * chains that were duplicated across ~15 call sites with subtle variations.
 * Uses the canonical regex-based helpers from tree-store.js for consistency.
 *
 * @param {Object} entry - Lorebook entry object (must have `comment` property)
 * @returns {boolean} true if the entry is a tracker or any kind of summary
 */
export function isSystemEntry(entry) {
    const title = entry?.comment;
    return isSummaryTitle(title) || isTrackerTitle(title);
}

/**
 * Check whether a lorebook entry is an active fact entry (not disabled, not a
 * tracker, not a summary). This is the most common filter predicate in the
 * codebase — used when iterating entries to find "real" content.
 *
 * @param {Object} entry - Lorebook entry object
 * @returns {boolean} true if the entry is an active, non-system fact entry
 */
export function isActiveFactEntry(entry) {
    if (!entry || entry.disable) return false;
    return !isSystemEntry(entry);
}

/**
 * Check whether an entry is specifically an Act Summary entry.
 * Delegates to summary-hierarchy.js's canonical helper.
 *
 * @param {Object} entry - Lorebook entry object
 * @returns {boolean}
 */
export function isActSummaryEntry(entry) {
    return isActSummaryTitle(entry?.comment);
}

/**
 * Check whether an entry is specifically a Story Summary entry.
 * Delegates to summary-hierarchy.js's canonical helper.
 *
 * @param {Object} entry - Lorebook entry object
 * @returns {boolean}
 */
export function isStorySummaryEntry(entry) {
    return isStorySummaryTitle(entry?.comment);
}

/**
 * Check whether an entry is specifically a Tracker entry.
 * Delegates to tree-store.js's canonical helper.
 *
 * @param {Object} entry - Lorebook entry object
 * @returns {boolean}
 */
export function isTrackerEntry(entry) {
    return isTrackerTitle(entry?.comment);
}

/**
 * Check whether an entry is specifically a Summary entry (scene, act, or story).
 * Delegates to tree-store.js's canonical helper.
 *
 * @param {Object} entry - Lorebook entry object
 * @returns {boolean}
 */
export function isSummaryEntry(entry) {
    return isSummaryTitle(entry?.comment);
}

// ── Entry Iteration ──────────────────────────────────────────────

/**
 * Iterate over active entries in a lorebook's entries map, calling `callback`
 * for each non-disabled entry. Optionally skip system entries (trackers/summaries).
 *
 * This replaces the ubiquitous pattern:
 *   for (const key of Object.keys(bookData.entries)) {
 *       const entry = bookData.entries[key];
 *       if (entry.disable) continue;
 *       const title = (entry.comment || '').toLowerCase();
 *       if (title.startsWith('[tracker') || title.startsWith('[summary') || ...) continue;
 *       // ...
 *   }
 *
 * @param {Object} entries - The `bookData.entries` object (uid-keyed map)
 * @param {function(Object, string): void} callback - Called with (entry, key) for each match
 * @param {Object} [opts]
 * @param {boolean} [opts.skipSystem=true] - If true, skip tracker and summary entries
 */
export function iterActiveEntries(entries, callback, { skipSystem = true } = {}) {
    if (!entries) return;
    for (const key of Object.keys(entries)) {
        const entry = entries[key];
        if (!entry || entry.disable) continue;
        if (skipSystem && isSystemEntry(entry)) continue;
        callback(entry, key);
    }
}

/**
 * Collect active entries from a lorebook's entries map into an array.
 * Convenience wrapper around iterActiveEntries for the common collect pattern.
 *
 * @param {Object} entries - The `bookData.entries` object
 * @param {Object} [opts]
 * @param {boolean} [opts.skipSystem=true] - If true, skip tracker and summary entries
 * @returns {Object[]} Array of matching entry objects
 */
export function collectActiveEntries(entries, { skipSystem = true } = {}) {
    const result = [];
    iterActiveEntries(entries, (entry) => result.push(entry), { skipSystem });
    return result;
}

/**
 * Collect titles of active non-system entries, trimmed and filtered.
 * Replaces the pattern duplicated in commands.js (L278-281) and tools/remember.js (L76-79):
 *   Object.values(bookData.entries)
 *       .filter(e => !e.disable && e.comment)
 *       .map(e => (e.comment || '').trim())
 *       .filter(t => t && !t.toLowerCase().startsWith('[tracker') && ...)
 *
 * @param {Object} entries - The `bookData.entries` object
 * @returns {string[]} Array of trimmed entry titles
 */
export function collectActiveEntryTitles(entries) {
    const titles = [];
    iterActiveEntries(entries, (entry) => {
        const title = (entry.comment || '').trim();
        if (title) titles.push(title);
    }, { skipSystem: true });
    return titles;
}

// ── Chunking ─────────────────────────────────────────────────────

/**
 * Split an array of items into chunks that fit within a character budget.
 * Uses an "overfill" strategy: when an item would exceed the limit, it is still
 * added to the current chunk (ensuring no item is stranded as a sole member of
 * a new chunk), and then a new chunk is started.
 *
 * Previously duplicated as `chunkEntries` (tree-builder.js L409-437) and
 * `chunkMessages` (tree-builder.js L1012-1034), differing only in how each
 * item's size is estimated.
 *
 * @template T
 * @param {T[]} items - The items to chunk
 * @param {function(T): number} sizeFn - Returns the estimated character size of an item
 * @param {number} charLimit - Maximum characters per chunk (soft limit due to overfill)
 * @returns {T[][]} Array of chunks
 */
export function chunkBySize(items, sizeFn, charLimit) {
    if (items.length === 0) return [];

    const chunks = [];
    let currentChunk = [];
    let currentSize = 0;

    for (const item of items) {
        const size = sizeFn(item);

        if (currentChunk.length > 0 && currentSize + size > charLimit) {
            // Overfill: include this item in the current chunk, then start new
            currentChunk.push(item);
            chunks.push(currentChunk);
            currentChunk = [];
            currentSize = 0;
        } else {
            currentChunk.push(item);
            currentSize += size;
        }
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    return chunks;
}

// ── Date Formatting ──────────────────────────────────────────────

/**
 * Shared short date/time format options.
 * Previously duplicated as inline objects in activity-feed.js (L1976, L2003, L2656)
 * and ui-controller.js (L2084).
 */
const SHORT_DATETIME_OPTIONS = Object.freeze({
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
});

/**
 * Format a date value as a short, human-readable date/time string.
 * Uses the user's locale with month abbreviation + day + time.
 *
 * Examples: "Jan 5, 12:30 PM", "Dec 31, 09:15 AM"
 *
 * @param {Date|number|string} dateValue - A Date object, timestamp, or date string
 * @returns {string} Formatted date string, or '—' if the input is invalid
 */
export function formatShortDateTime(dateValue) {
    if (dateValue == null) return '—';
    try {
        const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
        if (isNaN(date.getTime())) return '—';
        return date.toLocaleString([], SHORT_DATETIME_OPTIONS);
    } catch {
        return '—';
    }
}

// ── Secret-tag convention ────────────────────────────────────────
// Entries tagged [SECRET …] hold information a character does not yet
// know. Injected content is model-visible; the tag controls behavior,
// not visibility. See docs/superpowers/specs/2026-07-17-secret-tag-convention-design.md

/** Matches the opening of a [SECRET …] tag. No `g` flag → stateless .test(). */
export const SECRET_TAG_RE = /\[SECRET\b/i;

/** Standing rule injected above smart context when a tagged entry is present. */
export const SECRET_GUARD_LINE =
    '[Some retrieved entries are tagged [SECRET …]. These contain information a character does not yet know. ' +
    'Treat them as narrator-only dramatic irony — do not let that character reveal, act on, or acknowledge the ' +
    "information until the story establishes they've learned it.]";

/** Appended to write-tool content descriptions so the model applies/removes the tag. */
export const SECRET_AUTHORING_INSTRUCTION =
    ' If information should be hidden from a character (secrets, dramatic irony, things not yet learned), ' +
    'prefix the content with [SECRET — <who> is unaware]. When the story establishes the character has learned it, ' +
    'update the entry to remove the tag.';
