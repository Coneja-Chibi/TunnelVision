/**
 * TunnelVision Sidecar Post-Generation Writer
 * After each chat generation, this module reviews what happened and performs
 * bookkeeping writes (remember, update, merge, summarize, forget, reorganize, split) via the sidecar LLM.
 *
 * Flow:
 *   1. Fires on MESSAGE_RECEIVED (after the chat model's full response)
 *   2. Builds context: tree overview + recent chat (including the new response)
 *   3. Sends to sidecar LLM asking what should be remembered or updated
 *   4. Parses structured JSON response with write operations
 *   5. Executes each operation via the tool action functions directly
 *
 * The sidecar never touches the chat context — it only writes to lorebooks.
 * All writes go through the same tool actions the chat model uses, so
 * permission checks, dedup detection, and tree assignment all still apply.
 */

import { getContext } from '../../../st-context.js';
import { loadWorldInfo, saveWorldInfo, deleteWorldInfoEntry, deleteWIOriginalDataValue } from '../../../world-info.js';
import {
    getTree,
    saveTree,
    findNodeById,
    getAllEntryUids,
    getSettings,
} from './tree-store.js';
import { getReadableBooks, getWritableBooks, getBookListWithDescriptions, checkToolConfirmation, REMEMBER_NAME, UPDATE_NAME, FORGET_NAME, SUMMARIZE_NAME, REORGANIZE_NAME, MERGESPLIT_NAME } from './tool-registry.js';
import { isSidecarConfigured, isCircuitOpen, sidecarGenerate, getSidecarModelLabel } from './llm-sidecar.js';
import { getDefinition as getRememberDef } from './tools/remember.js';
import { getDefinition as getUpdateDef } from './tools/update.js';
import { getDefinition as getSummarizeDef } from './tools/summarize.js';
import { getDefinition as getForgetDef } from './tools/forget.js';
import { getDefinition as getReorganizeDef } from './tools/reorganize.js';
import { getDefinition as getMergeSplitDef } from './tools/merge-split.js';
import { logSidecarWrite, logSnapshotRevert } from './activity-feed.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { applyBackgroundPromptAddendum, buildLanguageDirective, trigramSimilarity } from './agent-utils.js';
import { isStaticEntry } from './entry-protection.js';

const SUMMARY_DEDUP_THRESHOLD = 0.50;

// ─── Turn Snapshots (for undos) ──────────────────────────────────

/**
 * Stores lorebook entry snapshots before they are modified by the sidecar.
 * Allows reverting updates if a message is deleted or swiped.
 * Keyed by "msgId:hash".
 * @type {Map<string, Object>}
 */
const turnSnapshots = new Map();

/** chat_metadata key under which snapshots persist across reloads. */
const SNAPSHOTS_METADATA_KEY = 'tunnelvision_snapshots';
/** Max snapshots retained (20; bounds chat-file bloat, constant regardless of chat length). */
const MAX_SNAPSHOTS = 20;

/**
 * Persist the in-memory snapshot map into chat_metadata so revert-on-deletion
 * survives a page reload. Stored as a plain object keyed by "msgId:hash".
 */
function persistSnapshots() {
    try {
        const context = getContext();
        if (!context.chatMetadata) return;
        context.chatMetadata[SNAPSHOTS_METADATA_KEY] = Object.fromEntries(turnSnapshots);
        context.saveMetadataDebounced?.();
    } catch { /* no active chat */ }
}

/**
 * Rehydrate the snapshot map from chat_metadata. Call on init and on
 * CHAT_CHANGED so reverts work after a reload or chat switch.
 */
export function hydrateSnapshots() {
    try {
        turnSnapshots.clear();
        const data = getContext().chatMetadata?.[SNAPSHOTS_METADATA_KEY];
        if (data && typeof data === 'object') {
            for (const [key, snap] of Object.entries(data)) {
                turnSnapshots.set(key, snap);
            }
        }
    } catch { /* no active chat */ }
}

/**
 * Take a snapshot of the state of entries about to be modified.
 * @param {string} snapshotKey
 * @param {WriteOp[]} ops
 */
async function takeSnapshots(snapshotKey, ops) {
    const snapshots = {
        createdUids: [], // UIDs of new entries created this turn (to be deleted)
        modifiedEntries: {}, // Original state of entries updated/merged (to be restored)
        treeState: {}, // Copy of tree root for each book (to be restored)
    };

    for (const op of ops) {
        if (!op.lorebook) continue;
        const bookData = await loadWorldInfo(op.lorebook);
        if (!bookData?.entries) continue;

        if (op.type === 'update' || op.type === 'merge' || op.type === 'forget' || op.type === 'split') {
            const uids = op.type === 'merge' ? [op.keep_uid, op.remove_uid] : [op.uid];
            for (const uid of uids) {
                if (uid === undefined) continue;
                const entry = findEntryByUid(bookData.entries, uid);
                if (entry) {
                    const key = `${op.lorebook}:${uid}`;
                    if (!snapshots.modifiedEntries[key]) {
                        snapshots.modifiedEntries[key] = JSON.parse(JSON.stringify(entry));
                    }
                }
            }
        }
        
        // Always snapshot the tree state if we might change it
        if (!snapshots.treeState[op.lorebook]) {
            const tree = getTree(op.lorebook);
            if (tree?.root) {
                snapshots.treeState[op.lorebook] = JSON.parse(JSON.stringify(tree.root));
            }
        }
    }

    turnSnapshots.set(snapshotKey, snapshots);

    // Prune old snapshots (keep last MAX_SNAPSHOTS)
    while (turnSnapshots.size > MAX_SNAPSHOTS) {
        const firstKey = turnSnapshots.keys().next().value;
        turnSnapshots.delete(firstKey);
    }

    persistSnapshots();
}

/**
 * Exported for index.js to use during cleanup.
 * Reverts any modifications made by the sidecar for a specific message.
 */
export async function revertMessageSnapshots(msgId, msgHash) {
    const key = `${msgId}:${msgHash}`;
    const snapshots = turnSnapshots.get(key);
    if (!snapshots) return false;

    console.log(`[TunnelVision] Reverting sidecar modifications for message ${msgId}...`);

    let deletedCount = 0;
    let restoredCount = 0;
    const touchedBooks = new Set();

    // 1. Delete created entries
    for (const item of snapshots.createdUids) {
        const { bookName, uid } = item;
        const bookData = await loadWorldInfo(bookName);
        if (bookData?.entries) {
            const entry = bookData.entries[uid];
            if (entry) {
                console.debug(`   - Deleting created entry: "${entry.comment}" (UID ${uid})`);
                await deleteWorldInfoEntry(bookData, uid, { silent: true });
                deleteWIOriginalDataValue(bookData, uid);

                await saveWorldInfo(bookName, bookData, true);

                // Force UI update so it vanishes from the native Lorebook instantly
                if (typeof window.renderWorldInfoList === 'function') window.renderWorldInfoList();
                if (typeof window.renderWorldInfo === 'function') window.renderWorldInfo();

                deletedCount++;
                touchedBooks.add(bookName);
            }
        }
    }

    // 2. Restore modified entries
    const booksToSave = new Set();
    for (const [idKey, originalEntry] of Object.entries(snapshots.modifiedEntries)) {
        const [bookName, uid] = idKey.split(':');
        const bookData = await loadWorldInfo(bookName);
        if (bookData?.entries) {
            const entryKey = Object.keys(bookData.entries).find(k => bookData.entries[k].uid === Number(uid));
            if (entryKey) {
                console.debug(`   - Restoring entry: UID ${uid} in "${bookName}"`);
                bookData.entries[entryKey] = originalEntry;
                
                // Deep restore to SillyTavern's underlying array
                if (bookData.originalData && Array.isArray(bookData.originalData.entries)) {
                    const origIdx = bookData.originalData.entries.findIndex(x => x.uid === Number(uid));
                    if (origIdx >= 0) {
                        bookData.originalData.entries[origIdx] = originalEntry;
                    }
                }
                
                booksToSave.add(bookName);
                restoredCount++;
                touchedBooks.add(bookName);
            }
        }
    }
    for (const bookName of booksToSave) {
        const bookData = await loadWorldInfo(bookName);
        await saveWorldInfo(bookName, bookData, true);
        if (typeof window.renderWorldInfoList === 'function') window.renderWorldInfoList();
    }

    // 3. Restore tree states
    let treeCount = 0;
    for (const [bookName, originalRoot] of Object.entries(snapshots.treeState)) {
        const tree = getTree(bookName);
        if (tree) {
            console.debug(`   - Restoring tree structure for "${bookName}"`);
            tree.root = originalRoot;
            saveTree(bookName, tree);
            treeCount++;
            touchedBooks.add(bookName);
        }
    }

    turnSnapshots.delete(key);
    persistSnapshots();

    // Surface the revert in the activity feed — one summary item per message
    logSnapshotRevert({ deletedCount, restoredCount, treeCount, books: [...touchedBooks] });

    return true;
}

/**
 * Scan all stored snapshots and revert any that belong to messages that are
 * no longer in the chat (or have been modified via swiping).
 * This completely decouples the undo logic from ST event arguments.
 */
export async function revertInvalidSnapshots() {
    const context = getContext();
    const chat = context.chat;
    if (!chat || !turnSnapshots.size) return;

    // Build set of currently valid msgId:msgHash combinations
    const validHashes = new Set();
    for (const msg of chat) {
        const hash = msg.mes ? `${msg.mes.length}_${msg.mes.substring(0, 100).replace(/[^\w]/g, '')}` : '0';
        if (msg.mesId !== undefined) {
            validHashes.add(`${msg.mesId}:${hash}`);
        } else if (hash !== '0') {
            // Legacy chats: use content-hash-only key for fingerprint matching
            validHashes.add(hash);
        }
    }

    // Revert any snapshot whose key is no longer valid
    for (const key of turnSnapshots.keys()) {
        const parts = key.split(':');
        const msgId = parts[0];
        const valid = validHashes.has(key);
        if (!valid) {
            const msgHash = parts.slice(1).join(':');
            // Also check: the snapshot's content hash might match a current message's hash
            // (e.g., when msgId is 'untracked', compare by hash alone)
            const hashOnly = msgHash;
            const hashMatches = msgId === 'untracked' && validHashes.has(hashOnly);
            if (!hashMatches) {
                console.log(`[TunnelVision] Reverting sidecar snapshot for message ${msgId}`);
                await revertMessageSnapshots(msgId, msgHash);
            }
        }
    }
}

// ─── Recent Operations Buffer ────────────────────────────────────

/**
 * Tracks recent sidecar operations to avoid redundant writes across turns.
 * Keyed by chatId.
 * @type {Map<string, Array<{type: string, summary: string, turn: number}>>}
 */
const recentOpsBuffer = new Map();
const MAX_BUFFERED_OPS = 10;

/**
 * Add an operation to the recent buffer.
 * @param {string} chatId
 * @param {string} type
 * @param {string} summary
 */
function bufferOperation(chatId, type, summary) {
    if (!chatId) return;
    if (!recentOpsBuffer.has(chatId)) {
        recentOpsBuffer.set(chatId, []);
    }
    const buffer = recentOpsBuffer.get(chatId);
    buffer.unshift({ type, summary, turn: getContext().chat.length });
    if (buffer.length > MAX_BUFFERED_OPS) {
        buffer.pop();
    }
}

/**
 * Format recent operations for the sidecar prompt.
 * @param {string} chatId
 * @returns {string}
 */
function formatRecentOperations(chatId) {
    if (!chatId || !recentOpsBuffer.has(chatId)) return '';
    const buffer = recentOpsBuffer.get(chatId);
    if (buffer.length === 0) return '';

    let text = '\nRECENT SIDECAR OPERATIONS (already performed):\n';
    for (const op of buffer) {
        text += `- Turn ${op.turn} [${op.type}]: ${op.summary}\n`;
    }
    return text;
}

// ─── Summary Dedup ───────────────────────────────────────────────

/**
 * Load title+body text from all existing [Summary] entries across the given books.
 * Returns objects so the dedup loop can convert near-duplicates to updates.
 * @param {string[]} bookNames
 * @returns {Promise<Array<{text: string, uid: number, lorebook: string}>>}
 */
async function loadSummaryTexts(bookNames) {
    const entries = [];
    for (const bookName of bookNames) {
        const bookData = await loadWorldInfo(bookName);
        if (!bookData?.entries) continue;
        for (const e of Object.values(bookData.entries)) {
            if (e.disable) continue;
            if (!(e.comment || '').startsWith('[Summary]')) continue;
            const title = (e.comment || '').replace(/^\[Summary\]\s*/, '').trim();
            const rawContent = e.content || '';
            const bodyStart = rawContent.indexOf('\n\n');
            const body = bodyStart >= 0 ? rawContent.slice(bodyStart + 2) : rawContent;
            entries.push({ text: `${title} ${body}`.toLowerCase(), uid: e.uid, lorebook: bookName });
        }
    }
    return entries;
}

/**
 * Format a summarize op's content in the same structure used by tools/summarize.js.
 * Used when converting a duplicate summarize op into an update op.
 * @param {Object} op
 * @returns {string}
 */
function formatSummaryContent(op) {
    const significance = op.significance || 'moderate';
    const participants = Array.isArray(op.participants) && op.participants.length > 0
        ? op.participants.join(', ')
        : '(unspecified)';
    return `[Scene Summary — ${significance}]\nParticipants: ${participants}\n\n${(op.summary || '').trim()}`;
}

/**
 * Load stripped titles of all existing [Summary] entries, most recent first (by UID).
 * Used to populate the EXISTING SUMMARIES section in the writer prompt so the LLM
 * sees the full list even when the tree overview truncates the Summaries node.
 * @param {string[]} bookNames
 * @returns {Promise<string[]>}
 */
async function loadSummaryTitles(bookNames) {
    const items = [];
    for (const bookName of bookNames) {
        const bookData = await loadWorldInfo(bookName);
        if (!bookData?.entries) continue;
        for (const e of Object.values(bookData.entries)) {
            if (e.disable) continue;
            if (!(e.comment || '').startsWith('[Summary]')) continue;
            const title = (e.comment || '').replace(/^\[Summary\]\s*/, '').trim();
            if (title) items.push({ uid: e.uid ?? 0, title });
        }
    }
    items.sort((a, b) => b.uid - a.uid);
    return items.slice(0, 50).map(i => i.title);
}

// ─── Tree Overview (shared format with sidecar-retrieval.js) ─────

/**
 * Build a compact tree overview for the sidecar writer prompt.
 * Includes entry titles/UIDs so the sidecar can reference existing entries for updates.
 * @returns {Promise<string>}
 */
async function buildWriterTreeOverview() {
    const activeBooks = getReadableBooks();
    if (activeBooks.length === 0) return '';

    let overview = '';
    for (const bookName of activeBooks) {
        const tree = getTree(bookName);
        if (!tree?.root) continue;

        const bookData = await loadWorldInfo(bookName);
        overview += `Lorebook: ${bookName}\n`;
        overview += formatWriterNode(tree.root, 0, true, bookData?.entries);
        overview += '\n';
    }

    // Cap to avoid blowing sidecar context (higher than retrieval since we include content snippets)
    const maxLen = 8000;
    if (overview.length > maxLen) {
        overview = overview.substring(0, maxLen - 80) + '\n  ... (tree truncated)\n';
    }

    return overview;
}

/**
 * Recursively format a node, including entry titles for update reference.
 * @param {Object} node
 * @param {number} depth
 * @param {boolean} isRoot
 * @param {Object} [entries] - lorebook entries object for title lookup
 * @returns {string}
 */
function formatWriterNode(node, depth, isRoot, entries) {
    const indent = '  '.repeat(depth);
    const children = node.children || [];
    const entryUids = node.entryUids || [];
    let text = '';

    if (isRoot) {
        if (entryUids.length > 0) {
            text += `${indent}[${node.id}] ROOT (${entryUids.length} entries)\n`;
        }
    } else {
        const isLeaf = children.length === 0;
        const type = isLeaf ? 'leaf' : 'branch';
        text += `${indent}[${node.id}] ${node.label || 'Unnamed'} [${type}]\n`;
    }

    // Show entry titles + content snippets so sidecar can detect duplicates and prefer updates
    if (entries && entryUids.length > 0) {
        for (const uid of entryUids.slice(0, 8)) {
            const entry = findEntryByUid(entries, uid);
            if (entry && !entry.disable) {
                const title = entry.comment || entry.key?.[0] || `Entry #${uid}`;
                const snippet = (entry.content || '').substring(0, 150).replace(/\n/g, ' ');
                const staticLabel = isStaticEntry(entry) ? ' [STATIC — reference only]' : '';
                text += `${indent}  - UID ${uid}: "${title}"${staticLabel}`;
                if (snippet) text += ` — ${snippet}${(entry.content || '').length > 150 ? '...' : ''}`;
                text += '\n';
            }
        }
        if (entryUids.length > 8) {
            text += `${indent}  ... +${entryUids.length - 8} more entries\n`;
        }
    }

    for (const child of children) {
        text += formatWriterNode(child, depth + 1, false, entries);
    }

    return text;
}

/**
 * Find an entry by UID in a lorebook's entries object.
 * @param {Object} entries
 * @param {number} uid
 * @returns {Object|null}
 */
function findEntryByUid(entries, uid) {
    for (const key of Object.keys(entries)) {
        if (entries[key].uid === uid) return entries[key];
    }
    return null;
}

// ─── Chat Context ────────────────────────────────────────────────

/**
 * Extract recent chat messages for the sidecar writer.
 * The latest AI response is excluded — the sidecar should only record facts
 * established by the USER, not potentially hallucinated AI roleplay content.
 * We include up to maxMessages of prior context (user + character turns) so the
 * sidecar understands the conversation flow, but the actual "new information"
 * it should act on comes only from the user's latest message(s).
 * @param {number} maxMessages
 * @returns {string}
 */
function extractRecentChat(maxMessages = 15) {
    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length === 0) return '';

    // Find the last non-system message — if it's from the character, exclude it
    let end = chat.length;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_system) continue;
        if (!chat[i].is_user) {
            end = i; // exclude this AI response
        }
        break;
    }

    if (end === 0) return '';

    const lines = [];
    const start = Math.max(0, end - maxMessages);

    for (let i = start; i < end; i++) {
        const msg = chat[i];
        if (msg.is_system) continue;
        const role = msg.is_user ? 'User' : 'Character';
        const text = (msg.mes || '').substring(0, 800).replace(/\n/g, ' ');
        if (text.trim()) {
            lines.push(`${role}: ${text}`);
        }
    }

    return lines.join('\n');
}

// ─── Sidecar Prompt ──────────────────────────────────────────────

const WRITER_SYSTEM_PROMPT = `You are a lorebook maintenance assistant. After each conversation turn, you review what happened and decide what knowledge should be saved, updated, merged, summarized, forgotten, reorganized, or split in the lorebook.

Rules:
- Return a JSON object with fields: "reasoning", "remember", "update", "merge", "summarize", "forget", "reorganize", "split"
- Write operations may target ONLY books listed under WRITABLE LOREBOOKS. Other books in CURRENT LOREBOOK STATE are read-only reference material
- "reasoning": A brief explanation of why these operations are needed
- "remember" entries are NEW facts/events not already in the lorebook
- "update" entries modify EXISTING entries (you must reference the UID)
- "merge" consolidates two EXISTING entries that overlap — specify keep_uid (entry to keep) and remove_uid (entry to absorb)
- "summarize" creates a permanent narrative record — use ONLY for: first meetings of important characters, arc-ending events, major revelations, character deaths or departures, turning points that definitively change the story direction. Do NOT use for routine dialogue, incremental roleplay, or content already covered by a recent Summaries entry.
- "forget" disables entries that are no longer relevant (character died, fact proven false, info outdated)
- "reorganize" moves entries between tree nodes or creates new categories for better organization
- "split" divides one entry that covers multiple topics into two focused entries
- Entries marked [STATIC — reference only] are user-authored reference material. Never update, merge, split, forget, or move them.
- Only create entries for significant, persistent information — not ephemeral dialogue
- You are seeing conversation HISTORY only (the AI's latest response is excluded). Record facts the USER has established or confirmed, not speculative/fictional content
- Focus on: character development, relationship changes, plot events, world-building facts, status changes
- For "remember", choose the most specific matching tree node_id from CURRENT LOREBOOK STATE. If no branch fits, omit node_id and it will be filed at Root
- If nothing significant happened, return: {"reasoning": "No significant events to record", "remember": [], "update": [], "merge": [], "summarize": [], "forget": [], "reorganize": [], "split": []}

CRITICAL — Deduplication:
- READ the content snippets shown for each existing entry carefully
- If an existing entry already covers the same fact, DO NOT create a new "remember" — use "update" on that UID instead, or skip it entirely
- Two entries about the same topic (e.g. a character's background) should be consolidated via "merge" (preferred) or "update", never duplicated
- When in doubt, prefer updating an existing entry over creating a new one
- If two existing entries cover the same topic, use "merge" to combine them into one

CRITICAL — Granularity:
- Prefer FEWER, BROADER entries over many small ones
- Combine related facts into a single entry (e.g. "Character X — Background and Traits" not separate entries for each trait)
- A single conversation turn should rarely produce more than 1-2 entries
- Do NOT create entries for: greetings, minor dialogue, restating known facts, ephemeral actions
- Use "split" only when an entry has grown to cover genuinely unrelated topics

CRITICAL — Updates must be surgical:
- When updating an entry, your "content" field REPLACES the entire existing content
- You MUST include ALL existing information from the entry that is still valid, plus your additions/changes
- NEVER write a partial update that drops existing facts — that destroys data
- If you only need to change the title or keys, omit the "content" field entirely
- Keep your response concise — summarize rather than rewrite verbose entries word-for-word

CRITICAL — Housekeeping:
- Use "forget" sparingly — only when information is definitively wrong or permanently irrelevant
- Use "reorganize" when entries are clearly in the wrong category
- Use "summarize" sparingly — 0 per turn is the norm. Never create a summary when an existing Summaries entry (listed above under EXISTING SUMMARY ENTRIES) already covers the same scene or session. When in doubt, skip it.
- You can only see recent messages. NEVER use language like "first meeting", "first encounter", "for the first time", or "initial" — you cannot know if this is genuinely a first occurrence. Use neutral, factual language (e.g. "A meeting between X and Y" not "First meeting between X and Y").
- Do NOT over-organize — only reorganize when there's a clear structural problem

Response format:
{
  "reasoning": "A brief explanation of why these operations are needed",
  "remember": [
    {"lorebook": "BookName", "title": "Entry Title", "content": "The fact to remember...", "keys": ["keyword1", "keyword2"], "node_id": "tv_xxx_yyy"}
  ],
  "update": [
    {"lorebook": "BookName", "uid": 123, "content": "Updated content...", "title": "Optional new title"}
  ],
  "merge": [
    {"lorebook": "BookName", "keep_uid": 123, "remove_uid": 456, "merged_content": "Combined content...", "merged_title": "Optional merged title"}
  ],
  "summarize": [
    {"lorebook": "BookName", "title": "Scene Title", "summary": "What happened in past tense...", "participants": ["Character1"], "significance": "moderate"}
  ],
  "forget": [
    {"lorebook": "BookName", "uid": 123, "reason": "Why this should be forgotten"}
  ],
  "reorganize": [
    {"lorebook": "BookName", "action": "move", "uid": 123, "target_node_id": "tv_xxx_yyy"}
  ],
  "split": [
    {"lorebook": "BookName", "uid": 123, "keep_content": "Content that stays...", "keep_title": "Original title", "new_content": "Split-off content...", "new_title": "New entry title", "new_keys": ["key1"]}
  ]
}

Return ONLY the JSON object, no explanation.`;

/**
 * Build the sidecar writer prompt.
 * @param {string} treeOverview
 * @param {string} recentChat
 * @param {string} [recentOps]
 * @returns {string}
 */
function buildWriterPrompt(treeOverview, recentChat, recentOps = '', summaryTitles = []) {
    const writableBooks = getBookListWithDescriptions({ writableOnly: true });
    const summarySection = summaryTitles.length > 0
        ? `\nEXISTING SUMMARY ENTRIES (already recorded — do NOT create duplicates):\n${summaryTitles.map(t => `- ${t}`).join('\n')}\n`
        : '';
    return `CURRENT LOREBOOK STATE:
${treeOverview}${summarySection}${recentOps}

WRITABLE LOREBOOKS:
${writableBooks}

CONVERSATION (including latest response):
${recentChat}

Based on the latest conversation turn, what lorebook operations (if any) should be performed? Return a JSON object.`;
}

// ─── Parse Response ──────────────────────────────────────────────

/**
 * @typedef {Object} WriteOp
 * @property {'remember'|'update'|'merge'|'summarize'|'forget'|'reorganize'|'split'} type
 * @property {string} lorebook
 * @property {string} [title]
 * @property {string} [content]
 * @property {string[]} [keys]
 * @property {string} [node_id]
 * @property {number} [uid]
 * @property {number} [keep_uid]
 * @property {number} [remove_uid]
 * @property {string} [summary]
 * @property {string[]} [participants]
 * @property {string} [significance]
 * @property {string} [reason]
 * @property {string} [action]
 * @property {string} [target_node_id]
 * @property {string} [keep_content]
 * @property {string} [keep_title]
 * @property {string} [new_content]
 * @property {string} [new_title]
 * @property {string[]} [new_keys]
 */

/**
 * Parse the sidecar's response into write operations.
 * @param {string} response
 * @returns {{ ops: WriteOp[], reasoning: string }}
 */
function parseWriteOps(response) {
    if (!response || typeof response !== 'string') return { ops: [], reasoning: '' };

    // Try to find JSON object in response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { ops: [], reasoning: '' };

    try {
        const parsed = JSON.parse(jsonMatch[0]);
        const ops = [];
        const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';

        if (Array.isArray(parsed.remember)) {
            for (const r of parsed.remember.slice(0, 5)) {
                if (!r.title || !r.content) continue;
                ops.push({
                    type: 'remember',
                    lorebook: r.lorebook || '',
                    title: String(r.title).substring(0, 200),
                    content: String(r.content).substring(0, 2000),
                    keys: Array.isArray(r.keys) ? r.keys.map(String).slice(0, 10) : [],
                    node_id: r.node_id ? String(r.node_id) : undefined,
                });
            }
        }

        if (Array.isArray(parsed.update)) {
            for (const u of parsed.update.slice(0, 5)) {
                if (u.uid === undefined || u.uid === null) continue;
                if (!u.content && !u.title) continue;
                ops.push({
                    type: 'update',
                    lorebook: u.lorebook || '',
                    uid: Number(u.uid),
                    content: u.content ? String(u.content).substring(0, 2000) : undefined,
                    title: u.title ? String(u.title).substring(0, 200) : undefined,
                });
            }
        }

        if (Array.isArray(parsed.merge)) {
            for (const m of parsed.merge.slice(0, 3)) {
                if (m.keep_uid === undefined || m.keep_uid === null) continue;
                if (m.remove_uid === undefined || m.remove_uid === null) continue;
                ops.push({
                    type: 'merge',
                    lorebook: m.lorebook || '',
                    keep_uid: Number(m.keep_uid),
                    remove_uid: Number(m.remove_uid),
                    content: m.merged_content ? String(m.merged_content).substring(0, 2000) : undefined,
                    title: m.merged_title ? String(m.merged_title).substring(0, 200) : undefined,
                });
            }
        }

        if (Array.isArray(parsed.summarize)) {
            for (const s of parsed.summarize.slice(0, 2)) {
                if (!s.title || !s.summary) continue;
                ops.push({
                    type: 'summarize',
                    lorebook: s.lorebook || '',
                    title: String(s.title).substring(0, 200),
                    summary: String(s.summary).substring(0, 2000),
                    participants: Array.isArray(s.participants) ? s.participants.map(String).slice(0, 10) : [],
                    significance: ['minor', 'moderate', 'major', 'critical'].includes(s.significance) ? s.significance : 'moderate',
                });
            }
        }

        if (Array.isArray(parsed.forget)) {
            for (const f of parsed.forget.slice(0, 3)) {
                if (f.uid === undefined || f.uid === null) continue;
                if (!f.reason) continue;
                ops.push({
                    type: 'forget',
                    lorebook: f.lorebook || '',
                    uid: Number(f.uid),
                    reason: String(f.reason).substring(0, 500),
                });
            }
        }

        if (Array.isArray(parsed.reorganize)) {
            for (const r of parsed.reorganize.slice(0, 3)) {
                if (!r.action) continue;
                ops.push({
                    type: 'reorganize',
                    lorebook: r.lorebook || '',
                    action: String(r.action),
                    uid: r.uid !== undefined ? Number(r.uid) : undefined,
                    target_node_id: r.target_node_id ? String(r.target_node_id) : undefined,
                    title: r.label ? String(r.label).substring(0, 200) : undefined,
                });
            }
        }

        if (Array.isArray(parsed.split)) {
            for (const sp of parsed.split.slice(0, 2)) {
                if (sp.uid === undefined || sp.uid === null) continue;
                if (!sp.keep_content || !sp.new_content || !sp.new_title) continue;
                ops.push({
                    type: 'split',
                    lorebook: sp.lorebook || '',
                    uid: Number(sp.uid),
                    keep_content: String(sp.keep_content).substring(0, 2000),
                    keep_title: sp.keep_title ? String(sp.keep_title).substring(0, 200) : undefined,
                    new_content: String(sp.new_content).substring(0, 2000),
                    new_title: String(sp.new_title).substring(0, 200),
                    new_keys: Array.isArray(sp.new_keys) ? sp.new_keys.map(String).slice(0, 10) : [],
                });
            }
        }

        return { ops, reasoning };
    } catch {
        return { ops: [], reasoning: '' };
    }
}

/**
 * Return the existing entries a write operation would mutate. Creation-only
 * operations intentionally have no targets and remain allowed.
 * @param {WriteOp} op
 * @returns {number[]}
 */
function getMutationTargetUids(op) {
    switch (op.type) {
        case 'merge': return [op.keep_uid, op.remove_uid];
        case 'update':
        case 'forget':
        case 'split': return [op.uid];
        case 'reorganize': return op.action === 'move' ? [op.uid] : [];
        default: return [];
    }
}

/**
 * Defence in depth for the sidecar writer: do not pass operations that target
 * static/constant entries to tool actions, even if the model ignores prompt
 * instructions or an entry was omitted from the truncated tree overview.
 * @param {WriteOp[]} ops
 * @returns {Promise<{allowed: WriteOp[], skipped: string[]}>}
 */
export async function excludeStaticWriteOps(ops) {
    const books = new Map();
    const allowed = [];
    const skipped = [];

    for (const op of ops) {
        const targetUids = getMutationTargetUids(op).filter(Number.isFinite);
        if (targetUids.length === 0 || !op.lorebook) {
            allowed.push(op);
            continue;
        }

        if (!books.has(op.lorebook)) {
            books.set(op.lorebook, await loadWorldInfo(op.lorebook));
        }
        const entries = books.get(op.lorebook)?.entries || {};
        const staticEntry = targetUids
            .map((uid) => findEntryByUid(entries, uid))
            .find((entry) => isStaticEntry(entry));

        if (staticEntry) {
            const title = staticEntry.comment || `UID ${staticEntry.uid}`;
            const message = `SKIP [${op.type}]: static entry "${title}" (UID ${staticEntry.uid}) is protected.`;
            console.warn(`[TunnelVision] Sidecar writer: ${message}`);
            skipped.push(message);
            continue;
        }

        allowed.push(op);
    }

    return { allowed, skipped };
}

// ─── Execute Write Operations ────────────────────────────────────

/**
 * Execute parsed write operations via tool action functions.
 * @param {WriteOp[]} ops
 * @param {string} [reasoning]
 * @param {string|number} [messageId]
 * @returns {Promise<{succeeded: number, failed: number, results: string[]}>}
 */
async function executeWriteOps(ops, reasoning = '', messageId = null) {
    const results = [];
    let succeeded = 0;
    let failed = 0;

    // Generate snapshot key for this turn
    const lastMsg = getContext().chat[getContext().chat.length - 1];
    const msgId = messageId ?? lastMsg?.mesId ?? 'untracked';
    const msgHash = lastMsg?.mes ? `${lastMsg.mes.length}_${lastMsg.mes.substring(0, 100).replace(/[^\w]/g, '')}` : '0';
    const snapshotKey = `${msgId}:${msgHash}`;

    // Never snapshot or invoke actions for static entries: they are protected
    // from all autonomous sidecar mutations.
    const { allowed: safeOps, skipped } = await excludeStaticWriteOps(ops);
    results.push(...skipped);
    if (safeOps.length === 0) {
        return { succeeded, failed, skipped: skipped.length, results };
    }

    // Take snapshots before modifying anything.
    await takeSnapshots(snapshotKey, safeOps);

    // Lazily get tool definitions (they rebuild each call to pick up current book list)
    const rememberAction = getRememberDef().action;
    const updateAction = getUpdateDef().action;
    const summarizeAction = getSummarizeDef().action;
    const forgetAction = getForgetDef().action;
    const reorganizeAction = getReorganizeDef().action;
    const mergeSplitAction = getMergeSplitDef().action;

    // Map op types to tool names for confirmation checks
    const OP_TO_TOOL = {
        remember: REMEMBER_NAME,
        update: UPDATE_NAME,
        merge: MERGESPLIT_NAME,
        split: MERGESPLIT_NAME,
        summarize: SUMMARIZE_NAME,
        forget: FORGET_NAME,
        reorganize: REORGANIZE_NAME,
    };

    for (const op of safeOps) {
        try {
            // Check confirmation if the user has it enabled for this tool type
            const toolName = OP_TO_TOOL[op.type];
            if (toolName) {
                const approved = await checkToolConfirmation(toolName, op);
                if (!approved) {
                    console.log(`[TunnelVision] Sidecar write denied by user: ${op.type} "${op.title || op.uid || ''}"`)
                    results.push({ op, success: false, result: 'Denied by user' });
                    failed++;
                    continue;
                }
            }

            let result;
            const context = getContext();
            const lastMsg = context.chat[context.chat.length - 1];
            
            // Resolve message ID reliably
            let msgId = messageId;
            if (msgId === null || msgId === undefined) {
                msgId = lastMsg?.mesId;
            }
            if (msgId === null || msgId === undefined) {
                msgId = 'untracked';
            }

            const msgHash = lastMsg?.mes ? `${lastMsg.mes.length}_${lastMsg.mes.substring(0, 100).replace(/[^\w]/g, '')}` : '0';
            const tv_tracker = `!tv_tracker:${msgId}:${msgHash}`;

            if (op.type === 'remember') {
                result = await rememberAction({
                    lorebook: op.lorebook,
                    title: op.title,
                    content: op.content,
                    keys: op.keys,
                    node_id: op.node_id,
                    tv_tracker,
                    _backgroundSource: 'sidecar',
                });
            } else if (op.type === 'update') {
                result = await updateAction({
                    lorebook: op.lorebook,
                    uid: op.uid,
                    content: op.content,
                    title: op.title,
                    _backgroundSource: 'sidecar',
                });
            } else if (op.type === 'merge') {
                result = await mergeSplitAction({
                    lorebook: op.lorebook,
                    action: 'merge',
                    keep_uid: op.keep_uid,
                    remove_uid: op.remove_uid,
                    merged_content: op.content || undefined,
                    merged_title: op.title || undefined,
                    _backgroundSource: 'sidecar',
                });
            } else if (op.type === 'summarize') {
                result = await summarizeAction({
                    lorebook: op.lorebook,
                    title: op.title,
                    summary: op.summary,
                    participants: op.participants,
                    significance: op.significance,
                    tv_tracker,
                    _backgroundSource: 'sidecar',
                });
            } else if (op.type === 'forget') {
                result = await forgetAction({
                    lorebook: op.lorebook,
                    uid: op.uid,
                    reason: op.reason,
                    _backgroundSource: 'sidecar',
                });
            } else if (op.type === 'reorganize') {
                result = await reorganizeAction({
                    lorebook: op.lorebook,
                    action: op.action,
                    uid: op.uid,
                    target_node_id: op.target_node_id,
                    label: op.title,
                    _backgroundSource: 'sidecar',
                });
            } else if (op.type === 'split') {
                result = await mergeSplitAction({
                    lorebook: op.lorebook,
                    action: 'split',
                    uid: op.uid,
                    keep_content: op.keep_content,
                    keep_title: op.keep_title,
                    new_content: op.new_content,
                    new_title: op.new_title,
                    new_keys: op.new_keys,
                    _backgroundSource: 'sidecar',
                });
            }

            const isError = typeof result === 'string' && (
                result.startsWith('Missing required') ||
                result.startsWith('Failed to') ||
                result.includes('not found') ||
                result.startsWith('No writable')
            );

            if (isError) {
                failed++;
                results.push(`FAIL [${op.type}]: ${result}`);
            } else {
                succeeded++;
                results.push(`OK [${op.type}]: ${result}`);

                // If this was a creation, record the UID for cleanup/undo
                if (op.type === 'remember' || op.type === 'summarize') {
                    const uidMatch = String(result).match(/\(UID (\d+)\)/);
                    if (uidMatch) {
                        const uid = Number(uidMatch[1]);
                        const snapshots = turnSnapshots.get(snapshotKey);
                        if (snapshots) {
                            snapshots.createdUids.push({ bookName: op.lorebook, uid });
                        }
                    }
                }

                const opSummary = op.type === 'remember'
                    ? `"${(op.title || '').substring(0, 50)}"`
                    : op.type === 'merge'
                    ? `UID ${op.keep_uid ?? '?'} ← UID ${op.remove_uid ?? '?'}${op.title ? ` "${op.title.substring(0, 40)}"` : ''}`
                    : op.type === 'summarize'
                    ? `"${(op.title || '').substring(0, 50)}"`
                    : op.type === 'forget'
                    ? `UID ${op.uid ?? '?'}: ${(op.reason || '').substring(0, 40)}`
                    : op.type === 'reorganize'
                    ? `${op.action || '?'}${op.uid ? ` UID ${op.uid}` : ''}${op.title ? ` "${op.title.substring(0, 30)}"` : ''}`
                    : op.type === 'split'
                    ? `UID ${op.uid ?? '?'} → "${(op.new_title || '').substring(0, 40)}"`
                    : `UID ${op.uid ?? '?'}${op.title ? ` "${op.title.substring(0, 40)}"` : ''}`;

                bufferOperation(getContext().chatId, op.type, opSummary);

                logSidecarWrite(op.type, {
                    lorebook: op.lorebook,
                    title: op.title,
                    uid: op.uid,
                    keep_uid: op.keep_uid,
                    remove_uid: op.remove_uid,
                    summary: opSummary,
                    reasoning,
                });
            }
        } catch (err) {
            failed++;
            results.push(`ERROR [${op.type}]: ${err.message}`);
        }
    }

    // Re-persist: createdUids were appended to the snapshot during this loop,
    // after takeSnapshots' initial persist. Without this, created entries
    // wouldn't be deleted on a revert after a reload.
    persistSnapshots();

    return { succeeded, failed, results };
}

// ─── Main Entry Point ────────────────────────────────────────────

/**
 * Run sidecar post-generation writer.
 * Called after MESSAGE_RECEIVED in index.js.
 *
 * @param {string|number} [messageId]
 * @returns {Promise<void>}
 */
export async function runSidecarWriter(messageId = null) {
    const settings = getSettings();

    // Guard: must be enabled and sidecar must be configured
    if (!settings.sidecarPostGenWriter) return;
    if (isCircuitOpen()) {
        console.debug('[TunnelVision] Sidecar post-gen writer: circuit breaker open — skipping');
        return;
    }
    if (!isSidecarConfigured()) {
        console.debug('[TunnelVision] Sidecar post-gen writer enabled but no sidecar configured — skipping');
        return;
    }

    const activeBooks = getReadableBooks();
    if (activeBooks.length === 0) return;
    if (getWritableBooks().length === 0) {
        console.debug('[TunnelVision] Sidecar post-gen writer: no writable lorebooks');
        return;
    }

    // Build tree overview (includes entry titles for update reference)
    const treeOverview = await buildWriterTreeOverview();
    if (!treeOverview.trim()) {
        console.debug('[TunnelVision] Sidecar post-gen writer: no tree content');
        return;
    }

    // Extract recent chat including the new response
    const contextMessages = settings.sidecarWriterContextMessages ?? 15;
    const recentChat = extractRecentChat(contextMessages);
    if (!recentChat.trim()) {
        console.debug('[TunnelVision] Sidecar post-gen writer: no recent chat context');
        return;
    }

    const recentOps = formatRecentOperations(getContext().chatId);
    const summaryTitles = await loadSummaryTitles(activeBooks);

    try {
        // Ask sidecar what to write
        const prompt = buildWriterPrompt(treeOverview, recentChat, recentOps, summaryTitles);
        const langDirective = buildLanguageDirective();
        const response = await sidecarGenerate({
            prompt,
            systemPrompt: applyBackgroundPromptAddendum(WRITER_SYSTEM_PROMPT) + langDirective,
        });

        const _rawModel = getSidecarModelLabel() || 'unknown';
        console.groupCollapsed(`[TunnelVision] Sidecar writer raw response (${_rawModel})`);
        console.log(response);
        console.groupEnd();

        const { ops, reasoning } = parseWriteOps(response);
        if (ops.length === 0) {
            console.log('[TunnelVision] Sidecar post-gen writer: no write operations needed');
            return;
        }

        // Cap total operations
        const maxOps = settings.sidecarWriterMaxOps ?? 5;
        const capped = ops.slice(0, maxOps);

        // Dedup summarize ops — skip if near-identical to an existing summary entry
        let summaryTexts = null;
        const dedupedOps = [];
        for (const op of capped) {
            if (op.type === 'summarize') {
                if (!summaryTexts) {
                    summaryTexts = await loadSummaryTexts(activeBooks);
                }
                const newText = `${op.title || ''} ${op.summary || ''}`.toLowerCase();
                const isDupe = summaryTexts.some(e => trigramSimilarity(newText, e.text) >= SUMMARY_DEDUP_THRESHOLD);
                if (isDupe) {
                    // Find the best-matching existing summary and update it instead of creating a new one
                    const bestMatch = summaryTexts.reduce(
                        (best, e) => {
                            const score = trigramSimilarity(newText, e.text);
                            return score > best.score ? { score, entry: e } : best;
                        },
                        { score: 0, entry: null },
                    ).entry;

                    if (bestMatch?.uid != null) {
                        console.log(`[TunnelVision] Sidecar writer: updating existing summary UID ${bestMatch.uid} instead of creating duplicate "${op.title}"`);
                        dedupedOps.push({
                            type: 'update',
                            lorebook: bestMatch.lorebook,
                            uid: bestMatch.uid,
                            content: formatSummaryContent(op),
                            title: op.title ? `[Summary] ${op.title}` : undefined,
                        });
                    } else {
                        console.log(`[TunnelVision] Sidecar writer: skipping duplicate summary "${op.title}" (no UID to update)`);
                    }
                    continue;
                }
                summaryTexts.push({ text: newText, uid: null, lorebook: op.lorebook });
            }
            dedupedOps.push(op);
        }
        if (dedupedOps.length === 0) {
            console.log('[TunnelVision] Sidecar post-gen writer: all ops filtered by dedup');
            return;
        }

        // Execute writes
        const { succeeded, failed, results } = await executeWriteOps(dedupedOps, reasoning, messageId);

        // Explicitly refresh UI after all modifications are complete
        const { refreshUI } = await import('./ui-controller.js');
        refreshUI();

        const _writerModel = getSidecarModelLabel() || 'unknown';
        console.log(
            `[TunnelVision] Sidecar post-gen writer [${_writerModel}]: ${succeeded} succeeded, ${failed} failed out of ${dedupedOps.length} operations`,
        );
        for (const r of results) {
            console.debug(`  ${r}`);
        }

        console.groupCollapsed(`[TunnelVision] Sidecar writer details (${_writerModel})`);
        if (reasoning) console.log('Reasoning:', reasoning);
        for (const op of dedupedOps) {
            if (op.type === 'remember') {
                console.log(`📝 Remember: "${op.title}" → ${op.lorebook || '(auto)'}`);
                console.log(`   Content: ${(op.content || '').substring(0, 200)}${(op.content || '').length > 200 ? '...' : ''}`);
                console.log(`   Keys: ${(op.keys || []).join(', ') || '(none)'}`);
            } else if (op.type === 'update') {
                console.log(`✏️ Update: UID ${op.uid}${op.title ? ` "${op.title}"` : ''} → ${op.lorebook || '(auto)'}`);
                if (op.content) console.log(`   Content: ${op.content.substring(0, 200)}${op.content.length > 200 ? '...' : ''}`);
            } else if (op.type === 'merge') {
                console.log(`🔗 Merge: UID ${op.keep_uid} ← UID ${op.remove_uid}${op.title ? ` "${op.title}"` : ''} → ${op.lorebook || '(auto)'}`);
                if (op.content) console.log(`   Content: ${op.content.substring(0, 200)}${op.content.length > 200 ? '...' : ''}`);
            } else if (op.type === 'summarize') {
                console.log(`📋 Summarize: "${op.title}" [${op.significance || 'moderate'}] → ${op.lorebook || '(auto)'}`);
                if (op.summary) console.log(`   Summary: ${op.summary.substring(0, 200)}${op.summary.length > 200 ? '...' : ''}`);
                if (op.participants?.length) console.log(`   Participants: ${op.participants.join(', ')}`);
            } else if (op.type === 'forget') {
                console.log(`🗑️ Forget: UID ${op.uid} → ${op.lorebook || '(auto)'}`);
                console.log(`   Reason: ${op.reason || '(none)'}`);
            } else if (op.type === 'reorganize') {
                console.log(`📂 Reorganize [${op.action}]: ${op.uid ? `UID ${op.uid}` : ''}${op.target_node_id ? ` → ${op.target_node_id}` : ''}${op.title ? ` "${op.title}"` : ''} → ${op.lorebook || '(auto)'}`);
            } else if (op.type === 'split') {
                console.log(`✂️ Split: UID ${op.uid} → "${op.new_title}" → ${op.lorebook || '(auto)'}`);
                if (op.keep_content) console.log(`   Keep: ${op.keep_content.substring(0, 150)}${op.keep_content.length > 150 ? '...' : ''}`);
                if (op.new_content) console.log(`   New: ${op.new_content.substring(0, 150)}${op.new_content.length > 150 ? '...' : ''}`);
            }
        }
        console.log('Results:', results);
        console.groupEnd();
    } catch (error) {
        console.error('[TunnelVision] Sidecar post-gen writer failed:', error);
    }
}
