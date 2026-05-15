/**
 * TunnelVision_Search Tool
 * Navigates the hierarchical tree index to retrieve lorebook entries.
 *
 * Supports two search modes:
 *   - "traversal" (default): Top-down step-by-step. Model sees top-level nodes,
 *     picks one, drills deeper via recursive tool calls (ST RECURSE_LIMIT).
 *   - "collapsed": Entire tree shown at once with summaries. Model picks node IDs
 *     directly in a single call. Based on RAPTOR research showing collapsed-tree
 *     retrieval consistently outperforms top-down traversal.
 */

import { loadWorldInfo } from '../../../../world-info.js';
import {
    getTree,
    findNodeById,
    getAllEntryUids,
    getSettings,
} from '../tree-store.js';
import { getReadableBooks } from '../tool-registry.js';
import { getKeywordTriggeredUids } from '../index.js';

// ─── Loop Detection ─────────────────────────────────────────────
// Tracks node IDs called within the current generation turn.
// If the same node is requested 3+ times, we break the loop by
// returning guidance instead of the normal response.

const _nodeCallCounts = new Map(); // node_id → call count this turn
const LOOP_THRESHOLD = 3;

// ─── Selective Retrieval Tracking ────────────────────────────────
// When selective retrieval resolves specific UIDs, store them here
// so smart-context can filter its candidates to match.

const _selectivelyRetrievedUids = new Set();

/**
 * Get the set of UIDs the model explicitly selected this turn.
 * Empty if no selective retrieval has happened yet.
 */
export function getSelectivelyRetrievedUids() {
    return _selectivelyRetrievedUids;
}

/**
 * Clear selective retrieval tracking. Call at GENERATION_STARTED.
 */
export function resetSelectiveRetrievalTracker() {
    _selectivelyRetrievedUids.clear();
}

/**
 * Reset the loop detector. Call at GENERATION_STARTED.
 */
export function resetSearchLoopTracker() {
    _nodeCallCounts.clear();
}

/**
 * Track a node_id call and return a loop-break message if threshold hit.
 * @param {string} nodeId
 * @returns {string|null} Loop-break message, or null if not looping
 */
function checkSearchLoop(nodeId) {
    if (!nodeId) return null;
    const count = (_nodeCallCounts.get(nodeId) || 0) + 1;
    _nodeCallCounts.set(nodeId, count);
    if (count >= LOOP_THRESHOLD) {
        const sampleIds = _collectSampleNodeIds(4).filter(id => id !== nodeId);
        const alternatives = sampleIds.length > 0
            ? ` Try these other nodes instead: ${sampleIds.join(', ')}.`
            : '';
        return (
            `You have searched node "${nodeId}" ${count} times this turn with the same result. ` +
            `To find what you need, try one of these approaches:\n` +
            `1. Use action "search" with a "query" keyword to search across all entries\n` +
            `2. Use action "retrieve" to get the full content of this node\n` +
            `3. Navigate to a different branch of the tree${alternatives}`
        );
    }
    return null;
}

/**
 * Build a UID→entry lookup map from lorebook data.
 * Eliminates O(n²) iteration when resolving multiple UIDs.
 * @param {Object} entries - bookData.entries
 * @returns {Map<number, Object>}
 */
function buildUidMap(entries) {
    const map = new Map();
    for (const key of Object.keys(entries)) {
        map.set(entries[key].uid, entries[key]);
    }
    return map;
}

export const TOOL_NAME = 'TunnelVision_Search';
export const COMPACT_DESCRIPTION = 'Navigate and search the lorebook tree to retrieve relevant entries for the current scene.';

// ─── Multi-Document Constants ────────────────────────────────────

/** Prefix for document-level virtual node IDs (lorebook selectors). */
const DOC_NODE_PREFIX = 'tv_doc_';

/**
 * Generate a deterministic virtual node ID for a lorebook.
 * These IDs let the model "pick a document" as if it were a top-level tree node.
 * @param {string} bookName
 * @returns {string}
 */
function docNodeId(bookName) {
    return `${DOC_NODE_PREFIX}${bookName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/**
 * Check if a node ID is a document-level virtual node.
 * @param {string} nodeId
 * @returns {boolean}
 */
function isDocNode(nodeId) {
    return nodeId.startsWith(DOC_NODE_PREFIX);
}

/**
 * Resolve a document node ID back to a lorebook name.
 * @param {string} nodeId
 * @returns {string|null}
 */
function resolveDocNodeBook(nodeId) {
    if (!isDocNode(nodeId)) return null;
    const suffix = nodeId.slice(DOC_NODE_PREFIX.length);
    // Try exact match first (bookName may have had chars replaced with _)
    const activeBooks = getReadableBooks();
    for (const bookName of activeBooks) {
        if (docNodeId(bookName) === nodeId) return bookName;
    }
    return null;
}

// ─── Traversal Mode Helpers ──────────────────────────────────────

/**
 * Build the top-level overview showing lorebooks as selectable document nodes.
 * Used in traversal mode — the model sees one level at a time.
 * When multiple lorebooks are active, shows document-level nodes the model can pick.
 * When only one lorebook is active, shows its tree children directly.
 * @returns {string}
 */
function buildTopLevelOverview() {
    const activeBooks = getReadableBooks();
    if (activeBooks.length === 0) return '';

    // Single lorebook: show its children directly (no document-level indirection)
    if (activeBooks.length === 1) {
        const tree = getTree(activeBooks[0]);
        if (!tree || !tree.root) return '';
        let overview = `Lorebook: ${activeBooks[0]}\n`;
        overview += formatChildrenForNavigation(tree.root);
        return overview;
    }

    // Multiple lorebooks: present each as a selectable document node
    let overview = 'Documents (pick a document to explore its contents):\n';
    for (const bookName of activeBooks) {
        const tree = getTree(bookName);
        if (!tree || !tree.root) continue;
        const totalEntries = getAllEntryUids(tree.root).length;
        const childCount = (tree.root.children || []).length;
        const id = docNodeId(bookName);
        overview += `  - [${id}] ${bookName} (${childCount} categories, ${totalEntries} entries)\n`;
        if (tree.root.summary) {
            overview += `    Summary: ${tree.root.summary}\n`;
        }
    }
    return overview;
}

/**
 * Format a node's children as navigation options.
 * @param {import('../tree-store.js').TreeNode} parentNode
 * @returns {string}
 */
function formatChildrenForNavigation(parentNode) {
    const children = parentNode.children || [];
    const directEntries = parentNode.entryUids || [];

    if (children.length === 0) {
        if (directEntries.length > 0) {
            return `  This node has ${directEntries.length} entries ready to retrieve.\n`;
        }
        return '  (empty)\n';
    }

    let text = '';
    for (const child of children) {
        if (child.hidden) continue;
        const entryCount = getAllEntryUids(child).length;
        const hasChildren = (child.children || []).length > 0;
        const depthIndicator = hasChildren ? ' [has sub-categories]' : ' [leaf]';

        text += `  - [${child.id}] ${child.label || 'Unnamed'}${depthIndicator} (${entryCount} entries)\n`;
        if (child.summary) {
            text += `    Summary: ${child.summary}\n`;
        }
    }

    if (directEntries.length > 0) {
        text += `  - [${parentNode.id}] (${directEntries.length} entries directly on this node)\n`;
    }

    return text;
}

// ─── Unified Mode Helpers ────────────────────────────────────────

/**
 * Build a unified tree overview merging all active lorebook trees.
 * Children from all books appear as top-level siblings. Each node label
 * is prefixed with [BookName] to maintain provenance.
 * @returns {string}
 */
function buildUnifiedTreeOverview() {
    const activeBooks = getReadableBooks();
    if (activeBooks.length === 0) return '';

    // Single lorebook: no need for unified mode, use normal view
    if (activeBooks.length === 1) {
        const tree = getTree(activeBooks[0]);
        if (!tree || !tree.root) return '';
        let overview = `Lorebook: ${activeBooks[0]}\n`;
        overview += formatChildrenForNavigation(tree.root);
        return overview;
    }

    let overview = 'Unified Knowledge Tree (all lorebooks merged):\n';
    for (const bookName of activeBooks) {
        const tree = getTree(bookName);
        if (!tree || !tree.root) continue;
        for (const child of (tree.root.children || [])) {
            if (child.hidden) continue;
            const entryCount = getAllEntryUids(child).length;
            const hasChildren = (child.children || []).length > 0;
            const depthIndicator = hasChildren ? ' [has sub-categories]' : ' [leaf]';
            overview += `  - [${child.id}] ${child.label || 'Unnamed'}${depthIndicator} (${entryCount} entries, from: ${bookName})\n`;
            if (child.summary) {
                overview += `    Summary: ${child.summary}\n`;
            }
        }
        // Show root-level entries if any
        const rootEntries = (tree.root.entryUids || []).length;
        if (rootEntries > 0) {
            overview += `  - [${tree.root.id}] ${bookName} root (${rootEntries} entries)\n`;
        }
    }
    return overview;
}

/**
 * Build a unified collapsed-tree overview merging all active lorebook trees.
 * @param {number} [maxDepth=Infinity]
 * @returns {string}
 */
function buildUnifiedCollapsedOverview(maxDepth = Infinity) {
    const activeBooks = getReadableBooks();
    if (activeBooks.length === 0) return '';

    if (activeBooks.length === 1) {
        const tree = getTree(activeBooks[0]);
        if (!tree || !tree.root) return '';
        return `Lorebook: ${activeBooks[0]}\n` + formatCollapsedNode(tree.root, 0, true, maxDepth);
    }

    let overview = 'Unified Knowledge Tree (all lorebooks merged):\n';
    for (const bookName of activeBooks) {
        const tree = getTree(bookName);
        if (!tree || !tree.root) continue;
        // Show each book's children at the top level
        for (const child of (tree.root.children || [])) {
            if (child.hidden) continue;
            overview += formatCollapsedNode(child, 1, false, maxDepth);
        }
        if ((tree.root.entryUids || []).length > 0) {
            overview += `  [${tree.root.id}] ${bookName} root (${(tree.root.entryUids || []).length} direct entries)\n`;
        }
    }
    return overview;
}

// ─── Collapsed Mode Helpers ──────────────────────────────────────

/**
 * Build a full collapsed-tree view showing nodes up to maxDepth levels.
 * The model sees the tree structure at once and picks node IDs directly.
 * When multiple lorebooks are active, each gets a selectable document-level node.
 * @param {number} [maxDepth=Infinity]
 * @returns {string}
 */
function buildCollapsedTreeOverview(maxDepth = Infinity) {
    const activeBooks = getReadableBooks();
    if (activeBooks.length === 0) return '';

    const multiDoc = activeBooks.length > 1;
    let overview = multiDoc
        ? 'Documents & Tree Index (pick node IDs to retrieve content):\n'
        : '';

    for (const bookName of activeBooks) {
        const tree = getTree(bookName);
        if (!tree || !tree.root) continue;

        if (multiDoc) {
            const totalEntries = getAllEntryUids(tree.root).length;
            const id = docNodeId(bookName);
            overview += `[${id}] ${bookName} (${totalEntries} entries total)\n`;
        } else {
            overview += `Lorebook: ${bookName}\n`;
        }
        // Show tree under this document, indented one level deeper in multi-doc
        const baseDepth = multiDoc ? 1 : 0;
        overview += formatCollapsedNode(tree.root, baseDepth, true, maxDepth);
        overview += '\n';
    }
    return overview;
}

/**
 * Recursively format a node and descendants for collapsed-tree display.
 * @param {import('../tree-store.js').TreeNode} node
 * @param {number} depth
 * @param {boolean} isRoot
 * @param {number} [maxDepth=Infinity] - Stop recursing at this depth and show a navigate hint instead
 * @returns {string}
 */
function formatCollapsedNode(node, depth, isRoot = false, maxDepth = Infinity) {
    const indent = '  '.repeat(depth);
    const children = node.children || [];
    const directEntries = (node.entryUids || []).length;
    const totalEntries = getAllEntryUids(node).length;

    let text = '';

    if (isRoot) {
        // Root node: just show its ID for direct-entry retrieval if it has entries
        if (directEntries > 0) {
            text += `${indent}[${node.id}] ROOT (${directEntries} direct entries)\n`;
        }
    } else {
        // Regular node: show ID, label, summary, entry counts
        const isLeaf = children.length === 0;
        const type = isLeaf ? 'leaf' : 'branch';
        text += `${indent}[${node.id}] ${node.label || 'Unnamed'} [${type}] (${totalEntries} entries`;
        if (!isLeaf && directEntries > 0) {
            text += `, ${directEntries} direct`;
        }
        text += ')\n';
        if (node.summary) {
            text += `${indent}  ${node.summary}\n`;
        }

        // Depth-limited: show navigate hint instead of recursing into children
        if (maxDepth !== Infinity && depth >= maxDepth && children.length > 0) {
            const subCount = children.length;
            const totalBelow = totalEntries - directEntries;
            text += `${indent}  → Navigate into this node to see ${subCount} sub-categories (${totalBelow} entries)\n`;
            return text;
        }
    }

    for (const child of children) {
        if (child.hidden) continue;
        text += formatCollapsedNode(child, depth + 1, false, maxDepth);
    }

    return text;
}

// ─── Shared Helpers ──────────────────────────────────────────────

/**
 * Resolve a node to its full entry content.
 * Handles both real tree nodes and virtual document-level nodes.
 * @param {string} nodeId
 * @returns {Promise<string>}
 */
async function resolveNodeEntries(nodeId, seenEntries = new Set()) {
    const results = [];

    // Document-level node: resolve all entries from that specific lorebook
    if (isDocNode(nodeId)) {
        const bookName = resolveDocNodeBook(nodeId);
        if (!bookName) return '';
        const tree = getTree(bookName);
        if (!tree || !tree.root) return '';
        const uids = getAllEntryUids(tree.root);
        const bookData = await loadWorldInfo(bookName);
        if (!bookData || !bookData.entries) return '';
        const uidMap = buildUidMap(bookData.entries);
        pushResolvedEntries(results, seenEntries, bookName, uidMap, uids);
        return results.join('\n\n');
    }

    // Regular node: search across all active books
    const activeBooks = getReadableBooks();
    for (const bookName of activeBooks) {
        const tree = getTree(bookName);
        if (!tree || !tree.root) continue;

        const node = findNodeById(tree.root, nodeId);
        if (!node) continue;

        const uids = getAllEntryUids(node);
        const bookData = await loadWorldInfo(bookName);
        if (!bookData || !bookData.entries) continue;

        const uidMap = buildUidMap(bookData.entries);
        pushResolvedEntries(results, seenEntries, bookName, uidMap, uids);
    }

    return results.join('\n\n');
}

function pushResolvedEntries(results, seenEntries, bookName, uidMap, uids) {
    for (const uid of uids) {
        const entry = uidMap.get(uid);
        if (!entry?.content || entry.disable) continue;

        const key = `${bookName}:${uid}`;
        if (seenEntries.has(key)) continue;
        seenEntries.add(key);
        const title = entry.comment || entry.key?.[0] || `Entry #${uid}`;
        const triggered = getKeywordTriggeredUids().has(Number(uid));
        const tag = triggered ? ' | ⚡ Already in context via keyword trigger' : '';
        results.push(`[Lorebook: ${bookName} | UID: ${uid} | Title: ${title}${tag}]\n${entry.content}`);
    }
}

/**
 * Build a manifest of entry titles/keys for a node WITHOUT injecting full content.
 * Used in selective retrieval mode so the model can pick specific entries.
 * @param {string} nodeId
 * @returns {Promise<{manifest: string, count: number}>}
 */
async function buildEntryManifest(nodeId) {
    const lines = [];
    let count = 0;
    const seen = new Set();

    const resolveFromBook = (bookName, uidMap, uids) => {
        for (const uid of uids) {
            const key = `${bookName}:${uid}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const entry = uidMap.get(uid);
            if (!entry?.content || entry.disable) continue;
            count++;
            const title = entry.comment || entry.key?.[0] || `Entry #${uid}`;
            const keys = (entry.key || []).slice(0, 5).join(', ');
            const preview = (entry.content || '').substring(0, 120).replace(/\n/g, ' ');
            const triggered = getKeywordTriggeredUids().has(Number(uid));
            const tag = triggered ? ' ⚡already in context' : '';
            lines.push(`  - [UID ${uid}] "${title}" (${bookName})${tag}${keys ? ` — keys: ${keys}` : ''}\n    ${preview}${entry.content.length > 120 ? '...' : ''}`);
        }
    };

    if (isDocNode(nodeId)) {
        const bookName = resolveDocNodeBook(nodeId);
        if (!bookName) return { manifest: '', count: 0 };
        const tree = getTree(bookName);
        if (!tree?.root) return { manifest: '', count: 0 };
        const uids = getAllEntryUids(tree.root);
        const bookData = await loadWorldInfo(bookName);
        if (!bookData?.entries) return { manifest: '', count: 0 };
        resolveFromBook(bookName, buildUidMap(bookData.entries), uids);
    } else {
        for (const bookName of getReadableBooks()) {
            const tree = getTree(bookName);
            if (!tree?.root) continue;
            const node = findNodeById(tree.root, nodeId);
            if (!node) continue;
            const uids = getAllEntryUids(node);
            const bookData = await loadWorldInfo(bookName);
            if (!bookData?.entries) continue;
            resolveFromBook(bookName, buildUidMap(bookData.entries), uids);
        }
    }

    return { manifest: lines.join('\n'), count };
}

/**
 * Resolve specific entries by UID across all active lorebooks.
 * Used in selective retrieval mode when the model picks entries from the manifest.
 * @param {number[]} uids
 * @returns {Promise<string>}
 */
async function resolveEntriesByUid(uids) {
    const results = [];
    const seen = new Set();

    for (const bookName of getReadableBooks()) {
        const bookData = await loadWorldInfo(bookName);
        if (!bookData?.entries) continue;
        const uidMap = buildUidMap(bookData.entries);

        for (const uid of uids) {
            const numUid = Number(uid);
            if (!isFinite(numUid)) continue;
            const entry = uidMap.get(numUid);
            if (!entry?.content || entry.disable) continue;
            const key = `${bookName}:${numUid}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const title = entry.comment || entry.key?.[0] || `Entry #${numUid}`;
            results.push(`[Lorebook: ${bookName} | UID: ${numUid} | Title: ${title}]\n${entry.content}`);
        }
    }

    return results.join('\n\n');
}

/**
 * Find which book a node belongs to.
 * Handles both real tree nodes and virtual document-level nodes.
 * @param {string} nodeId
 * @returns {{ node: import('../tree-store.js').TreeNode, bookName: string, isDocNode: boolean } | null}
 */
function findNodeAcrossBooks(nodeId) {
    // Check if this is a virtual document-level node
    if (isDocNode(nodeId)) {
        const bookName = resolveDocNodeBook(nodeId);
        if (!bookName) return null;
        const tree = getTree(bookName);
        if (!tree || !tree.root) return null;
        return { node: tree.root, bookName, isDocNode: true };
    }

    for (const bookName of getReadableBooks()) {
        const tree = getTree(bookName);
        if (!tree || !tree.root) continue;
        const node = findNodeById(tree.root, nodeId);
        if (node) return { node, bookName, isDocNode: false };
    }
    return null;
}

/**
 * Collect a sample of node IDs from active trees for error recovery hints.
 * Used when the model calls the tool with empty args (proxy truncated the description).
 * @param {number} max Maximum number of IDs to return
 * @returns {string[]}
 */
function _collectSampleNodeIds(max = 8) {
    const ids = [];
    for (const bookName of getReadableBooks()) {
        const tree = getTree(bookName);
        if (!tree?.root) continue;
        const queue = [...(tree.root.children || [])];
        while (queue.length > 0 && ids.length < max) {
            const node = queue.shift();
            if (node.id) ids.push(node.id);
            if (node.children) queue.push(...node.children);
        }
    }
    return ids;
}

// ─── Tool Definition ─────────────────────────────────────────────

/**
 * Build the dynamic tree overview portion of the Search description.
 * Separated from the static instruction text so prompt overrides don't bake in the tree.
 * @returns {string} Tree overview text to append to the description, or empty string
 */
export function getTreeOverview() {
    const activeBooks = getReadableBooks();
    if (activeBooks.length === 0) return '';

    let hasValidTree = false;
    for (const bookName of activeBooks) {
        const tree = getTree(bookName);
        if (tree && tree.root && ((tree.root.children || []).length > 0 || (tree.root.entryUids || []).length > 0)) {
            hasValidTree = true;
            break;
        }
    }
    if (!hasValidTree) return '';

    const settings = getSettings();
    const searchMode = settings.searchMode || 'traversal';
    const isCollapsed = searchMode === 'collapsed';
    const multiBookMode = settings.multiBookMode || 'unified';
    const useUnified = multiBookMode === 'unified' && activeBooks.length > 1;
    const collapsedDepth = isCollapsed ? (settings.collapsedDepth ?? 2) : Infinity;

    let treeOverview;
    if (useUnified) {
        treeOverview = isCollapsed
            ? buildUnifiedCollapsedOverview(collapsedDepth)
            : buildUnifiedTreeOverview();
    } else {
        treeOverview = isCollapsed
            ? buildCollapsedTreeOverview(collapsedDepth)
            : buildTopLevelOverview();
    }

    // Cap tree overview to avoid blowing up context window
    const maxLen = isCollapsed ? 6000 : 4000;
    if (treeOverview.length > maxLen) {
        treeOverview = treeOverview.substring(0, maxLen - 100) + '\n  ... (tree truncated, use node IDs to retrieve content)\n';
    }

    const header = isCollapsed ? '\n\nFull tree index:\n' : '\n\nTop-level tree:\n';
    return header + treeOverview;
}

/**
 * Check whether at least one active book has a valid (non-empty) tree.
 * @returns {boolean}
 */
function hasAnyValidTree() {
    for (const bookName of getReadableBooks()) {
        const tree = getTree(bookName);
        if (tree && tree.root && ((tree.root.children || []).length > 0 || (tree.root.entryUids || []).length > 0)) {
            return true;
        }
    }
    return false;
}

/**
 * Returns the tool definition for ToolManager.registerFunctionTool().
 * @returns {Object|null} Tool definition or null if no active lorebooks
 */
export function getDefinition() {
    const activeBooks = getReadableBooks();
    if (activeBooks.length === 0) return null;

    const settings = getSettings();
    const searchMode = settings.searchMode || 'traversal';
    const isCollapsed = searchMode === 'collapsed';
    const selective = settings.selectiveRetrieval === true;

    const selectiveNote = selective
        ? '\n\nSELECTIVE RETRIEVAL: When you retrieve a node, you will see a manifest of entry titles and previews instead of full content. Pick the entries you need by their UIDs using entry_uids to get their full content.'
        : '';

    const description = isCollapsed
        ? `Search lorebook knowledge by selecting from the full tree index below. Use this to find relevant world info, character details, lore, or rules for the current scene.

HOW TO USE (Collapsed-Tree Mode):
1. Review the FULL tree structure below — all categories and sub-categories are shown
2. Pick the node_id(s) most relevant to the current scene
3. Call with action "retrieve" and the node_id to get the actual entry content
4. You can retrieve from ANY level — branches return all entries underneath, leaves return their own entries

TIP: Pick the most specific (deepest) node that matches your need. Retrieving a branch returns ALL descendant entries, which may include irrelevant content.

CROSS-BOOK SEARCH: Use action "search" with a "query" to find entries by keyword across ALL active lorebooks. Useful when you're not sure which category something is in, or need to find a specific character/place/item by name.${selectiveNote}`
        : `Search lorebook knowledge by navigating a hierarchical tree. Use this to find relevant world info, character details, lore, or rules for the current scene.

HOW TO USE (Traversal Mode):
1. First call: Review the top-level categories below and pick the most relevant
2. If the selected node has sub-categories, call again with that node_id to go deeper
3. When you find the right category, use action "retrieve" to get the actual content

CROSS-BOOK SEARCH: Use action "search" with a "query" to find entries by keyword across ALL active lorebooks. Useful when you're not sure which category something is in, or need to find a specific character/place/item by name.${selectiveNote}`;

    // Entry UIDs parameter for selective retrieval
    const entryUidsParam = selective
        ? {
            entry_uids: {
                type: 'array',
                items: { type: 'number' },
                description: 'Specific entry UIDs to retrieve full content for. Use after seeing the entry manifest from a retrieve call.',
            },
        }
        : {};

    // Collapsed mode: node_ids accepts multiple IDs in one call
    // NOTE: $schema is intentionally omitted — it's non-standard for OpenAI function calling
    // and causes some proxies (e.g. Electron Hub, OpenRouter) to silently strip or mangle
    // the tool call arguments, resulting in empty args `{}`.
    const parameters = isCollapsed
        ? {
            type: 'object',
            required: ['node_ids'],
            properties: {
                node_ids: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'One or more node IDs to retrieve content from. Pick the most relevant nodes for the current scene.',
                },
                node_id: {
                    type: 'string',
                    description: 'Single node ID (use node_ids for multiple). Kept for compatibility.',
                },
                action: {
                    type: 'string',
                    enum: ['retrieve', 'navigate', 'search'],
                    description: '"retrieve" to get entry content (default). "navigate" to see a node\'s children. "search" to find entries by keyword across all lorebooks.',
                },
                query: {
                    type: 'string',
                    description: 'For action "search": keyword or phrase to find across all lorebooks. Matches entry titles, keywords, and content.',
                },
                ...entryUidsParam,
            },
        }
        : {
            type: 'object',
            required: ['node_id'],
            properties: {
                node_id: {
                    type: 'string',
                    description: 'The node ID to navigate into or retrieve from.',
                },
                action: {
                    type: 'string',
                    enum: ['navigate', 'retrieve', 'search'],
                    description: '"navigate" to see children, "retrieve" to get entry content. "search" to find entries by keyword across all lorebooks. Auto-detects: navigate if node has children, retrieve if leaf.',
                },
                query: {
                    type: 'string',
                    description: 'For action "search": keyword or phrase to find across all lorebooks. Matches entry titles, keywords, and content.',
                },
                ...entryUidsParam,
            },
        };

    return {
        name: TOOL_NAME,
        displayName: 'TunnelVision Search',
        description,
        parameters,
        action: async (args) => {
            // Tree validity check at call time (not registration time) to avoid
            // race conditions where trees haven't loaded yet during startup.
            if (!hasAnyValidTree()) {
                return 'No valid tree index found. The tree may still be loading — try again, or build a tree first using the TunnelVision settings panel.';
            }

            // Loop detection: break degenerate loops where the model
            // keeps calling the same node_id repeatedly
            const loopNodeId = args.node_id || (Array.isArray(args.node_ids) ? args.node_ids[0] : null);
            if (loopNodeId) {
                const loopBreak = checkSearchLoop(loopNodeId);
                if (loopBreak) return loopBreak;
            }

            // Selective retrieval: resolve specific entries by UID
            if (selective && Array.isArray(args.entry_uids) && args.entry_uids.length > 0) {
                return handleSelectiveEntryRetrieval(args.entry_uids);
            }

            // Cross-book keyword search
            if (args.action === 'search') {
                return handleCrossBookSearch(args, selective);
            }

            // Collapsed mode: support node_ids (array) or node_id (string)
            if (isCollapsed) {
                return handleCollapsedSearch(args, selective);
            }
            return handleTraversalSearch(args, selective);
        },
        formatMessage: async (args) => {
            if (args?.action === 'search') return 'Searching across all lorebooks...';
            const action = args?.action || (isCollapsed ? 'retrieve' : 'navigate');
            return action === 'retrieve'
                ? 'Retrieving lorebook entries...'
                : 'Navigating lorebook tree...';
        },
        shouldRegister: async () => {
            const settings = getSettings();
            if (settings.globalEnabled === false) return false;
            return getReadableBooks().length > 0;
        },
        stealth: false,
    };
}

/**
 * Handle selective entry retrieval: model provides specific UIDs to get full content.
 * @param {number[]} entryUids
 * @returns {Promise<string>}
 */
async function handleSelectiveEntryRetrieval(entryUids) {
    const content = await resolveEntriesByUid(entryUids);
    if (!content) {
        return `No entries found for UIDs: ${entryUids.join(', ')}. Double-check the UIDs from the manifest — they must be numeric entry UIDs, not node IDs.`;
    }
    // Track which UIDs the model explicitly selected so smart-context
    // can filter its candidates to only these entries
    for (const uid of entryUids) {
        _selectivelyRetrievedUids.add(Number(uid));
    }
    console.log(`[TunnelVision] Selective retrieval: ${entryUids.length} UID(s) requested`);
    return content;
}

/**
 * Handle search in collapsed-tree mode.
 * Supports multi-node retrieval in a single call.
 * @param {Object} args
 * @param {boolean} selective - If true, return manifest instead of full content
 */
async function handleCollapsedSearch(args, selective = false) {
    // Gather all requested node IDs
    let nodeIds = [];
    if (Array.isArray(args.node_ids) && args.node_ids.length > 0) {
        nodeIds = args.node_ids;
    } else if (args.node_id) {
        nodeIds = [args.node_id];
    }

    if (nodeIds.length === 0) {
        // Include available node IDs in the error so the model can recover even if
        // the tool description was truncated by a proxy (e.g. Electron Hub)
        const sampleIds = _collectSampleNodeIds(8);
        const idHint = sampleIds.length > 0
            ? ` Available node IDs include: ${sampleIds.join(', ')}. Use action "search" with a "query" for keyword search.`
            : '';
        return `No node_id or node_ids provided.${idHint}`;
    }

    const action = args.action || 'retrieve';

    // Navigate: show children of the first requested node
    if (action === 'navigate') {
        const found = findNodeAcrossBooks(nodeIds[0]);
        if (!found) return `Node "${nodeIds[0]}" not found. Check the available node IDs.`;
        const { node } = found;
        const hasChildren = (node.children || []).length > 0;
        if (!hasChildren) {
            return `Node "${node.label}" is a leaf node with no sub-categories. Use action "retrieve" to get its content.`;
        }
        let response = `Category: ${node.label}\n`;
        if (node.summary) response += `Summary: ${node.summary}\n`;
        response += `\nSub-categories:\n`;
        response += formatChildrenForNavigation(node);
        return response;
    }

    // Retrieve: get content from all requested nodes
    const allContent = [];
    const notFound = [];
    const retrieved = [];

    for (const nodeId of nodeIds) {
        const found = findNodeAcrossBooks(nodeId);
        if (!found) {
            notFound.push(nodeId);
            continue;
        }

        if (selective) {
            const { manifest, count } = await buildEntryManifest(nodeId);
            if (manifest) {
                retrieved.push({ label: found.node.label, count });
                allContent.push(`Category: ${found.node.label} (${count} entries)\n${manifest}`);
            }
        } else {
            const content = await resolveNodeEntries(nodeId);
            if (content) {
                const entryCount = getAllEntryUids(found.node).length;
                retrieved.push({ label: found.node.label, count: entryCount });
                allContent.push(content);
            }
        }
    }

    if (allContent.length === 0) {
        if (notFound.length > 0) {
            return `Node(s) not found: ${notFound.join(', ')}. Check the available node IDs.`;
        }
        return 'Selected nodes have no entry content. Try different nodes.';
    }

    const summary = retrieved.map(r => `"${r.label}" (${r.count})`).join(', ');
    console.log(`[TunnelVision] Retrieved from ${retrieved.length} node(s): ${summary}${selective ? ' (manifest)' : ''}`);

    let response = allContent.join('\n\n');
    if (notFound.length > 0) {
        response += `\n\n[Warning: Node(s) not found: ${notFound.join(', ')}]`;
    }
    if (selective) {
        response += '\n\nTo get full content, call again with entry_uids containing the UIDs you want.';
    }
    return response;
}

/**
 * Handle search in traversal mode (original step-by-step navigation).
 * @param {Object} args
 * @param {boolean} selective - If true, return manifest instead of full content
 */
async function handleTraversalSearch(args, selective = false) {
    if (!args?.node_id) {
        const sampleIds = _collectSampleNodeIds(6);
        const idHint = sampleIds.length > 0
            ? ` Available node IDs include: ${sampleIds.join(', ')}.`
            : '';
        return `No node_id provided.${idHint}`;
    }

    const found = findNodeAcrossBooks(args.node_id);
    if (!found) {
        return `Node "${args.node_id}" not found. Check the available node IDs.`;
    }

    const { node, bookName, isDocNode: isDoc } = found;

    // Document-level node: always navigate into it (show root children)
    if (isDoc) {
        let response = `Document: ${bookName}\n`;
        if (node.summary) response += `Summary: ${node.summary}\n`;
        response += `\nCategories:\n`;
        response += formatChildrenForNavigation(node);
        response += `\nNavigate deeper with a category node_id, or use action "retrieve" on any node to get its content.`;
        return response;
    }

    const hasChildren = (node.children || []).length > 0;
    const action = args.action || (hasChildren ? 'navigate' : 'retrieve');

    if (action === 'navigate' && hasChildren) {
        let response = `Category: ${node.label}\n`;
        if (node.summary) response += `Summary: ${node.summary}\n`;
        response += `\nSub-categories:\n`;
        response += formatChildrenForNavigation(node);
        response += `\nNavigate deeper with a sub-category node_id, or use action "retrieve" on any node to get its content.`;
        return response;
    }

    // Selective mode: show manifest instead of full content
    if (selective) {
        const { manifest, count } = await buildEntryManifest(args.node_id);
        if (!manifest) {
            return `Node "${node.label}" has no entry content. Try a different branch.`;
        }
        console.log(`[TunnelVision] Showing manifest for "${node.label}": ${count} entries`);
        let response = `Category: ${node.label} — ${count} entries found:\n\n${manifest}`;
        response += '\n\nTo get full content, call again with entry_uids containing the UIDs you want.';
        return response;
    }

    const content = await resolveNodeEntries(args.node_id);
    if (!content) {
        return `Node "${node.label}" has no entry content. Try a different branch.`;
    }

    const entryCount = getAllEntryUids(node).length;
    console.log(`[TunnelVision] Retrieved ${entryCount} entries from "${node.label}"`);
    return content;
}

// ─── Cross-Book Search ───────────────────────────────────────────

/** Maximum results returned from cross-book search. */
const SEARCH_MAX_RESULTS = 10;
/** Maximum content preview length per result. */
const SEARCH_PREVIEW_LEN = 200;

/**
 * Search across all active lorebooks by keyword.
 * Matches against entry title (comment), keywords, and content.
 * Returns matching entries with source book, UID, tree location, and content preview.
 */
async function handleCrossBookSearch(args, selective = false) {
    const query = (args.query || '').trim();
    if (!query) {
        return 'Search requires a "query" — a keyword or phrase to find across lorebooks.';
    }

    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const activeBooks = getReadableBooks();
    const results = [];

    for (const bookName of activeBooks) {
        const bookData = await loadWorldInfo(bookName);
        if (!bookData?.entries) continue;

        const tree = getTree(bookName);

        for (const key of Object.keys(bookData.entries)) {
            const entry = bookData.entries[key];
            if (entry.disable) continue;

            // Build searchable text from title, keys, and content
            const title = (entry.comment || '').toLowerCase();
            const keys = (entry.key || []).join(' ').toLowerCase();
            const content = (entry.content || '').toLowerCase();
            const searchable = `${title} ${keys} ${content}`;

            // All terms must match somewhere in the entry
            const matches = terms.every(t => searchable.includes(t));
            if (!matches) continue;

            // Find which tree node this entry belongs to
            let nodeLabel = '(unassigned)';
            if (tree?.root) {
                const nodeName = findEntryNode(tree.root, entry.uid);
                if (nodeName) nodeLabel = nodeName;
            }

            results.push({
                uid: entry.uid,
                title: entry.comment || entry.key?.[0] || `#${entry.uid}`,
                book: bookName,
                node: nodeLabel,
                keys: (entry.key || []).slice(0, 5).join(', '),
                preview: (entry.content || '').substring(0, SEARCH_PREVIEW_LEN),
            });

            if (results.length >= SEARCH_MAX_RESULTS) break;
        }
        if (results.length >= SEARCH_MAX_RESULTS) break;
    }

    if (results.length === 0) {
        return `No entries found matching "${query}" across ${activeBooks.length} lorebook(s). Try different keywords, or use tree navigation to browse by category.`;
    }

    console.log(`[TunnelVision] Cross-book search "${query}": ${results.length} result(s)`);

    let response = `Found ${results.length} entry/entries matching "${query}":\n\n`;
    for (const r of results) {
        response += `— "${r.title}" (UID ${r.uid}, ${r.book} → ${r.node})\n`;
        if (r.keys) response += `  Keys: ${r.keys}\n`;
        response += `  ${r.preview}${r.preview.length >= SEARCH_PREVIEW_LEN ? '...' : ''}\n\n`;
    }
    response += selective
        ? 'To get full entry content, call again with entry_uids containing the UIDs you want. Or use Update/Forget with a UID.'
        : 'Use action "retrieve" with node_id to get full content, or Update/Forget with the UID.';
    return response;
}

/**
 * Find which tree node contains a given entry UID.
 * Returns the node label or null if not found.
 * @param {Object} node
 * @param {number} uid
 * @returns {string|null}
 */
function findEntryNode(node, uid) {
    if ((node.entryUids || []).includes(uid)) {
        return node.label || 'root';
    }
    for (const child of (node.children || [])) {
        const found = findEntryNode(child, uid);
        if (found) return found;
    }
    return null;
}
