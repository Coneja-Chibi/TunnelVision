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

/**
 * Create a new lorebook entry and assign it to a tree node.
 * @param {string} bookName - Lorebook name
 * @param {Object} params
 * @param {string} params.content - Entry content text
 * @param {string} params.comment - Entry title/comment
 * @param {string[]} [params.keys] - Primary trigger keys
 * @param {string} [params.nodeId] - Tree node to assign to (defaults to root)
 * @returns {Promise<{uid: number, comment: string, nodeLabel: string}>}
 */
export async function createEntry(bookName, { content, comment, keys, nodeId }) {
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
    if (Array.isArray(keys) && keys.length > 0) {
        newEntry.key = keys.map(k => String(k).trim()).filter(Boolean);
    }
    // TunnelVision-managed entries: disable keyword triggering since retrieval is tree-based
    newEntry.selective = false;
    newEntry.constant = false;
    newEntry.disable = false;

    // Persist to disk
    await saveWorldInfo(bookName, bookData, true);

    // Assign to tree node
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
        addEntryToNode(targetNode, newEntry.uid);
        saveTree(bookName, tree);
    } else {
        nodeLabel = '(no tree)';
    }

    if (isTrackerTitle(newEntry.comment)) {
        setTrackerUid(bookName, newEntry.uid, true);
    }

    console.log(`[TunnelVision] Created entry "${comment}" (UID ${newEntry.uid}) in "${bookName}" → ${nodeLabel}`);
    return { uid: newEntry.uid, comment: newEntry.comment, nodeLabel };
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
        // Find the correct key for this UID (keys are NOT the same as UIDs in ST)
        for (const key of Object.keys(bookData.entries)) {
            if (bookData.entries[key].uid === uid) {
                delete bookData.entries[key];
                break;
            }
        }
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
        for (const key of Object.keys(bookData.entries)) {
            if (bookData.entries[key].uid === removeUid) {
                delete bookData.entries[key];
                break;
            }
        }
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
