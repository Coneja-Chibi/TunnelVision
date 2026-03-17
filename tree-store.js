/**
 * TunnelVision Tree Store
 * Manages the hierarchical tree index over lorebook entries.
 * Each tree node represents a category/topic containing references to WI entry UIDs.
 */

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { loadWorldInfo } from '../../../world-info.js';

const EXTENSION_NAME = 'tunnelvision';
const TRACKER_TITLE_PREFIX = /^\[tracker[^\]]*\]/i;

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
    normalizeTree(tree, lorebookName);
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
export const SETTING_DEFAULTS = {
    globalEnabled: true,
    trees: {},
    enabledLorebooks: {},
    selectedLorebook: null,
    bookDescriptions: {},
    connectionProfile: null,
    sidecarTemperature: 0.2,
    sidecarMaxTokens: 8192,
    disabledTools: {},
    searchMode: 'traversal',
    collapsedDepth: 2,
    recurseLimit: 5,
    enableVectorDedup: false,
    vectorDedupThreshold: 0.85,
    llmBuildDetail: 'lite',
    treeGranularity: 0,
    llmChunkTokens: 30000,
    commandsEnabled: true,
    commandPrefix: '!',
    commandContextMessages: 50,
    autoSummaryEnabled: false,
    autoSummaryInterval: 20,
    multiBookMode: 'unified',
    trackerUids: {},
    mandatoryTools: false,
    mandatoryPromptPosition: 'in_chat',
    mandatoryPromptDepth: 1,
    mandatoryPromptRole: 'system',
    mandatoryPromptText: '[IMPORTANT INSTRUCTION: You MUST use at least one TunnelVision tool call this turn. Before responding to the user, search the lorebook for relevant context using TunnelVision_Search. If important new information emerged in the conversation, also use TunnelVision_Remember to save it. Do NOT skip tool calls — they are mandatory every generation.]',
    notebookEnabled: true,
    notebookPromptPosition: 'in_chat',
    notebookPromptDepth: 1,
    notebookPromptRole: 'system',
    selectiveRetrieval: true,
    ephemeralResults: true,
    ephemeralToolFilter: ['TunnelVision_Search', 'TunnelVision_Summarize', 'TunnelVision_MergeSplit'],
    stealthMode: false,
    autoHideSummarized: true,
    passthroughConstant: true,
    confirmTools: {},
    toolPromptOverrides: {},
    // Sidecar auto-retrieval (pre-gen)
    sidecarAutoRetrieval: false,
    sidecarContextMessages: 10,
    sidecarMaxInjectionTokens: 4000,
    // LLM-evaluable conditional triggers (evaluated during sidecar retrieval)
    conditionalTriggersEnabled: true,
    // Sidecar post-gen writer
    sidecarPostGenWriter: false,
    sidecarWriterContextMessages: 15,
    sidecarWriterMaxOps: 5,
    // Per-lorebook permissions: { bookName: 'read_write' | 'read_only' | 'write_only' }
    bookPermissions: {},
    // Compact tool prompts: register one guide tool + one-liner descriptions to save tokens
    compactToolPrompts: true,
};

function ensureSettings() {
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = {};
    }
    const s = extension_settings[EXTENSION_NAME];
    let didMutate = false;
    for (const [key, defaultVal] of Object.entries(SETTING_DEFAULTS)) {
        if (s[key] === undefined || s[key] === null) {
            s[key] = (typeof defaultVal === 'object' && defaultVal !== null)
                ? JSON.parse(JSON.stringify(defaultVal))
                : defaultVal;
            didMutate = true;
        }
    }
    // Migration: old 'keys' detail level was renamed to 'lite'
    if (s.llmBuildDetail === 'keys') {
        s.llmBuildDetail = 'lite';
        didMutate = true;
    }

    if (normalizeTrackerSettings(s)) {
        didMutate = true;
    }

    if (normalizeConnectionProfileSetting(s)) {
        didMutate = true;
    }

    for (const [bookName, tree] of Object.entries(s.trees || {})) {
        if (normalizeTree(tree, bookName)) {
            didMutate = true;
        }
    }

    if (didMutate) {
        saveSettingsDebounced();
    }
}

export function getSettings() {
    ensureSettings();
    return extension_settings[EXTENSION_NAME];
}

function normalizeTree(tree, lorebookName) {
    if (!tree || typeof tree !== 'object') return false;

    let mutated = false;
    if (typeof tree.lorebookName !== 'string' || !tree.lorebookName) {
        tree.lorebookName = lorebookName;
        mutated = true;
    }

    if (!tree.root || typeof tree.root !== 'object') {
        tree.root = createTreeNode('Root', `Top-level index for ${tree.lorebookName}`);
        mutated = true;
    }

    if (typeof tree.version !== 'number' || !Number.isFinite(tree.version)) {
        tree.version = 1;
        mutated = true;
    }

    if (typeof tree.lastBuilt !== 'number' || !Number.isFinite(tree.lastBuilt)) {
        tree.lastBuilt = Date.now();
        mutated = true;
    }

    if (normalizeTreeNode(tree.root)) {
        mutated = true;
    }

    return mutated;
}

function normalizeTreeNode(node) {
    if (!node || typeof node !== 'object') return false;

    let mutated = false;
    if (typeof node.id !== 'string' || !node.id) {
        node.id = generateNodeId();
        mutated = true;
    }
    if (typeof node.label !== 'string') {
        node.label = 'Unnamed';
        mutated = true;
    }
    if (typeof node.summary !== 'string') {
        node.summary = '';
        mutated = true;
    }
    if (!Array.isArray(node.entryUids)) {
        node.entryUids = [];
        mutated = true;
    }
    if (!Array.isArray(node.children)) {
        node.children = [];
        mutated = true;
    }
    if (typeof node.collapsed !== 'boolean') {
        node.collapsed = Boolean(node._collapsed);
        mutated = true;
    }
    if ('_collapsed' in node) {
        delete node._collapsed;
        mutated = true;
    }

    for (const child of node.children) {
        if (normalizeTreeNode(child)) {
            mutated = true;
        }
    }

    return mutated;
}

function normalizeTrackerSettings(settings) {
    const trackerUids = settings.trackerUids;
    if (!trackerUids || typeof trackerUids !== 'object' || Array.isArray(trackerUids)) {
        settings.trackerUids = {};
        return true;
    }

    let mutated = false;
    for (const [bookName, rawUids] of Object.entries(trackerUids)) {
        const next = Array.isArray(rawUids)
            ? [...new Set(rawUids.map(uid => Number(uid)).filter(uid => Number.isFinite(uid)))]
            : [];

        if (next.length === 0) {
            if (Array.isArray(rawUids) && rawUids.length === 0) continue;
            delete trackerUids[bookName];
            mutated = true;
            continue;
        }

        next.sort((a, b) => a - b);
        if (!Array.isArray(rawUids) || rawUids.length !== next.length || rawUids.some((uid, index) => uid !== next[index])) {
            trackerUids[bookName] = next;
            mutated = true;
        }
    }

    return mutated;
}

function normalizeConnectionProfileSetting(settings) {
    const current = settings.connectionProfile;
    if (!current || typeof current !== 'string') return false;

    const profiles = getConnectionProfiles();
    if (profiles.some(profile => profile.id === current)) {
        return false;
    }

    const legacyMatch = profiles.find(profile => profile.name === current);
    if (legacyMatch) {
        settings.connectionProfile = legacyMatch.id;
        return true;
    }

    return false;
}

function getConnectionProfiles() {
    const profiles = extension_settings?.connectionManager?.profiles;
    return Array.isArray(profiles) ? profiles : [];
}

function resolveEntriesMap(entriesOrBookData) {
    if (!entriesOrBookData || typeof entriesOrBookData !== 'object') return null;
    if (entriesOrBookData.entries && typeof entriesOrBookData.entries === 'object') {
        return entriesOrBookData.entries;
    }
    return entriesOrBookData;
}

function getTrackerSet(bookName) {
    ensureSettings();
    const trackerUids = extension_settings[EXTENSION_NAME].trackerUids;
    return new Set(Array.isArray(trackerUids[bookName]) ? trackerUids[bookName] : []);
}

function storeTrackerSet(bookName, trackerSet) {
    const settings = getSettings();
    const next = [...trackerSet].sort((a, b) => a - b);
    if (next.length > 0) {
        settings.trackerUids[bookName] = next;
    } else {
        delete settings.trackerUids[bookName];
    }
}

export function getSelectedLorebook() {
    const settings = getSettings();
    return settings.selectedLorebook || null;
}

export function setSelectedLorebook(lorebookName) {
    const settings = getSettings();
    settings.selectedLorebook = lorebookName || null;
    saveSettingsDebounced();
}

export function getConnectionProfileId() {
    const settings = getSettings();
    return settings.connectionProfile || null;
}

export function setConnectionProfileId(profileId) {
    const settings = getSettings();
    settings.connectionProfile = profileId || null;
    saveSettingsDebounced();
}

export function findConnectionProfile(profileRef = null) {
    const ref = profileRef ?? getConnectionProfileId();
    if (!ref) return null;

    const profiles = getConnectionProfiles();
    return profiles.find(profile => profile.id === ref || profile.name === ref) || null;
}

export function getConnectionProfileName(profileRef = null) {
    return findConnectionProfile(profileRef)?.name || null;
}

export function listConnectionProfiles() {
    return [...getConnectionProfiles()];
}

// ─── Per-Lorebook Permissions ────────────────────────────────────

/**
 * Get the permission level for a lorebook.
 * @param {string} bookName
 * @returns {'read_write'|'read_only'|'write_only'}
 */
export function getBookPermission(bookName) {
    ensureSettings();
    return extension_settings[EXTENSION_NAME].bookPermissions[bookName] || 'read_write';
}

/**
 * Set the permission level for a lorebook.
 * @param {string} bookName
 * @param {'read_write'|'read_only'|'write_only'} permission
 */
export function setBookPermission(bookName, permission) {
    ensureSettings();
    if (permission === 'read_write') {
        // Default — remove from map to keep it clean
        delete extension_settings[EXTENSION_NAME].bookPermissions[bookName];
    } else {
        extension_settings[EXTENSION_NAME].bookPermissions[bookName] = permission;
    }
    saveSettingsDebounced();
}

/**
 * Check if a lorebook allows read (Search) operations.
 * @param {string} bookName
 * @returns {boolean}
 */
export function canReadBook(bookName) {
    const perm = getBookPermission(bookName);
    return perm === 'read_write' || perm === 'read_only';
}

/**
 * Check if a lorebook allows write (Remember/Update/Forget) operations.
 * @param {string} bookName
 * @returns {boolean}
 */
export function canWriteBook(bookName) {
    const perm = getBookPermission(bookName);
    return perm === 'read_write' || perm === 'write_only';
}

export function isTrackerTitle(title) {
    return TRACKER_TITLE_PREFIX.test(String(title || '').trim());
}

export function getTrackerUids(bookName) {
    return [...getTrackerSet(bookName)];
}

export function isTrackerUid(bookName, uid) {
    return getTrackerSet(bookName).has(Number(uid));
}

export function setTrackerUid(bookName, uid, tracked, { save = true } = {}) {
    const trackerSet = getTrackerSet(bookName);
    const numericUid = Number(uid);
    if (!Number.isFinite(numericUid)) return false;

    const hadUid = trackerSet.has(numericUid);
    if (tracked) {
        trackerSet.add(numericUid);
    } else {
        trackerSet.delete(numericUid);
    }

    if (hadUid === trackerSet.has(numericUid)) {
        return false;
    }

    storeTrackerSet(bookName, trackerSet);
    if (save) {
        saveSettingsDebounced();
    }
    return true;
}

export async function syncTrackerUidsForLorebook(bookName, entriesOrBookData = null, { save = true } = {}) {
    const entries = entriesOrBookData ? resolveEntriesMap(entriesOrBookData) : resolveEntriesMap(await loadWorldInfo(bookName));
    const trackerSet = getTrackerSet(bookName);
    const next = new Set();

    if (entries) {
        for (const key of Object.keys(entries)) {
            const entry = entries[key];
            if (!entry || entry.disable) continue;

            const shouldTrack = trackerSet.has(entry.uid) || isTrackerTitle(entry.comment);
            if (shouldTrack) {
                next.add(entry.uid);
            }
        }
    }

    const current = [...trackerSet].sort((a, b) => a - b);
    const normalized = [...next].sort((a, b) => a - b);
    const changed = current.length !== normalized.length || current.some((uid, index) => uid !== normalized[index]);

    if (!changed) {
        return normalized;
    }

    storeTrackerSet(bookName, next);
    if (save) {
        saveSettingsDebounced();
    }

    return normalized;
}
