/**
 * TunnelVision Tree Store
 * Manages the hierarchical tree index over lorebook entries.
 * Each tree node represents a category/topic containing references to WI entry UIDs.
 */

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const EXTENSION_NAME = 'tunnelvision';

/**
 * @typedef {Object} TreeNode
 * @property {string} id - Unique node ID
 * @property {string} label - Display name / topic description
 * @property {string} summary - Brief summary of what entries under this node cover
 * @property {number[]} entryUids - WI entry UIDs directly under this node
 * @property {TreeNode[]} children - Sub-categories
 * @property {boolean} collapsed - UI state for tree editor
 */

/**
 * @typedef {Object} TreeIndex
 * @property {string} lorebookName - Name of the lorebook this tree indexes
 * @property {TreeNode} root - Root node of the tree
 * @property {number} version - Schema version for future migrations
 * @property {number} lastBuilt - Timestamp of last tree build
 */

export function generateNodeId() {
    // Use crypto.getRandomValues for better collision resistance across rapid calls
    const arr = new Uint8Array(6);
    crypto.getRandomValues(arr);
    const rand = Array.from(arr, b => b.toString(36).padStart(2, '0')).join('').substring(0, 8);
    return `tv_${Date.now()}_${rand}`;
}

export function createTreeNode(label = 'New Category', summary = '') {
    return {
        id: generateNodeId(),
        label,
        summary,
        entryUids: [],
        children: [],
        collapsed: false,
    };
}

export function createEmptyTree(lorebookName) {
    return {
        lorebookName,
        root: createTreeNode('Root', `Top-level index for ${lorebookName}`),
        version: 1,
        lastBuilt: Date.now(),
    };
}

/**
 * Get the tree index for a specific lorebook.
 * @param {string} lorebookName
 * @returns {TreeIndex|null}
 */
export function getTree(lorebookName) {
    ensureSettings();
    return extension_settings[EXTENSION_NAME].trees[lorebookName] || null;
}

/**
 * Save a tree index for a lorebook.
 * @param {string} lorebookName
 * @param {TreeIndex} tree
 */
export function saveTree(lorebookName, tree) {
    ensureSettings();
    tree.lorebookName = lorebookName;
    extension_settings[EXTENSION_NAME].trees[lorebookName] = tree;
    saveSettingsDebounced();
}

/**
 * Delete the tree index for a lorebook.
 * @param {string} lorebookName
 */
export function deleteTree(lorebookName) {
    ensureSettings();
    delete extension_settings[EXTENSION_NAME].trees[lorebookName];
    saveSettingsDebounced();
}

/**
 * Check if a lorebook has TunnelVision enabled.
 * @param {string} lorebookName
 * @returns {boolean}
 */
export function isLorebookEnabled(lorebookName) {
    ensureSettings();
    return extension_settings[EXTENSION_NAME].enabledLorebooks[lorebookName] === true;
}

/**
 * Toggle TunnelVision for a lorebook.
 * @param {string} lorebookName
 * @param {boolean} enabled
 */
export function setLorebookEnabled(lorebookName, enabled) {
    ensureSettings();
    extension_settings[EXTENSION_NAME].enabledLorebooks[lorebookName] = enabled;
    saveSettingsDebounced();
}

/**
 * Get the user-set description for a lorebook, or empty string.
 * @param {string} lorebookName
 * @returns {string}
 */
export function getBookDescription(lorebookName) {
    ensureSettings();
    return extension_settings[EXTENSION_NAME].bookDescriptions[lorebookName] || '';
}

/**
 * Set a user description for a lorebook.
 * @param {string} lorebookName
 * @param {string} description
 */
export function setBookDescription(lorebookName, description) {
    ensureSettings();
    extension_settings[EXTENSION_NAME].bookDescriptions[lorebookName] = description;
    saveSettingsDebounced();
}

/**
 * Find a node by ID in the tree (depth-first).
 * @param {TreeNode} node
 * @param {string} nodeId
 * @returns {TreeNode|null}
 */
export function findNodeById(node, nodeId) {
    if (!node) return null;
    if (node.id === nodeId) return node;
    for (const child of (node.children || [])) {
        const found = findNodeById(child, nodeId);
        if (found) return found;
    }
    return null;
}

/**
 * Find the parent of a node by ID.
 * @param {TreeNode} root
 * @param {string} nodeId
 * @returns {TreeNode|null}
 */
export function findParentNode(root, nodeId) {
    if (!root) return null;
    for (const child of (root.children || [])) {
        if (child.id === nodeId) return root;
        const found = findParentNode(child, nodeId);
        if (found) return found;
    }
    return null;
}

/**
 * Remove a node from the tree. Entries are moved to parent.
 * @param {TreeNode} root
 * @param {string} nodeId
 * @returns {boolean} Whether the node was removed
 */
export function removeNode(root, nodeId) {
    const parent = findParentNode(root, nodeId);
    if (!parent) return false;

    const idx = parent.children.findIndex(c => c.id === nodeId);
    if (idx === -1) return false;

    const removed = parent.children[idx];
    // Move orphaned entries up to parent
    if (!parent.entryUids) parent.entryUids = [];
    parent.entryUids.push(...(removed.entryUids || []));
    // Move orphaned children up to parent
    parent.children.splice(idx, 1, ...(removed.children || []));

    return true;
}

/**
 * Add an entry UID to a specific node.
 * @param {TreeNode} node
 * @param {number} uid
 */
export function addEntryToNode(node, uid) {
    if (!node) return;
    if (!node.entryUids) node.entryUids = [];
    if (!node.entryUids.includes(uid)) {
        node.entryUids.push(uid);
    }
}

/**
 * Remove an entry UID from any node in the tree.
 * @param {TreeNode} root
 * @param {number} uid
 */
export function removeEntryFromTree(root, uid) {
    if (!root) return;
    root.entryUids = (root.entryUids || []).filter(u => u !== uid);
    for (const child of (root.children || [])) {
        removeEntryFromTree(child, uid);
    }
}

/**
 * Collect all entry UIDs in the tree (all nodes).
 * @param {TreeNode} node
 * @returns {number[]}
 */
export function getAllEntryUids(node) {
    if (!node) return [];
    const uids = [...(node.entryUids || [])];
    for (const child of (node.children || [])) {
        uids.push(...getAllEntryUids(child));
    }
    return uids;
}

/**
 * Build a text representation of the tree for the LLM tool description.
 * This is what the model sees when deciding which branch to search.
 * @param {TreeNode} node
 * @param {number} depth
 * @returns {string}
 */
export function buildTreeDescription(node, depth = 0) {
    if (!node) return '';
    const indent = '  '.repeat(depth);
    const entryCount = (node.entryUids || []).length;
    let desc = `${indent}- [${node.id}] ${node.label || 'Unnamed'}`;
    if (node.summary) desc += `: ${node.summary}`;
    if (entryCount > 0) desc += ` (${entryCount} entries)`;
    desc += '\n';

    for (const child of (node.children || [])) {
        desc += buildTreeDescription(child, depth + 1);
    }
    return desc;
}

/**
 * Get entries for a set of node IDs (the model's selection).
 * @param {TreeNode} root
 * @param {string[]} nodeIds
 * @returns {number[]} Array of entry UIDs
 */
export function getEntriesForNodes(root, nodeIds) {
    const uids = [];
    for (const nodeId of nodeIds) {
        const node = findNodeById(root, nodeId);
        if (node) {
            uids.push(...getAllEntryUids(node));
        }
    }
    return [...new Set(uids)];
}

/** Default settings values. Adding a new setting = add one line here. */
const SETTING_DEFAULTS = {
    globalEnabled: true,
    trees: {},
    enabledLorebooks: {},
    bookDescriptions: {},
    connectionProfile: null,
    disabledTools: {},
    searchMode: 'traversal',
    recurseLimit: 5,
    enableVectorDedup: false,
    vectorDedupThreshold: 0.85,
    llmBuildDetail: 'lite',
    llmChunkTokens: 30000,
    commandsEnabled: true,
    commandPrefix: '!',
    commandContextMessages: 50,
    autoSummaryEnabled: false,
    autoSummaryInterval: 20,
    multiBookMode: 'unified',
    trackerUids: {},
    mandatoryTools: false,
    notebookEnabled: true,
    stealthMode: false,
    autoHideSummarized: true,
};

function ensureSettings() {
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = {};
    }
    const s = extension_settings[EXTENSION_NAME];
    for (const [key, defaultVal] of Object.entries(SETTING_DEFAULTS)) {
        if (s[key] === undefined || s[key] === null) {
            // For objects/arrays, clone the default to prevent shared references
            s[key] = (typeof defaultVal === 'object' && defaultVal !== null)
                ? JSON.parse(JSON.stringify(defaultVal))
                : defaultVal;
        }
    }
    // Migration: old 'keys' detail level was renamed to 'lite'
    if (s.llmBuildDetail === 'keys') {
        s.llmBuildDetail = 'lite';
    }
}

export function getSettings() {
    ensureSettings();
    return extension_settings[EXTENSION_NAME];
}
