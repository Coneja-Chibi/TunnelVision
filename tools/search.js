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
import { getActiveTunnelVisionBooks } from '../tool-registry.js';

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
    const activeBooks = getActiveTunnelVisionBooks();
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
    const activeBooks = getActiveTunnelVisionBooks();
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
    const activeBooks = getActiveTunnelVisionBooks();
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
 * @returns {string}
 */
function buildUnifiedCollapsedOverview() {
    const activeBooks = getActiveTunnelVisionBooks();
    if (activeBooks.length === 0) return '';

    if (activeBooks.length === 1) {
        const tree = getTree(activeBooks[0]);
        if (!tree || !tree.root) return '';
        return `Lorebook: ${activeBooks[0]}\n` + formatCollapsedNode(tree.root, 0, true);
    }

    let overview = 'Unified Knowledge Tree (all lorebooks merged):\n';
    for (const bookName of activeBooks) {
        const tree = getTree(bookName);
        if (!tree || !tree.root) continue;
        // Show each book's children at the top level
        for (const child of (tree.root.children || [])) {
            overview += formatCollapsedNode(child, 1);
        }
        if ((tree.root.entryUids || []).length > 0) {
            overview += `  [${tree.root.id}] ${bookName} root (${(tree.root.entryUids || []).length} direct entries)\n`;
        }
    }
    return overview;
}

// ─── Collapsed Mode Helpers ──────────────────────────────────────

/**
 * Build a full collapsed-tree view showing ALL nodes at ALL levels.
 * The model sees the entire tree structure at once and picks node IDs directly.
 * When multiple lorebooks are active, each gets a selectable document-level node.
 * @returns {string}
 */
function buildCollapsedTreeOverview() {
    const activeBooks = getActiveTunnelVisionBooks();
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
        // Show full tree under this document, indented one level deeper in multi-doc
        const baseDepth = multiDoc ? 1 : 0;
        overview += formatCollapsedNode(tree.root, baseDepth, true);
        overview += '\n';
    }
    return overview;
}

/**
 * Recursively format a node and all descendants for collapsed-tree display.
 * @param {import('../tree-store.js').TreeNode} node
 * @param {number} depth
 * @param {boolean} isRoot
 * @returns {string}
 */
function formatCollapsedNode(node, depth, isRoot = false) {
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
    }

    for (const child of children) {
        text += formatCollapsedNode(child, depth + 1);
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
async function resolveNodeEntries(nodeId) {
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
        for (const uid of uids) {
            const entry = uidMap.get(uid);
            if (entry?.content) results.push(entry.content);
        }
        return results.join('\n\n');
    }

    // Regular node: search across all active books
    const activeBooks = getActiveTunnelVisionBooks();
    for (const bookName of activeBooks) {
        const tree = getTree(bookName);
        if (!tree || !tree.root) continue;

        const node = findNodeById(tree.root, nodeId);
        if (!node) continue;

        const uids = getAllEntryUids(node);
        const bookData = await loadWorldInfo(bookName);
        if (!bookData || !bookData.entries) continue;

        const uidMap = buildUidMap(bookData.entries);
        for (const uid of uids) {
            const entry = uidMap.get(uid);
            if (entry?.content) results.push(entry.content);
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

    for (const bookName of getActiveTunnelVisionBooks()) {
        const tree = getTree(bookName);
        if (!tree || !tree.root) continue;
        const node = findNodeById(tree.root, nodeId);
        if (node) return { node, bookName, isDocNode: false };
    }
    return null;
}

// ─── Tool Definition ─────────────────────────────────────────────

/**
 * Returns the tool definition for ToolManager.registerFunctionTool().
 * @returns {Object|null} Tool definition or null if no valid trees exist
 */
export function getDefinition() {
    const activeBooks = getActiveTunnelVisionBooks();
    if (activeBooks.length === 0) return null;

    let hasValidTree = false;
    for (const bookName of activeBooks) {
        const tree = getTree(bookName);
        if (tree && tree.root && ((tree.root.children || []).length > 0 || (tree.root.entryUids || []).length > 0)) {
            hasValidTree = true;
            break;
        }
    }
    if (!hasValidTree) return null;

    const settings = getSettings();
    const searchMode = settings.searchMode || 'traversal';
    const isCollapsed = searchMode === 'collapsed';

    const multiBookMode = settings.multiBookMode || 'unified';
    const useUnified = multiBookMode === 'unified' && activeBooks.length > 1;

    let treeOverview;
    if (useUnified) {
        treeOverview = isCollapsed
            ? buildUnifiedCollapsedOverview()
            : buildUnifiedTreeOverview();
    } else {
        treeOverview = isCollapsed
            ? buildCollapsedTreeOverview()
            : buildTopLevelOverview();
    }

    // Cap description to avoid blowing up context window
    const maxLen = isCollapsed ? 6000 : 4000;
    if (treeOverview.length > maxLen) {
        treeOverview = treeOverview.substring(0, maxLen - 100) + '\n  ... (tree truncated, use node IDs to retrieve content)\n';
    }

    const description = isCollapsed
        ? `Search lorebook knowledge by selecting from the full tree index below. Use this to find relevant world info, character details, lore, or rules for the current scene.

HOW TO USE (Collapsed-Tree Mode):
1. Review the FULL tree structure below — all categories and sub-categories are shown
2. Pick the node_id(s) most relevant to the current scene
3. Call with action "retrieve" and the node_id to get the actual entry content
4. You can retrieve from ANY level — branches return all entries underneath, leaves return their own entries

TIP: Pick the most specific (deepest) node that matches your need. Retrieving a branch returns ALL descendant entries, which may include irrelevant content.

Full tree index:
${treeOverview}`
        : `Search lorebook knowledge by navigating a hierarchical tree. Use this to find relevant world info, character details, lore, or rules for the current scene.

HOW TO USE (Traversal Mode):
1. First call: Review the top-level categories below and pick the most relevant
2. If the selected node has sub-categories, call again with that node_id to go deeper
3. When you find the right category, use action "retrieve" to get the actual content

Top-level tree:
${treeOverview}`;

    // Collapsed mode: node_ids accepts multiple IDs in one call
    const parameters = isCollapsed
        ? {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
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
                    enum: ['retrieve', 'navigate'],
                    description: '"retrieve" to get entry content (default). "navigate" to see a node\'s children.',
                },
                reasoning: {
                    type: 'string',
                    description: 'Brief explanation of why these nodes are relevant to the current scene.',
                },
            },
        }
        : {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                node_id: {
                    type: 'string',
                    description: 'The node ID to navigate into or retrieve from.',
                },
                action: {
                    type: 'string',
                    enum: ['navigate', 'retrieve'],
                    description: '"navigate" to see children, "retrieve" to get entry content. Auto-detects: navigate if node has children, retrieve if leaf.',
                },
                reasoning: {
                    type: 'string',
                    description: 'Brief explanation of why this branch is relevant to the current scene.',
                },
            },
            required: ['node_id'],
        };

    return {
        name: TOOL_NAME,
        displayName: 'TunnelVision Search',
        description,
        parameters,
        action: async (args) => {
            if (args.reasoning) {
                console.log(`[TunnelVision] Search | ${args.reasoning}`);
            }

            // Collapsed mode: support node_ids (array) or node_id (string)
            if (isCollapsed) {
                return handleCollapsedSearch(args);
            }
            return handleTraversalSearch(args);
        },
        formatMessage: async (args) => {
            const action = args?.action || (isCollapsed ? 'retrieve' : 'navigate');
            return action === 'retrieve'
                ? 'Retrieving lorebook entries...'
                : 'Navigating lorebook tree...';
        },
        shouldRegister: async () => {
            const settings = getSettings();
            if (settings.globalEnabled === false) return false;
            return getActiveTunnelVisionBooks().length > 0;
        },
        stealth: false,
    };
}

/**
 * Handle search in collapsed-tree mode.
 * Supports multi-node retrieval in a single call.
 */
async function handleCollapsedSearch(args) {
    // Gather all requested node IDs
    let nodeIds = [];
    if (Array.isArray(args.node_ids) && args.node_ids.length > 0) {
        nodeIds = args.node_ids;
    } else if (args.node_id) {
        nodeIds = [args.node_id];
    }

    if (nodeIds.length === 0) {
        return 'No node_id or node_ids provided. Select one or more node IDs from the tree above.';
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
        const content = await resolveNodeEntries(nodeId);
        if (content) {
            const entryCount = getAllEntryUids(found.node).length;
            retrieved.push({ label: found.node.label, count: entryCount });
            allContent.push(content);
        }
    }

    if (allContent.length === 0) {
        if (notFound.length > 0) {
            return `Node(s) not found: ${notFound.join(', ')}. Check the available node IDs.`;
        }
        return 'Selected nodes have no entry content. Try different nodes.';
    }

    const summary = retrieved.map(r => `"${r.label}" (${r.count})`).join(', ');
    console.log(`[TunnelVision] Retrieved from ${retrieved.length} node(s): ${summary}`);

    let response = allContent.join('\n\n');
    if (notFound.length > 0) {
        response += `\n\n[Warning: Node(s) not found: ${notFound.join(', ')}]`;
    }
    return response;
}

/**
 * Handle search in traversal mode (original step-by-step navigation).
 */
async function handleTraversalSearch(args) {
    if (!args?.node_id) {
        return 'No node_id provided. Select a node from the tree above.';
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

    const content = await resolveNodeEntries(args.node_id);
    if (!content) {
        return `Node "${node.label}" has no entry content. Try a different branch.`;
    }

    const entryCount = getAllEntryUids(node).length;
    console.log(`[TunnelVision] Retrieved ${entryCount} entries from "${node.label}"`);
    return content;
}
