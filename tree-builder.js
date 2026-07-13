/**
 * TunnelVision Tree Builder
 * Auto-generates tree indices from lorebook entries using LLM reasoning
 * or manual organization based on existing entry metadata.
 *
 * Follows the PageIndex pattern:
 *   1. Build hierarchical structure from content
 *   2. Generate LLM summaries per node (PageIndex: generate_node_summary)
 *   3. Recursively subdivide large nodes (PageIndex: process_large_node_recursively)
 */

import { generateRaw as _generateRaw } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { loadWorldInfo } from '../../../world-info.js';
import { isSidecarConfigured, sidecarGenerate } from './llm-sidecar.js';
import { createEntry, findEntryByUid } from './entry-manager.js';
import {
    createEmptyTree,
    createTreeNode,
    addEntryToNode,
    saveTree,
    getAllEntryUids,
    getSettings,
    consolidateSiblingNodes,
} from './tree-store.js';
import { applyBackgroundPromptAddendum, trigramSimilarity } from './agent-utils.js';

/**
 * Granularity presets control how aggressively the builder splits entries.
 * Higher levels = more categories, fewer entries per node = deeper/wider trees.
 */
const GRANULARITY_PRESETS = {
    1: { targetCategories: '3-5', maxEntries: 20, label: 'Minimal' },
    2: { targetCategories: '5-8', maxEntries: 12, label: 'Moderate' },
    3: { targetCategories: '8-15', maxEntries: 8, label: 'Detailed' },
    4: { targetCategories: '12-20', maxEntries: 5, label: 'Extensive' },
};

/**
 * Get the effective granularity level.
 * Level 0 = auto: picks based on entry count so small lorebooks aren't over-split.
 * Levels 1-4 = manual override regardless of lorebook size.
 * @param {number} [entryCount] - Number of entries (used only for auto-detection)
 * @returns {{ targetCategories: string, maxEntries: number, label: string, level: number }}
 */
function getEffectiveGranularity(entryCount = 0) {
    const settings = getSettings();
    let level = Number(settings.treeGranularity) || 0;

    if (level === 0) {
        // Auto: scale splitting based on lorebook size
        if (entryCount >= 3000) level = 4;
        else if (entryCount >= 1000) level = 3;
        else if (entryCount >= 200) level = 2;
        else level = 1;
    }

    level = Math.min(4, Math.max(1, level));
    return { ...GRANULARITY_PRESETS[level], level };
}

/** Strip thinking/reasoning blocks from LLM responses. */
const THINK_BLOCK_RE = /<think[\s\S]*?<\/think>/gi;

/**
 * Wrapper around LLM generation. Uses the sidecar (direct API) when configured,
 * falls back to ST's generateRaw when not. Strips thinking blocks from responses.
 */
async function generateRaw(opts) {
    // Try sidecar first, fall back to generateRaw on failure
    if (isSidecarConfigured()) {
        try {
            console.debug('[TunnelVision] tree-builder: using SIDECAR for LLM call');
            return await sidecarGenerate(opts);
        } catch (e) {
            console.warn('[TunnelVision] tree-builder: sidecar failed, falling back to main API:', e.message);
        }
    }

    try {
        console.debug('[TunnelVision] tree-builder: using ST generateRaw');
        const result = await _generateRaw(opts);
        return typeof result === 'string' ? result.replace(THINK_BLOCK_RE, '').trim() : result;
    } catch (e) {
        const msg = e?.message || String(e);
        if (/failed to fetch/i.test(msg)) {
            throw new Error('LLM request failed (network error). Check your API connection, model availability, and that your provider is online.');
        }
        throw e;
    }
}

/**
 * Run a callback against TV's LLM. If the sidecar is configured, the callback makes
 * direct API calls; otherwise it runs against ST's current active API (generateRaw).
 * No connection-profile switching — TV no longer owns an ST profile.
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function withSidecarOrCurrentApi(fn) {
    return fn();
}

/**
 * Format a single lorebook entry for LLM prompts, respecting the detail level setting.
 * Used by categorization, subdivision, and summary generation for consistency.
 * @param {Object} entry - Lorebook entry object
 * @param {string} detail - 'full' | 'lite' | 'names'
 * @param {Object} [options]
 * @param {boolean} [options.includeUid=true] - Prefix with UID (needed for categorization, not for summaries)
 * @returns {string}
 */
function formatEntryForLLM(entry, detail, options = {}) {
    const { includeUid = true } = options;
    const label = entry.comment || entry.key?.[0] || `Entry #${entry.uid}`;

    let line = includeUid ? `UID ${entry.uid}: "${label}"` : `${label}`;

    if (detail !== 'names') {
        const keys = entry.key?.join(', ');
        if (keys) line += ` [keys: ${keys}]`;
        if (entry.group) line += ` (group: ${entry.group})`;
        if (entry.constant) line += ' [always active]';
        if (entry.keysecondary?.length > 0) line += ` [secondary: ${entry.keysecondary.join(', ')}]`;
    }

    if (detail === 'lite') {
        const preview = (entry.content || '').substring(0, 150);
        if (preview) line += `\n    Preview: ${preview}`;
    } else if (detail === 'full') {
        const content = entry.content || '';
        if (content) line += `\n    Content: ${content}`;
    }

    return line;
}

/**
 * Build a tree automatically from existing entry metadata (keys, comments, groups).
 * @param {string} lorebookName
 * @param {Object} [options]
 * @param {boolean} [options.generateSummaries=false] - Call LLM for node summaries
 * @returns {Promise<import('./tree-store.js').TreeIndex>}
 */
export async function buildTreeFromMetadata(lorebookName, options = {}) {
    const bookData = await loadWorldInfo(lorebookName);
    if (!bookData || !bookData.entries) {
        throw new Error(`Lorebook "${lorebookName}" not found or has no entries.`);
    }

    const tree = createEmptyTree(lorebookName);
    const entries = bookData.entries;
    const groupMap = new Map();
    const ungrouped = [];

    for (const key of Object.keys(entries)) {
        const entry = entries[key];
        if (entry.disable) continue;
        const groupName = entry.group?.trim();
        if (groupName) {
            for (const g of groupName.split(',').map(s => s.trim()).filter(Boolean)) {
                if (!groupMap.has(g)) groupMap.set(g, []);
                groupMap.get(g).push(entry);
            }
        } else {
            ungrouped.push(entry);
        }
    }

    for (const [groupName, groupEntries] of groupMap) {
        const node = createTreeNode(groupName, `${groupEntries.length} entries from group "${groupName}"`);
        for (const entry of groupEntries) addEntryToNode(node, entry.uid);
        tree.root.children.push(node);
    }

    if (ungrouped.length > 0) {
        const keyMap = new Map();
        for (const entry of ungrouped) {
            const firstKey = entry.key?.[0]?.trim() || 'Uncategorized';
            if (!keyMap.has(firstKey)) keyMap.set(firstKey, []);
            keyMap.get(firstKey).push(entry);
        }
        if (keyMap.size <= 20) {
            for (const [keyName, keyEntries] of keyMap) {
                const node = createTreeNode(keyName, `Entries keyed on "${keyName}"`);
                for (const entry of keyEntries) addEntryToNode(node, entry.uid);
                tree.root.children.push(node);
            }
        } else {
            const generalNode = createTreeNode('General', `${ungrouped.length} ungrouped entries`);
            for (const entry of ungrouped) addEntryToNode(generalNode, entry.uid);
            tree.root.children.push(generalNode);
        }
    }

    if (options.generateSummaries) {
        await generateSummariesForTree(tree.root, lorebookName);
    }

    tree.lastBuilt = Date.now();
    saveTree(lorebookName, tree);
    return tree;
}

/**
 * Build a tree using LLM reasoning to categorize entries.
 * Large lorebooks are split into chunks (with overfill) and categorized in multiple passes.
 * After building: subdivide large nodes, then generate per-node summaries.
 * @param {string} lorebookName
 * @param {Object} [options]
 * @param {function(string, number): void} [options.onProgress] - Called with (message, percentage 0-100)
 * @param {function(string): void} [options.onDetail] - Called with detail/sub-status text
 * @returns {Promise<import('./tree-store.js').TreeIndex>}
 */
export async function buildTreeWithLLM(lorebookName, options = {}) {
    return withSidecarOrCurrentApi(() => _buildTreeWithLLM(lorebookName, options));
}

/** Default max concurrent LLM calls during build phases. */
const BUILD_CONCURRENCY = 3;

const NODE_LABEL_FUZZY_THRESHOLD = 0.65;

/**
 * Run an array of async tasks with bounded concurrency.
 * @param {Array<() => Promise>} tasks - Factory functions that return promises
 * @param {number} limit - Max concurrent tasks
 * @returns {Promise<Array>} Results in order
 */
async function runWithConcurrency(tasks, limit = BUILD_CONCURRENCY) {
    const results = new Array(tasks.length);
    let nextIdx = 0;

    async function worker() {
        while (nextIdx < tasks.length) {
            const idx = nextIdx++;
            try {
                results[idx] = await tasks[idx]();
            } catch (e) {
                results[idx] = e;
            }
        }
    }

    const workers = [];
    for (let i = 0; i < Math.min(limit, tasks.length); i++) {
        workers.push(worker());
    }
    await Promise.all(workers);
    return results;
}

async function _buildTreeWithLLM(lorebookName, options = {}) {
    const progress = options.onProgress || (() => {});
    const detail_ = options.onDetail || (() => {});
    const bookData = await loadWorldInfo(lorebookName);
    if (!bookData || !bookData.entries) {
        throw new Error(`Lorebook "${lorebookName}" not found or has no entries.`);
    }

    const activeEntries = [];
    for (const key of Object.keys(bookData.entries)) {
        const entry = bookData.entries[key];
        if (entry.disable) continue;
        activeEntries.push(entry);
    }

    if (activeEntries.length === 0) {
        throw new Error(`Lorebook "${lorebookName}" has no active entries to index.`);
    }

    const settings = getSettings();
    const detail = settings.llmBuildDetail || 'full';
    const chunkLimit = settings.llmChunkTokens || 30000;

    // Format all entries and split into chunks with overfill
    const chunks = chunkEntries(activeEntries, detail, chunkLimit);
    const gran = getEffectiveGranularity(activeEntries.length);
    console.log(`[TunnelVision] Categorizing ${activeEntries.length} entries in ${chunks.length} chunk(s) (limit: ${chunkLimit} chars)`);
    console.log(`[TunnelVision] Using granularity level ${gran.level} (${gran.label}): ${gran.targetCategories} top-level categories, max ${gran.maxEntries} entries/node`);

    // First chunk: fresh categorization (must run alone to establish categories)
    // When multi-chunk, give the first prompt a manifest of ALL entry names so it
    // creates categories that cover the entire lorebook, not just chunk 1's entries.
    progress(`Categorizing chunk 1/${chunks.length}`, 0);
    detail_(`${activeEntries.length} entries across ${chunks.length} chunk(s)`);
    const allEntryManifest = chunks.length > 1
        ? activeEntries.map(e => formatEntryForLLM(e, 'names', { includeUid: false })).join('\n  - ')
        : null;
    const firstPrompt = buildCategorizationPrompt(lorebookName, chunks[0], activeEntries.length, allEntryManifest);
    const firstResponse = await generateRaw({
        prompt: firstPrompt,
        systemPrompt: applyBackgroundPromptAddendum('You are a categorization assistant. Respond ONLY with valid JSON, no commentary.'),
    });
    if (!firstResponse) throw new Error('LLM returned empty response for tree categorization.');

    const allUids = activeEntries.map(e => e.uid);
    // For multi-chunk builds, only pass chunk 1's UIDs to the initial parse.
    // parseLLMTreeResponse's fallback assigns unplaced UIDs to root — if allUids
    // is passed here, entries from chunks 2+ are pre-assigned to root before those
    // chunks are even processed, causing mergeLLMResponse to skip them as "already assigned".
    const chunk1Uids = chunks.length > 1 ? chunks[0].map(e => e.uid) : allUids;
    const tree = await parseLLMTreeResponse(lorebookName, firstResponse, chunk1Uids);

    // Subsequent chunks: run in parallel — each gets the same category snapshot
    if (chunks.length > 1) {
        const existingCategories = extractCategoryLabels(tree.root);
        const chunkTasks = [];
        for (let i = 1; i < chunks.length; i++) {
            const chunkIdx = i;
            chunkTasks.push(() => {
                progress(`Categorizing chunks (${chunkIdx + 1}/${chunks.length})`, Math.round((chunkIdx / chunks.length) * 60));
                const contPrompt = buildContinuationPrompt(lorebookName, chunks[chunkIdx], existingCategories, activeEntries.length);
                return generateRaw({
                    prompt: contPrompt,
                    systemPrompt: applyBackgroundPromptAddendum('You are a categorization assistant. Respond ONLY with valid JSON, no commentary.'),
                });
            });
        }

        const chunkResults = await runWithConcurrency(chunkTasks, BUILD_CONCURRENCY);

        // Merge results sequentially (merging is cheap, just node assignment)
        for (let i = 0; i < chunkResults.length; i++) {
            const resp = chunkResults[i];
            if (resp && typeof resp === 'string') {
                mergeLLMResponse(tree, resp, allUids);
            } else if (resp instanceof Error) {
                console.warn(`[TunnelVision] Chunk ${i + 2}/${chunks.length} categorization failed:`, resp);
            }
        }
    }

    // Assign any still-unassigned UIDs to root
    const assigned = new Set(getAllEntryUids(tree.root));
    for (const uid of allUids) {
        if (!assigned.has(uid)) addEntryToNode(tree.root, uid);
    }

    // Re-categorize any entries that couldn't be placed by the main chunking pass
    if (tree.root.entryUids.length > 0) {
        progress('Re-categorizing uncategorized entries…', 62);
        const rootUids = [...tree.root.entryUids];
        const rootUidSet = new Set(rootUids);
        const rootEntries = activeEntries.filter(e => rootUidSet.has(e.uid));
        const existingCategories = extractCategoryLabels(tree.root);
        if (existingCategories.length > 0) {
            console.log(`[TunnelVision] Re-categorizing ${rootEntries.length} uncategorized entries against ${existingCategories.length} categories…`);
            const retryPrompt = buildContinuationPrompt(lorebookName, rootEntries, existingCategories, activeEntries.length);
            const retryResponse = await generateRaw({
                prompt: retryPrompt,
                systemPrompt: applyBackgroundPromptAddendum('You are a categorization assistant. Respond ONLY with valid JSON, no commentary.'),
            });
            if (retryResponse) {
                tree.root.entryUids = []; // clear so mergeLLMResponse can place them
                mergeLLMResponse(tree, retryResponse, allUids);
                const reassigned = new Set(getAllEntryUids(tree.root));
                for (const uid of rootUids) {
                    if (!reassigned.has(uid)) addEntryToNode(tree.root, uid);
                }
                console.log(`[TunnelVision] Re-categorization: placed ${rootUids.length - tree.root.entryUids.length}/${rootUids.length} previously uncategorized entries.`);
            }
        }
    }

    // Save intermediate tree so chunking work isn't lost if subdivision/summaries abort
    tree.lastBuilt = Date.now();
    saveTree(lorebookName, tree);
    console.log('[TunnelVision] Chunked categorization complete, saved intermediate tree.');

    // PageIndex pattern: recursively subdivide large nodes (parallel siblings)
    progress('Subdividing large nodes…', 65);
    detail_(`Splitting categories with ${gran.maxEntries}+ entries (granularity: ${gran.label})`);
    await subdivideLargeNodes(tree.root, bookData, activeEntries.length);
    consolidateSiblingNodes(tree.root);
    saveTree(lorebookName, tree);

    // PageIndex pattern: generate per-node summaries (parallel with batching)
    progress('Generating summaries…', 80);
    detail_('LLM writing descriptions for each category');
    await _generateSummariesForTree(tree.root, lorebookName, true, bookData);

    saveTree(lorebookName, tree);
    return tree;
}

// ─── Chunking ────────────────────────────────────────────────────

/**
 * Split entries into chunks that fit within the character limit.
 * Uses overfill: if adding the next entry exceeds the limit, include it
 * anyway so entries are never split mid-way. Only starts a new chunk after.
 * @param {Object[]} entries - Lorebook entry objects
 * @param {string} detail - Detail level for formatting
 * @param {number} charLimit - Max characters per chunk
 * @returns {Object[][]} Array of entry chunks
 */
function chunkEntries(entries, detail, charLimit) {
    if (entries.length === 0) return [];

    const chunks = [];
    let currentChunk = [];
    let currentSize = 0;

    for (const entry of entries) {
        const formatted = formatEntryForLLM(entry, detail);
        const entrySize = formatted.length + 5; // +5 for "  - " prefix and newline

        if (currentChunk.length > 0 && currentSize + entrySize > charLimit) {
            // Overfill: include this entry in the current chunk, then start new
            currentChunk.push(entry);
            chunks.push(currentChunk);
            currentChunk = [];
            currentSize = 0;
        } else {
            currentChunk.push(entry);
            currentSize += entrySize;
        }
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    return chunks;
}

/**
 * Extract existing category labels from tree for continuation prompts.
 * @param {import('./tree-store.js').TreeNode} root
 * @returns {string[]}
 */
function extractCategoryLabels(root) {
    const labels = [];
    for (const child of (root.children || [])) {
        const count = getAllEntryUids(child).length;
        const summary = child.summary ? ` — ${child.summary.split('\n')[0].slice(0, 80)}` : '';
        labels.push(`${child.label} (${count} entries)${summary}`);
        for (const sub of (child.children || [])) {
            const subCount = getAllEntryUids(sub).length;
            const subSummary = sub.summary ? ` — ${sub.summary.split('\n')[0].slice(0, 60)}` : '';
            labels.push(`  ${child.label} > ${sub.label} (${subCount} entries)${subSummary}`);
            for (const grand of (sub.children || [])) {
                const grandCount = getAllEntryUids(grand).length;
                labels.push(`    ${child.label} > ${sub.label} > ${grand.label} (${grandCount} entries)`);
            }
        }
    }
    return labels;
}

/**
 * Build a continuation prompt for subsequent chunks that references existing categories.
 * @param {string} lorebookName
 * @param {Object[]} entries
 * @param {string[]} existingCategories
 * @returns {string}
 */
function buildContinuationPrompt(lorebookName, entries, existingCategories, totalEntryCount = 0) {
    const detail = getSettings().llmBuildDetail || 'full';
    const entryList = entries.map(e => `  - ${formatEntryForLLM(e, detail)}`).join('\n');
    const catList = existingCategories.map(c => `  - ${c}`).join('\n');
    const gran = getEffectiveGranularity(totalEntryCount);
    const subCatHint = gran.level >= 3 ? ' Prefer creating new sub-categories over placing entries in broad existing ones.' : '';

    return `You are continuing to organize a lorebook called "${lorebookName}". Previous entries have already been categorized.

Existing categories:
${catList}

Here are the NEW entries to categorize:
${entryList}

IMPORTANT: Every entry UID must appear exactly once. Strongly prefer existing categories — only create a new one if NO existing category is even a plausible fit. New category labels must follow the same naming style as existing ones (specific noun phrases, no "Other"/"Misc"/"General").${subCatHint} Do NOT leave entries uncategorized — every UID must be in a category.

Respond with ONLY valid JSON in this exact format:
{
  "categories": [
    {
      "label": "Existing or New Category Name",
      "summary": "Brief description",
      "entries": [uid1, uid2],
      "children": []
    }
  ]
}`;
}

/**
 * Merge a continuation LLM response into the existing tree.
 * Entries assigned to existing category labels go into those nodes;
 * new categories are added as new children of root.
 * @param {import('./tree-store.js').TreeIndex} tree
 * @param {string} response
 * @param {number[]} validUids
 */
function fuzzyFindNode(label, labelMap) {
    if (labelMap.has(label)) return labelMap.get(label);
    let best = null, bestScore = 0;
    for (const [key, node] of labelMap) {
        const score = trigramSimilarity(label, key);
        if (score > bestScore && score >= NODE_LABEL_FUZZY_THRESHOLD) {
            bestScore = score;
            best = node;
        }
    }
    return best;
}

function mergeLLMResponse(tree, response, validUids) {
    try {
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return;

        const parsed = JSON.parse(jsonMatch[0]);
        if (!parsed.categories || !Array.isArray(parsed.categories)) return;

        const validSet = new Set(validUids);
        const alreadyAssigned = new Set(getAllEntryUids(tree.root));

        // Build a label→node lookup for existing categories (case-insensitive)
        const labelMap = new Map();
        function indexNodes(node) {
            labelMap.set(node.label.toLowerCase(), node);
            for (const child of (node.children || [])) indexNodes(child);
        }
        for (const child of tree.root.children) indexNodes(child);

        for (const cat of parsed.categories) {
            const catLabel = (cat.label || 'Unnamed').toLowerCase();
            const existingNode = fuzzyFindNode(catLabel, labelMap);
            const targetNode = existingNode || createTreeNode(cat.label || 'Unnamed', cat.summary || '');

            if (Array.isArray(cat.entries)) {
                for (const uid of cat.entries) {
                    const n = Number(uid);
                    if (validSet.has(n) && !alreadyAssigned.has(n)) {
                        addEntryToNode(targetNode, n);
                        alreadyAssigned.add(n);
                    }
                }
            }

            // Handle children in the response
            if (Array.isArray(cat.children)) {
                for (const sub of cat.children) {
                    const subLabel = (sub.label || 'Unnamed').toLowerCase();
                    const existingSub = fuzzyFindNode(subLabel, labelMap);
                    const subNode = existingSub || createTreeNode(sub.label || 'Unnamed', sub.summary || '');
                    if (Array.isArray(sub.entries)) {
                        for (const uid of sub.entries) {
                            const n = Number(uid);
                            if (validSet.has(n) && !alreadyAssigned.has(n)) {
                                addEntryToNode(subNode, n);
                                alreadyAssigned.add(n);
                            }
                        }
                    }
                    if (!existingSub && subNode.entryUids.length > 0) {
                        targetNode.children.push(subNode);
                        labelMap.set(subLabel, subNode);
                    }
                }
            }

            if (!existingNode && (targetNode.entryUids.length > 0 || targetNode.children.length > 0)) {
                tree.root.children.push(targetNode);
                labelMap.set(catLabel, targetNode);
            }
        }
    } catch (e) {
        console.warn('[TunnelVision] Failed to merge continuation chunk:', e);
    }
}

/**
 * Generate LLM summaries for each node in the tree.
 * Mirrors PageIndex's generate_summaries_for_structure().
 * The summary describes what entries a node covers, enabling the retrieval
 * step to reason about relevance without reading full entry content.
 */
export async function generateSummariesForTree(node, lorebookName, _isRoot = true) {
    if (_isRoot) {
        return withSidecarOrCurrentApi(() => _generateSummariesForTree(node, lorebookName, true, null));
    }
    return _generateSummariesForTree(node, lorebookName, _isRoot, null);
}

/**
 * Internal summary generator — batches nodes and runs in parallel.
 * @param {import('./tree-store.js').TreeNode} rootNode
 * @param {string} lorebookName
 * @param {boolean} _isRoot
 * @param {Object} [cachedBookData] - Pre-loaded book data to avoid redundant loads
 */
async function _generateSummariesForTree(rootNode, lorebookName, _isRoot = true, cachedBookData = null) {
    const bookData = cachedBookData || await loadWorldInfo(lorebookName);
    if (!bookData || !bookData.entries) return;

    const settings = getSettings();
    const detail = settings.llmBuildDetail || 'full';

    // Collect all non-root nodes that need summaries
    const nodesToSummarize = [];
    function collectNodes(node, isRoot) {
        if (!isRoot) {
            const uids = getAllEntryUids(node);
            if (uids.length > 0) nodesToSummarize.push(node);
        }
        for (const child of (node.children || [])) collectNodes(child, false);
    }
    collectNodes(rootNode, true);

    if (nodesToSummarize.length === 0) {
        if (_isRoot) await generateBookSummary(rootNode, lorebookName);
        return;
    }

    // Batch nodes into groups of up to 5 for fewer LLM calls
    const BATCH_SIZE = 5;
    const batches = [];
    for (let i = 0; i < nodesToSummarize.length; i += BATCH_SIZE) {
        batches.push(nodesToSummarize.slice(i, i + BATCH_SIZE));
    }

    console.log(`[TunnelVision] Generating summaries: ${nodesToSummarize.length} nodes in ${batches.length} batch(es)`);

    // Build tasks for each batch
    const batchTasks = batches.map((batch, batchIdx) => () => {
        // Build a multi-node summary prompt
        const sections = batch.map(node => {
            const uids = getAllEntryUids(node);
            const entryTexts = [];
            for (const uid of uids.slice(0, 10)) {
                const entry = findEntryByUid(bookData.entries, uid);
                if (entry) {
                    entryTexts.push(`  - ${formatEntryForLLM(entry, detail, { includeUid: false })}`);
                }
            }
            return `Category "${node.label}" (${uids.length} entries):\n${entryTexts.join('\n')}`;
        });

        const prompt = batch.length === 1
            ? `Entries from lorebook category "${batch[0].label}":\n${sections[0].split('\n').slice(1).join('\n')}\n\nWrite a brief 1-2 sentence description of what topics and information these entries cover. Return ONLY the description.`
            : `Write a brief 1-2 sentence summary for EACH of the following lorebook categories. Return ONLY a JSON object mapping category name to its summary.\n\n${sections.join('\n\n')}\n\nRespond with ONLY JSON: { "Category Name": "summary text", ... }`;

        return generateRaw({
            prompt,
            systemPrompt: applyBackgroundPromptAddendum('You are a summarization assistant. Return only the requested output, no commentary.'),
        }).then(response => ({ batchIdx, batch, response }))
            .catch(e => {
                console.warn(`[TunnelVision] Summary batch ${batchIdx + 1} failed:`, e);
                return { batchIdx, batch, response: null };
            });
    });

    // Run batches in parallel with concurrency limit
    const results = await runWithConcurrency(batchTasks, BUILD_CONCURRENCY);

    // Parse results and assign summaries to nodes
    for (const result of results) {
        if (!result || result instanceof Error || !result.response) continue;
        const { batch, response } = result;

        if (batch.length === 1) {
            // Single-node batch: response is the summary directly
            batch[0].summary = response.trim();
        } else {
            // Multi-node batch: parse JSON mapping
            try {
                const jsonMatch = response.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    for (const node of batch) {
                        // Try exact match, then case-insensitive
                        const summary = parsed[node.label]
                            || Object.entries(parsed).find(([k]) => k.toLowerCase() === node.label.toLowerCase())?.[1];
                        if (summary) node.summary = String(summary).trim();
                    }
                }
            } catch (e) {
                console.warn('[TunnelVision] Failed to parse batched summary response:', e);
                // Fallback: if only one entry in response, try to assign to first unsummarized node
            }
        }
    }

    // Append deduplicated keywords from entries to each node's summary.
    // This makes keywords directly visible to the AI during tree navigation
    // without requiring a schema change or separate lookup.
    for (const node of nodesToSummarize) {
        if (!node.summary) continue;
        const uids = getAllEntryUids(node);
        const keywordSet = new Map();
        for (const uid of uids) {
            const entry = findEntryByUid(bookData.entries, uid);
            if (entry?.key) {
                for (const k of entry.key) {
                    const trimmed = String(k).trim();
                    // Deduplicate case-insensitively but preserve original casing
                    if (trimmed && !keywordSet.has(trimmed.toLowerCase())) {
                        keywordSet.set(trimmed.toLowerCase(), trimmed);
                    }
                }
            }
        }
        if (keywordSet.size > 0) {
            // Cap at 30 keywords to avoid bloating node summaries
            const keywords = [...keywordSet.values()].slice(0, 30).join(', ');
            node.summary = node.summary.replace(/\n\[Keywords:[^\]]*\]\s*$/, '') + `\n[Keywords: ${keywords}]`;
        }
    }

    // Generate book-level summary after all nodes are done
    if (_isRoot && rootNode.children.length > 0) {
        await generateBookSummary(rootNode, lorebookName);
    }
}

/**
 * Generate a book-level summary from top-level category labels and summaries.
 * Stored on the root node's summary field. Only overwrites if no user description is set.
 */
async function generateBookSummary(rootNode, lorebookName) {
    // Don't overwrite user-set description
    const { getBookDescription, setBookDescription } = await import('./tree-store.js');
    if (getBookDescription(lorebookName)) return;

    const categoryList = rootNode.children
        .map(c => c.summary ? `- ${c.label}: ${c.summary}` : `- ${c.label}`)
        .join('\n');

    if (!categoryList) return;

    try {
        const totalEntries = getAllEntryUids(rootNode).length;
        const summary = await generateRaw({
            prompt: `This lorebook "${lorebookName}" has ${totalEntries} entries organized into these categories:\n${categoryList}\n\nWrite a brief 1-2 sentence description of what this lorebook contains overall — what kind of information does it store? Return ONLY the description.`,
            systemPrompt: applyBackgroundPromptAddendum('You are a summarization assistant. Return only the requested description, no commentary.'),
        });
        if (summary) {
            rootNode.summary = summary.trim();
            setBookDescription(lorebookName, rootNode.summary);
            console.log(`[TunnelVision] Generated book summary for "${lorebookName}": ${rootNode.summary}`);
        }
    } catch (e) {
        console.warn(`[TunnelVision] Book summary generation failed for "${lorebookName}":`, e);
    }
}

/**
 * Recursively subdivide nodes with too many entries.
 * Mirrors PageIndex's process_large_node_recursively().
 * Sibling nodes are subdivided in parallel for speed.
 * @param {import('./tree-store.js').TreeNode} node
 * @param {Object} bookData - Cached lorebook data (loaded once, passed through)
 * @param {number} totalEntryCount
 */
const MAX_SUBDIVISION_DEPTH = 4;

async function subdivideLargeNodes(node, bookData, totalEntryCount = 0, _depth = 0) {
    if (!bookData || !bookData.entries) return;
    if (_depth >= MAX_SUBDIVISION_DEPTH) return;

    const maxPerNode = getEffectiveGranularity(totalEntryCount).maxEntries;
    if (node.entryUids.length > maxPerNode) {
        const detail = getSettings().llmBuildDetail || 'full';
        const nodeEntries = node.entryUids.map(uid => findEntryByUid(bookData.entries, uid)).filter(Boolean);

        if (nodeEntries.length > maxPerNode) {
            // When the node already has children (e.g. root with orphaned entries from
            // multi-chunk categorization), tell the LLM about existing categories so it
            // can assign entries to them rather than creating redundant new ones.
            const existingHint = node.children.length > 0
                ? `\n\nExisting sub-categories in "${node.label}": ${node.children.map(c => `${c.label} (${c.entryUids.length} entries)`).join(', ')}. Assign entries to these when they fit, or create new sub-categories only for entries that genuinely do not fit any existing one.`
                : '';

            try {
                const gran = getEffectiveGranularity(totalEntryCount);
                const subCatCount = Math.min(6, Math.ceil(nodeEntries.length / gran.maxEntries));
                const entryList = nodeEntries.map(e => `  ${formatEntryForLLM(e, detail)}`).join('\n');
                const response = await generateRaw({
                    prompt: `You have ${nodeEntries.length} lorebook entries in the "${node.label}" category of a lorebook tree used for AI context retrieval. Split into 2–${subCatCount} focused sub-categories so an AI assistant can navigate to the right entries quickly.${existingHint}\n\nUse specific, descriptive noun phrases as sub-category labels. Avoid "Other", "Miscellaneous", or "General". Every entry must be assigned to exactly one sub-category.\n\nEntries:\n${entryList}\n\nRespond ONLY with JSON: { "subcategories": [{ "label": "Name", "entries": [uid1, uid2] }] }`,
                    systemPrompt: applyBackgroundPromptAddendum('You are a categorization assistant. Respond ONLY with valid JSON, no commentary.'),
                });
                if (response) {
                    const jsonMatch = response.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        const parsed = JSON.parse(jsonMatch[0]);
                        if (parsed.subcategories && Array.isArray(parsed.subcategories)) {
                            // Build lookup for existing children (case-insensitive)
                            const childMap = new Map();
                            for (const child of node.children) {
                                childMap.set(child.label.toLowerCase(), child);
                            }

                            const assigned = new Set();
                            for (const sub of parsed.subcategories) {
                                const subLabel = (sub.label || 'Unnamed').toLowerCase();
                                // Merge into existing child if label matches
                                const existingChild = fuzzyFindNode(subLabel, childMap);
                                const target = existingChild || createTreeNode(sub.label || 'Unnamed', '');
                                const isNew = !existingChild;

                                if (Array.isArray(sub.entries)) {
                                    for (const uid of sub.entries) {
                                        const n = Number(uid);
                                        if (node.entryUids.includes(n) && !assigned.has(n)) {
                                            addEntryToNode(target, n);
                                            assigned.add(n);
                                        }
                                    }
                                }
                                if (isNew && target.entryUids.length > 0) {
                                    node.children.push(target);
                                    childMap.set(subLabel, target);
                                }
                            }
                            node.entryUids = node.entryUids.filter(uid => !assigned.has(uid));
                        }
                    }
                }
            } catch (e) {
                console.warn(`[TunnelVision] Subdivision failed for "${node.label}":`, e);
            }
        }
    }

    // Recurse into children in parallel — sibling nodes are independent
    if (node.children.length > 0) {
        const childTasks = node.children.map(child => () => subdivideLargeNodes(child, bookData, totalEntryCount, _depth + 1));
        await runWithConcurrency(childTasks, BUILD_CONCURRENCY);
    }
}

function buildCategorizationPrompt(lorebookName, entries, totalEntryCount = 0, allEntryManifest = null) {
    const detail = getSettings().llmBuildDetail || 'full';
    const gran = getEffectiveGranularity(totalEntryCount);
    const entryList = entries.map(e => `  - ${formatEntryForLLM(e, detail)}`).join('\n');

    // When multi-chunk, show ALL entry names first so the LLM creates categories
    // that cover the full lorebook, not just this chunk's entries.
    const manifestSection = allEntryManifest
        ? `\nThis lorebook has ${totalEntryCount} total entries. Here is a list of ALL entry names for context (you will only categorize the detailed entries below, but design your categories to accommodate all of these):\n  - ${allEntryManifest}\n`
        : '';

    return `You are organizing a lorebook called "${lorebookName}" into a hierarchical tree for efficient retrieval.
${manifestSection}
Here are the entries to categorize now (with full details):
${entryList}

Create a JSON hierarchy that groups these entries into logical categories. Use ${gran.targetCategories} top-level categories, each with sub-categories where natural. Aim for no more than ${gran.maxEntries} entries per leaf node. Every entry UID listed above must appear exactly once. Do NOT leave entries uncategorized.

The tree is navigated by an AI assistant during chat to retrieve relevant context. Use specific, descriptive noun phrases as labels (e.g. "Magic System", "Elena's Backstory", "Port Alara Geography"). Avoid generic labels like "Other", "Miscellaneous", or "General". Category summaries should describe what an AI would find inside, not just restate the label.

Respond with ONLY valid JSON in this exact format:
{
  "categories": [
    {
      "label": "Category Name",
      "summary": "Brief description of what this category covers",
      "entries": [uid1, uid2],
      "children": [
        {
          "label": "Sub-category",
          "summary": "Description",
          "entries": [uid3],
          "children": []
        }
      ]
    }
  ]
}`;
}

async function parseLLMTreeResponse(lorebookName, response, entryUids) {
    try {
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON found in response');

        const parsed = JSON.parse(jsonMatch[0]);
        if (!parsed.categories || !Array.isArray(parsed.categories)) throw new Error('Invalid structure');

        const tree = createEmptyTree(lorebookName);
        const allUids = new Set(entryUids);
        const assigned = new Set();

        function buildNodes(categories, parent) {
            for (const cat of categories) {
                const node = createTreeNode(cat.label || 'Unnamed', cat.summary || '');
                if (Array.isArray(cat.entries)) {
                    for (const uid of cat.entries) {
                        const n = Number(uid);
                        if (allUids.has(n) && !assigned.has(n)) { addEntryToNode(node, n); assigned.add(n); }
                    }
                }
                if (Array.isArray(cat.children) && cat.children.length > 0) buildNodes(cat.children, node);
                if (node.entryUids.length > 0 || node.children.length > 0) parent.children.push(node);
            }
        }

        buildNodes(parsed.categories, tree.root);
        for (const uid of allUids) { if (!assigned.has(uid)) addEntryToNode(tree.root, uid); }
        tree.lastBuilt = Date.now();
        return tree;
    } catch (err) {
        console.warn('[TunnelVision] LLM parse failed, falling back to metadata:', err);
        return await buildTreeFromMetadata(lorebookName);
    }
}

// findEntryByUid imported from entry-manager.js

// ── Chat Ingest ──────────────────────────────────────────────────

/**
 * Ingest chat messages into lorebook entries using LLM extraction.
 * Reads a range of chat messages, chunks them, sends each chunk to the LLM
 * to extract facts, then creates entries via createEntry.
 *
 * @param {string} lorebookName - Target lorebook
 * @param {Object} options
 * @param {number} options.from - Start message index (0-based)
 * @param {number} options.to - End message index (inclusive)
 * @param {function} [options.progress] - Progress callback (message, percent)
 * @param {function} [options.detail] - Detail callback (text)
 * @returns {Promise<{created: number, errors: number}>}
 */
export async function ingestChatMessages(lorebookName, options) {
    return withSidecarOrCurrentApi(() => _ingestChatMessages(lorebookName, options));
}

async function _ingestChatMessages(lorebookName, { from, to, progress, detail }) {
    const context = getContext();
    if (!context.chat || context.chat.length === 0) {
        throw new Error('No chat is open. Open a chat before ingesting messages.');
    }
    if (!context.chatId) {
        throw new Error('No active chat ID. Please open a chat first.');
    }

    const chat = context.chat;
    const maxIdx = chat.length - 1;
    const start = Math.max(0, Math.min(from, maxIdx));
    const end = Math.max(start, Math.min(to, maxIdx));

    // Collect messages in range
    const messages = [];
    for (let i = start; i <= end; i++) {
        const msg = chat[i];
        if (!msg || msg.is_system) continue;
        const name = msg.name || (msg.is_user ? 'User' : 'Character');
        const text = (msg.mes || '').trim();
        if (!text) continue;
        messages.push({ index: i, name, text });
    }

    if (messages.length === 0) {
        throw new Error(`No messages found in range ${from}-${to}.`);
    }

    const report = (msg, pct) => { if (progress) progress(msg, pct); };
    const detail_ = (msg) => { if (detail) detail(msg); };

    report('Preparing messages...', 0);
    detail_(`${messages.length} messages in range ${start}-${end}`);

    // Chunk messages by character limit (reuse the same chunking strategy as tree building)
    const settings = getSettings();
    const charLimit = settings.llmChunkTokens || 30000;
    const chunks = chunkMessages(messages, charLimit);

    report(`Extracting facts from ${chunks.length} chunk(s)...`, 5);

    // Load existing lorebook entries to prevent re-extraction and for trigram dedup
    const existingBookData = await loadWorldInfo(lorebookName);
    const existingTitles = [];
    const dedupTexts = [];
    if (existingBookData?.entries) {
        for (const e of Object.values(existingBookData.entries)) {
            if (e.disable) continue;
            const title = (e.comment || '').trim();
            if (title) existingTitles.push(title);
            dedupTexts.push(`${e.comment || ''} ${e.content || ''}`.toLowerCase());
        }
    }
    const shownExistingTitles = existingTitles.slice(0, 150);
    const prevExtracted = []; // titles extracted from earlier chunks, passed to subsequent prompts

    let totalCreated = 0;
    let totalErrors = 0;

    for (let i = 0; i < chunks.length; i++) {
        const pct = 5 + Math.round(((i + 1) / chunks.length) * 90);
        report(`Processing chunk ${i + 1}/${chunks.length}...`, pct);
        detail_(`Chunk ${i + 1}: ${chunks[i].length} messages`);

        const formatted = chunks[i].map(m => `[${m.name}]: ${m.text}`).join('\n\n');

        let response;
        try {
            response = await generateRaw({
                prompt: buildIngestPrompt(lorebookName, formatted, shownExistingTitles, [...prevExtracted]),
                systemPrompt: applyBackgroundPromptAddendum('You are a fact extraction assistant. Extract important facts, character details, relationships, events, and world information from roleplay chat logs. Respond ONLY with valid JSON, no commentary.'),
            });
        } catch (e) {
            console.error(`[TunnelVision] Ingest chunk ${i + 1} LLM call failed:`, e);
            totalErrors++;
            continue;
        }

        if (!response) continue;

        // Parse JSON response. If the provider truncated the final object, keep
        // any complete objects from the same chunk instead of discarding all work.
        let entries;
        try {
            const parsed = parseIngestEntries(response);
            entries = parsed.entries;
            if (parsed.partial) {
                totalErrors++;
                console.warn(`[TunnelVision] Ingest chunk ${i + 1} response was partial; salvaged ${entries.length} complete entr${entries.length === 1 ? 'y' : 'ies'}.`);
            }
            if (!entries.length) {
                throw new Error('No complete JSON entries found in response');
            }
        } catch (e) {
            console.warn(`[TunnelVision] Ingest chunk ${i + 1} JSON parse failed:`, e, response);
            totalErrors++;
            continue;
        }

        if (!Array.isArray(entries)) continue;

        // Create entries (with trigram dedup against existing and already-ingested entries)
        for (const extracted of entries) {
            if (!extracted.title || !extracted.content) continue;
            const newText = `${extracted.title} ${extracted.content}`.toLowerCase();
            const isDupe = dedupTexts.some(existing => trigramSimilarity(newText, existing) >= 0.62);
            if (isDupe) {
                console.log(`[TunnelVision] Ingest: skipping duplicate "${extracted.title}"`);
                continue;
            }
            try {
                await createEntry(lorebookName, {
                    content: String(extracted.content).trim(),
                    comment: String(extracted.title).trim(),
                    keys: Array.isArray(extracted.keys) ? extracted.keys : [],
                    nodeId: null,
                });
                dedupTexts.push(newText);
                prevExtracted.push(String(extracted.title).trim());
                totalCreated++;
            } catch (e) {
                console.warn(`[TunnelVision] Failed to create entry "${extracted.title}":`, e);
                totalErrors++;
            }
        }
    }

    report('Done', 100);
    detail_(`Created ${totalCreated} entries, ${totalErrors} errors`);
    return { created: totalCreated, errors: totalErrors };
}

function buildIngestPrompt(lorebookName, chatText, existingTitles = [], prevExtracted = []) {
    const existingSection = existingTitles.length > 0
        ? `\n[Already in lorebook — do NOT re-extract these]\n${existingTitles.map(t => `- ${t}`).join('\n')}\n`
        : '';
    const prevSection = prevExtracted.length > 0
        ? `\n[Already extracted from earlier chunks — do NOT duplicate these]\n${prevExtracted.map(t => `- ${t}`).join('\n')}\n`
        : '';

    return `Extract important facts from this roleplay chat log for the lorebook "${lorebookName}".
${existingSection}${prevSection}
For each distinct fact, character detail, relationship, event, or world detail, create an entry.

Rules:
- Extract ONLY concrete facts, not dialogue or opinions
- Write content in third person, factual style
- Each entry should be a single, distinct piece of information
- Include character names in keys for cross-referencing
- Skip trivial or generic information
- Merge related facts into single entries when they belong together
- If a subject already appears in the "Already in lorebook" list above, write content as an addendum — state only the new specific detail, do NOT restate who they are or repeat their general description

Chat log:
${chatText}

Respond with ONLY a JSON array:
[
  {
    "title": "Short descriptive title",
    "content": "The factual information written in third person.",
    "keys": ["keyword1", "keyword2"],
    "significance": "low" | "medium" | "high",
    "when": "approximate story time if discernible, otherwise omit this field"
  }
]`;
}

function findBalancedJsonEnd(text, start, opener, closer) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
        const ch = text[i];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
        } else if (ch === opener) {
            depth++;
        } else if (ch === closer) {
            depth--;
            if (depth === 0) return i;
        }
    }

    return -1;
}

function salvageCompleteObjects(text) {
    const entries = [];
    let inString = false;
    let escaped = false;
    let depth = 0;
    let objectStart = -1;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
        } else if (ch === '{') {
            if (depth === 0) objectStart = i;
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0 && objectStart >= 0) {
                try {
                    const parsed = JSON.parse(text.substring(objectStart, i + 1));
                    entries.push(parsed);
                } catch {
                    // Ignore malformed object and keep scanning for later complete ones.
                }
                objectStart = -1;
            }
        }
    }

    return entries;
}

function parseIngestEntries(response) {
    if (!response || typeof response !== 'string') {
        return { entries: [], partial: false };
    }

    const cleaned = response.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim();

    const arrayStart = cleaned.indexOf('[');
    if (arrayStart >= 0) {
        const arrayEnd = findBalancedJsonEnd(cleaned, arrayStart, '[', ']');
        if (arrayEnd >= 0) {
            const parsed = JSON.parse(cleaned.substring(arrayStart, arrayEnd + 1));
            return { entries: Array.isArray(parsed) ? parsed : [], partial: false };
        }

        const salvaged = salvageCompleteObjects(cleaned.substring(arrayStart));
        return { entries: salvaged, partial: salvaged.length > 0 };
    }

    const objectStart = cleaned.indexOf('{');
    if (objectStart >= 0) {
        const objectEnd = findBalancedJsonEnd(cleaned, objectStart, '{', '}');
        if (objectEnd >= 0) {
            const parsed = JSON.parse(cleaned.substring(objectStart, objectEnd + 1));
            return { entries: Array.isArray(parsed?.entries) ? parsed.entries : [parsed], partial: false };
        }
    }

    return { entries: [], partial: false };
}

/**
 * Chunk messages by character limit, keeping messages whole.
 * @param {Array<{index: number, name: string, text: string}>} messages
 * @param {number} charLimit
 * @returns {Array<Array>}
 */
function chunkMessages(messages, charLimit) {
    if (messages.length === 0) return [];

    const chunks = [];
    let current = [];
    let currentSize = 0;

    for (const msg of messages) {
        const size = msg.name.length + msg.text.length + 10;
        if (current.length > 0 && currentSize + size > charLimit) {
            current.push(msg); // overfill — don't split mid-message
            chunks.push(current);
            current = [];
            currentSize = 0;
        } else {
            current.push(msg);
            currentSize += size;
        }
    }

    if (current.length > 0) chunks.push(current);
    return chunks;
}
