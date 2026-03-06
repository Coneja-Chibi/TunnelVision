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
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { createEntry, findEntryByUid } from './entry-manager.js';
import {
    createEmptyTree,
    createTreeNode,
    addEntryToNode,
    saveTree,
    getAllEntryUids,
    getSettings,
} from './tree-store.js';

const MAX_ENTRIES_PER_NODE = 10;

/** Strip thinking/reasoning blocks from LLM responses. */
const THINK_BLOCK_RE = /<think[\s\S]*?<\/think>/gi;

/** Wrapper around generateRaw that strips thinking blocks from responses. */
async function generateRaw(opts) {
    const result = await _generateRaw(opts);
    return typeof result === 'string' ? result.replace(THINK_BLOCK_RE, '').trim() : result;
}

/**
 * Switch to the configured TV connection profile (if any), run the callback,
 * then restore the original profile. Falls back gracefully if Connection Manager
 * isn't installed or the /profile command isn't available.
 * @param {() => Promise<T>} fn Async function to run with the profile active
 * @returns {Promise<T>}
 * @template T
 */
async function withConnectionProfile(fn) {
    const settings = getSettings();
    const targetProfile = settings.connectionProfile;
    if (!targetProfile) {
        console.log('[TunnelVision] No connection profile configured, using current API.');
        return fn();
    }

    const profileCmd = SlashCommandParser?.commands?.['profile'];
    if (!profileCmd) {
        console.warn('[TunnelVision] /profile command not available (Connection Manager not loaded). Using current API.');
        return fn();
    }

    // Capture the current profile name to restore later
    const originalProfile = await profileCmd.callback({}, '');

    // Skip switching if already on the target profile
    if (originalProfile === targetProfile) {
        return fn();
    }

    try {
        console.log(`[TunnelVision] Switching to connection profile: "${targetProfile}"`);
        await profileCmd.callback({ await: 'true', timeout: '5000' }, targetProfile);
        return await fn();
    } finally {
        await profileCmd.callback({ await: 'true', timeout: '5000' }, originalProfile || '<None>');
    }
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
    return withConnectionProfile(() => _buildTreeWithLLM(lorebookName, options));
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
    const totalSteps = chunks.length + 2; // chunks + subdivide + summaries
    let currentStep = 0;
    console.log(`[TunnelVision] Categorizing ${activeEntries.length} entries in ${chunks.length} chunk(s) (limit: ${chunkLimit} chars)`);

    // First chunk: fresh categorization
    currentStep++;
    const chunkPct = (i) => Math.round((i / chunks.length) * 60); // 0-60% for chunking
    progress(`Categorizing chunk 1/${chunks.length}`, chunkPct(0));
    detail_(`${activeEntries.length} entries across ${chunks.length} chunk(s)`);
    const firstPrompt = buildCategorizationPrompt(lorebookName, chunks[0]);
    const firstResponse = await generateRaw({
        prompt: firstPrompt,
        systemPrompt: 'You are a categorization assistant. Respond ONLY with valid JSON, no commentary.',
    });
    if (!firstResponse) throw new Error('LLM returned empty response for tree categorization.');

    const allUids = activeEntries.map(e => e.uid);
    const tree = await parseLLMTreeResponse(lorebookName, firstResponse, allUids);

    // Subsequent chunks: merge into existing categories
    for (let i = 1; i < chunks.length; i++) {
        currentStep++;
        progress(`Categorizing chunk ${i + 1}/${chunks.length}`, chunkPct(i));
        const existingCategories = extractCategoryLabels(tree.root);
        const contPrompt = buildContinuationPrompt(lorebookName, chunks[i], existingCategories);
        try {
            const contResponse = await generateRaw({
                prompt: contPrompt,
                systemPrompt: 'You are a categorization assistant. Respond ONLY with valid JSON, no commentary.',
            });
            if (contResponse) {
                mergeLLMResponse(tree, contResponse, allUids);
            }
        } catch (e) {
            console.warn(`[TunnelVision] Chunk ${i + 1}/${chunks.length} categorization failed:`, e);
        }
    }

    // Assign any still-unassigned UIDs to root
    const assigned = new Set(getAllEntryUids(tree.root));
    for (const uid of allUids) {
        if (!assigned.has(uid)) addEntryToNode(tree.root, uid);
    }

    // Save intermediate tree so chunking work isn't lost if subdivision/summaries abort
    tree.lastBuilt = Date.now();
    saveTree(lorebookName, tree);
    console.log('[TunnelVision] Chunked categorization complete, saved intermediate tree.');

    // PageIndex pattern: recursively subdivide large nodes
    currentStep++;
    progress('Subdividing large nodes…', 65);
    detail_('Splitting categories with 10+ entries into sub-categories');
    await subdivideLargeNodes(tree.root, lorebookName);
    saveTree(lorebookName, tree);

    // PageIndex pattern: generate per-node summaries from actual content
    currentStep++;
    progress('Generating summaries…', 80);
    detail_('LLM writing descriptions for each category');
    await _generateSummariesForTree(tree.root, lorebookName);

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
        labels.push(child.label);
        for (const sub of (child.children || [])) {
            labels.push(`${child.label} > ${sub.label}`);
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
function buildContinuationPrompt(lorebookName, entries, existingCategories) {
    const detail = getSettings().llmBuildDetail || 'full';
    const entryList = entries.map(e => `  - ${formatEntryForLLM(e, detail)}`).join('\n');
    const catList = existingCategories.map(c => `  - ${c}`).join('\n');

    return `You are continuing to organize a lorebook called "${lorebookName}". Previous entries have already been categorized.

Existing categories:
${catList}

Here are the NEW entries to categorize:
${entryList}

Assign each entry to an existing category, or create new categories if none fit. Every entry UID must appear exactly once.

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
            const existingNode = labelMap.get(catLabel);
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
                    const existingSub = labelMap.get(subLabel);
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
        return withConnectionProfile(() => _generateSummariesForTree(node, lorebookName, true));
    }
    return _generateSummariesForTree(node, lorebookName, _isRoot);
}

async function _generateSummariesForTree(node, lorebookName, _isRoot = true) {
    const bookData = await loadWorldInfo(lorebookName);
    if (!bookData || !bookData.entries) return;

    const settings = getSettings();
    const detail = settings.llmBuildDetail || 'full';

    // Skip root node — it's just a container, not a real category
    if (!_isRoot) {
        const allUids = getAllEntryUids(node);
        if (allUids.length > 0) {
            const entryTexts = [];
            for (const uid of allUids.slice(0, 15)) {
                const entry = findEntryByUid(bookData.entries, uid);
                if (entry) {
                    entryTexts.push(`- ${formatEntryForLLM(entry, detail, { includeUid: false, contentLimit: 200 })}`);
                }
            }

            if (entryTexts.length > 0) {
                try {
                    const summary = await generateRaw({
                        prompt: `Entries from lorebook category "${node.label}":\n${entryTexts.join('\n')}\n\nWrite a brief 1-2 sentence description of what topics and information these entries cover. Return ONLY the description.`,
                        systemPrompt: 'You are a summarization assistant. Return only the requested description, no commentary.',
                    });
                    if (summary) node.summary = summary.trim();
                } catch (e) {
                    console.warn(`[TunnelVision] Summary generation failed for "${node.label}":`, e);
                }
            }
        }
    }

    for (const child of node.children) {
        await _generateSummariesForTree(child, lorebookName, false);
    }

    // After all children are summarized, generate a book-level summary for the root
    if (_isRoot && node.children.length > 0) {
        await generateBookSummary(node, lorebookName);
    }
}

/**
 * Generate a book-level summary from top-level category labels and summaries.
 * Stored on the root node's summary field. Only overwrites if no user description is set.
 */
async function generateBookSummary(rootNode, lorebookName) {
    // Don't overwrite user-set description
    const { getBookDescription } = await import('./tree-store.js');
    if (getBookDescription(lorebookName)) return;

    const categoryList = rootNode.children
        .map(c => c.summary ? `- ${c.label}: ${c.summary}` : `- ${c.label}`)
        .join('\n');

    if (!categoryList) return;

    try {
        const totalEntries = getAllEntryUids(rootNode).length;
        const summary = await generateRaw({
            prompt: `This lorebook "${lorebookName}" has ${totalEntries} entries organized into these categories:\n${categoryList}\n\nWrite a brief 1-2 sentence description of what this lorebook contains overall — what kind of information does it store? Return ONLY the description.`,
            systemPrompt: 'You are a summarization assistant. Return only the requested description, no commentary.',
        });
        if (summary) {
            rootNode.summary = summary.trim();
            console.log(`[TunnelVision] Generated book summary for "${lorebookName}": ${rootNode.summary}`);
        }
    } catch (e) {
        console.warn(`[TunnelVision] Book summary generation failed for "${lorebookName}":`, e);
    }
}

/**
 * Recursively subdivide nodes with too many entries.
 * Mirrors PageIndex's process_large_node_recursively().
 */
async function subdivideLargeNodes(node, lorebookName) {
    const bookData = await loadWorldInfo(lorebookName);
    if (!bookData || !bookData.entries) return;

    if (node.entryUids.length > MAX_ENTRIES_PER_NODE && node.children.length === 0) {
        const detail = getSettings().llmBuildDetail || 'full';
        const nodeEntries = node.entryUids.map(uid => findEntryByUid(bookData.entries, uid)).filter(Boolean);

        if (nodeEntries.length > MAX_ENTRIES_PER_NODE) {
            try {
                const entryList = nodeEntries.map(e => `  ${formatEntryForLLM(e, detail)}`).join('\n');
                const response = await generateRaw({
                    prompt: `You have ${nodeEntries.length} lorebook entries in "${node.label}". Split into 2-4 sub-categories.\n\nEntries:\n${entryList}\n\nRespond ONLY with JSON: { "subcategories": [{ "label": "Name", "entries": [uid1, uid2] }] }`,
                    systemPrompt: 'You are a categorization assistant. Respond ONLY with valid JSON, no commentary.',
                });
                if (response) {
                    const jsonMatch = response.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        const parsed = JSON.parse(jsonMatch[0]);
                        if (parsed.subcategories && Array.isArray(parsed.subcategories)) {
                            const assigned = new Set();
                            for (const sub of parsed.subcategories) {
                                const child = createTreeNode(sub.label || 'Unnamed', '');
                                if (Array.isArray(sub.entries)) {
                                    for (const uid of sub.entries) {
                                        const n = Number(uid);
                                        if (node.entryUids.includes(n) && !assigned.has(n)) {
                                            addEntryToNode(child, n);
                                            assigned.add(n);
                                        }
                                    }
                                }
                                if (child.entryUids.length > 0) node.children.push(child);
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

    for (const child of node.children) {
        await subdivideLargeNodes(child, lorebookName);
    }
}

function buildCategorizationPrompt(lorebookName, entries) {
    const detail = getSettings().llmBuildDetail || 'full';
    const entryList = entries.map(e => `  - ${formatEntryForLLM(e, detail)}`).join('\n');

    return `You are organizing a lorebook called "${lorebookName}" into a hierarchical tree for efficient retrieval.

Here are the entries:
${entryList}

Create a JSON hierarchy that groups these entries into logical categories. Use 2-4 top-level categories, each with optional sub-categories. Every entry UID must appear exactly once.

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
                parent.children.push(node);
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
    return withConnectionProfile(() => _ingestChatMessages(lorebookName, options));
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
                prompt: buildIngestPrompt(lorebookName, formatted),
                systemPrompt: 'You are a fact extraction assistant. Extract important facts, character details, relationships, events, and world information from roleplay chat logs. Respond ONLY with valid JSON, no commentary.',
            });
        } catch (e) {
            console.error(`[TunnelVision] Ingest chunk ${i + 1} LLM call failed:`, e);
            totalErrors++;
            continue;
        }

        if (!response) continue;

        // Parse JSON response
        let entries;
        try {
            const jsonMatch = response.match(/\[[\s\S]*\]/);
            if (!jsonMatch) {
                const objMatch = response.match(/\{[\s\S]*\}/);
                if (objMatch) {
                    const parsed = JSON.parse(objMatch[0]);
                    entries = parsed.entries || [parsed];
                } else {
                    throw new Error('No JSON found in response');
                }
            } else {
                entries = JSON.parse(jsonMatch[0]);
            }
        } catch (e) {
            console.warn(`[TunnelVision] Ingest chunk ${i + 1} JSON parse failed:`, e, response);
            totalErrors++;
            continue;
        }

        if (!Array.isArray(entries)) continue;

        // Create entries
        for (const extracted of entries) {
            if (!extracted.title || !extracted.content) continue;
            try {
                await createEntry(lorebookName, {
                    content: String(extracted.content).trim(),
                    comment: String(extracted.title).trim(),
                    keys: Array.isArray(extracted.keys) ? extracted.keys : [],
                    nodeId: null,
                });
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

function buildIngestPrompt(lorebookName, chatText) {
    return `Extract important facts from this roleplay chat log for the lorebook "${lorebookName}".

For each distinct fact, character detail, relationship, event, or world detail, create an entry.

Chat log:
${chatText}

Respond with ONLY a JSON array:
[
  {
    "title": "Short descriptive title",
    "content": "The factual information written in third person. Include names, places, details.",
    "keys": ["keyword1", "keyword2"]
  }
]

Rules:
- Extract ONLY concrete facts, not dialogue or opinions
- Write content in third person, factual style
- Each entry should be a single, distinct piece of information
- Include character names in keys for cross-referencing
- Skip trivial or generic information
- Merge related facts into single entries when they belong together`;
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
