/**
 * TunnelVision Sidecar Auto-Retrieval
 * Pre-generation tree navigation via the sidecar LLM.
 *
 * Before each chat generation, this module:
 *   1. Builds a collapsed tree overview of all active lorebooks
 *   2. Extracts recent chat context (last N messages)
 *   3. Sends both to the sidecar LLM asking it to pick relevant node IDs
 *   4. Resolves those node IDs to entry content
 *   5. Injects the content via setExtensionPrompt
 *
 * Works alongside (not replacing) the chat model's tool access — the chat model
 * can still call TunnelVision_Search for additional retrieval or write tools.
 */

import { getContext } from '../../../st-context.js';
import { extension_prompt_types, extension_prompt_roles, setExtensionPrompt } from '../../../../script.js';
import { loadWorldInfo } from '../../../world-info.js';
import {
    getTree,
    findNodeById,
    getAllEntryUids,
    getSettings,
} from './tree-store.js';
import { getReadableBooks } from './tool-registry.js';
import { hasEvaluableConditions, separateConditions, mapSelectiveLogic, describeSelectiveLogic, CONDITION_DESCRIPTIONS, CONDITION_LABELS, rollKeywordProbability, formatCondition } from './conditions.js';
import { isSidecarConfigured, sidecarGenerate, getSidecarModelLabel } from './llm-sidecar.js';
import { logSidecarRetrieval, logConditionalEvaluations, setSidecarActive } from './activity-feed.js';

const TV_SIDECAR_RETRIEVAL_KEY = 'tunnelvision_sidecar_retrieval';

// ─── Tree Overview (reuses collapsed-tree format from search.js) ─────

/**
 * Build a compact collapsed tree overview for the sidecar prompt.
 * Similar to buildCollapsedTreeOverview in search.js but kept independent
 * to avoid circular imports and to allow sidecar-specific formatting.
 * @returns {string}
 */
function buildSidecarTreeOverview() {
    const activeBooks = getReadableBooks();
    if (activeBooks.length === 0) return '';

    let overview = '';
    for (const bookName of activeBooks) {
        const tree = getTree(bookName);
        if (!tree?.root) continue;

        overview += `Lorebook: ${bookName}\n`;
        overview += formatNodeForSidecar(tree.root, 0, true);
        overview += '\n';
    }

    // Cap to avoid blowing sidecar context
    const maxLen = 5000;
    if (overview.length > maxLen) {
        overview = overview.substring(0, maxLen - 80) + '\n  ... (tree truncated)\n';
    }

    return overview;
}

/**
 * Recursively format a node for the sidecar's tree view.
 * @param {Object} node
 * @param {number} depth
 * @param {boolean} isRoot
 * @returns {string}
 */
function formatNodeForSidecar(node, depth, isRoot = false) {
    const indent = '  '.repeat(depth);
    const children = node.children || [];
    const directEntries = (node.entryUids || []).length;
    const totalEntries = getAllEntryUids(node).length;
    let text = '';

    if (isRoot) {
        if (directEntries > 0) {
            text += `${indent}[${node.id}] ROOT (${directEntries} entries)\n`;
        }
    } else {
        const isLeaf = children.length === 0;
        const type = isLeaf ? 'leaf' : 'branch';
        text += `${indent}[${node.id}] ${node.label || 'Unnamed'} [${type}] (${totalEntries} entries)\n`;
        if (node.summary) {
            text += `${indent}  ${node.summary}\n`;
        }
    }

    for (const child of children) {
        text += formatNodeForSidecar(child, depth + 1, false);
    }

    return text;
}

// ─── Chat Context Extraction ─────────────────────────────────────

/**
 * Extract recent chat messages for sidecar context.
 * @param {number} maxMessages
 * @returns {string}
 */
function extractRecentChat(maxMessages = 10) {
    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length === 0) return '';

    const lines = [];
    const start = Math.max(0, chat.length - maxMessages);

    for (let i = start; i < chat.length; i++) {
        const msg = chat[i];
        if (msg.is_system) continue;
        const role = msg.is_user ? 'User' : 'Character';
        const text = (msg.mes || '').substring(0, 500).replace(/\n/g, ' ');
        if (text.trim()) {
            lines.push(`${role}: ${text}`);
        }
    }

    return lines.join('\n');
}

// ─── Conditional Entry Collection ────────────────────────────────

/**
 * Collect entries with evaluable conditions from all active lorebooks.
 * Scans primary keys (key[]) and secondary keys (keysecondary[]) for [type:value] patterns.
 * @returns {Promise<Array<{ bookName: string, uid: number, title: string, primaryConditions: Array, primaryKeywords: string[], secondaryConditions: Array, secondaryKeywords: string[], logic: string }>>}
 */
async function collectConditionalEntries() {
    const results = [];
    const activeBooks = getReadableBooks();

    for (const bookName of activeBooks) {
        const bookData = await loadWorldInfo(bookName);
        if (!bookData?.entries) continue;

        for (const key of Object.keys(bookData.entries)) {
            const entry = bookData.entries[key];
            if (!entry || entry.disable) continue;
            if (!hasEvaluableConditions(entry)) continue;

            const primary = separateConditions(entry.key || []);
            const secondary = separateConditions(entry.keysecondary || []);

            // Only include if there's at least one actual condition
            if (primary.conditions.length === 0 && secondary.conditions.length === 0) continue;

            // Roll per-keyword probability — filter out conditions that fail
            const rolledPrimaryConditions = primary.conditions.filter(c => rollKeywordProbability(entry, formatCondition(c)));
            const rolledSecondaryConditions = secondary.conditions.filter(c => rollKeywordProbability(entry, formatCondition(c)));
            const rolledPrimaryKeywords = primary.keywords.filter(kw => rollKeywordProbability(entry, kw));
            const rolledSecondaryKeywords = secondary.keywords.filter(kw => rollKeywordProbability(entry, kw));

            // After probability roll, skip if nothing survived
            if (rolledPrimaryConditions.length === 0 && rolledSecondaryConditions.length === 0) continue;

            const logic = entry.selective ? mapSelectiveLogic(entry.selectiveLogic ?? 0) : 'AND_ANY';

            results.push({
                bookName,
                uid: entry.uid,
                title: entry.comment || entry.key?.[0] || `Entry #${entry.uid}`,
                primaryConditions: rolledPrimaryConditions,
                primaryKeywords: rolledPrimaryKeywords,
                secondaryConditions: rolledSecondaryConditions,
                secondaryKeywords: rolledSecondaryKeywords,
                logic,
            });
        }
    }

    return results;
}

/**
 * Build the Narrative Conditionals prompt section for the sidecar.
 * @param {Array} conditionalEntries - From collectConditionalEntries()
 * @returns {string}
 */
function buildConditionalSection(conditionalEntries) {
    if (conditionalEntries.length === 0) return '';

    let section = '\n\nNARRATIVE CONDITIONALS — Evaluate & Include:\n';
    section += 'Evaluate each entry\'s conditions against the current scene. Return a "conditional_evaluations" array in your JSON response.\n\n';
    section += 'Condition types:\n';
    for (const [type, desc] of Object.entries(CONDITION_DESCRIPTIONS)) {
        section += `- ${type}: ${desc}\n`;
    }

    section += '- Prefix ! means the condition should NOT be true (negation)\n';
    section += '- freeform conditions contain a natural-language description — evaluate whether the described situation applies\n';

    section += '\nSelective logic operators:\n';
    section += '- AND_ANY: Primary conditions must be true AND at least one secondary condition must be true\n';
    section += '- AND_ALL: Primary conditions must be true AND all secondary conditions must be true\n';
    section += '- NOT_ANY: Primary conditions must be true AND none of the secondary conditions should be true\n';
    section += '- NOT_ALL: Primary conditions must be true AND not all secondary conditions should be true\n';

    section += '\nEntries to evaluate:\n';
    for (const entry of conditionalEntries) {
        section += `- "${entry.title}" (uid:${entry.uid})\n`;

        // Primary
        const primaryParts = [
            ...entry.primaryKeywords.map(k => `"${k}"`),
            ...entry.primaryConditions.map(c => `[${c.negated ? '!' : ''}${c.type}:${c.value}]`),
        ];
        if (primaryParts.length > 0) {
            section += `  Primary: ${primaryParts.join(', ')}\n`;
        }

        // Secondary (only if selective)
        const secondaryParts = [
            ...entry.secondaryKeywords.map(k => `"${k}"`),
            ...entry.secondaryConditions.map(c => `[${c.negated ? '!' : ''}${c.type}:${c.value}]`),
        ];
        if (secondaryParts.length > 0) {
            section += `  Secondary: ${secondaryParts.join(', ')}\n`;
            section += `  Logic: ${entry.logic}\n`;
        }
    }

    return section;
}

// ─── Node Resolution ─────────────────────────────────────────────

/**
 * Resolve node IDs to entry content across all active lorebooks.
 * @param {string[]} nodeIds
 * @returns {Promise<string>}
 */
async function resolveNodeContent(nodeIds) {
    const results = [];
    const seenEntries = new Set();

    for (const nodeId of nodeIds) {
        for (const bookName of getReadableBooks()) {
            const tree = getTree(bookName);
            if (!tree?.root) continue;

            const node = findNodeById(tree.root, nodeId);
            if (!node) continue;

            const uids = getAllEntryUids(node);
            const bookData = await loadWorldInfo(bookName);
            if (!bookData?.entries) continue;

            for (const uid of uids) {
                const entryKey = `${bookName}:${uid}`;
                if (seenEntries.has(entryKey)) continue;
                seenEntries.add(entryKey);

                const entry = findEntryByUid(bookData.entries, uid);
                if (!entry?.content || entry.disable) continue;

                const title = entry.comment || entry.key?.[0] || `Entry #${uid}`;
                results.push(`[${bookName} | ${title}]\n${entry.content}`);
            }
        }
    }

    return results.join('\n\n');
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

// ─── Sidecar Prompt ──────────────────────────────────────────────

const SIDECAR_SYSTEM_PROMPT = `You are a retrieval assistant. Given a knowledge tree index, recent conversation, and optionally narrative conditionals, perform two tasks:

TASK 1 — Node Retrieval:
Pick the most relevant node IDs from the tree to retrieve for the next response.

TASK 2 — Conditional Evaluation (only if NARRATIVE CONDITIONALS section is present):
Evaluate each listed entry's conditions against the current scene state. Decide if conditions are met.

Return ONLY a JSON object:
{
  "reasoning": "Brief explanation of retrieval choices",
  "nodes": ["tv_123_abc"],
  "conditional_evaluations": [
    {"uid": 42, "accepted": true, "reason": "Scene mood is tense and characters are in a forest"}
  ]
}

Rules:
- Pick 1-5 nodes maximum — prefer specific leaf nodes over broad branches
- Pick nodes whose content would be most useful for the next character response
- If nothing seems relevant, return empty nodes: []
- For conditionals: evaluate EACH entry listed. Return accepted=true only if the scene genuinely matches
- Be strict — do not accept conditions that are merely implied or could be true. They must clearly apply to the current scene
- For negated conditions (prefixed with !): the condition is met when the described state is NOT present
- For freeform conditions: evaluate the natural-language description against the current scene
- Omit "conditional_evaluations" entirely if no conditionals section was provided
- Do NOT include any explanation outside the JSON object`;

/**
 * Build the sidecar retrieval prompt.
 * @param {string} treeOverview
 * @param {string} recentChat
 * @param {string} conditionalSection
 * @returns {string}
 */
function buildRetrievalPrompt(treeOverview, recentChat, conditionalSection = '') {
    return `KNOWLEDGE TREE INDEX:
${treeOverview}

RECENT CONVERSATION:
${recentChat}
${conditionalSection}
Which node IDs should be retrieved to provide relevant context for the next response?`;
}

// ─── Parse Response ──────────────────────────────────────────────

/**
 * Parse the sidecar's response to extract node IDs, reasoning, and conditional evaluations.
 * @param {string} response
 * @returns {{ nodeIds: string[], reasoning: string, conditionalEvaluations: Array<{ uid: number, accepted: boolean, reason: string }> }}
 */
function parseSidecarResponse(response) {
    const empty = { nodeIds: [], reasoning: '', conditionalEvaluations: [] };
    if (!response || typeof response !== 'string') return empty;

    // Try JSON object format first (preferred)
    const objMatch = response.match(/\{[\s\S]*\}/);
    if (objMatch) {
        try {
            const parsed = JSON.parse(objMatch[0]);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                const nodeIds = Array.isArray(parsed.nodes)
                    ? parsed.nodes.filter(id => typeof id === 'string' && id.startsWith('tv_')).slice(0, 5)
                    : [];
                const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';

                // Parse conditional evaluations
                let conditionalEvaluations = [];
                if (Array.isArray(parsed.conditional_evaluations)) {
                    conditionalEvaluations = parsed.conditional_evaluations
                        .filter(e => e && typeof e === 'object' && typeof e.uid === 'number' && typeof e.accepted === 'boolean')
                        .map(e => ({
                            uid: e.uid,
                            accepted: !!e.accepted,
                            reason: typeof e.reason === 'string' ? e.reason : '',
                        }));
                }

                return { nodeIds, reasoning, conditionalEvaluations };
            }
        } catch {
            // fall through
        }
    }

    // Fall back to legacy array format (no conditionals support)
    const arrayMatch = response.match(/\[[\s\S]*?\]/);
    if (!arrayMatch) return empty;

    try {
        const parsed = JSON.parse(arrayMatch[0]);
        if (!Array.isArray(parsed)) return empty;
        const nodeIds = parsed.filter(id => typeof id === 'string' && id.startsWith('tv_')).slice(0, 5);
        return { nodeIds, reasoning: '', conditionalEvaluations: [] };
    } catch {
        return empty;
    }
}

// ─── Conditional Entry Resolution ────────────────────────────────

/**
 * Resolve accepted conditional entries to their content for injection.
 * @param {Array<{ uid: number, accepted: boolean, reason: string }>} evaluations
 * @param {Array<{ bookName: string, uid: number, title: string }>} conditionalEntries
 * @returns {Promise<string>}
 */
async function resolveConditionalContent(evaluations, conditionalEntries) {
    const acceptedUids = new Set(
        evaluations.filter(e => e.accepted).map(e => e.uid),
    );
    if (acceptedUids.size === 0) return '';

    const results = [];
    for (const ce of conditionalEntries) {
        if (!acceptedUids.has(ce.uid)) continue;

        const bookData = await loadWorldInfo(ce.bookName);
        if (!bookData?.entries) continue;

        const entry = findEntryByUid(bookData.entries, ce.uid);
        if (!entry?.content || entry.disable) continue;

        results.push(entry.content);
    }

    return results.join('\n\n');
}

// ─── Main Entry Point ────────────────────────────────────────────

/**
 * Run sidecar auto-retrieval before a generation.
 * Called from onGenerationStarted in index.js.
 *
 * @returns {Promise<void>}
 */
export async function runSidecarRetrieval() {
    const settings = getSettings();

    // Guard: must be enabled and sidecar must be configured
    if (!settings.sidecarAutoRetrieval) return;
    if (!isSidecarConfigured()) {
        console.debug('[TunnelVision] Sidecar auto-retrieval enabled but no sidecar configured — skipping');
        return;
    }

    const activeBooks = getReadableBooks();
    if (activeBooks.length === 0) return;

    // Build tree overview
    const treeOverview = buildSidecarTreeOverview();
    if (!treeOverview.trim()) {
        console.debug('[TunnelVision] Sidecar auto-retrieval: no tree content to navigate');
        return;
    }

    // Extract recent chat
    const contextMessages = settings.sidecarContextMessages ?? 10;
    const recentChat = extractRecentChat(contextMessages);
    if (!recentChat.trim()) {
        console.debug('[TunnelVision] Sidecar auto-retrieval: no recent chat context');
        return;
    }

    // Collect entries with evaluable conditions
    const conditionalEntries = settings.conditionalTriggersEnabled !== false
        ? await collectConditionalEntries()
        : [];
    const conditionalSection = buildConditionalSection(conditionalEntries);

    setSidecarActive(true);
    try {
        // Ask sidecar LLM to pick relevant nodes AND evaluate conditionals
        const prompt = buildRetrievalPrompt(treeOverview, recentChat, conditionalSection);
        const response = await sidecarGenerate({
            prompt,
            systemPrompt: SIDECAR_SYSTEM_PROMPT,
        });

        const { nodeIds, reasoning, conditionalEvaluations } = parseSidecarResponse(response);

        // Exit early only if nothing at all was selected
        if (nodeIds.length === 0 && conditionalEvaluations.filter(e => e.accepted).length === 0) {
            console.log('[TunnelVision] Sidecar auto-retrieval: no relevant nodes or accepted conditionals');
            clearRetrievalPrompt(settings);
            return;
        }

        // Injection settings
        const position = mapPosition(settings.mandatoryPromptPosition);
        const depth = settings.mandatoryPromptDepth ?? 1;
        const role = mapRole(settings.mandatoryPromptRole);
        const maxChars = (settings.sidecarMaxInjectionTokens ?? 4000) * 4;

        // Resolve node content (tree-based retrieval)
        let injectionParts = [];

        if (nodeIds.length > 0) {
            const nodeContent = await resolveNodeContent(nodeIds);
            if (nodeContent.trim()) {
                injectionParts.push(nodeContent);
            }
        }

        // Resolve accepted conditional entries
        if (conditionalEvaluations.length > 0) {
            const conditionalContent = await resolveConditionalContent(conditionalEvaluations, conditionalEntries);
            if (conditionalContent.trim()) {
                injectionParts.push(conditionalContent);
            }

            const acceptedCount = conditionalEvaluations.filter(e => e.accepted).length;
            const rejectedCount = conditionalEvaluations.filter(e => !e.accepted).length;
            console.log(`[TunnelVision] Conditional evaluations: ${acceptedCount} accepted, ${rejectedCount} rejected`);
            logConditionalEvaluations(conditionalEvaluations, conditionalEntries);
        }

        if (injectionParts.length === 0) {
            console.log('[TunnelVision] Sidecar auto-retrieval: nodes/conditionals selected but no content resolved');
            clearRetrievalPrompt(settings);
            return;
        }

        // Combine with framing and cap
        const framing = '[The following context has been automatically retrieved because it is relevant to the current scene. Incorporate it naturally.]\n\n';
        const injectionText = framing + injectionParts.join('\n\n');
        const capped = injectionText.length > maxChars
            ? injectionText.substring(0, maxChars) + '\n[... content truncated]'
            : injectionText;

        // IN_CHAT depth 0 = injected at the very bottom of the chat history (closest to the latest message)
        setExtensionPrompt(TV_SIDECAR_RETRIEVAL_KEY, capped, extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);

        // Resolve node labels for the feed
        const nodeLabels = nodeIds.map(id => {
            for (const bookName of activeBooks) {
                const tree = getTree(bookName);
                if (!tree?.root) continue;
                const node = findNodeById(tree.root, id);
                if (node) return node.label || id;
            }
            return id;
        });

        const _modelLabel = getSidecarModelLabel() || 'unknown';
        console.log(`[TunnelVision] Sidecar auto-retrieval [${_modelLabel}]: injected ${nodeIds.length} node(s) + ${conditionalEvaluations.filter(e => e.accepted).length} conditional(s) (~${capped.length} chars)`);
        logSidecarRetrieval({ nodeIds, nodeLabels, charCount: capped.length, reasoning });

        // Detailed console output for sidecar transparency
        console.groupCollapsed(`[TunnelVision] Sidecar retrieval details (${_modelLabel})`);
        console.log('Model:', _modelLabel);
        if (reasoning) console.log('Reasoning:', reasoning);
        if (nodeIds.length > 0) {
            console.log('Selected nodes:', nodeIds.map((id, i) => `${id} → "${nodeLabels[i] || id}"`));
        }
        if (conditionalEvaluations.length > 0) {
            console.log('Conditional evaluations:', conditionalEvaluations.map(e => {
                const ce = conditionalEntries.find(c => c.uid === e.uid);
                return `${ce?.title || `uid:${e.uid}`} → ${e.accepted ? 'ACCEPTED' : 'REJECTED'} (${e.reason})`;
            }));
        }
        console.log(`Total chars: ${capped.length} (~${Math.round(capped.length / 4)} tokens)`);
        console.groupEnd();
    } catch (error) {
        console.error('[TunnelVision] Sidecar auto-retrieval failed:', error);
        clearRetrievalPrompt(settings);
    } finally {
        setSidecarActive(false);
    }
}

/**
 * Clear the sidecar retrieval prompt (no content to inject).
 * @param {Object} settings
 */
function clearRetrievalPrompt(settings) {
    const position = mapPosition(settings.mandatoryPromptPosition);
    const depth = settings.mandatoryPromptDepth ?? 1;
    const role = mapRole(settings.mandatoryPromptRole);
    setExtensionPrompt(TV_SIDECAR_RETRIEVAL_KEY, '', position, depth, false, role);
}

/**
 * Map position setting to ST enum.
 * @param {string} val
 * @returns {number}
 */
function mapPosition(val) {
    switch (val) {
        case 'in_prompt': return extension_prompt_types.IN_PROMPT;
        case 'in_chat':
        default: return extension_prompt_types.IN_CHAT;
    }
}

/**
 * Map role setting to ST enum.
 * @param {string} val
 * @returns {number}
 */
function mapRole(val) {
    switch (val) {
        case 'user': return extension_prompt_roles.USER;
        case 'assistant': return extension_prompt_roles.ASSISTANT;
        case 'system':
        default: return extension_prompt_roles.SYSTEM;
    }
}
