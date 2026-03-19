/**
 * TunnelVision Diagnostics
 * Checks every potential failure point and offers fixes.
 */

import { selected_world_info, world_names, loadWorldInfo, createWorldInfoEntry, saveWorldInfo } from '../../../world-info.js';
import { ToolManager } from '../../../tool-calling.js';
import { main_api, online_status, event_types, generateRaw, saveSettingsDebounced } from '../../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../../popup.js';
import { extension_settings } from '../../../extensions.js';
import {
    getTree,
    createEmptyTree,
    getAllEntryUids,
    findNodeById,
    getSettings,
    saveTree,
    getBookDescription,
    isTrackerTitle,
} from './tree-store.js';
import { getContext } from '../../../st-context.js';
import { getActiveTunnelVisionBooks, ALL_TOOL_NAMES, CONFIRMABLE_TOOLS, preflightToolRuntimeState } from './tool-registry.js';
import { hasEvaluableConditions, separateConditions, formatCondition, getKeywordProbability } from './conditions.js';


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
    const settingsBefore = JSON.stringify(getSettings());
    const results = [];

    results.push(checkSettingsExist());
    results.push(checkApiConnected());
    results.push(checkToolCallingSupport());
    results.push(checkPromptPostProcessing());
    results.push(...checkActiveLorebooksExist());
    results.push(...checkTreesValid());
    results.push(...await checkEntryUidsValid());
    results.push(...checkNodeSummaries());
    results.push(...checkNodeKeywords());
    results.push(...checkDuplicateUids());
    results.push(...await checkNearDuplicateEntries());
    results.push(...await checkEmptyLorebooks());
    results.push(...checkNodeIntegrity());
    results.push(...await checkToolRuntimeDuringDiagnostics());
    results.push(checkDisabledTools());
    results.push(checkConfirmToolConfig());
    results.push(checkToolPromptOverrides());
    results.push(checkWorldInfoApi());
    results.push(checkOrphanedTrees());
    results.push(checkSearchMode());
    results.push(checkSelectiveRetrieval());
    results.push(checkRecurseLimit());
    results.push(checkLlmBuildDetail());
    results.push(checkLlmChunkSize());
    results.push(checkVectorDedupConfig());
    results.push(...checkSummariesNode());
    results.push(...checkCollapsedTreeSize());
    results.push(...checkOversizedLeafNodes());
    results.push(...checkGranularityMismatch());
    results.push(...checkLargeLorebookSettings());
    results.push(...checkMultiDocConsistency());
    results.push(checkPopupAvailability());
    results.push(...checkActivityFeedEvent());
    results.push(checkFeedPersistence());
    results.push(checkGenerateRawAvailability());
    results.push(checkWiSuppressionEvent());
    results.push(checkChatIngestRequirements());
    results.push(checkMandatoryToolsEvent());
    results.push(checkPromptInjectionSettings());
    results.push(checkCommandsConfig());
    results.push(checkAutoSummaryConfig());
    results.push(checkMultiBookMode());
    results.push(await checkSidecarConfig());
    results.push(...await checkTrackerUids());
    results.push(...checkArcNodes());
    results.push(checkNotebookConfig());
    results.push(checkStealthMode());
    results.push(checkCompactToolPrompts());
    results.push(checkEphemeralResults());
    results.push(checkAutoHideSummarized());
    results.push(checkConstantPassthrough());
    results.push(...checkBookDescriptions());
    results.push(...checkBookPermissions());
    results.push(checkSidecarAutoRetrieval());
    results.push(checkConditionalTriggers());
    results.push(...await checkKeywordProbabilities());
    results.push(checkSidecarPostGenWriter());
    results.push(checkTurnSummaryEvent());

    const settingsAfter = JSON.stringify(getSettings());
    if (settingsBefore !== settingsAfter) {
        saveSettingsDebounced();
    }

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

/** Check that the current API/model supports tool calling with specific guidance. */
function checkToolCallingSupport() {
    try {
        const supported = ToolManager.isToolCallingSupported();
        if (supported) {
            return pass('Current API supports tool calling');
        }

        // Give specific guidance on what's wrong
        if (main_api !== 'openai') {
            return fail('Tool calling requires Chat Completion mode. Your current API (' + main_api + ') is Text Completion. Switch to a Chat Completion API (OpenAI, Claude, Gemini, etc.) in ST connection settings.');
        }

        const context = getContext();
        const ccSettings = context.chatCompletionSettings;

        if (ccSettings && !ccSettings.function_calling) {
            return fail('"Enable function calling" is OFF in your Chat Completion preset. Turn it on: AI Response Configuration → Function Calling → Enable.');
        }

        return warn('Current API/model may not support tool calling. Check your model supports function calls.');
    } catch (e) {
        return warn('Could not verify tool calling support: ' + e.message);
    }
}

/** Check that Prompt Post-Processing mode is compatible with tool calling. */
function checkPromptPostProcessing() {
    try {
        if (main_api !== 'openai') {
            return pass('PPP check not applicable for non-Chat Completion APIs');
        }

        const context = getContext();
        const ccSettings = context.chatCompletionSettings;
        if (!ccSettings) {
            return warn('Could not read Chat Completion settings to check PPP mode.');
        }

        const ppp = ccSettings.custom_prompt_post_processing;
        // These are the modes that preserve tool calls in the prompt
        const toolCompatible = ['', 'merge_tools', 'semi_tools', 'strict_tools'];
        if (toolCompatible.includes(ppp)) {
            return pass('Prompt Post-Processing mode (' + (ppp || 'None') + ') is compatible with tool calling');
        }

        return warn('Prompt Post-Processing is set to "' + ppp + '" which strips tool calls from the prompt. Switch to a *_tools variant (e.g. "merge_tools") or "None" for TunnelVision to work.');
    } catch (e) {
        return warn('Could not check PPP mode: ' + e.message);
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

/** Check tool runtime state using preflightToolRuntimeState — repairs and validates registration. */
async function checkToolRuntimeDuringDiagnostics() {
    const snapshot = await preflightToolRuntimeState({ repair: true, reason: 'diagnostics', log: true });
    const results = [];

    if (snapshot.activeBooks.length === 0) {
        results.push(pass('No active TunnelVision lorebooks — tools correctly unregistered'));
        results.push(pass('No active TunnelVision lorebooks — no ST stealth flags to validate'));
        results.push(pass('No active TunnelVision lorebooks — no next-generation TunnelVision tools required'));
        return results;
    }

    if (snapshot.expectedToolNames.length === 0) {
        results.push(warn('All enabled TunnelVision tools are disabled, so none are expected to be registered.'));
        results.push(pass('No enabled TunnelVision tools use ST stealth'));
        results.push(warn('Next-generation tool eligibility: no enabled TunnelVision tools are available because they are disabled in settings.'));
        return results;
    }

    if (snapshot.missingToolNames.length === 0) {
        const suffix = snapshot.repairApplied ? ' (recovered during diagnostics)' : '';
        results.push(pass(`All ${snapshot.expectedToolNames.length} enabled TunnelVision tools registered${suffix}`));
    } else if (snapshot.registeredToolNames.length === 0) {
        results.push(fail(`No enabled TunnelVision tools are registered. Missing: ${snapshot.missingToolNames.join(', ')}`));
    } else {
        results.push(warn(`${snapshot.missingToolNames.length} enabled TunnelVision tool(s) not registered: ${snapshot.missingToolNames.join(', ')}`));
    }

    if (snapshot.stealthToolNames.length === 0) {
        results.push(pass('No enabled TunnelVision tools use ST stealth'));
    } else {
        results.push(fail(`Enabled TunnelVision tools still using ST stealth: ${snapshot.stealthToolNames.join(', ')}`));
    }

    if (snapshot.eligibilityErrors.length > 0) {
        results.push(fail(`Next-generation tool eligibility check failed: ${snapshot.eligibilityErrors.join(' | ')}`));
    } else if (snapshot.eligibleToolNames.length > 0) {
        results.push(pass(`Next-generation tool eligibility: ${snapshot.eligibleToolNames.length} tool(s) available (${snapshot.eligibleToolNames.join(', ')})`));
    } else {
        results.push(fail('Next-generation tool eligibility: no TunnelVision tools would be offered on the next generation despite active lorebooks.'));
    }

    return results;
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

/** Check confirm tool configuration for invalid references. */
function checkConfirmToolConfig() {
    const settings = getSettings();
    const confirmTools = settings.confirmTools || {};
    const enabledNames = Object.keys(confirmTools).filter(name => confirmTools[name]);

    if (enabledNames.length === 0) {
        return pass('Tool confirmation: none enabled');
    }

    const invalid = enabledNames.filter(name => !ALL_TOOL_NAMES.includes(name));
    if (invalid.length > 0) {
        // Auto-fix: remove invalid references
        for (const name of invalid) {
            delete confirmTools[name];
        }
        return warn(`Tool confirmation: removed ${invalid.length} invalid tool reference(s): ${invalid.join(', ')}`);
    }

    const notConfirmable = enabledNames.filter(name => !CONFIRMABLE_TOOLS.has(name));
    if (notConfirmable.length > 0) {
        // Auto-fix: remove non-confirmable tool references
        for (const name of notConfirmable) {
            delete confirmTools[name];
        }
        return warn(`Tool confirmation: removed ${notConfirmable.length} non-confirmable tool reference(s): ${notConfirmable.map(n => n.replace('TunnelVision_', '')).join(', ')}`);
    }

    return pass(`Tool confirmation: ${enabledNames.length} tool(s) require approval (${enabledNames.map(n => n.replace('TunnelVision_', '')).join(', ')})`);
}

/** Check tool prompt overrides for invalid or empty entries. */
function checkToolPromptOverrides() {
    const settings = getSettings();
    const overrides = settings.toolPromptOverrides || {};
    const overrideNames = Object.keys(overrides);

    if (overrideNames.length === 0) {
        return pass('Tool prompt overrides: none configured');
    }

    let fixed = 0;

    // Auto-fix: remove empty string overrides
    for (const name of overrideNames) {
        if (typeof overrides[name] === 'string' && overrides[name].trim() === '') {
            delete overrides[name];
            fixed++;
        }
    }

    // Auto-fix: strip stale baked-in dynamic content (tree overview, tracker list) from overrides
    for (const name of Object.keys(overrides)) {
        const val = overrides[name];
        if (typeof val !== 'string') continue;

        // New delimiter format
        let cutIdx = val.indexOf('---TV_DYNAMIC_BELOW---');
        // Legacy: tree overview baked in before delimiter was introduced
        if (cutIdx < 0) cutIdx = val.indexOf('\n\nFull tree index:\n');
        if (cutIdx < 0) cutIdx = val.indexOf('\n\nTop-level tree:\n');

        if (cutIdx >= 0) {
            const cleaned = val.substring(0, cutIdx).trimEnd();
            if (cleaned) {
                overrides[name] = cleaned;
            } else {
                delete overrides[name];
            }
            fixed++;
        }
    }

    // Warn about invalid tool names
    const remaining = Object.keys(overrides);
    const invalid = remaining.filter(name => !ALL_TOOL_NAMES.includes(name));
    for (const name of invalid) {
        delete overrides[name];
        fixed++;
    }

    if (fixed > 0) {
        const activeCount = Object.keys(overrides).length;
        return warn(`Tool prompt overrides: auto-removed ${fixed} invalid/empty override(s). ${activeCount} valid override(s) remaining.`);
    }

    return pass(`Tool prompt overrides: ${remaining.length} tool(s) have custom descriptions`);
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

/** Check that node summaries include keyword footers for better AI retrieval. */
function checkNodeKeywords() {
    const results = [];
    const activeBooks = getActiveTunnelVisionBooks();

    for (const bookName of activeBooks) {
        const tree = getTree(bookName);
        if (!tree || !tree.root) continue;

        let nodesWithEntries = 0;
        let nodesWithKeywords = 0;

        function checkNode(node, isRoot) {
            if (isRoot) {
                for (const child of (node.children || [])) checkNode(child, false);
                return;
            }
            const uids = getAllEntryUids(node);
            if (uids.length > 0 && node.summary) {
                nodesWithEntries++;
                if (/\[Keywords:/.test(node.summary)) {
                    nodesWithKeywords++;
                }
            }
            for (const child of (node.children || [])) checkNode(child, false);
        }

        checkNode(tree.root, true);

        if (nodesWithEntries === 0) continue;

        const pct = Math.round((nodesWithKeywords / nodesWithEntries) * 100);
        if (pct === 100) {
            results.push(pass(`All ${nodesWithEntries} nodes with entries in "${bookName}" have keyword footers`));
        } else if (pct > 0) {
            results.push(warn(`${nodesWithKeywords}/${nodesWithEntries} nodes in "${bookName}" have keyword footers (${pct}%). Rebuild with LLM to add keywords for better retrieval.`));
        } else {
            results.push(warn(`No nodes in "${bookName}" have keyword footers. Rebuild with LLM to add entry keywords to node summaries for improved AI navigation.`));
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

/** Check for near-duplicate entry titles that suggest redundant content. */
async function checkNearDuplicateEntries() {
    const results = [];
    const activeBooks = getActiveTunnelVisionBooks();

    for (const bookName of activeBooks) {
        const bookData = await loadWorldInfo(bookName);
        if (!bookData?.entries) continue;

        // Collect all non-disabled entry titles
        const entries = [];
        for (const key of Object.keys(bookData.entries)) {
            const entry = bookData.entries[key];
            if (entry.disable) continue;
            const title = (entry.comment || entry.key?.[0] || '').trim().toLowerCase();
            if (title) {
                entries.push({ uid: entry.uid, title, original: entry.comment || entry.key?.[0] || `#${entry.uid}` });
            }
        }

        // Simple O(n²) check for very similar titles (small n per lorebook, so acceptable)
        const dupes = [];
        const seen = new Set();
        for (let i = 0; i < entries.length; i++) {
            if (seen.has(i)) continue;
            for (let j = i + 1; j < entries.length; j++) {
                if (seen.has(j)) continue;
                if (titlesAreSimilar(entries[i].title, entries[j].title)) {
                    dupes.push(`"${entries[i].original}" (UID ${entries[i].uid}) ≈ "${entries[j].original}" (UID ${entries[j].uid})`);
                    seen.add(j);
                }
            }
        }

        if (dupes.length > 0) {
            results.push(warn(`Lorebook "${bookName}" has ${dupes.length} near-duplicate entry pair(s): ${dupes.slice(0, 3).join('; ')}${dupes.length > 3 ? ` (+${dupes.length - 3} more)` : ''}. Consider merging with TunnelVision_MergeSplit or manually.`));
        }
    }

    if (results.length === 0 && activeBooks.length > 0) {
        results.push(pass('No near-duplicate entry titles detected'));
    }

    return results;
}

/**
 * Check if two titles are similar enough to be potential duplicates.
 * Uses simple heuristics: exact match after normalization, or one contains the other.
 * @param {string} a - Normalized (lowercase, trimmed) title
 * @param {string} b - Normalized (lowercase, trimmed) title
 * @returns {boolean}
 */
function titlesAreSimilar(a, b) {
    if (a === b) return true;
    // One contains the other and they're close in length
    if (a.length > 3 && b.length > 3) {
        if (a.includes(b) || b.includes(a)) {
            const lenRatio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
            return lenRatio > 0.6;
        }
    }
    return false;
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

/** Check selective retrieval configuration. */
function checkSelectiveRetrieval() {
    const settings = getSettings();
    if (!settings.selectiveRetrieval) {
        return pass('Selective retrieval: off (all entries injected on retrieve)');
    }
    const limit = Number(settings.recurseLimit) || 5;
    if (limit < 3) {
        return warn('Selective retrieval is on but recurse limit is below 3. The model needs at least 2 calls per leaf (manifest + entry pick). Consider raising the recurse limit.');
    }
    return pass('Selective retrieval: on (model picks individual entries from manifests)');
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
            const depth = settings.collapsedDepth ?? 2;
            results.push(warn(`"${bookName}" tree has ${nodeCount} nodes. In collapsed mode, the overview may be truncated (est. ${estimate} chars vs ${MAX_LEN} limit). Try lowering Collapsed Tree Depth (currently ${depth}) or using traversal mode.`));
        }
    }

    return results;
}

/** Check for leaf nodes with too many entries, suggesting a rebuild with higher granularity. */
function checkOversizedLeafNodes() {
    const results = [];
    const activeBooks = getActiveTunnelVisionBooks();
    const settings = getSettings();
    const granularity = Number(settings.treeGranularity) || 0;

    for (const bookName of activeBooks) {
        const tree = getTree(bookName);
        if (!tree || !tree.root) continue;

        const oversized = [];
        const threshold = 20; // flag leaves with 20+ entries regardless of granularity
        function scan(node) {
            const isLeaf = (node.children || []).length === 0;
            if (isLeaf && (node.entryUids || []).length > threshold) {
                oversized.push({ label: node.label, count: node.entryUids.length });
            }
            for (const child of (node.children || [])) scan(child);
        }
        scan(tree.root);

        if (oversized.length > 0) {
            const top3 = oversized.sort((a, b) => b.count - a.count).slice(0, 3);
            const examples = top3.map(n => `"${n.label}" (${n.count})`).join(', ');
            const hint = granularity < 3
                ? ' Try rebuilding with higher Tree Granularity (Detailed or Extensive).'
                : ' Consider rebuilding the tree or manually splitting these categories.';
            results.push(warn(`"${bookName}" has ${oversized.length} leaf node(s) with 20+ entries: ${examples}.${hint}`));
        }
    }

    return results;
}

/** Check if granularity setting matches lorebook size. */
function checkGranularityMismatch() {
    const results = [];
    const activeBooks = getActiveTunnelVisionBooks();
    const settings = getSettings();
    const granularity = Number(settings.treeGranularity) || 0;

    if (granularity === 0) return results; // auto mode, no mismatch possible

    for (const bookName of activeBooks) {
        const tree = getTree(bookName);
        if (!tree || !tree.root) continue;

        const totalEntries = getAllEntryUids(tree.root).length;
        let recommended;
        if (totalEntries >= 3000) recommended = 4;
        else if (totalEntries >= 1000) recommended = 3;
        else if (totalEntries >= 200) recommended = 2;
        else recommended = 1;

        if (granularity < recommended - 1) {
            const labels = { 1: 'Minimal', 2: 'Moderate', 3: 'Detailed', 4: 'Extensive' };
            results.push(warn(`"${bookName}" has ${totalEntries} entries but granularity is set to ${labels[granularity] || granularity}. With this many entries, more splitting is recommended (${labels[recommended]} or Auto). Rebuild to apply.`));
        }
    }

    return results;
}

/** Check if large lorebooks are using settings that will cause issues at build/retrieval time. */
function checkLargeLorebookSettings() {
    const results = [];
    const activeBooks = getActiveTunnelVisionBooks();
    const settings = getSettings();

    for (const bookName of activeBooks) {
        const tree = getTree(bookName);
        if (!tree || !tree.root) continue;

        const totalEntries = getAllEntryUids(tree.root).length;
        if (totalEntries < 500) continue; // only check large lorebooks

        // Warn if using traversal mode with large lorebooks — collapsed is better
        if ((settings.searchMode || 'traversal') === 'traversal') {
            results.push(warn(`"${bookName}" has ${totalEntries} entries. Collapsed Tree mode is recommended for large lorebooks — it reduces tool calls and improves retrieval accuracy. Change in Advanced Settings > Search Mode.`));
        }

        // Warn if collapsed depth is too high for large lorebooks
        if ((settings.searchMode || 'traversal') === 'collapsed') {
            const depth = settings.collapsedDepth ?? 2;
            if (depth > 2 && totalEntries >= 1000) {
                results.push(warn(`"${bookName}" has ${totalEntries} entries with collapsed depth set to ${depth}. This may produce a very large tool description. Try depth 1-2 for lorebooks this size.`));
            }
        }

        // Warn if chunk size is very small for large lorebooks (will cause many sequential LLM calls)
        const chunkLimit = settings.llmChunkTokens || 30000;
        if (chunkLimit < 20000 && totalEntries >= 1000) {
            results.push(warn(`LLM Chunk Size is ${chunkLimit.toLocaleString()} chars with ${totalEntries} entries in "${bookName}". This will cause many LLM calls during tree building. Consider raising to 30,000+ for faster builds.`));
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
    if (!event_types || !event_types.TOOL_CALLS_RENDERED) {
        results.push(warn('event_types.TOOL_CALLS_RENDERED not found. Visual hiding of tool-call messages will not work after render.'));
    } else {
        results.push(pass('TOOL_CALLS_RENDERED event available for visual hiding'));
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

/** Check prompt injection settings for validity and auto-fix bad values. */
function checkPromptInjectionSettings() {
    const settings = getSettings();
    const validPositions = ['in_chat', 'in_prompt'];
    const validRoles = ['system', 'user', 'assistant'];
    const warnings = [];
    let fixed = null;

    // Mandatory prompt settings
    if (settings.mandatoryTools) {
        if (!validPositions.includes(settings.mandatoryPromptPosition)) {
            settings.mandatoryPromptPosition = 'in_chat';
            fixed = (fixed || '') + ' Auto-reset invalid mandatory prompt position to "in_chat".';
        }
        if (!validRoles.includes(settings.mandatoryPromptRole)) {
            settings.mandatoryPromptRole = 'system';
            fixed = (fixed || '') + ' Auto-reset invalid mandatory prompt role to "system".';
        }
        // in_chat + user role can bisect tool_use/tool_result pairs on Anthropic/Claude,
        // causing "unexpected tool_use_id" errors. Auto-fix to system role.
        if (settings.mandatoryPromptPosition === 'in_chat' && settings.mandatoryPromptRole === 'user') {
            settings.mandatoryPromptRole = 'system';
            fixed = (fixed || '') + ' Auto-reset mandatory prompt role from "user" to "system" (user role with in_chat can break tool call pairing on Claude/Anthropic).';
        }
        if (settings.mandatoryPromptPosition === 'in_prompt' && settings.mandatoryPromptDepth > 0) {
            warnings.push('Mandatory prompt is set to "In System Prompt" -- depth is ignored in this mode.');
        }
        if (!settings.mandatoryPromptText || settings.mandatoryPromptText.trim().length === 0) {
            warnings.push('Mandatory tools is enabled but the prompt text is empty. The model will receive no instruction.');
        }
    }

    // Notebook prompt settings
    if (settings.notebookEnabled !== false) {
        if (!validPositions.includes(settings.notebookPromptPosition)) {
            settings.notebookPromptPosition = 'in_chat';
            fixed = (fixed || '') + ' Auto-reset invalid notebook prompt position to "in_chat".';
        }
        if (!validRoles.includes(settings.notebookPromptRole)) {
            settings.notebookPromptRole = 'system';
            fixed = (fixed || '') + ' Auto-reset invalid notebook prompt role to "system".';
        }
        // Same in_chat + user role guard for notebook
        if (settings.notebookPromptPosition === 'in_chat' && settings.notebookPromptRole === 'user') {
            settings.notebookPromptRole = 'system';
            fixed = (fixed || '') + ' Auto-reset notebook prompt role from "user" to "system" (user role with in_chat can break tool call pairing on Claude/Anthropic).';
        }
    }

    if (fixed) {
        warnings.push(fixed.trim());
    }
    if (warnings.length > 0) {
        return { status: 'warn', message: warnings.join(' | '), fix: fixed?.trim() || null };
    }
    return pass('Prompt injection settings valid');
}

/** Check slash commands configuration: context messages validation and auto-fix. */
function checkCommandsConfig() {
    const settings = getSettings();

    // Validate and auto-fix commandContextMessages
    const ctx = Number(settings.commandContextMessages);
    if (!isFinite(ctx) || ctx < 1) {
        settings.commandContextMessages = 50;
        return warn('Slash command context messages was invalid. Auto-reset to 50.');
    }

    return pass(`Slash commands: registered (context ${ctx} msgs)`);
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

/** Check sidecar LLM configuration: connection profile, API key availability. */
async function checkSidecarConfig() {
    const settings = getSettings();
    const profileId = settings.connectionProfile;

    if (!profileId) {
        return pass('Sidecar LLM: not configured (using ST generateRaw fallback)');
    }

    const { findConnectionProfile } = await import('./tree-store.js');
    const profile = findConnectionProfile(profileId);

    if (!profile) {
        return warn(`Sidecar: Connection profile "${profileId}" not found. It may have been deleted from Connection Manager.`);
    }

    if (!profile.api || !profile.model) {
        return warn(`Sidecar: Connection profile "${profile.name}" is missing API provider or model. Sidecar calls will fall back to generateRaw.`);
    }

    // Verify API key is available via ST's secrets system
    try {
        const { fetchSecretKey } = await import('./llm-sidecar.js');
        const PROVIDER_SECRET_MAP = {
            openai: 'api_key_openai', claude: 'api_key_claude', openrouter: 'api_key_openrouter',
            makersuite: 'api_key_makersuite', deepseek: 'api_key_deepseek', mistralai: 'api_key_mistralai',
            groq: 'api_key_groq', custom: 'api_key_custom', xai: 'api_key_xai',
        };
        const secretKey = PROVIDER_SECRET_MAP[profile.api];
        if (secretKey) {
            const key = await fetchSecretKey(secretKey);
            if (!key) {
                return warn(`Sidecar: No API key found for "${profile.api}". Add your key in ST's API settings and ensure allowKeysExposure is enabled in config.yaml.`);
            }
        }
    } catch (e) {
        return warn(`Sidecar: Failed to verify API key: ${e.message}`);
    }

    return pass(`Sidecar LLM: "${profile.name}" (${profile.api} / ${profile.model})`);
}

/** Check tracker UIDs reference valid entries, auto-remove stale, auto-detect title-based trackers. */
async function checkTrackerUids() {
    const results = [];
    const settings = getSettings();
    const trackerUids = settings.trackerUids || {};
    let totalTrackers = 0;

    for (const bookName of Object.keys(trackerUids)) {
        const uids = Array.isArray(trackerUids[bookName]) ? trackerUids[bookName] : [];
        if (uids.length === 0) continue;

        if (!world_names?.includes(bookName)) {
            delete trackerUids[bookName];
            results.push(warn(`Tracker entries for missing lorebook "${bookName}" were removed.`));
            continue;
        }

        const bookData = await loadWorldInfo(bookName);
        if (!bookData?.entries) {
            results.push(warn(`Tracker entries for "${bookName}" could not be validated because the lorebook failed to load.`));
            continue;
        }

        const entryMap = new Map();
        for (const key of Object.keys(bookData.entries)) {
            const entry = bookData.entries[key];
            entryMap.set(entry.uid, entry);
        }

        const next = [];
        let staleCount = 0;
        let disabledCount = 0;
        let migratedCount = 0;

        for (const uid of uids) {
            const entry = entryMap.get(uid);
            if (!entry) {
                staleCount++;
                continue;
            }
            if (entry.disable) {
                disabledCount++;
                continue;
            }
            if (!next.includes(uid)) {
                next.push(uid);
            }
        }

        // Auto-detect entries with tracker titles that aren't tracked yet
        for (const entry of entryMap.values()) {
            if (entry.disable || !isTrackerTitle(entry.comment) || next.includes(entry.uid)) continue;
            next.push(entry.uid);
            migratedCount++;
        }

        // Normalize: sort and dedupe
        next.sort((a, b) => a - b);
        if (next.length > 0) {
            trackerUids[bookName] = next;
        } else {
            delete trackerUids[bookName];
        }

        totalTrackers += next.length;

        if (staleCount > 0 || disabledCount > 0 || migratedCount > 0) {
            results.push(
                warn(
                    `"${bookName}" tracker list was normalized: ` +
                    `${staleCount} stale removed, ${disabledCount} disabled removed, ${migratedCount} title-based tracker(s) added.`,
                ),
            );
        } else {
            results.push(pass(`"${bookName}" tracker entries validated (${next.length})`));
        }
    }

    if (totalTrackers === 0) {
        results.push(pass('Tracker entries: none configured'));
    } else if (Object.keys(trackerUids).length > 1) {
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
        return warn('Hide tool-call messages: ON. TunnelVision tool-call messages are visually hidden in chat. Disable if you need to debug tool call behavior.');
    }
    return pass('Hide tool-call messages: off (tool calls visible in chat)');
}

/** Check compact tool prompts configuration. */
function checkCompactToolPrompts() {
    const settings = getSettings();
    if (settings.compactToolPrompts) {
        return pass('Compact tool prompts: enabled (guide tool replaces verbose descriptions)');
    }
    return pass('Compact tool prompts: disabled (full descriptions sent per tool)');
}

/** Check ephemeral tool results configuration. */
function checkEphemeralResults() {
    const settings = getSettings();
    if (!settings.ephemeralResults) {
        return pass('Ephemeral tool results: off (old results stay in context)');
    }
    if (!event_types || !event_types.GENERATION_STARTED) {
        return warn('Ephemeral results is enabled but GENERATION_STARTED event is unavailable. Results will not be stripped.');
    }
    const filter = settings.ephemeralToolFilter;
    if (!Array.isArray(filter) || filter.length === 0) {
        return warn('Ephemeral results is enabled but no tools are selected for stripping. Nothing will be cleared. Select at least one tool in the filter list.');
    }
    if (filter.includes('TunnelVision_Notebook')) {
        settings.ephemeralToolFilter = filter.filter(n => n !== 'TunnelVision_Notebook');
        return { status: 'warn', message: 'Notebook was in the ephemeral filter list but is always protected. Auto-removed.', fix: 'Removed TunnelVision_Notebook from ephemeral filter.' };
    }
    const toolNames = filter.join(', ').replace(/TunnelVision_/g, '');
    return warn(`Ephemeral tool results: ON. Stripping old results for: ${toolNames}. Notebook is always protected. This saves context tokens but stripped data cannot be recovered.`);
}

/** Check auto-hide summarized messages config. */
function checkAutoHideSummarized() {
    const settings = getSettings();
    if (settings.autoHideSummarized === true) {
        return pass('Auto-hide summarized: ON. Messages covered by summaries will be hidden from chat to save tokens.');
    }
    return pass('Auto-hide summarized: off. Summarized messages remain visible in chat.');
}

/** Check constant entry passthrough setting and warn about implications. */
function checkConstantPassthrough() {
    const settings = getSettings();
    if (settings.passthroughConstant !== false) {
        return pass('Constant entry passthrough: ON. Entries marked "Always Active" in TV-managed lorebooks will bypass tree gating and inject normally via ST.');
    }
    return warn('Constant entry passthrough: OFF. All entries in TV-managed lorebooks are suppressed from normal WI injection, including constant (always-active) entries like chat summaries. If you have constant entries that should always appear in context, enable "Constant Entry Passthrough" in Advanced Settings.');
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

/** Check that active lorebooks have descriptions for multi-book disambiguation. */
function checkBookDescriptions() {
    const results = [];
    const activeBooks = getActiveTunnelVisionBooks();
    if (activeBooks.length <= 1) {
        // Single book doesn't need a description for disambiguation
        return results;
    }

    let missing = 0;
    for (const bookName of activeBooks) {
        const userDesc = getBookDescription(bookName);
        const tree = getTree(bookName);
        const hasTreeSummary = tree?.root?.summary && tree.root.summary !== `Top-level index for ${bookName}`;

        if (userDesc) {
            // User-set description — best
            continue;
        } else if (hasTreeSummary) {
            // LLM-generated tree summary — acceptable
            continue;
        } else {
            missing++;
        }
    }

    if (missing > 0) {
        results.push(warn(`${missing} of ${activeBooks.length} active lorebooks have no description. Without descriptions, the AI may write entries to the wrong lorebook. Set descriptions in each lorebook's settings, or rebuild trees with LLM to auto-generate them.`));
    } else {
        results.push(pass(`All ${activeBooks.length} active lorebooks have descriptions for multi-book disambiguation`));
    }

    return results;
}

function checkBookPermissions() {
    const results = [];
    const settings = getSettings();
    const perms = settings.bookPermissions || {};
    const activeBooks = getActiveTunnelVisionBooks();

    if (Object.keys(perms).length === 0) {
        return results; // All defaults — nothing to report
    }

    const readOnly = activeBooks.filter(b => perms[b] === 'read_only');
    const writeOnly = activeBooks.filter(b => perms[b] === 'write_only');
    const readable = activeBooks.filter(b => perms[b] !== 'write_only');
    const writable = activeBooks.filter(b => perms[b] !== 'read_only');

    if (readable.length === 0 && activeBooks.length > 0) {
        results.push(warn('All active lorebooks are write-only — Search tool will have nothing to search. Consider setting at least one lorebook to Read+Write or Read-Only.'));
    }
    if (writable.length === 0 && activeBooks.length > 0) {
        results.push(warn('All active lorebooks are read-only — Remember/Update/Forget tools cannot write anywhere. Consider setting at least one lorebook to Read+Write or Write-Only.'));
    }

    if (readOnly.length > 0 || writeOnly.length > 0) {
        const parts = [];
        if (readOnly.length > 0) parts.push(`${readOnly.length} read-only`);
        if (writeOnly.length > 0) parts.push(`${writeOnly.length} write-only`);
        results.push(pass(`Book permissions: ${parts.join(', ')} (${readable.length} readable, ${writable.length} writable)`));
    }

    return results;
}

function checkSidecarAutoRetrieval() {
    const settings = getSettings();
    if (!settings.sidecarAutoRetrieval) {
        return pass('Sidecar auto-retrieval: disabled');
    }

    if (!settings.connectionProfile) {
        return warn('Sidecar auto-retrieval is enabled but no connection profile is selected. Auto-retrieval requires a sidecar connection profile.');
    }

    const maxTokens = settings.sidecarMaxInjectionTokens ?? 4000;
    if (maxTokens > 12000) {
        return warn(`Sidecar auto-retrieval max injection is ${maxTokens} tokens — this is very large and may consume significant context. Consider reducing to 4000-8000.`);
    }

    return pass(`Sidecar auto-retrieval: enabled (${settings.sidecarContextMessages ?? 10} messages context, ${maxTokens} token cap)`);
}

function checkSidecarPostGenWriter() {
    const settings = getSettings();
    if (!settings.sidecarPostGenWriter) {
        return pass('Sidecar post-gen writer: disabled');
    }

    if (!settings.connectionProfile) {
        return warn('Sidecar post-gen writer is enabled but no connection profile is selected. The writer requires a sidecar connection profile.');
    }

    const maxOps = settings.sidecarWriterMaxOps ?? 5;
    if (maxOps > 8) {
        return warn(`Sidecar post-gen writer max operations is ${maxOps} — this is high and may cause many lorebook writes per turn. Consider reducing to 3-5.`);
    }

    return pass(`Sidecar post-gen writer: enabled (${settings.sidecarWriterContextMessages ?? 15} messages context, max ${maxOps} ops/turn)`);
}

/** Check conditional triggers configuration. */
function checkConditionalTriggers() {
    const settings = getSettings();
    if (settings.conditionalTriggersEnabled === false) {
        return pass('Narrative conditionals: disabled');
    }

    if (!settings.sidecarAutoRetrieval) {
        return warn('Narrative conditionals are enabled but sidecar auto-retrieval is OFF. Conditionals require auto-retrieval to evaluate. Enable "Auto-Retrieve Before Generation" in sidecar settings.');
    }

    if (!settings.connectionProfile) {
        return warn('Narrative conditionals are enabled but no sidecar connection profile is selected. Conditionals require a sidecar LLM to evaluate scene state.');
    }

    return pass('Narrative conditionals: enabled (conditions on entries will be evaluated by sidecar)');
}

/**
 * Check for entries with per-keyword probability values.
 * Warns if probabilities reference keywords that no longer exist on the entry.
 */
async function checkKeywordProbabilities() {
    const results = [];
    const books = getActiveTunnelVisionBooks();
    let totalProbs = 0;
    let staleProbs = 0;

    for (const bookName of books) {
        const bookData = await loadWorldInfo(bookName);
        if (!bookData?.entries) continue;

        for (const key of Object.keys(bookData.entries)) {
            const entry = bookData.entries[key];
            if (!entry?.tvKeywordProbability) continue;

            const probMap = entry.tvKeywordProbability;
            const allKeywords = [...(entry.key || []), ...(entry.keysecondary || [])];

            for (const kwStr of Object.keys(probMap)) {
                totalProbs++;
                if (!allKeywords.includes(kwStr)) {
                    staleProbs++;
                    // Auto-fix: remove stale probability entry
                    delete probMap[kwStr];
                }
            }

            // Clean up empty map
            if (Object.keys(probMap).length === 0) {
                delete entry.tvKeywordProbability;
            }
        }

        if (staleProbs > 0) {
            await saveWorldInfo(bookName, bookData, true);
        }
    }

    if (staleProbs > 0) {
        results.push(warn(`Cleaned ${staleProbs} stale keyword probability entries (keywords were removed but probability data lingered).`));
    }

    if (totalProbs > 0) {
        results.push(pass(`Keyword probabilities: ${totalProbs - staleProbs} active across all entries`));
    } else {
        results.push(pass('Keyword probabilities: none configured (all keywords fire at 100%)'));
    }

    return results;
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
