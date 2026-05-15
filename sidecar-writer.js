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
import { loadWorldInfo } from '../../../world-info.js';
import {
    getTree,
    findNodeById,
    getAllEntryUids,
    getSettings,
} from './tree-store.js';
import { getReadableBooks, getWritableBooks, getBookListWithDescriptions, checkToolConfirmation, REMEMBER_NAME, UPDATE_NAME, FORGET_NAME, SUMMARIZE_NAME, REORGANIZE_NAME, MERGESPLIT_NAME } from './tool-registry.js';
import { isSidecarConfigured, sidecarGenerate, getSidecarModelLabel } from './llm-sidecar.js';
import { getDefinition as getRememberDef } from './tools/remember.js';
import { getDefinition as getUpdateDef } from './tools/update.js';
import { getDefinition as getSummarizeDef } from './tools/summarize.js';
import { getDefinition as getForgetDef } from './tools/forget.js';
import { getDefinition as getReorganizeDef } from './tools/reorganize.js';
import { getDefinition as getMergeSplitDef } from './tools/merge-split.js';
import { logSidecarWrite } from './activity-feed.js';
import { applyBackgroundPromptAddendum, buildLanguageDirective } from './agent-utils.js';

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
                text += `${indent}  - UID ${uid}: "${title}"`;
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
- "summarize" creates a scene/event summary for significant narrative beats (filed under a Summaries category)
- "forget" disables entries that are no longer relevant (character died, fact proven false, info outdated)
- "reorganize" moves entries between tree nodes or creates new categories for better organization
- "split" divides one entry that covers multiple topics into two focused entries
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
- Use "summarize" for significant scenes or narrative beats that should be preserved as events
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
 * @returns {string}
 */
function buildWriterPrompt(treeOverview, recentChat) {
    const writableBooks = getBookListWithDescriptions({ writableOnly: true });
    return `CURRENT LOREBOOK STATE:
${treeOverview}

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

// ─── Execute Write Operations ────────────────────────────────────

/**
 * Execute parsed write operations via tool action functions.
 * @param {WriteOp[]} ops
 * @param {string} [reasoning]
 * @returns {Promise<{succeeded: number, failed: number, results: string[]}>}
 */
async function executeWriteOps(ops, reasoning = '') {
    const results = [];
    let succeeded = 0;
    let failed = 0;

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

    for (const op of ops) {
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
            if (op.type === 'remember') {
                result = await rememberAction({
                    lorebook: op.lorebook,
                    title: op.title,
                    content: op.content,
                    keys: op.keys,
                    node_id: op.node_id,
                });
            } else if (op.type === 'update') {
                result = await updateAction({
                    lorebook: op.lorebook,
                    uid: op.uid,
                    content: op.content,
                    title: op.title,
                });
            } else if (op.type === 'merge') {
                result = await mergeSplitAction({
                    lorebook: op.lorebook,
                    action: 'merge',
                    keep_uid: op.keep_uid,
                    remove_uid: op.remove_uid,
                    merged_content: op.content || undefined,
                    merged_title: op.title || undefined,
                });
            } else if (op.type === 'summarize') {
                result = await summarizeAction({
                    lorebook: op.lorebook,
                    title: op.title,
                    summary: op.summary,
                    participants: op.participants,
                    significance: op.significance,
                });
            } else if (op.type === 'forget') {
                result = await forgetAction({
                    lorebook: op.lorebook,
                    uid: op.uid,
                    reason: op.reason,
                });
            } else if (op.type === 'reorganize') {
                result = await reorganizeAction({
                    lorebook: op.lorebook,
                    action: op.action,
                    uid: op.uid,
                    target_node_id: op.target_node_id,
                    label: op.title,
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
                logSidecarWrite(op.type, {
                    lorebook: op.lorebook,
                    title: op.title,
                    uid: op.uid,
                    keep_uid: op.keep_uid,
                    remove_uid: op.remove_uid,
                    summary: op.type === 'remember'
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
                        : `UID ${op.uid ?? '?'}${op.title ? ` "${op.title.substring(0, 40)}"` : ''}`,
                    reasoning,
                });
            }
        } catch (err) {
            failed++;
            results.push(`ERROR [${op.type}]: ${err.message}`);
        }
    }

    return { succeeded, failed, results };
}

// ─── Main Entry Point ────────────────────────────────────────────

/**
 * Run sidecar post-generation writer.
 * Called after MESSAGE_RECEIVED in index.js.
 *
 * @returns {Promise<void>}
 */
export async function runSidecarWriter() {
    const settings = getSettings();

    // Guard: must be enabled and sidecar must be configured
    if (!settings.sidecarPostGenWriter) return;
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

    try {
        // Ask sidecar what to write
        const prompt = buildWriterPrompt(treeOverview, recentChat);
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

        // Execute writes
        const { succeeded, failed, results } = await executeWriteOps(capped, reasoning);

        const _writerModel = getSidecarModelLabel() || 'unknown';
        console.log(
            `[TunnelVision] Sidecar post-gen writer [${_writerModel}]: ${succeeded} succeeded, ${failed} failed out of ${capped.length} operations`,
        );
        for (const r of results) {
            console.debug(`  ${r}`);
        }

        console.groupCollapsed(`[TunnelVision] Sidecar writer details (${_writerModel})`);
        if (reasoning) console.log('Reasoning:', reasoning);
        for (const op of capped) {
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
