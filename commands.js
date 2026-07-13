/**
 * TunnelVision Slash Commands
 * Registers /tv-* slash commands for forcing tool actions.
 *
 * Commands use generateAnalytical() for LLM reasoning, then call entry-manager
 * functions directly for CRUD. No generateQuietPrompt — no hoping the chat model
 * decides to call a tool.
 *
 * Commands:
 *   /tv-search [query]     — Search lorebook entries
 *   /tv-remember [content] — Save content to memory
 *   /tv-summarize [title]  — Create a scene summary
 *   /tv-forget [name]      — Forget/disable an entry
 *   /tv-merge [hint]       — Merge two specific related entries
 *   /tv-split [hint]       — Split a multi-topic entry
 *   /tv-dedupe [lorebook]  — Batch-merge all duplicate clusters
 *   /tv-ingest [lorebook]  — Ingest recent chat messages (no generation)
 *
 * Settings consumed (from tree-store.js getSettings()):
 *   commandContextMessages number   default 50
 */

import { getContext } from '../../../st-context.js';
import { loadWorldInfo } from '../../../world-info.js';
import { canReadBook, canWriteBook, getSettings, getSelectedLorebook, getTree, createTreeNode, saveTree, findNodeById, consolidateSiblingNodes } from './tree-store.js';
import { getActiveTunnelVisionBooks, resolveTargetBook } from './tool-registry.js';
import { ingestChatMessages } from './tree-builder.js';
import { createEntry, mergeEntries, splitEntry, forgetEntry, updateEntry, findEntryByUid } from './entry-manager.js';
import { generateAnalytical, getStoryContext, trigramSimilarity } from './agent-utils.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let _initialized = false;

/**
 * Register all /tv-* slash commands.
 * Safe to call multiple times — idempotency guard prevents duplicate registration.
 */
export function initCommands() {
    if (_initialized) return;
    _initialized = true;

    registerSlashCommands();
}

// ---------------------------------------------------------------------------
// Slash command registration
// ---------------------------------------------------------------------------

function registerSlashCommands() {
    const registerSlashCommand = getContext()?.registerSlashCommand;
    if (typeof registerSlashCommand !== 'function') {
        console.error('[TunnelVision] Slash command API is unavailable; /tv-* commands were not registered');
        return;
    }

    registerSlashCommand('tv-search', wrapCallback(handleSearch), [], 'Search TunnelVision lorebook entries.');
    registerSlashCommand('tv-remember', wrapCallback(handleRemember), [], 'Save content to TunnelVision memory.');
    registerSlashCommand('tv-summarize', wrapCallback(handleSummarize), [], 'Create a TunnelVision scene summary from recent chat.');
    registerSlashCommand('tv-forget', wrapCallback(handleForget), [], 'Forget/disable a TunnelVision lorebook entry.');
    registerSlashCommand('tv-merge', wrapCallback(handleMerge), [], 'Merge duplicate/related TunnelVision lorebook entries.');
    registerSlashCommand('tv-split', wrapCallback(handleSplit), [], 'Split a multi-topic TunnelVision lorebook entry into focused pieces.');
    registerSlashCommand('tv-dedupe', wrapCallback(handleDedupe), [], 'Batch-merge all duplicate/near-duplicate entries in a TunnelVision lorebook.');
    registerSlashCommand('tv-ingest', wrapCallback(handleIngestCommand), [], 'Ingest recent chat messages into a TunnelVision lorebook.');
}

// ---------------------------------------------------------------------------
// Callback wrapper — shared precondition checks + error handling
// ---------------------------------------------------------------------------

function wrapCallback(handler) {
    return async function (namedArgs, unnamedArg) {
        try {
            const settings = getSettings();
            if (settings.globalEnabled === false) {
                toastr.warning('TunnelVision is disabled.', 'TunnelVision');
                return '';
            }

            const activeBooks = getActiveTunnelVisionBooks();
            if (activeBooks.length === 0) {
                toastr.warning('No active TunnelVision lorebooks.', 'TunnelVision');
                return '';
            }

            await handler(namedArgs, unnamedArg, { settings, activeBooks });
        } catch (err) {
            console.error('[TunnelVision] Slash command failed:', err);
            toastr.error(`Command failed: ${err.message}`, 'TunnelVision');
        }
        return '';
    };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolveCurrentLorebook(activeBooks) {
    const selectedLorebook = getSelectedLorebook();
    if (selectedLorebook && activeBooks.includes(selectedLorebook)) {
        return selectedLorebook;
    }
    return activeBooks.length === 1 ? activeBooks[0] : null;
}

function resolveBook(activeBooks) {
    const name = resolveCurrentLorebook(activeBooks);
    if (!name && activeBooks.length > 1) {
        toastr.warning('Multiple lorebooks active — select one in TunnelVision settings first.', 'TunnelVision');
        return null;
    }
    return name || activeBooks[0];
}

function resolveAccessibleBook(activeBooks, access, action) {
    const candidateBooks = access === 'read'
        ? activeBooks.filter(canReadBook)
        : access === 'readwrite'
            ? activeBooks.filter((book) => canReadBook(book) && canWriteBook(book))
        : access === 'write'
            ? activeBooks.filter(canWriteBook)
            : activeBooks;
    if (candidateBooks.length === 0) {
        const label = access === 'read' ? 'readable' : access === 'write' ? 'writable' : access === 'readwrite' ? 'readable and writable' : 'active';
        toastr.warning(`No ${label} TunnelVision lorebooks available for /tv-${action}.`, 'TunnelVision');
        return null;
    }

    const selectedLorebook = getSelectedLorebook();
    if (selectedLorebook && candidateBooks.includes(selectedLorebook)) {
        return selectedLorebook;
    }
    if (candidateBooks.length > 1) {
        toastr.warning('Multiple eligible lorebooks active - select one in TunnelVision settings first.', 'TunnelVision');
        return null;
    }
    return candidateBooks[0];
}

function getContextMessages() {
    const settings = getSettings();
    return Number(settings.commandContextMessages) || 50;
}

/**
 * Build a compact entry listing from a lorebook for LLM consumption.
 * @returns {Promise<string>} Formatted entry list, or empty string
 */
async function buildEntryListing(bookName) {
    if (!canReadBook(bookName)) return '';
    const bookData = await loadWorldInfo(bookName);
    if (!bookData?.entries) return '';

    const lines = [];
    for (const entry of Object.values(bookData.entries)) {
        if (entry.disable) continue;
        const title = (entry.comment || '').trim() || `Entry #${entry.uid}`;
        const preview = (entry.content || '').substring(0, 120).replace(/\n/g, ' ');
        lines.push(`- UID ${entry.uid}: "${title}" — ${preview}`);
    }
    return lines.join('\n');
}

/**
 * Get recent chat as a compact text block for LLM context.
 */
function getRecentChat(messageCount) {
    try {
        const context = getContext();
        const chat = context?.chat;
        if (!chat || chat.length === 0) return '';

        const start = Math.max(0, chat.length - messageCount);
        const lines = [];
        for (let i = start; i < chat.length; i++) {
            const msg = chat[i];
            if (msg.is_system) continue;
            const name = msg.is_user ? (context.name1 || 'User') : (msg.name || context.name2 || 'AI');
            const text = (msg.mes || '').substring(0, 300);
            lines.push(`${name}: ${text}`);
        }
        return lines.join('\n');
    } catch {
        return '';
    }
}

/**
 * Parse JSON from an LLM response, handling markdown fences.
 */
function parseJSON(text) {
    if (!text) return null;
    // Strip markdown code fences
    const stripped = text.replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim();
    try {
        return JSON.parse(stripped);
    } catch {
        // Try to find the first { or [ and parse from there
        const start = stripped.search(/[{[]/);
        if (start >= 0) {
            try { return JSON.parse(stripped.substring(start)); } catch { /* fall through */ }
        }
        return null;
    }
}

// ---------------------------------------------------------------------------
// Command handlers — generateAnalytical for reasoning, direct CRUD for action
// ---------------------------------------------------------------------------

async function handleSearch(_namedArgs, unnamedArg, { activeBooks }) {
    const bookName = resolveAccessibleBook(activeBooks, 'read', 'search');
    if (!bookName) return;

    const query = String(unnamedArg || '').trim();
    if (!query) {
        toastr.warning('Usage: /tv-search <query>', 'TunnelVision');
        return;
    }

    const entryList = await buildEntryListing(bookName);
    if (!entryList) {
        toastr.warning(`No entries found in "${bookName}".`, 'TunnelVision');
        return;
    }

    toastr.info('Searching...', 'TunnelVision');

    const prompt = `Search this lorebook for entries relevant to: "${query}"

ENTRIES IN "${bookName}":
${entryList}

Return JSON: { "results": [{ "uid": <number>, "title": "<string>", "relevance": "<why this matches>" }] }
Return only the most relevant entries (max 10). If nothing matches, return { "results": [] }.`;

    const response = await generateAnalytical({ prompt });
    const parsed = parseJSON(response);

    if (!parsed?.results?.length) {
        toastr.info('No matching entries found.', 'TunnelVision');
        return;
    }

    // Display results
    const bookData = await loadWorldInfo(bookName);
    const resultLines = [];
    for (const r of parsed.results) {
        const entry = bookData?.entries ? findEntryByUid(bookData.entries, r.uid) : null;
        if (entry) {
            resultLines.push(`**${entry.comment || 'Untitled'}** (UID ${r.uid}): ${(entry.content || '').substring(0, 200)}`);
        }
    }

    if (resultLines.length > 0) {
        toastr.success(`Found ${resultLines.length} matching entries.`, 'TunnelVision');
        console.log(`[TunnelVision] /tv-search results for "${query}":\n${resultLines.join('\n')}`);
    } else {
        toastr.info('Search returned UIDs that could not be resolved.', 'TunnelVision');
    }
}

async function handleRemember(_namedArgs, unnamedArg, { activeBooks }) {
    const bookName = resolveAccessibleBook(activeBooks, 'write', 'remember');
    if (!bookName) return;

    const hint = String(unnamedArg || '').trim();
    if (!hint) {
        toastr.warning('Usage: /tv-remember <what to remember>', 'TunnelVision');
        return;
    }

    const { book: lorebook, error } = resolveTargetBook(bookName, { checkWrite: true });
    if (error) {
        toastr.error(error, 'TunnelVision');
        return;
    }

    const isSchemaRequest = /\b(design|schema|track(er|ing)?|template|format|struct(ure)?)\b/i.test(hint);
    const messageCount = getContextMessages();
    const recentChat = getRecentChat(messageCount);
    const storyCtx = getStoryContext();
    const contextBlock = [storyCtx, recentChat].filter(Boolean).join('\n\n');

    toastr.info(isSchemaRequest ? 'Designing tracker schema...' : 'Creating memory entry...', 'TunnelVision');

    const schemaInstructions = isSchemaRequest
        ? `\nThe user wants a TRACKER — a structured schema for tracking state that changes over time.
Design a well-structured format using headers, bullet points, and key:value pairs.
Include placeholder values that demonstrate the format. Prefix the title with "[Tracker]".`
        : '';

    const prompt = `${contextBlock ? contextBlock + '\n\n' : ''}The user wants to remember: "${hint}"
${schemaInstructions}
Based on the conversation above, create a lorebook entry that captures this information.
Write in third person, factual style. Include relevant names, places, and details from the conversation.

Return JSON:
{
  "title": "<short descriptive title for the entry>",
  "content": "<well-written third-person factual entry content>",
  "keys": ["<keyword1>", "<keyword2>"]
}`;

    const response = await generateAnalytical({ prompt });
    const parsed = parseJSON(response);

    if (!parsed?.title || !parsed?.content) {
        toastr.error('Failed to create entry — could not parse LLM response.', 'TunnelVision');
        return;
    }

    try {
        const result = await createEntry(lorebook, {
            content: parsed.content,
            comment: parsed.title,
            keys: Array.isArray(parsed.keys) ? parsed.keys : [],
        });
        toastr.success(`Saved: "${result.comment}" (UID ${result.uid})`, 'TunnelVision');
    } catch (e) {
        toastr.error(`Failed to save: ${e.message}`, 'TunnelVision');
    }
}

async function handleSummarize(_namedArgs, unnamedArg, { activeBooks }) {
    const bookName = resolveAccessibleBook(activeBooks, 'write', 'summarize');
    if (!bookName) return;

    const { book: lorebook, error } = resolveTargetBook(bookName, { checkWrite: true });
    if (error) {
        toastr.error(error, 'TunnelVision');
        return;
    }

    const titleHint = String(unnamedArg || '').trim() || 'Recent events';
    const messageCount = getContextMessages();
    const recentChat = getRecentChat(messageCount);

    if (!recentChat) {
        toastr.warning('No chat messages to summarize.', 'TunnelVision');
        return;
    }

    toastr.info('Creating summary...', 'TunnelVision');

    const storyCtx = getStoryContext();
    const prompt = `${storyCtx ? storyCtx + '\n\n' : ''}Summarize the following conversation for a creative writing lorebook.
Write in third person, past tense, capturing key actions, decisions, emotional beats, and plot developments.

Topic/title hint: "${titleHint}"

RECENT CONVERSATION:
${recentChat}

Return JSON:
{
  "title": "[Summary] <concise descriptive title>",
  "summary": "<thorough third-person past-tense summary>",
  "significance": "minor|moderate|major|critical"
}`;

    const response = await generateAnalytical({ prompt });
    const parsed = parseJSON(response);

    if (!parsed?.title || !parsed?.summary) {
        toastr.error('Failed to create summary — could not parse LLM response.', 'TunnelVision');
        return;
    }

    try {
        const sig = parsed.significance || 'moderate';
        const content = `[Scene Summary — ${sig}]\n\n${parsed.summary.trim()}`;
        const result = await createEntry(lorebook, {
            content,
            comment: parsed.title,
            keys: [],
        });
        toastr.success(`Summary saved: "${result.comment}" (UID ${result.uid})`, 'TunnelVision');
    } catch (e) {
        toastr.error(`Failed to save summary: ${e.message}`, 'TunnelVision');
    }
}

async function handleForget(_namedArgs, unnamedArg, { activeBooks }) {
    const bookName = resolveAccessibleBook(activeBooks, 'readwrite', 'forget');
    if (!bookName) return;

    const target = String(unnamedArg || '').trim();
    if (!target) {
        toastr.warning('Usage: /tv-forget <entry name or UID>', 'TunnelVision');
        return;
    }

    // If the user gave a numeric UID, use it directly
    const directUid = parseInt(target, 10);
    if (!isNaN(directUid) && String(directUid) === target) {
        toastr.info(`Forgetting entry UID ${directUid}...`, 'TunnelVision');
        try {
            const result = await forgetEntry(bookName, directUid);
            toastr.success(`Forgotten: "${result.comment}" (${result.action})`, 'TunnelVision');
        } catch (e) {
            toastr.error(`Failed to forget: ${e.message}`, 'TunnelVision');
        }
        return;
    }

    // Otherwise, ask the LLM to identify the entry by name
    const entryList = await buildEntryListing(bookName);
    if (!entryList) {
        toastr.warning(`No entries found in "${bookName}".`, 'TunnelVision');
        return;
    }

    toastr.info('Identifying entry to forget...', 'TunnelVision');

    const prompt = `The user wants to forget/remove this entry from their lorebook: "${target}"

ENTRIES IN "${bookName}":
${entryList}

Which entry best matches their request? Return JSON: { "uid": <number>, "title": "<entry title>", "reason": "<why this matches>" }
If no entry matches, return { "uid": null, "reason": "No matching entry found" }.`;

    const response = await generateAnalytical({ prompt });
    const parsed = parseJSON(response);

    if (!parsed?.uid) {
        toastr.warning(`Could not identify an entry matching "${target}".`, 'TunnelVision');
        return;
    }

    try {
        const result = await forgetEntry(bookName, parsed.uid);
        toastr.success(`Forgotten: "${result.comment}" (UID ${parsed.uid}, ${result.action})`, 'TunnelVision');
    } catch (e) {
        toastr.error(`Failed to forget UID ${parsed.uid}: ${e.message}`, 'TunnelVision');
    }
}

async function handleMerge(_namedArgs, unnamedArg, { activeBooks }) {
    const bookName = resolveAccessibleBook(activeBooks, 'readwrite', 'merge');
    if (!bookName) return;

    const hint = String(unnamedArg || '').trim();
    const entryList = await buildEntryListing(bookName);
    if (!entryList) {
        toastr.warning(`No entries found in "${bookName}".`, 'TunnelVision');
        return;
    }

    toastr.info('Identifying entries to merge...', 'TunnelVision');

    const hintClause = hint
        ? `The user specifically wants to merge entries related to: "${hint}"`
        : 'Find the two most similar/overlapping entries that should be consolidated.';

    const prompt = `${hintClause}

ENTRIES IN "${bookName}":
${entryList}

Identify two entries that cover the same topic and should be merged into one.
Pick the entry with the better content as "keep_uid" and the redundant one as "remove_uid".
Write clean, consolidated merged content that combines the best of both.

Return JSON:
{
  "keep_uid": <number>,
  "remove_uid": <number>,
  "merged_title": "<clean title for the merged entry>",
  "merged_content": "<consolidated content combining both entries>",
  "reason": "<why these should be merged>"
}
If no entries should be merged, return { "keep_uid": null, "reason": "No duplicate entries found" }.`;

    const response = await generateAnalytical({ prompt });
    const parsed = parseJSON(response);

    if (!parsed?.keep_uid || !parsed?.remove_uid) {
        toastr.info(parsed?.reason || 'No entries identified for merging.', 'TunnelVision');
        return;
    }

    try {
        const result = await mergeEntries(bookName, parsed.keep_uid, parsed.remove_uid, {
            mergedContent: parsed.merged_content,
            mergedTitle: parsed.merged_title,
        });
        toastr.success(
            `Merged: "${result.removedComment}" (UID ${result.removedUid}) → "${result.comment}" (UID ${result.uid})`,
            'TunnelVision',
        );
    } catch (e) {
        toastr.error(`Merge failed: ${e.message}`, 'TunnelVision');
    }
}

async function handleSplit(_namedArgs, unnamedArg, { activeBooks }) {
    const bookName = resolveAccessibleBook(activeBooks, 'readwrite', 'split');
    if (!bookName) return;

    const hint = String(unnamedArg || '').trim();
    const entryList = await buildEntryListing(bookName);
    if (!entryList) {
        toastr.warning(`No entries found in "${bookName}".`, 'TunnelVision');
        return;
    }

    // If user gave a UID, target that entry specifically
    const directUid = parseInt(hint, 10);
    let targetEntry = null;
    if (!isNaN(directUid) && String(directUid) === hint) {
        const bookData = await loadWorldInfo(bookName);
        targetEntry = bookData?.entries ? findEntryByUid(bookData.entries, directUid) : null;
    }

    toastr.info('Analyzing entry for split...', 'TunnelVision');

    const targetClause = targetEntry
        ? `Split this specific entry (UID ${directUid}, "${targetEntry.comment || ''}"):\n${targetEntry.content}`
        : hint
            ? `The user wants to split an entry related to: "${hint}"\n\nENTRIES IN "${bookName}":\n${entryList}`
            : `Find the entry that covers too many topics and should be split.\n\nENTRIES IN "${bookName}":\n${entryList}`;

    const prompt = `${targetClause}

Identify one entry that covers multiple distinct topics and split it into two focused entries.

Return JSON:
{
  "uid": <number>,
  "keep_content": "<content that stays in the original entry>",
  "keep_title": "<updated title for the original entry>",
  "new_content": "<content for the new split-off entry>",
  "new_title": "<title for the new entry>",
  "reason": "<why this split improves organization>"
}
If no entry needs splitting, return { "uid": null, "reason": "No entries need splitting" }.`;

    const response = await generateAnalytical({ prompt });
    const parsed = parseJSON(response);

    if (!parsed?.uid) {
        toastr.info(parsed?.reason || 'No entries identified for splitting.', 'TunnelVision');
        return;
    }

    try {
        const result = await splitEntry(bookName, parsed.uid, {
            keepContent: parsed.keep_content,
            keepTitle: parsed.keep_title,
            newContent: parsed.new_content,
            newTitle: parsed.new_title,
        });
        toastr.success(
            `Split: "${result.originalTitle}" → kept + new "${result.newTitle}" (UID ${result.newUid})`,
            'TunnelVision',
        );
    } catch (e) {
        toastr.error(`Split failed: ${e.message}`, 'TunnelVision');
    }
}

// ---------------------------------------------------------------------------
// Dedupe handler — batch-merge all duplicate clusters
// ---------------------------------------------------------------------------

const DEDUPE_SIMILARITY_THRESHOLD = 0.55;
const DEDUPE_MAX_CLUSTERS_PER_BATCH = 8;

/**
 * Find duplicate clusters using trigram similarity on content+title,
 * or title-only similarity (matching diagnostics' detection logic).
 * Returns groups of 2+ entries that are near-duplicates of each other.
 */
function findDuplicateClusters(entries, threshold) {
    // Union-Find for clustering
    const parent = new Map();
    function find(uid) {
        if (!parent.has(uid)) parent.set(uid, uid);
        if (parent.get(uid) !== uid) parent.set(uid, find(parent.get(uid)));
        return parent.get(uid);
    }
    function union(a, b) {
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent.set(ra, rb);
    }

    function titlesMatch(a, b) {
        const na = a.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
        const nb = b.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
        if (na === nb) return true;
        if (na.length > 3 && nb.length > 3 && (na.includes(nb) || nb.includes(na))) {
            return Math.min(na.length, nb.length) / Math.max(na.length, nb.length) > 0.5;
        }
        const wordsA = na.split(' ').filter(w => w.length > 2);
        const wordsB = nb.split(' ').filter(w => w.length > 2);
        const [shorter, longer] = wordsA.length <= wordsB.length
            ? [wordsA, new Set(wordsB)] : [wordsB, new Set(wordsA)];
        if (shorter.length >= 2) {
            const overlap = shorter.filter(w => longer.has(w)).length;
            return overlap / shorter.length >= 0.8;
        }
        return false;
    }

    // Compare all pairs — cluster if title matches OR full-text trigram similarity meets threshold
    for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
            const textA = `${entries[i].title} ${entries[i].content}`.toLowerCase();
            const textB = `${entries[j].title} ${entries[j].content}`.toLowerCase();
            if (titlesMatch(entries[i].title, entries[j].title) || trigramSimilarity(textA, textB) >= threshold) {
                union(entries[i].uid, entries[j].uid);
            }
        }
    }

    // Group by cluster root
    const clusters = new Map();
    for (const entry of entries) {
        const root = find(entry.uid);
        if (!clusters.has(root)) clusters.set(root, []);
        clusters.get(root).push(entry);
    }

    // Only return clusters with 2+ entries
    return [...clusters.values()].filter(c => c.length >= 2);
}

/**
 * Find or create a "Deduped" node under root for parking merged-away entries.
 */
function getOrCreateDedupedNode(bookName) {
    const tree = getTree(bookName);
    if (!tree?.root) return null;

    // Look for existing Deduped node
    for (const child of (tree.root.children || [])) {
        if (child.label === 'Deduped') return { node: child, tree };
    }

    // Create one — hidden from AI traversal
    const node = createTreeNode('Deduped', 'Entries absorbed during deduplication. Safe to delete.');
    node.hidden = true;
    tree.root.children = tree.root.children || [];
    tree.root.children.push(node);
    saveTree(bookName, tree);
    return { node, tree };
}

async function handleDedupe(_namedArgs, unnamedArg, { activeBooks }) {
    const requested = String(unnamedArg || '').trim();
    let bookName;

    if (requested) {
        bookName = activeBooks.find(b => b.toLowerCase() === requested.toLowerCase());
        if (!bookName) {
            toastr.warning(`Lorebook "${requested}" not found among active books.`, 'TunnelVision');
            return;
        }
        if (!canReadBook(bookName) || !canWriteBook(bookName)) {
            toastr.warning(`Lorebook "${bookName}" must be readable and writable for dedupe.`, 'TunnelVision');
            return;
        }
    } else {
        bookName = resolveAccessibleBook(activeBooks, 'readwrite', 'dedupe');
    }
    if (!bookName) return;

    // Load all active entries
    const bookData = await loadWorldInfo(bookName);
    if (!bookData?.entries) {
        toastr.warning(`No entries in "${bookName}".`, 'TunnelVision');
        return;
    }

    const allEntries = [];
    for (const entry of Object.values(bookData.entries)) {
        if (entry.disable) continue;
        allEntries.push({
            uid: entry.uid,
            title: (entry.comment || '').trim() || `Entry #${entry.uid}`,
            content: (entry.content || '').trim(),
        });
    }

    if (allEntries.length < 2) {
        toastr.info('Not enough entries to deduplicate.', 'TunnelVision');
        return;
    }

    toastr.info(`Scanning ${allEntries.length} entries for duplicates...`, 'TunnelVision');

    const threshold = getSettings().vectorDedupThreshold || DEDUPE_SIMILARITY_THRESHOLD;
    const clusters = findDuplicateClusters(allEntries, threshold);

    if (clusters.length === 0) {
        toastr.success('No duplicate clusters found — lorebook is clean.', 'TunnelVision');
        return;
    }

    const totalDupes = clusters.reduce((sum, c) => sum + c.length, 0);
    toastr.info(
        `Found ${clusters.length} duplicate cluster(s) (${totalDupes} entries total). Merging...`,
        'TunnelVision',
    );

    let mergedCount = 0;
    let errorCount = 0;

    // Process in batches to avoid overwhelming the LLM
    for (let batchStart = 0; batchStart < clusters.length; batchStart += DEDUPE_MAX_CLUSTERS_PER_BATCH) {
        const batch = clusters.slice(batchStart, batchStart + DEDUPE_MAX_CLUSTERS_PER_BATCH);

        // Build prompt for this batch
        const clusterDescriptions = batch.map((cluster, idx) => {
            const entryLines = cluster.map(e => {
                const preview = e.content.substring(0, 200).replace(/\n/g, ' ');
                return `  - UID ${e.uid}: "${e.title}" — ${preview}`;
            }).join('\n');
            return `CLUSTER ${idx + 1} (${cluster.length} entries):\n${entryLines}`;
        }).join('\n\n');

        const prompt = `You are deduplicating a lorebook. For each cluster below, all entries cover the same topic.
Pick the ONE best entry to keep (keep_uid) and write clean consolidated content that combines the best information from all entries in the cluster.

${clusterDescriptions}

Return JSON — an array with one object per cluster:
[
  {
    "cluster": 1,
    "keep_uid": <number>,
    "remove_uids": [<numbers of all OTHER entries to absorb>],
    "merged_title": "<clean consolidated title>",
    "merged_content": "<consolidated content combining the best of all entries>"
  }
]`;

        let parsed;
        try {
            const response = await generateAnalytical({ prompt });
            parsed = parseJSON(response);
        } catch (e) {
            console.error('[TunnelVision] /tv-dedupe LLM batch failed:', e);
            toastr.warning(`Batch ${batchStart + 1} LLM call failed: ${e.message}`, 'TunnelVision');
            errorCount += batch.length;
            continue;
        }

        if (!Array.isArray(parsed)) {
            console.warn('[TunnelVision] /tv-dedupe: LLM did not return an array, skipping batch');
            errorCount += batch.length;
            continue;
        }

        // Execute merges for this batch
        for (const instruction of parsed) {
            if (!instruction?.keep_uid || !Array.isArray(instruction.remove_uids)) continue;

            for (const removeUid of instruction.remove_uids) {
                try {
                    await mergeEntries(bookName, instruction.keep_uid, removeUid, {
                        mergedContent: instruction.merged_content,
                        mergedTitle: instruction.merged_title,
                    });
                    mergedCount++;

                    // Move the disabled entry to Deduped node
                    const dedupResult = getOrCreateDedupedNode(bookName);
                    if (dedupResult) {
                        const { node: dedupNode, tree } = dedupResult;
                        dedupNode.entryUids = dedupNode.entryUids || [];
                        dedupNode.entryUids.push(removeUid);
                        saveTree(bookName, tree);
                    }
                } catch (e) {
                    console.warn(`[TunnelVision] /tv-dedupe: merge UID ${removeUid} → ${instruction.keep_uid} failed:`, e.message);
                    errorCount++;
                }
            }

            // After merging all into the keeper, set the final merged content once
            // (mergeEntries concatenates by default on each call, but we want the LLM's clean version)
            if (instruction.merged_content && instruction.remove_uids.length > 0) {
                try {
                    await updateEntry(bookName, instruction.keep_uid, {
                        content: instruction.merged_content,
                        comment: instruction.merged_title,
                    });
                } catch { /* best effort — merge already succeeded */ }
            }
        }

        if (batchStart + DEDUPE_MAX_CLUSTERS_PER_BATCH < clusters.length) {
            toastr.info(
                `Progress: ${mergedCount} merged so far, ${clusters.length - batchStart - DEDUPE_MAX_CLUSTERS_PER_BATCH} clusters remaining...`,
                'TunnelVision',
            );
        }
    }

    // Consolidate near-duplicate tree category nodes
    let nodesConsolidated = 0;
    const tree = getTree(bookName);
    if (tree?.root) {
        nodesConsolidated = consolidateSiblingNodes(tree.root);
        if (nodesConsolidated > 0) saveTree(bookName, tree);
    }

    if (mergedCount > 0 || nodesConsolidated > 0) {
        const entryMsg = mergedCount > 0
            ? `${mergedCount} entr${mergedCount === 1 ? 'y' : 'ies'} merged into their clusters. `
            : '';
        const nodeMsg = nodesConsolidated > 0
            ? `${nodesConsolidated} category node${nodesConsolidated === 1 ? '' : 's'} consolidated. `
            : '';
        const errMsg = errorCount > 0 ? `${errorCount} error(s). ` : '';
        const absorbMsg = mergedCount > 0 ? 'Absorbed entries moved to "Deduped" node for review.' : '';
        toastr.success(`Deduplication complete: ${entryMsg}${nodeMsg}${errMsg}${absorbMsg}`, 'TunnelVision');
    } else {
        toastr.warning(
            `Deduplication finished but no merges succeeded (${errorCount} error(s)).`,
            'TunnelVision',
        );
    }
}

// ---------------------------------------------------------------------------
// Ingest handler (unchanged — already uses direct action)
// ---------------------------------------------------------------------------

async function handleIngestCommand(_namedArgs, unnamedArg, { activeBooks }) {
    const requested = String(unnamedArg || '').trim();
    let targetLorebook;

    if (requested) {
        targetLorebook = activeBooks.find(b => b.toLowerCase() === requested.toLowerCase()) || null;
        if (!targetLorebook) {
            toastr.warning(`Lorebook "${requested}" not found among active books.`, 'TunnelVision');
            return;
        }
        if (!canWriteBook(targetLorebook)) {
            toastr.warning(`Lorebook "${targetLorebook}" is not writable.`, 'TunnelVision');
            return;
        }
    } else {
        targetLorebook = resolveAccessibleBook(activeBooks, 'write', 'ingest');
    }

    if (!targetLorebook) return;

    const contextMessages = getContextMessages();

    try {
        const context = getContext();
        const chat = context?.chat;

        if (!chat || chat.length === 0) {
            toastr.error('No chat is open. Open a chat before ingesting.', 'TunnelVision');
            return;
        }

        const from = Math.max(0, chat.length - contextMessages);
        const to = chat.length - 1;

        toastr.info(`Ingesting messages ${from}\u2013${to} into "${targetLorebook}"\u2026`, 'TunnelVision');

        const result = await ingestChatMessages(targetLorebook, {
            from,
            to,
            progress: (msg) => toastr.info(msg, 'TunnelVision'),
            detail: () => {},
        });

        toastr.success(
            `Ingested ${result.created} entr${result.created === 1 ? 'y' : 'ies'} ` +
            `(${result.errors} error${result.errors === 1 ? '' : 's'}).`,
            'TunnelVision',
        );
    } catch (err) {
        console.error('[TunnelVision] /tv-ingest failed:', err);
        toastr.error(`Ingest failed: ${err.message}`, 'TunnelVision');
    }
}
