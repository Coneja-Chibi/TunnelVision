/**
 * Entry protection predicates shared by autonomous maintenance paths.
 * This module deliberately has no host dependencies so write safeguards remain
 * available in low-level CRUD code and isolated tests.
 */

/**
 * Check whether a lorebook entry is a static/constant entry.
 * Constant entries are authored reference material that SillyTavern injects
 * unconditionally; background automation must never rewrite or remove them.
 *
 * @param {Object} entry - Lorebook entry object
 * @returns {boolean} true when the entry is static/constant
 */
export function isStaticEntry(entry) {
    return entry?.constant === true;
}
