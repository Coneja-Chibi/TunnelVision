/**
 * TunnelVision Entry Manager
 * Handles lorebook entry CRUD operations triggered by tool calls.
 * Lorebook CRUD operations shared by all TunnelVision memory tools.
 * Kept separate from tool-registry.js so entry logic is testable/reusable.
 *
 * Uses ST's native world-info API:
 *   createWorldInfoEntry(name, data) - creates entry, returns entry object
 *   saveWorldInfo(name, data, immediately) - persists to disk
 *   loadWorldInfo(name) - loads lorebook data with .entries
 */

import {
    loadWorldInfo,
    createWorldInfoEntry,
    saveWorldInfo,
    deleteWorldInfoEntry,
    deleteWIOriginalDataValue,
} from '../../../world-info.js';
import {
    getTree,
    saveTree,
    findNodeById,
    addEntryToNode,
    removeEntryFromTree,
    createTreeNode,
    isTrackerTitle,
    isTrackerUid,
    setTrackerUid,
} from './tree-store.js';

// ─── World Info Data Cache ───────────────────────────────────────
// Avoids repeated async loadWorldInfo calls in hot paths like scoring.
// Populated by getCachedWorldInfo (async), read by getCachedWorldInfoSync.

const _wiCache = new Map();

/**
 * Load and cache lorebook data. Use this to pre-warm the cache.
 * @param {string} bookName
 * @returns {Promise<Object|null>}
 */
export async function getCachedWorldInfo(bookName) {
    const bookData = await loadWorldInfo(bookName);
    if (bookData) _wiCache.set(bookName, bookData);
    return bookData;
}

/**
 * Get cached lorebook data synchronously. Returns null if not yet cached.
 * Call getCachedWorldInfo first to populate.
 * @param {string} bookName
 * @returns {Object|null}
 */
export function getCachedWorldInfoSync(bookName) {
    return _wiCache.get(bookName) || null;
}

/**
 * Invalidate the cache for a specific book (call after writes).
 * @param {string} bookName
 */
export function invalidateWorldInfoCache(bookName) {
    _wiCache.delete(bookName);
}

/**
 * Create a new lorebook entry and assign it to a tree node.
 * @param {string} bookName - Lorebook name
 * @param {Object} params
 * @param {string} params.content - Entry content text
 * @param {string} params.comment - Entry title/comment
 * @param {string[]} [params.keys] - Primary trigger keys
 * @param {string} [params.nodeId] - Tree node to assign to (defaults to root)
 * @param {string} [params.tv_tracker] - Optional tracking keyword for sidecar auto-cleanup
 * @returns {Promise<{uid: number, comment: string, nodeLabel: string}>}
 */
export async function createEntry(bookName, { content, comment, keys, nodeId, tv_tracker }) {
    if (!content || !content.trim()) {
        throw new Error('Entry content cannot be empty.');
    }
    if (!comment || !comment.trim()) {
        throw new Error('Entry comment/title cannot be empty.');
    }

    const bookData = await loadWorldInfo(bookName);
    if (!bookData || !bookData.entries) {
        throw new Error(`Lorebook "${bookName}" not found or has no entry data.`);
    }

    // Create entry via ST API
    const newEntry = createWorldInfoEntry(bookName, bookData);
    if (!newEntry) {
        throw new Error('Failed to create new lorebook entry (ST returned undefined).');
    }

    // Populate fields
    newEntry.content = content.trim();
    newEntry.comment = comment.trim();
    
    let finalKeys = [];
    if (Array.isArray(keys)) {
        finalKeys = keys.map(k => String(k).trim()).filter(Boolean);
    }
    
    // Store tracking data as a native keyword so ST doesn't strip it
    if (tv_tracker) {
        finalKeys.push(tv_tracker);
    }
    
    if (finalKeys.length > 0) {
        newEntry.key = finalKeys;
    }
    
    // TunnelVision-managed entries: disable keyword triggering since retrieval is tree-based
    newEntry.selective = false;
    newEntry.constant = false;
    newEntry.disable = false;

    // 1. Persist lorebook to disk FIRST (assigns final server-side UID)
    await saveWorldInfo(bookName, bookData, true);
    
    // 2. Refresh the local reference to get the assigned UID
    const freshBook = await loadWorldInfo(bookName);
    const finalizedEntry = Object.values(freshBook.entries).find(e => 
        e.comment === comment.trim() && e.content === content.trim()
    );

    if (!finalizedEntry) {
        throw new Error('Failed to retrieve finalized entry after save.');
    }

    // 3. Assign to tree node using the FINAL UID
    let nodeLabel = 'Root';
    const tree = getTree(bookName);
    if (tree && tree.root) {
        let targetNode = tree.root;
        if (nodeId) {
            const found = findNodeById(tree.root, nodeId);
            if (found) {
                targetNode = found;
                nodeLabel = found.label;
            }
        }
        addEntryToNode(targetNode, finalizedEntry.uid);
        saveTree(bookName, tree);
    }

    // 4. Force SillyTavern UI to update
    forceSTLorebookUIUpdate(bookName);

    if (isTrackerTitle(finalizedEntry.comment)) {
        setTrackerUid(bookName, finalizedEntry.uid, true);
    }

    console.log(`[TunnelVision] Created entry "${comment}" (UID ${finalizedEntry.uid}) in "${bookName}" → ${nodeLabel}`);
    return { uid: finalizedEntry.uid, comment: finalizedEntry.comment, nodeLabel };
}

/**
 * Update an existing lorebook entry's content and/or comment.
 * @param {string} bookName - Lorebook name
 * @param {number} uid - Entry UID to update
 * @param {Object} updates
 * @param {string} [updates.content] - New content (replaces entirely)
 * @param {string} [updates.comment] - New comment/title
 * @param {string[]} [updates.keys] - New primary keys
 * @returns {Promise<{uid: number, comment: string, updated: string[]}>}
 */
export async function updateEntry(bookName, uid, updates) {
    const bookData = await loadWorldInfo(bookName);
    if (!bookData || !bookData.entries) {
        throw new Error(`Lorebook "${bookName}" not found or has no entry data.`);
    }

    const entry = findEntryByUid(bookData.entries, uid);
    if (!entry) {
        throw new Error(`Entry UID ${uid} not found in lorebook "${bookName}".`);
    }

    const changed = [];

    if (updates.content !== undefined && updates.content.trim()) {
        entry.content = updates.content.trim();
        changed.push('content');
    }
    if (updates.comment !== undefined && updates.comment.trim()) {
        entry.comment = updates.comment.trim();
        changed.push('comment');
    }
    if (Array.isArray(updates.keys)) {
        entry.key = updates.keys.map(k => String(k).trim()).filter(Boolean);
        changed.push('keys');
    }

    if (changed.length === 0) {
        throw new Error('No valid updates provided. Content and title must be non-empty strings if specified.');
    }

    await saveWorldInfo(bookName, bookData, true);
    if (entry.disable) {
        setTrackerUid(bookName, uid, false);
    } else if (isTrackerTitle(entry.comment) || isTrackerUid(bookName, uid)) {
        setTrackerUid(bookName, uid, true);
    }

    console.log(`[TunnelVision] Updated entry "${entry.comment}" (UID ${uid}) in "${bookName}": ${changed.join(', ')}`);
    return { uid, comment: entry.comment, updated: changed };
}

/**
 * Disable (soft-delete) a lorebook entry and remove it from the tree.
 * @param {string} bookName - Lorebook name
 * @param {number} uid - Entry UID to disable
 * @param {boolean} [hardDelete=false] - If true, actually delete instead of disable
 * @returns {Promise<{uid: number, comment: string, action: string}>}
 */
export async function forgetEntry(bookName, uid, hardDelete = false) {
    const bookData = await loadWorldInfo(bookName);
    if (!bookData || !bookData.entries) {
        throw new Error(`Lorebook "${bookName}" not found or has no entry data.`);
    }

    const entry = findEntryByUid(bookData.entries, uid);
    if (!entry) {
        throw new Error(`Entry UID ${uid} not found in lorebook "${bookName}".`);
    }

    const comment = entry.comment || `Entry #${uid}`;
    let action;

    if (hardDelete) {
        await deleteWorldInfoEntry(bookData, uid, { silent: true });
        deleteWIOriginalDataValue(bookData, uid);
        action = 'deleted';
    } else {
        entry.disable = true;
        action = 'disabled';
    }

    await saveWorldInfo(bookName, bookData, true);

    // Remove from tree regardless
    const tree = getTree(bookName);
    if (tree && tree.root) {
        removeEntryFromTree(tree.root, uid);
        saveTree(bookName, tree);
    }
    setTrackerUid(bookName, uid, false);

    console.log(`[TunnelVision] ${action} entry "${comment}" (UID ${uid}) in "${bookName}"`);
    return { uid, comment, action };
}

/**
 * Move an entry from one tree node to another.
 * @param {string} bookName - Lorebook name
 * @param {number} uid - Entry UID to move
 * @param {string} targetNodeId - Destination node ID
 * @returns {Promise<{uid: number, fromLabel: string, toLabel: string}>}
 */
export async function moveEntry(bookName, uid, targetNodeId) {
    const tree = getTree(bookName);
    if (!tree || !tree.root) {
        throw new Error(`No tree found for lorebook "${bookName}".`);
    }

    const targetNode = findNodeById(tree.root, targetNodeId);
    if (!targetNode) {
        throw new Error(`Target node "${targetNodeId}" not found in tree.`);
    }

    // Find current location
    const fromLabel = findNodeContainingUid(tree.root, uid)?.label || 'unknown';

    // Remove from all nodes, then add to target
    removeEntryFromTree(tree.root, uid);
    addEntryToNode(targetNode, uid);
    saveTree(bookName, tree);

    console.log(`[TunnelVision] Moved entry UID ${uid}: "${fromLabel}" → "${targetNode.label}"`);
    return { uid, fromLabel, toLabel: targetNode.label };
}

/**
 * Create a new category node in the tree.
 * @param {string} bookName - Lorebook name
 * @param {string} label - Category name
 * @param {string} [parentNodeId] - Parent node ID (defaults to root)
 * @returns {{ nodeId: string, label: string, parentLabel: string }}
 */
export function createCategory(bookName, label, parentNodeId) {
    const tree = getTree(bookName);
    if (!tree || !tree.root) {
        throw new Error(`No tree found for lorebook "${bookName}".`);
    }

    let parentNode = tree.root;
    if (parentNodeId) {
        const found = findNodeById(tree.root, parentNodeId);
        if (found) parentNode = found;
    }

    const newNode = createTreeNode(label, '');
    parentNode.children.push(newNode);
    saveTree(bookName, tree);

    console.log(`[TunnelVision] Created category "${label}" under "${parentNode.label}" in "${bookName}"`);
    return { nodeId: newNode.id, label: newNode.label, parentLabel: parentNode.label };
}

/**
 * Find an entry by UID across all entries in a lorebook's entry map.
 * @param {string} bookName
 * @param {number} uid
 * @returns {Promise<{entry: Object, bookName: string}|null>}
 */
export async function findEntry(bookName, uid) {
    const bookData = await loadWorldInfo(bookName);
    if (!bookData || !bookData.entries) return null;
    const entry = findEntryByUid(bookData.entries, uid);
    return entry ? { entry, bookName } : null;
}

/**
 * List entries in a specific tree node with their comments/titles.
 * Used by Reorganize tool to show what's in a node.
 * @param {string} bookName
 * @param {string} nodeId
 * @returns {Promise<Array<{uid: number, comment: string, contentPreview: string}>>}
 */
export async function listNodeEntries(bookName, nodeId) {
    const tree = getTree(bookName);
    if (!tree || !tree.root) return [];

    const node = findNodeById(tree.root, nodeId);
    if (!node) return [];

    const uids = node.entryUids || [];
    if (uids.length === 0) return [];

    const bookData = await loadWorldInfo(bookName);
    if (!bookData || !bookData.entries) return [];

    return uids.map(uid => {
        const entry = findEntryByUid(bookData.entries, uid);
        if (!entry) return null;
        return {
            uid,
            comment: entry.comment || `Entry #${uid}`,
            contentPreview: (entry.content || '').substring(0, 100),
        };
    }).filter(Boolean);
}

/**
 * Merge two entries into one. Keeps the first entry, appends the second's content,
 * then disables (or deletes) the second entry and removes it from the tree.
 * @param {string} bookName - Lorebook name
 * @param {number} keepUid - UID of the entry to keep (will receive merged content)
 * @param {number} removeUid - UID of the entry to absorb and disable
 * @param {Object} [opts]
 * @param {string} [opts.mergedContent] - Optional custom merged content (overrides auto-merge)
 * @param {string} [opts.mergedTitle] - Optional new title for the merged entry
 * @param {boolean} [opts.hardDelete=false] - Hard-delete the absorbed entry instead of disabling
 * @returns {Promise<{uid: number, comment: string, removedUid: number, removedComment: string}>}
 */
export async function mergeEntries(bookName, keepUid, removeUid, opts = {}) {
    if (keepUid === removeUid) {
        throw new Error('Cannot merge an entry with itself.');
    }

    const bookData = await loadWorldInfo(bookName);
    if (!bookData || !bookData.entries) {
        throw new Error(`Lorebook "${bookName}" not found or has no entry data.`);
    }

    const keepEntry = findEntryByUid(bookData.entries, keepUid);
    if (!keepEntry) {
        throw new Error(`Entry UID ${keepUid} (keep) not found in lorebook "${bookName}".`);
    }

    const removeEntry = findEntryByUid(bookData.entries, removeUid);
    if (!removeEntry) {
        throw new Error(`Entry UID ${removeUid} (remove) not found in lorebook "${bookName}".`);
    }

    const removedComment = removeEntry.comment || `Entry #${removeUid}`;

    // Merge content
    if (opts.mergedContent && opts.mergedContent.trim()) {
        keepEntry.content = opts.mergedContent.trim();
    } else {
        keepEntry.content = `${keepEntry.content}\n\n---\n\n${removeEntry.content}`;
    }

    // Merge title if provided
    if (opts.mergedTitle && opts.mergedTitle.trim()) {
        keepEntry.comment = opts.mergedTitle.trim();
    }

    // Merge keys (deduplicate)
    const existingKeys = new Set((keepEntry.key || []).map(k => String(k).toLowerCase()));
    for (const k of (removeEntry.key || [])) {
        if (!existingKeys.has(String(k).toLowerCase())) {
            keepEntry.key = keepEntry.key || [];
            keepEntry.key.push(k);
        }
    }

    // Disable or delete the absorbed entry
    if (opts.hardDelete) {
        await deleteWorldInfoEntry(bookData, removeUid, { silent: true });
        deleteWIOriginalDataValue(bookData, removeUid);
    } else {
        removeEntry.disable = true;
    }

    await saveWorldInfo(bookName, bookData, true);

    // Remove absorbed entry from tree
    const tree = getTree(bookName);
    if (tree && tree.root) {
        removeEntryFromTree(tree.root, removeUid);
        saveTree(bookName, tree);
    }

    const shouldTrackMergedEntry =
        isTrackerUid(bookName, keepUid) ||
        isTrackerUid(bookName, removeUid) ||
        isTrackerTitle(keepEntry.comment);
    setTrackerUid(bookName, keepUid, shouldTrackMergedEntry);
    setTrackerUid(bookName, removeUid, false);

    console.log(`[TunnelVision] Merged entry UID ${removeUid} ("${removedComment}") into UID ${keepUid} ("${keepEntry.comment}") in "${bookName}"`);
    return { uid: keepUid, comment: keepEntry.comment, removedUid: removeUid, removedComment };
}

/**
 * Split one entry into two. The original entry keeps part of the content,
 * and a new entry is created with the rest.
 * @param {string} bookName - Lorebook name
 * @param {number} uid - UID of the entry to split
 * @param {Object} params
 * @param {string} params.keepContent - Content that stays in the original entry
 * @param {string} params.keepTitle - Title for the original entry (can be unchanged)
 * @param {string} params.newContent - Content for the new split-off entry
 * @param {string} params.newTitle - Title for the new split-off entry
 * @param {string[]} [params.newKeys] - Optional keys for the new entry
 * @returns {Promise<{originalUid: number, originalTitle: string, newUid: number, newTitle: string, nodeLabel: string}>}
 */
export async function splitEntry(bookName, uid, { keepContent, keepTitle, newContent, newTitle, newKeys }) {
    if (!keepContent || !keepContent.trim()) {
        throw new Error('keepContent cannot be empty — the original entry needs content.');
    }
    if (!newContent || !newContent.trim()) {
        throw new Error('newContent cannot be empty — the new entry needs content.');
    }
    if (!newTitle || !newTitle.trim()) {
        throw new Error('newTitle cannot be empty — the new entry needs a title.');
    }

    const bookData = await loadWorldInfo(bookName);
    if (!bookData || !bookData.entries) {
        throw new Error(`Lorebook "${bookName}" not found or has no entry data.`);
    }

    const original = findEntryByUid(bookData.entries, uid);
    if (!original) {
        throw new Error(`Entry UID ${uid} not found in lorebook "${bookName}".`);
    }
    const wasTracker = isTrackerUid(bookName, uid) || isTrackerTitle(original.comment);

    // Update the original entry
    original.content = keepContent.trim();
    if (keepTitle && keepTitle.trim()) {
        original.comment = keepTitle.trim();
    }

    await saveWorldInfo(bookName, bookData, true);

    // Find the node the original lives in, so we can place the new entry alongside it
    const tree = getTree(bookName);
    let nodeId = null;
    if (tree && tree.root) {
        const containingNode = findNodeContainingUid(tree.root, uid);
        if (containingNode) nodeId = containingNode.id;
    }

    // Create the new split-off entry (reuses createEntry for consistency)
    const newResult = await createEntry(bookName, {
        content: newContent,
        comment: newTitle,
        keys: newKeys || [],
        nodeId,
    });
    if (wasTracker) {
        setTrackerUid(bookName, uid, true);
        setTrackerUid(bookName, newResult.uid, true);
    }

    console.log(`[TunnelVision] Split entry UID ${uid} → kept "${original.comment}", created UID ${newResult.uid} "${newResult.comment}" in "${bookName}"`);
    return {
        originalUid: uid,
        originalTitle: original.comment,
        newUid: newResult.uid,
        newTitle: newResult.comment,
        nodeLabel: newResult.nodeLabel,
    };
}

// --- Shared helpers ---

/**
 * Find an entry by UID in an entries map.
 * Shared across entry-manager, tree-builder, and search.
 * @param {Object} entries - Lorebook entries map (key → entry object)
 * @param {number} uid
 * @returns {Object|null}
 */
export function findEntryByUid(entries, uid) {
    for (const key of Object.keys(entries)) {
        if (entries[key].uid === uid) return entries[key];
    }
    return null;
}

function findNodeContainingUid(node, uid) {
    if ((node.entryUids || []).includes(uid)) return node;
    for (const child of (node.children || [])) {
        const found = findNodeContainingUid(child, uid);
        if (found) return found;
    }
    return null;
}

/**
 * Force SillyTavern's native UI to redraw the entries list for a lorebook.
 * @param {string} bookName
 */
export function forceSTLorebookUIUpdate(bookName) {
    const sel = document.getElementById('world_editor_select');
    if (sel && sel.options[sel.selectedIndex]?.textContent === bookName) {
        sel.dispatchEvent(new Event('change'));
    }
}

// ─── Utilities required by post-turn-processor & summary-hierarchy ───

/**
 * Build a uid → entry map from a lorebook entries object.
 * @param {Object} entries - Lorebook entries map (key → entry object)
 * @returns {Map<number, Object>}
 */
export function buildUidMap(entries) {
    const map = new Map();
    if (!entries) return map;
    for (const key of Object.keys(entries)) {
        const e = entries[key];
        if (e?.uid != null) map.set(e.uid, e);
    }
    return map;
}

/**
 * Parse a JSON object from LLM output, stripping markdown fences and preamble.
 * @param {string} text - Raw LLM response
 * @param {{ type?: 'object'|'array' }} [opts]
 * @returns {Object|Array|null}
 */
export function parseJsonFromLLM(text, opts = {}) {
    if (!text) return null;
    // Strip markdown code fences
    let cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '');
    // Find the first { or [ depending on expected type
    const opener = opts.type === 'array' ? '[' : '{';
    const closer = opts.type === 'array' ? ']' : '}';
    const start = cleaned.indexOf(opener);
    if (start < 0) return null;
    // Find matching closer (simple depth tracking)
    let depth = 0;
    for (let i = start; i < cleaned.length; i++) {
        if (cleaned[i] === opener) depth++;
        else if (cleaned[i] === closer) depth--;
        if (depth === 0) {
            try {
                return JSON.parse(cleaned.substring(start, i + 1));
            } catch {
                return null;
            }
        }
    }
    return null;
}

// ─── Entry temporal metadata (creation/update timestamps per entry) ──

const _entryTemporal = new Map(); // key: `${bookName}:${uid}`

/**
 * Record temporal metadata for an entry (creation or update timestamp).
 * @param {string} bookName
 * @param {number} uid
 * @param {{ created?: number, updated?: number, source?: string, turnIndex?: number }} meta
 */
export function recordEntryTemporal(bookName, uid, meta) {
    const key = `${bookName}:${uid}`;
    const existing = _entryTemporal.get(key) || {};
    _entryTemporal.set(key, { ...existing, ...meta });
    if (Number.isFinite(meta?.turnIndex)) {
        setEntryTurnIndex(bookName, uid, Number(meta.turnIndex));
    }
}

/**
 * Get temporal metadata for an entry.
 * @param {string} bookName
 * @param {number} uid
 * @returns {{ created?: number, updated?: number, source?: string, turnIndex?: number }|null}
 */
export function getEntryTemporal(bookName, uid) {
    return _entryTemporal.get(`${bookName}:${uid}`) || null;
}

// ─── Entry version tracking (simple history for undo/audit) ──────────

const _entryVersions = new Map(); // key: `${bookName}:${uid}` → Array

/**
 * Get version history for an entry.
 * @param {string} bookName
 * @param {number} uid
 * @returns {Array<{ content: string, comment: string, timestamp: number }>}
 */
export function getEntryVersions(bookName, uid) {
    return _entryVersions.get(`${bookName}:${uid}`) || [];
}

/**
 * Record a version snapshot for an entry (call before updating).
 * @param {string} bookName
 * @param {number} uid
 * @param {{ content: string, comment: string }} snapshot
 */
export function recordEntryVersion(bookName, uid, snapshot) {
    const key = `${bookName}:${uid}`;
    const versions = _entryVersions.get(key) || [];
    versions.push({ ...snapshot, timestamp: Date.now() });
    // Keep last 10 versions
    if (versions.length > 10) versions.shift();
    _entryVersions.set(key, versions);
}

// ─── Persistence helper ─────────────────────────────────────────────

/**
 * Persist world info data for a book (wrapper around saveWorldInfo).
 * @param {string} bookName
 * @param {Object} bookData
 */
export async function persistWorldInfo(bookName, bookData) {
    await saveWorldInfo(bookName, bookData, true);
}

// ─── Turn-scoped entry count (for rate limiting tool calls per turn) ─

let _turnEntryCount = 0;

export function resetTurnEntryCount() {
    _turnEntryCount = 0;
}

export function getTurnEntryCount() {
    return _turnEntryCount;
}

export function incrementTurnEntryCount() {
    return ++_turnEntryCount;
}

// ─── Dirty cache invalidation ────────────────────────────────────────

/**
 * Invalidate any dirty/stale WI caches. Clears the entire WI cache.
 * Called at the start of each generation to ensure fresh data.
 */
export function invalidateDirtyWorldInfoCache() {
    _wiCache.clear();
}

// ─── HTML escaping ───────────────────────────────────────────────────

/**
 * Escape HTML special characters for safe rendering.
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ─── Entry turn index + supersedes tracking ─────────────────────────

const _entryTurnIndex = new Map(); // key: `${bookName}:${uid}` → turn number
const _entrySupersedes = new Map(); // key: `${bookName}:${uid}` → superseded uid

export function getEntryTurnIndex(bookName, uid) {
    return _entryTurnIndex.get(`${bookName}:${uid}`) ?? -1;
}

export function setEntryTurnIndex(bookName, uid, turn) {
    _entryTurnIndex.set(`${bookName}:${uid}`, turn);
}

export function setEntrySupersedes(bookName, uid, supersededUid) {
    _entrySupersedes.set(`${bookName}:${uid}`, supersededUid);
}

export function getEntrySupersedes(bookName, uid) {
    return _entrySupersedes.get(`${bookName}:${uid}`) ?? null;
}

// ─── Prompt constants for LLM-driven operations ─────────────────────

export const KEYWORD_RULES = `Keywords rules:
- Provide 3-8 specific, searchable keywords
- Include character names, locations, objects, and themes mentioned
- Prefer concrete nouns over abstract concepts
- Include temporal markers if the event has time significance`;

export const SUMMARY_STYLE_RULES = `Summary style rules:
- Write in third person, past tense
- Be specific about WHO did WHAT and WHY
- Include emotional beats and character reactions
- Note any changes to relationships, status, or world state
- Keep it concise but information-dense (aim for 100-200 words)`;

export const FACT_EXTRACTION_PROMPT = `You are a memory curator for an ongoing roleplay. Extract discrete, reusable facts from the conversation below.

For each fact, provide:
- title: A short, descriptive label (e.g. "Elena's fear of fire", "Tavern location")
- content: The factual information in third person. If the subject already appears in the "Already Known Facts" list below, write ONLY the new specific detail — do NOT restate who they are or repeat their general description.
- keys: 3-8 searchable keywords — include character names, locations, objects, themes, and temporal markers
- significance: "low" | "medium" | "high"

Only extract facts that would be useful to recall in future scenes. Skip transient dialogue, greetings, and meta-commentary.

{existingFactsSection}
{temporalContext}
{inputSection}

Respond with ONLY a JSON array of fact objects (no markdown, no code fences).`;

/**
 * Build a keyword array for a summary entry.
 * @param {{ participants?: string[], arc?: string, when?: string }} parsed
 * @param {string[]} participants
 * @param {string} significance
 * @returns {string[]}
 */
export function buildSummaryKeys(parsed, participants = [], significance = 'moderate') {
    const keys = [];
    if (participants?.length) keys.push(...participants);
    if (parsed?.arc) keys.push(parsed.arc);
    if (parsed?.when) keys.push(parsed.when);
    if (significance) keys.push(significance);
    // Deduplicate
    return [...new Set(keys.filter(Boolean))];
}
