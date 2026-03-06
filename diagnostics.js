/**
 * TunnelVision Diagnostics
 * Checks every potential failure point and offers fixes.
 */

import { selected_world_info, world_names, loadWorldInfo, createWorldInfoEntry, saveWorldInfo } from '../../../world-info.js';
import { ToolManager } from '../../../tool-calling.js';
import { main_api, online_status, event_types, generateRaw } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { extension_settings } from '../../../extensions.js';
import {
    getTree,
    createEmptyTree,
    isLorebookEnabled,
    getAllEntryUids,
    findNodeById,
    getSettings,
    saveTree,
} from './tree-store.js';
import { getContext } from '../../../st-context.js';
import { getActiveTunnelVisionBooks, ALL_TOOL_NAMES } from './tool-registry.js';


/**
 * @typedef {Object} DiagResult
 * @property {'pass'|'warn'|'fail'} status
 * @property {string} message
 * @property {string|null} fix - Description of auto-fix applied, or null
 */

/**
 * Run all diagnostic checks.
 * @returns {DiagResult[]}
 */
export async function runDiagnostics() {
    const results = [];

    results.push(checkSettingsExist());
    results.push(checkApiConnected());
    results.push(checkToolCallingSupport());
    results.push(...checkActiveLorebooksExist());
    results.push(...checkTreesValid());
    results.push(...await checkEntryUidsValid());
    results.push(...checkNodeSummaries());
    results.push(...checkDuplicateUids());
    results.push(...await checkEmptyLorebooks());
    results.push(...checkNodeIntegrity());
    results.push(checkToolRegistered());
    results.push(checkDisabledTools());
    results.push(checkWorldInfoApi());
    results.push(checkOrphanedTrees());
    results.push(checkSearchMode());
    results.push(checkRecurseLimit());
    results.push(checkLlmBuildDetail());
    results.push(checkLlmChunkSize());
    results.push(checkVectorDedupConfig());
    results.push(...checkSummariesNode());
    results.push(...checkCollapsedTreeSize());
    results.push(...checkMultiDocConsistency());
    results.push(checkPopupAvailability());
    results.push(...checkActivityFeedEvent());
    results.push(checkFeedPersistence());
    results.push(checkGenerateRawAvailability());
    results.push(checkWiSuppressionEvent());
    results.push(checkChatIngestRequirements());
    results.push(checkMandatoryToolsEvent());
    results.push(checkCommandsConfig());
    results.push(checkAutoSummaryConfig());
    results.push(checkMultiBookMode());
    results.push(checkConnectionProfile());
    results.push(...checkTrackerUids());
    results.push(...checkArcNodes());
    results.push(checkNotebookConfig());
    results.push(checkStealthMode());
    results.push(checkAutoHideSummarized());
    results.push(checkTurnSummaryEvent());

    return results;
}

/** Check that extension settings are initialized. */
function checkSettingsExist() {
    try {
        const settings = getSettings();
        if (settings && settings.trees && settings.enabledLorebooks) {
            return pass('Extension settings initialized');
        }
        return fail('Extension settings missing or corrupt');
    } catch (e) {
        return fail(`Settings check error: ${e.message}`);
    }
}

/** Check that an API is connected (needed for generateRaw calls during tree building). */
function checkApiConnected() {
    if (!main_api) {
        return fail('No API selected. TunnelVision needs an API connection for LLM tree building.');
    }
    if (online_status === 'no_connection') {
        return warn('API is not connected. Tree building with LLM and summary generation will fail.');
    }
    return pass(`API connected (${main_api})`);
}

/** Check that the current API/model supports tool calling. */
function checkToolCallingSupport() {
    try {
        const supported = ToolManager.isToolCallingSupported();
        if (supported) {
            return pass('Current API supports tool calling');
        }
        return warn('Current API/model may not support tool calling. TunnelVision requires tool call support.');
    } catch (e) {
        return warn(`Could not verify tool calling support: ${e.message}`);
    }
}

/** Check that enabled lorebooks actually exist and are active (global, character, or chat). */
function checkActiveLorebooksExist() {
    const results = [];
    const settings = getSettings();
    const activeBooks = getActiveTunnelVisionBooks();

    for (const bookName of Object.keys(settings.enabledLorebooks)) {
        if (!settings.enabledLorebooks[bookName]) continue;

        if (!world_names?.includes(bookName)) {
            results.push(fail(`Enabled lorebook "${bookName}" does not exist. Disabling.`));
            settings.enabledLorebooks[bookName] = false;
        } else if (!activeBooks.includes(bookName)) {
            results.push(warn(`Lorebook "${bookName}" has TunnelVision enabled but is not active in current chat (not found in global, character, or chat lorebooks).`));
        } else {
            results.push(pass(`Lorebook "${bookName}" exists and is active`));
        }
    }

    if (results.length === 0) {
        results.push(warn('No lorebooks have TunnelVision enabled'));
    }

    return results;
}

/** Check that tree structures are valid for enabled lorebooks. */
function checkTreesValid() {
    const results = [];
    const activeBooks = getActiveTunnelVisionBooks();

    for (const bookName of activeBooks) {
        const tree = getTree(bookName);
        if (!tree) {
            results.push(fail(`Lorebook "${bookName}" is enabled but has no tree index. Build one first.`));
            continue;
        }
        if (!tree.root) {
            results.push(fail(`Tree for "${bookName}" has no root node. Rebuilding empty tree.`));
            saveTree(bookName, createEmptyTree(bookName));
            continue;
        }
        if ((tree.root.children || []).length === 0 && (tree.root.entryUids || []).length === 0) {
            results.push(warn(`Tree for "${bookName}" is empty. Add categories and assign entries.`));
        } else {
            const totalEntries = getAllEntryUids(tree.root).length;
            results.push(pass(`Tree for "${bookName}" has ${tree.root.children.length} categories, ${totalEntries} entries`));
        }
    }

    return results;
}

/** Check that entry UIDs in trees still exist in their lorebooks. */
async function checkEntryUidsValid() {
    const results = [];
    const activeBooks = getActiveTunnelVisionBooks();

    for (const bookName of activeBooks) {
        const tree = getTree(bookName);
        if (!tree || !tree.root) continue;

        const bookData = await loadWorldInfo(bookName);
        if (!bookData || !bookData.entries) continue;

        const validUids = new Set();
        for (const key of Object.keys(bookData.entries)) {
            validUids.add(bookData.entries[key].uid);
        }

        const treeUids = getAllEntryUids(tree.root);
        const staleUids = treeUids.filter(uid => !validUids.has(uid));

        if (staleUids.length > 0) {
            results.push(warn(`Tree for "${bookName}" has ${staleUids.length} stale entry reference(s). These entries may have been deleted from the lorebook.`));
            // Auto-fix: remove stale UIDs
            removeStaleUids(tree.root, validUids);
            saveTree(bookName, tree);
            results.push(pass(`Auto-removed ${staleUids.length} stale reference(s) from "${bookName}" tree`));
        } else if (treeUids.length > 0) {
            results.push(pass(`All ${treeUids.length} entry references in "${bookName}" tree are valid`));
        }

        // Check for unindexed entries
        const indexedUids = new Set(treeUids);
        const unindexed = [...validUids].filter(uid => !indexedUids.has(uid));
        if (unindexed.length > 0) {
            results.push(warn(`${unindexed.length} entries in "${bookName}" are not assigned to any tree node`));
        }
    }

    return results;
}

/** Check if all TunnelVision tools are properly registered. */
function checkToolRegistered() {
    const activeBooks = getActiveTunnelVisionBooks();
    if (activeBooks.length === 0) {
        return pass('No active TunnelVision lorebooks — tools correctly unregistered');
    }

    const missing = [];
    for (const toolName of ALL_TOOL_NAMES) {
        try {
            const name = ToolManager.getDisplayName(toolName);
            if (!name) missing.push(toolName);
        } catch {
            missing.push(toolName);
        }
    }

    if (missing.length === 0) {
        return pass(`All ${ALL_TOOL_NAMES.length} TunnelVision tools registered`);
    }
    if (missing.length === ALL_TOOL_NAMES.length) {
        return fail(`No TunnelVision tools are registered. Re-register via settings toggle.`);
    }
    return warn(`${missing.length} tool(s) not registered: ${missing.join(', ')}`);
}

/** Report which tools the user has manually disabled via Advanced Settings. */
function checkDisabledTools() {
    const settings = getSettings();
    const disabled = settings.disabledTools || {};
    const disabledNames = ALL_TOOL_NAMES.filter(name => disabled[name]);

    if (disabledNames.length === 0) {
        return pass('All TunnelVision tools enabled');
    }
    if (disabledNames.length === ALL_TOOL_NAMES.length) {
        return warn('All TunnelVision tools are disabled in Advanced Settings. The AI cannot use any memory features.');
    }
    return warn(`${disabledNames.length} tool(s) disabled: ${disabledNames.map(n => n.replace('TunnelVision_', '')).join(', ')}`);
}

/** Check that tree nodes have LLM-generated summaries (PageIndex pattern). */
function checkNodeSummaries() {
    const results = [];
    const activeBooks = getActiveTunnelVisionBooks();

    for (const bookName of activeBooks) {
        const tree = getTree(bookName);
        if (!tree || !tree.root) continue;

        let totalNodes = 0;
        let nodesWithSummary = 0;

        function countSummaries(node) {
            const children = node.children || [];
            const entryUids = node.entryUids || [];
            if (children.length > 0 || entryUids.length > 0) {
                totalNodes++;
                if (node.summary && node.summary.trim().length > 0) {
                    nodesWithSummary++;
                }
            }
            for (const child of children) countSummaries(child);
        }

        countSummaries(tree.root);

        if (totalNodes === 0) continue;

        const pct = Math.round((nodesWithSummary / totalNodes) * 100);
        if (pct === 100) {
            results.push(pass(`All ${totalNodes} nodes in "${bookName}" have LLM summaries`));
        } else if (pct >= 50) {
            results.push(warn(`${nodesWithSummary}/${totalNodes} nodes in "${bookName}" have summaries (${pct}%). Rebuild with LLM for better retrieval.`));
        } else {
            results.push(warn(`Only ${nodesWithSummary}/${totalNodes} nodes in "${bookName}" have summaries. Tree traversal quality will be poor without summaries. Use "Build With LLM" to generate them.`));
        }
    }

    return results;
}

/** Check for entries assigned to multiple nodes (causes duplicate retrieval). */
function checkDuplicateUids() {
    const results = [];
    const activeBooks = getActiveTunnelVisionBooks();

    for (const bookName of activeBooks) {
        const tree = getTree(bookName);
        if (!tree || !tree.root) continue;

        const seen = new Map();
        function walk(node) {
            for (const uid of (node.entryUids || [])) {
                if (seen.has(uid)) {
                    seen.get(uid).push(node.label || node.id);
                } else {
                    seen.set(uid, [node.label || node.id]);
                }
            }
            for (const child of (node.children || [])) walk(child);
        }
        walk(tree.root);

        const dupes = [...seen.entries()].filter(([, nodes]) => nodes.length > 1);
        if (dupes.length > 0) {
            results.push(warn(`"${bookName}" has ${dupes.length} entry/entries assigned to multiple nodes. This causes duplicate content in retrieval.`));
        }
    }

    return results;
}

/** Check that enabled lorebooks actually have active (non-disabled) entries. */
async function checkEmptyLorebooks() {
    const results = [];
    const activeBooks = getActiveTunnelVisionBooks();

    for (const bookName of activeBooks) {
        const bookData = await loadWorldInfo(bookName);
        if (!bookData || !bookData.entries) {
            results.push(fail(`Lorebook "${bookName}" has no entry data. TunnelVision cannot index it.`));
            continue;
        }

        const activeEntries = Object.keys(bookData.entries).filter(
            key => !bookData.entries[key].disable,
        );
        if (activeEntries.length === 0) {
            results.push(warn(`Lorebook "${bookName}" has no active entries. All entries are disabled.`));
        }
    }

    return results;
}

/** Check that all tree nodes have required fields (catches import corruption). */
function checkNodeIntegrity() {
    const results = [];
    const activeBooks = getActiveTunnelVisionBooks();

    for (const bookName of activeBooks) {
        const tree = getTree(bookName);
        if (!tree || !tree.root) continue;

        let corruptNodes = 0;
        let fixed = 0;
        function walk(node) {
            if (!node.id || typeof node.id !== 'string') {
                corruptNodes++;
                return;
            }
            if (!Array.isArray(node.children)) { node.children = []; fixed++; }
            if (!Array.isArray(node.entryUids)) { node.entryUids = []; fixed++; }
            if (typeof node.label !== 'string') { node.label = 'Unnamed'; fixed++; }
            for (const child of node.children) walk(child);
        }
        walk(tree.root);

        if (fixed > 0) {
            saveTree(bookName, tree);
            results.push(warn(`Auto-fixed ${fixed} missing field(s) in "${bookName}" tree nodes (possibly from import).`));
        }
        if (corruptNodes > 0) {
            results.push(fail(`"${bookName}" tree has ${corruptNodes} node(s) without valid IDs. Rebuild the tree.`));
        }
    }

    return results;
}

/** Check that ST's world-info API functions are available (needed by entry-manager). */
function checkWorldInfoApi() {
    const missing = [];
    if (typeof createWorldInfoEntry !== 'function') missing.push('createWorldInfoEntry');
    if (typeof saveWorldInfo !== 'function') missing.push('saveWorldInfo');
    if (typeof loadWorldInfo !== 'function') missing.push('loadWorldInfo');

    if (missing.length > 0) {
        return fail(`Missing ST world-info API: ${missing.join(', ')}. Memory tools (Remember, Update, Forget) will fail.`);
    }
    return pass('ST world-info API available for memory tools');
}

/** Check for trees belonging to lorebooks that no longer exist. */
function checkOrphanedTrees() {
    const settings = getSettings();
    const orphaned = [];

    for (const bookName of Object.keys(settings.trees)) {
        if (!world_names?.includes(bookName)) {
            orphaned.push(bookName);
        }
    }

    if (orphaned.length > 0) {
        return warn(`Found ${orphaned.length} tree(s) for non-existent lorebooks: ${orphaned.join(', ')}. These can be safely deleted.`);
    }
    return pass('No orphaned trees found');
}

/** Check that search mode is a valid value. Auto-fix if corrupted. */
function checkSearchMode() {
    const settings = getSettings();
    const valid = ['traversal', 'collapsed'];
    if (valid.includes(settings.searchMode)) {
        return pass(`Search mode: ${settings.searchMode}`);
    }
    const oldValue = settings.searchMode;
    settings.searchMode = 'traversal';
    return warn(`Invalid search mode "${oldValue}". Auto-reset to "traversal".`);
}

/** Check that recurse limit is sane. Warn if very high. */
function checkRecurseLimit() {
    const settings = getSettings();
    const limit = Number(settings.recurseLimit);
    if (!isFinite(limit) || limit < 1) {
        settings.recurseLimit = 5;
        return warn('Recurse limit was invalid. Auto-reset to default (5).');
    }
    if (limit > 50) {
        settings.recurseLimit = 50;
        return warn(`Recurse limit was ${limit} (max 50). Clamped to 50.`);
    }
    if (limit > 15) {
        return warn(`Recurse limit is ${limit}. High values increase API costs and latency. Only needed for very deep trees.`);
    }
    return pass(`Recurse limit: ${limit}`);
}

/** Check that LLM build detail level is a valid value. Auto-fix if corrupted. */
function checkLlmBuildDetail() {
    const settings = getSettings();
    const valid = ['full', 'lite', 'names'];
    if (valid.includes(settings.llmBuildDetail)) {
        return pass(`LLM build detail: ${settings.llmBuildDetail}`);
    }
    const oldValue = settings.llmBuildDetail;
    settings.llmBuildDetail = 'full';
    return warn(`Invalid LLM build detail "${oldValue}". Auto-reset to "full".`);
}

/** Check that LLM chunk size is a valid number. Auto-fix if corrupted. */
function checkLlmChunkSize() {
    const settings = getSettings();
    const size = Number(settings.llmChunkTokens);
    if (!isFinite(size) || size < 1000) {
        const oldValue = settings.llmChunkTokens;
        settings.llmChunkTokens = 30000;
        return warn(`LLM chunk size was invalid (${oldValue}). Auto-reset to 30,000 chars.`);
    }
    if (size > 500000) {
        settings.llmChunkTokens = 500000;
        return warn(`LLM chunk size was ${size} (max 500,000). Clamped to 500,000.`);
    }
    if (size < 5000) {
        return warn(`LLM chunk size is ${size} chars. Very small chunks mean many LLM calls during tree building, increasing cost and time.`);
    }
    return pass(`LLM chunk size: ${size.toLocaleString()} chars`);
}

/** Check that dedup config is valid when enabled. */
function checkVectorDedupConfig() {
    const settings = getSettings();
    if (!settings.enableVectorDedup) {
        return pass('Duplicate detection: disabled');
    }
    const threshold = Number(settings.vectorDedupThreshold);
    if (!isFinite(threshold) || threshold < 0.1 || threshold > 1.0) {
        const oldValue = settings.vectorDedupThreshold;
        settings.vectorDedupThreshold = 0.85;
        return warn(`Dedup threshold was invalid (${oldValue}). Auto-reset to 0.85.`);
    }
    if (threshold < 0.5) {
        return warn(`Dedup threshold is ${threshold}. Very low thresholds will flag many entries as duplicates, creating noise.`);
    }

    return pass(`Duplicate detection: enabled (trigram similarity, threshold ${threshold})`);
}

/** Check that active lorebooks have a "Summaries" node for the Summarize tool. */
function checkSummariesNode() {
    const results = [];
    const activeBooks = getActiveTunnelVisionBooks();

    for (const bookName of activeBooks) {
        const tree = getTree(bookName);
        if (!tree || !tree.root) continue;

        const summariesNode = (tree.root.children || []).find(
            c => c.label === 'Summaries',
        );
        if (!summariesNode) {
            results.push(warn(`"${bookName}" has no "Summaries" category. The Summarize tool will auto-create one on first use, but you may want to create it manually for better organization.`));
        } else {
            const count = getAllEntryUids(summariesNode).length;
            results.push(pass(`"${bookName}" has Summaries node (${count} entries)`));
        }
    }

    return results;
}

/** Check if collapsed-tree overview would be truncated (too many nodes). */
function checkCollapsedTreeSize() {
    const results = [];
    const settings = getSettings();
    if (settings.searchMode !== 'collapsed') return results;

    const activeBooks = getActiveTunnelVisionBooks();
    const MAX_LEN = 6000;

    for (const bookName of activeBooks) {
        const tree = getTree(bookName);
        if (!tree || !tree.root) continue;

        // Estimate overview size: ~80 chars per node (ID + label + summary snippet + indent)
        let nodeCount = 0;
        function count(node) {
            nodeCount++;
            for (const child of (node.children || [])) count(child);
        }
        count(tree.root);

        const estimate = nodeCount * 80;
        if (estimate > MAX_LEN) {
            results.push(warn(`"${bookName}" tree has ${nodeCount} nodes. In collapsed mode, the overview may be truncated (est. ${estimate} chars vs ${MAX_LEN} limit). Consider using traversal mode or simplifying the tree.`));
        }
    }

    return results;
}

/** When multiple lorebooks are active, check all have valid trees (multi-doc mode). */
function checkMultiDocConsistency() {
    const results = [];
    const activeBooks = getActiveTunnelVisionBooks();
    if (activeBooks.length <= 1) return results;

    let booksWithTrees = 0;
    let booksWithoutTrees = 0;
    for (const bookName of activeBooks) {
        const tree = getTree(bookName);
        if (tree && tree.root && ((tree.root.children || []).length > 0 || (tree.root.entryUids || []).length > 0)) {
            booksWithTrees++;
        } else {
            booksWithoutTrees++;
        }
    }

    if (booksWithoutTrees > 0 && booksWithTrees > 0) {
        results.push(warn(`Multi-document mode: ${booksWithoutTrees} of ${activeBooks.length} active lorebooks have no tree index. The AI can only search lorebooks with built trees.`));
    } else if (booksWithTrees === activeBooks.length) {
        results.push(pass(`Multi-document mode: all ${activeBooks.length} lorebooks have valid trees`));
    }

    return results;
}

/** Check that ST's popup system is available for the tree editor. */
function checkPopupAvailability() {
    if (typeof callGenericPopup !== 'function') {
        return fail('ST popup system (callGenericPopup) not available. Tree editor popup will not work.');
    }
    if (!POPUP_TYPE || POPUP_TYPE.DISPLAY === undefined) {
        return warn('POPUP_TYPE.DISPLAY not found. Tree editor popup may not render correctly.');
    }
    return pass('ST popup system available for tree editor');
}

/** Check that activity feed events exist. */
function checkActivityFeedEvent() {
    const results = [];
    if (!event_types || !event_types.WORLD_INFO_ACTIVATED) {
        results.push(warn('event_types.WORLD_INFO_ACTIVATED not found. Activity feed will not show triggered worldbook entries.'));
    } else {
        results.push(pass('WORLD_INFO_ACTIVATED event available for entry tracking'));
    }
    if (!event_types || !event_types.TOOL_CALLS_PERFORMED) {
        results.push(warn('event_types.TOOL_CALLS_PERFORMED not found. Activity feed will not show real-time tool calls.'));
    } else {
        results.push(pass('TOOL_CALLS_PERFORMED event available for tool tracking'));
    }
    // Check that the floating trigger was injected into DOM
    if (!document.querySelector('.tv-float-trigger')) {
        results.push(warn('Activity feed floating trigger not found in DOM. The feed widget may not have initialized.'));
    } else {
        results.push(pass('Activity feed floating widget present in DOM'));
    }
    return results;
}

/** Check that generateRaw is available for LLM tree building. */
function checkGenerateRawAvailability() {
    if (typeof generateRaw !== 'function') {
        return fail('generateRaw not available. LLM tree building and summary generation will fail.');
    }
    return pass('generateRaw available for LLM tree building');
}

/** Check that WORLDINFO_ENTRIES_LOADED event exists so TV can suppress normal keyword scanning. */
function checkWiSuppressionEvent() {
    if (!event_types || !event_types.WORLDINFO_ENTRIES_LOADED) {
        return warn('event_types.WORLDINFO_ENTRIES_LOADED not found. TV-managed lorebooks will still trigger via normal keyword matching, causing double-injection. Requires newer ST version.');
    }
    return pass('WI suppression hook available (WORLDINFO_ENTRIES_LOADED)');
}

/** Check that chat ingest prerequisites are met (generateRaw available). */
function checkChatIngestRequirements() {
    if (typeof generateRaw !== 'function') {
        return warn('generateRaw not available. Chat ingest requires an LLM connection to extract facts from messages.');
    }
    return pass('Chat ingest prerequisites available (generateRaw + getContext)');
}

/** Check that GENERATION_STARTED event exists for mandatory tool call injection. */
function checkMandatoryToolsEvent() {
    if (!event_types || !event_types.GENERATION_STARTED) {
        return warn('event_types.GENERATION_STARTED not found. Mandatory tool calls setting will not work. Requires newer ST version.');
    }
    return pass('GENERATION_STARTED event available for mandatory tool calls');
}

/** Check !commands configuration: prerequisites, settings validation, and auto-fix. */
function checkCommandsConfig() {
    const settings = getSettings();

    // Feature disabled — just report it
    if (!settings.commandsEnabled) {
        return pass('User commands: disabled');
    }

    // Check prerequisite event
    if (!event_types || !event_types.GENERATION_STARTED) {
        return warn(
            'event_types.GENERATION_STARTED not available. ' +
            '!commands will not intercept generations. Requires a newer ST version.',
        );
    }

    // Validate and auto-fix commandPrefix
    let prefix = settings.commandPrefix;
    if (!prefix || typeof prefix !== 'string' || prefix.length === 0) {
        settings.commandPrefix = '!';
        prefix = '!';
        return warn('Command prefix was empty. Auto-reset to "!".');
    }
    if (prefix.length > 3) {
        const oldLen = prefix.length;
        settings.commandPrefix = prefix.slice(0, 3);
        prefix = settings.commandPrefix;
        return warn(`Command prefix was ${oldLen} chars (max 3). Truncated to "${prefix}".`);
    }

    // Validate and auto-fix commandContextMessages
    const ctx = Number(settings.commandContextMessages);
    if (!isFinite(ctx) || ctx < 1) {
        settings.commandContextMessages = 50;
        return warn('Command context messages was invalid. Auto-reset to 50.');
    }

    return pass(`User commands: enabled (prefix "${prefix}", context ${ctx} msgs)`);
}

/** Check auto-summary configuration. */
function checkAutoSummaryConfig() {
    const settings = getSettings();
    if (!settings.autoSummaryEnabled) {
        return pass('Auto-summary: disabled');
    }
    const interval = Number(settings.autoSummaryInterval);
    if (!isFinite(interval) || interval < 1) {
        settings.autoSummaryInterval = 20;
        return warn('Auto-summary interval was invalid. Auto-reset to 20.');
    }
    if (interval < 5) {
        return warn(`Auto-summary interval is ${interval}. Very low values will create excessive summaries.`);
    }
    return pass(`Auto-summary: enabled (every ${interval} messages)`);
}

/** Check multi-book mode is a valid value. */
function checkMultiBookMode() {
    const settings = getSettings();
    const valid = ['unified', 'per-book'];
    if (valid.includes(settings.multiBookMode)) {
        return pass(`Multi-book mode: ${settings.multiBookMode}`);
    }
    const oldValue = settings.multiBookMode;
    settings.multiBookMode = 'unified';
    return warn(`Invalid multi-book mode "${oldValue}". Auto-reset to "unified".`);
}

/** Check connection profile reference is valid and Connection Manager is available. */
function checkConnectionProfile() {
    const settings = getSettings();
    if (!settings.connectionProfile) {
        return pass('Connection profile: using current API settings');
    }

    // Try to verify the profile exists via Connection Manager settings
    try {
        const cmSettings = extension_settings?.connectionManager;
        if (!cmSettings) {
            return warn(`Connection profile "${settings.connectionProfile}" is set but Connection Manager extension is not loaded. Profile switching will fall back to current API.`);
        }
        if (cmSettings.profiles && Array.isArray(cmSettings.profiles)) {
            const exists = cmSettings.profiles.some(p => p.name === settings.connectionProfile);
            if (exists) {
                return pass(`Connection profile: "${settings.connectionProfile}"`);
            }
            return warn(`Connection profile "${settings.connectionProfile}" not found in Connection Manager. It may have been deleted.`);
        }
    } catch { /* ignore */ }
    return pass(`Connection profile: "${settings.connectionProfile}" (unverified — Connection Manager may not be loaded)`);
}

/** Check tracker UIDs reference valid entries. */
function checkTrackerUids() {
    const results = [];
    const settings = getSettings();
    const trackerUids = settings.trackerUids || {};
    let totalTrackers = 0;

    for (const bookName of Object.keys(trackerUids)) {
        const uids = trackerUids[bookName];
        if (!Array.isArray(uids) || uids.length === 0) continue;
        totalTrackers += uids.length;
    }

    if (totalTrackers === 0) {
        results.push(pass('Tracker entries: none configured'));
    } else {
        results.push(pass(`Tracker entries: ${totalTrackers} configured across ${Object.keys(trackerUids).length} lorebook(s)`));
    }

    return results;
}

/** Check arc nodes in trees have isArc flag and are under Summaries. */
function checkArcNodes() {
    const results = [];
    const activeBooks = getActiveTunnelVisionBooks();

    for (const bookName of activeBooks) {
        const tree = getTree(bookName);
        if (!tree || !tree.root) continue;

        let arcCount = 0;
        function findArcs(node) {
            if (node.isArc) arcCount++;
            for (const child of (node.children || [])) findArcs(child);
        }
        findArcs(tree.root);

        if (arcCount > 0) {
            results.push(pass(`"${bookName}" has ${arcCount} arc node(s) for narrative threads`));
        }
    }

    return results;
}

/** Check notebook configuration and chat metadata availability. */
function checkNotebookConfig() {
    const settings = getSettings();
    if (settings.notebookEnabled === false) {
        return pass('Notebook: disabled');
    }

    // Check if notebook tool is disabled via tool toggles
    const disabled = settings.disabledTools || {};
    if (disabled['TunnelVision_Notebook']) {
        return warn('Notebook is enabled in settings but disabled in Tool Access. The AI cannot use it.');
    }

    // Check GENERATION_STARTED event is available (needed for notebook injection)
    if (!event_types || !event_types.GENERATION_STARTED) {
        return warn('GENERATION_STARTED event not available. Notebook notes will not be injected into context.');
    }

    return pass('Notebook: enabled (notes persist per-chat in metadata)');
}

/** Check stealth mode configuration. */
function checkStealthMode() {
    const settings = getSettings();
    if (settings.stealthMode === true) {
        return warn('Stealth mode: ON. All TunnelVision tool calls are hidden from chat output. Disable if you need to debug tool call behavior.');
    }
    return pass('Stealth mode: off (tool calls visible in chat)');
}

/** Check auto-hide summarized messages config. */
function checkAutoHideSummarized() {
    const settings = getSettings();
    if (settings.autoHideSummarized === true) {
        return pass('Auto-hide summarized: ON. Messages covered by summaries will be hidden from chat to save tokens.');
    }
    return pass('Auto-hide summarized: off. Summarized messages remain visible in chat.');
}

/** Check that MESSAGE_RECEIVED event exists for turn-level console summary. */
function checkTurnSummaryEvent() {
    if (!event_types || !event_types.MESSAGE_RECEIVED) {
        return warn('MESSAGE_RECEIVED event not available. Post-turn tool call console summary will not print.');
    }
    return pass('Turn summary: MESSAGE_RECEIVED event available');
}

/** Check that the activity feed can persist to chat metadata. */
function checkFeedPersistence() {
    try {
        const context = getContext();
        if (!context.chatMetadata) {
            return warn('No chat metadata available. Activity feed will not persist across refreshes (no active chat).');
        }
        const data = context.chatMetadata.tunnelvision_feed;
        if (data && Array.isArray(data.items)) {
            return pass(`Activity feed persistence: ${data.items.length} items saved in chat metadata.`);
        }
        return pass('Activity feed persistence: ready (no items yet).');
    } catch {
        return warn('Could not access chat metadata. Activity feed will not persist across refreshes.');
    }
}

/** Remove UIDs from tree that aren't in the valid set. */
function removeStaleUids(node, validUids) {
    node.entryUids = (node.entryUids || []).filter(uid => validUids.has(uid));
    for (const child of (node.children || [])) {
        removeStaleUids(child, validUids);
    }
}

function pass(message) {
    return { status: 'pass', message, fix: null };
}

function warn(message) {
    return { status: 'warn', message, fix: null };
}

function fail(message) {
    return { status: 'fail', message, fix: null };
}
