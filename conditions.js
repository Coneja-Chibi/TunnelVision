/**
 * TunnelVision — LLM-Evaluable Conditional Triggers
 *
 * Parses [type:value] condition tags from lorebook entry keywords.
 * The sidecar evaluates these against scene state during pre-gen retrieval.
 *
 * Supported condition types:
 *   emotion      — Is this emotion present in recent messages?
 *   mood         — Does the scene have this overall atmosphere?
 *   timeOfDay    — Is it this time of day in the fiction?
 *   location     — Are characters at/in this place?
 *   weather      — Are these weather conditions present?
 *   activity     — Are characters doing this?
 *   relationship — Is this the dynamic between active characters?
 *   freeform     — Custom natural-language condition evaluated by the LLM
 */

/** Valid evaluable condition types. */
export const EVALUABLE_TYPES = new Set([
    'emotion',
    'mood',
    'timeOfDay',
    'location',
    'weather',
    'activity',
    'relationship',
    'freeform',
]);

/** Human-readable descriptions for sidecar prompting. */
export const CONDITION_DESCRIPTIONS = {
    emotion: 'Is this emotion present in recent messages?',
    mood: 'Does the scene have this overall atmosphere/vibe?',
    timeOfDay: 'Is it this time of day in the fiction?',
    location: 'Are characters at or in this place?',
    weather: 'Are these weather conditions present in the scene?',
    activity: 'Are characters currently doing this?',
    relationship: 'Is this the dynamic between the active characters?',
    freeform: 'Custom natural-language condition evaluated by the LLM',
};

/** Display labels for condition type keys. */
export const CONDITION_LABELS = {
    emotion: 'Emotion',
    mood: 'Mood',
    timeOfDay: 'Time of Day',
    location: 'Location',
    weather: 'Weather',
    activity: 'Activity',
    relationship: 'Relationship',
    freeform: 'Freeform',
};

/** Regex matching [!?type:value] condition syntax (supports optional ! negation prefix). */
const CONDITION_RE = /^\[(!?\w+):(.+)\]$/;

/**
 * Check if a keyword string is an evaluable condition.
 * @param {string} keyword
 * @returns {boolean}
 */
export function isEvaluableCondition(keyword) {
    if (!keyword || typeof keyword !== 'string') return false;
    const match = keyword.trim().match(CONDITION_RE);
    if (!match) return false;
    const rawType = match[1];
    const type = rawType.startsWith('!') ? rawType.slice(1) : rawType;
    return EVALUABLE_TYPES.has(type);
}

/**
 * Parse a single [type:value] keyword into a condition object.
 * Supports optional ! negation prefix on the type (e.g. [!emotion:happy]).
 * Returns null if the keyword is not a valid condition.
 * @param {string} keyword
 * @returns {{ type: string, value: string, negated: boolean } | null}
 */
export function parseCondition(keyword) {
    if (!keyword || typeof keyword !== 'string') return null;
    const match = keyword.trim().match(CONDITION_RE);
    if (!match) return null;
    const rawType = match[1];
    const negated = rawType.startsWith('!');
    const type = negated ? rawType.slice(1) : rawType;
    if (!EVALUABLE_TYPES.has(type)) return null;
    return { type, value: match[2].trim(), negated };
}

/**
 * Format a condition object back to [type:value] string.
 * Includes ! prefix when condition.negated is true.
 * @param {{ type: string, value: string, negated?: boolean }} condition
 * @returns {string}
 */
export function formatCondition(condition) {
    return `[${condition.negated ? '!' : ''}${condition.type}:${condition.value}]`;
}

/**
 * Separate an array of keywords into regular keywords and parsed conditions.
 * @param {string[]} keys
 * @returns {{ keywords: string[], conditions: Array<{ type: string, value: string, negated: boolean }> }}
 */
export function separateConditions(keys) {
    const keywords = [];
    const conditions = [];
    if (!Array.isArray(keys)) return { keywords, conditions };

    for (const key of keys) {
        const condition = parseCondition(key);
        if (condition) {
            conditions.push(condition);
        } else {
            keywords.push(key);
        }
    }
    return { keywords, conditions };
}

/**
 * Check if an entry has any evaluable conditions in its primary or secondary keys.
 * @param {{ key?: string[], keysecondary?: string[] }} entry
 * @returns {boolean}
 */
export function hasEvaluableConditions(entry) {
    const primary = entry?.key || [];
    const secondary = entry?.keysecondary || [];
    return primary.some(isEvaluableCondition) || secondary.some(isEvaluableCondition);
}

/**
 * Map ST's selectiveLogic number to a human-readable logic string.
 * ST uses: 0 = AND_ANY, 1 = NOT_ALL, 2 = NOT_ANY, 3 = AND_ALL
 * @param {number} selectiveLogic
 * @returns {string}
 */
export function mapSelectiveLogic(selectiveLogic) {
    switch (selectiveLogic) {
        case 0: return 'AND_ANY';
        case 1: return 'NOT_ALL';
        case 2: return 'NOT_ANY';
        case 3: return 'AND_ALL';
        default: return 'AND_ANY';
    }
}

/**
 * Build a human-readable description of selective logic for the sidecar prompt.
 * @param {string} logic - One of AND_ANY, AND_ALL, NOT_ANY, NOT_ALL
 * @returns {string}
 */
export function describeSelectiveLogic(logic) {
    switch (logic) {
        case 'AND_ANY': return 'Primary conditions must be true AND at least one secondary condition must be true';
        case 'AND_ALL': return 'Primary conditions must be true AND all secondary conditions must be true';
        case 'NOT_ANY': return 'Primary conditions must be true AND none of the secondary conditions should be true';
        case 'NOT_ALL': return 'Primary conditions must be true AND not all secondary conditions should be true';
        default: return 'Primary conditions must be true AND at least one secondary condition must be true';
    }
}

// ─── Per-Keyword Probability ─────────────────────────────────────

/**
 * Get the probability for a keyword/condition string on an entry.
 * Reads from entry.tvKeywordProbability map. Defaults to 100 if not set.
 * @param {Object} entry - The WI entry object
 * @param {string} keyword - The keyword or condition string (e.g. "revival" or "[mood:tense]")
 * @returns {number} 0-100
 */
export function getKeywordProbability(entry, keyword) {
    const map = entry?.tvKeywordProbability;
    if (!map || typeof map !== 'object') return 100;
    const val = map[keyword];
    return typeof val === 'number' ? Math.max(0, Math.min(100, val)) : 100;
}

/**
 * Set the probability for a keyword/condition string on an entry.
 * Creates the tvKeywordProbability map if it doesn't exist.
 * @param {Object} entry - The WI entry object
 * @param {string} keyword - The keyword or condition string
 * @param {number} probability - 0-100
 */
export function setKeywordProbability(entry, keyword, probability) {
    if (!entry) return;
    if (!entry.tvKeywordProbability || typeof entry.tvKeywordProbability !== 'object') {
        entry.tvKeywordProbability = {};
    }
    entry.tvKeywordProbability[keyword] = Math.max(0, Math.min(100, Math.round(probability)));
}

/**
 * Remove the probability entry for a keyword (resets to default 100).
 * Cleans up the map if empty.
 * @param {Object} entry - The WI entry object
 * @param {string} keyword - The keyword or condition string
 */
export function removeKeywordProbability(entry, keyword) {
    if (!entry?.tvKeywordProbability) return;
    delete entry.tvKeywordProbability[keyword];
    if (Object.keys(entry.tvKeywordProbability).length === 0) {
        delete entry.tvKeywordProbability;
    }
}

/**
 * Roll probability for a keyword. Returns true if the keyword should fire.
 * @param {Object} entry - The WI entry object
 * @param {string} keyword - The keyword or condition string
 * @returns {boolean}
 */
export function rollKeywordProbability(entry, keyword) {
    const prob = getKeywordProbability(entry, keyword);
    if (prob >= 100) return true;
    if (prob <= 0) return false;
    return Math.random() * 100 < prob;
}

/**
 * Filter an array of keywords/conditions by rolling probability for each.
 * Returns only the ones that pass.
 * @param {Object} entry - The WI entry object
 * @param {string[]} keywords - Array of keyword strings
 * @returns {string[]}
 */
export function filterByProbability(entry, keywords) {
    if (!Array.isArray(keywords)) return [];
    return keywords.filter(kw => rollKeywordProbability(entry, kw));
}
