/**
 * TunnelVision_Summarize Tool
 * Model-driven scene/event summarization. The AI decides when something is
 * worth summarizing — this is NOT interval-based or automatic.
 *
 * Creates temporal summary entries (what happened) as distinct from Remember's
 * entity/fact entries (what exists). Summaries capture scenes, events, and
 * narrative beats that the AI determines are significant enough to persist.
 *
 * Summaries are filed under a dedicated "Summaries" category node in the tree,
 * auto-created if it doesn't exist. This keeps temporal knowledge separate from
 * referential knowledge (characters, locations, rules, etc.).
 */

import { getTree, findNodeById, createTreeNode, saveTree, getSettings } from '../tree-store.js';
import { createEntry } from '../entry-manager.js';
import { getWritableBooks, resolveTargetBook, getBookListWithDescriptions } from '../tool-registry.js';
import { markAutoSummaryComplete } from '../auto-summary.js';
import { getLanguageInstruction } from '../agent-utils.js';
import { getContext } from '../../../../st-context.js';
import { hideChatMessageRange } from '../../../../chats.js';

export const TOOL_NAME = 'TunnelVision_Summarize';
export const COMPACT_DESCRIPTION = 'Create a scene or event summary to preserve significant narrative beats in long-term memory.';

const SUMMARIES_NODE_LABEL = 'Summaries';
const WATERMARK_KEY = 'tunnelvision_summary_watermark';
const PENDING_HIDE_KEY = 'tunnelvision_pending_summary_hide';

/**
 * Get the last-summarized message ID watermark for the current chat.
 * @returns {number} The message ID after which no summary has covered, or -1 if none.
 */
export function getWatermark() {
    const context = getContext();
    const val = context.chatMetadata?.[WATERMARK_KEY];
    return typeof val === 'number' ? val : -1;
}

/**
 * Set the last-summarized message ID watermark for the current chat.
 * @param {number} messageId
 */
export function setWatermark(messageId) {
    const context = getContext();
    context.chatMetadata[WATERMARK_KEY] = messageId;
}

/**
 * Compute the message range that can be hidden after a summary.
 * @param {number|undefined} messagesBack - How many messages back the summary covers.
 * @param {number|undefined} overrideStart - Explicit start message ID (used by auto-summary).
 * @param {number|undefined} overrideEnd - Explicit end message ID (used by auto-summary).
 * @returns {{ start: number, end: number, visibleCount: number, currentMsgId: number }|null}
 */
function getSummarizedHideRange(messagesBack, overrideStart, overrideEnd) {
    const settings = getSettings();
    if (!settings.autoHideSummarized) return null;

    const context = getContext();
    const chat = context.chat;
    if (!chat || chat.length < 2) return null;

    const currentMsgId = chat.length - 1;
    let hideStart, hideEnd;

    if (typeof overrideStart === 'number' && typeof overrideEnd === 'number') {
        // Explicit range from auto-summary
        hideStart = overrideStart;
        hideEnd = overrideEnd;
    } else if (typeof messagesBack === 'number' && messagesBack > 0) {
        // AI-provided range: hide OLD messages that the summary now makes redundant.
        // The summary covers the last N messages, so those should stay visible.
        // Hide everything BEFORE them (from after the last watermark up to the
        // start of the recent window).
        const watermark = getWatermark();
        hideStart = Math.max(1, watermark < 0 ? 1 : watermark + 1);
        hideEnd = Math.max(0, currentMsgId - messagesBack - 1);
    } else {
        // Fallback: use watermark
        const watermark = getWatermark();
        if (watermark < 0) {
            // Watermark has never been set (first-ever summary in this chat).
            console.log('[TunnelVision] Skipping auto-hide: no watermark set yet (first summary in this chat). Setting watermark to current position.');
            setWatermark(currentMsgId - 1);
            return null;
        }
        hideStart = watermark + 1;
        hideEnd = currentMsgId - 1;
    }

    // Sanity checks
    if (hideStart > hideEnd || hideStart < 0 || hideEnd < 0) return null;
    // Don't hide message 0 (first message / greeting)
    if (hideStart === 0) hideStart = 1;
    if (hideStart > hideEnd) return null;

    // Don't re-hide already hidden messages — count only visible ones
    let visibleCount = 0;
    for (let i = hideStart; i <= hideEnd; i++) {
        if (chat[i] && !chat[i].is_system) visibleCount++;
    }
    if (visibleCount === 0) return null;

    return { start: hideStart, end: hideEnd, visibleCount, currentMsgId };
}

function setPendingSummaryHide(range) {
    if (!range) return;
    const context = getContext();
    if (!context.chatMetadata) return;
    context.chatMetadata[PENDING_HIDE_KEY] = {
        start: range.start,
        end: range.end,
        visibleCount: range.visibleCount,
        currentMsgId: range.currentMsgId,
    };
    context.saveMetadataDebounced?.();
}

/**
 * Hide messages covered by a summary, using either messages_back or the watermark.
 * Exported so auto-summary can also call it.
 * @param {number|undefined} messagesBack - How many messages back the summary covers.
 * @param {number|undefined} overrideStart - Explicit start message ID (used by auto-summary).
 * @param {number|undefined} overrideEnd - Explicit end message ID (used by auto-summary).
 * @returns {Promise<string|null>} Status message or null if nothing was hidden.
 */
export async function hideSummarizedMessages(messagesBack, overrideStart, overrideEnd) {
    const range = getSummarizedHideRange(messagesBack, overrideStart, overrideEnd);
    if (!range) return null;

    try {
        await hideChatMessageRange(range.start, range.end, false);
        setWatermark(range.end);
        console.log(`[TunnelVision] Hid messages ${range.start}-${range.end} (${range.visibleCount} visible) after summary`);
        return `Hidden ${range.visibleCount} summarized messages (${range.start}-${range.end}).`;
    } catch (e) {
        console.error('[TunnelVision] Failed to hide summarized messages:', e);
        return null;
    }
}

export async function flushPendingSummaryHide() {
    const context = getContext();
    const pending = context.chatMetadata?.[PENDING_HIDE_KEY];
    if (!pending) return null;

    delete context.chatMetadata[PENDING_HIDE_KEY];
    context.saveMetadataDebounced?.();

    if (!getSettings().autoHideSummarized) return null;
    const chat = context.chat;
    if (!chat || pending.start > pending.end) return null;

    const maxSafeEnd = Math.min(Number(pending.end), chat.length - 2);
    const start = Math.max(1, Number(pending.start));
    if (!Number.isFinite(start) || !Number.isFinite(maxSafeEnd) || start > maxSafeEnd) return null;

    let visibleCount = 0;
    for (let i = start; i <= maxSafeEnd; i++) {
        if (chat[i] && !chat[i].is_system) visibleCount++;
    }
    if (visibleCount === 0) {
        setWatermark(maxSafeEnd);
        return null;
    }

    try {
        await hideChatMessageRange(start, maxSafeEnd, false);
        setWatermark(maxSafeEnd);
        console.log(`[TunnelVision] Hid messages ${start}-${maxSafeEnd} (${visibleCount} visible) after final response`);
        return `Hidden ${visibleCount} summarized messages (${start}-${maxSafeEnd}).`;
    } catch (e) {
        console.error('[TunnelVision] Failed to flush pending summarized messages:', e);
        return null;
    }
}

/**
 * Find or create the "Summaries" node in a lorebook's tree.
 * Returns the node ID. Creates the node under root if it doesn't exist.
 * @param {string} bookName
 * @returns {string|null} Node ID of the Summaries category, or null if no tree
 */
export function ensureSummariesNode(bookName) {
    let tree = getTree(bookName);
    if (!tree || !tree.root) {
        // No tree exists yet -- create a minimal one so summaries have a home
        const root = createTreeNode('Root', `Top-level index for ${bookName}`);
        tree = { lorebookName: bookName, root, version: 1, lastBuilt: Date.now() };
        saveTree(bookName, tree);
        console.log(`[TunnelVision] Created minimal tree for "${bookName}" to host summaries`);
    }

    // Look for existing Summaries node (direct child of root)
    for (const child of (tree.root.children || [])) {
        if (child.label === SUMMARIES_NODE_LABEL) {
            return child.id;
        }
    }

    // Create it
    const node = createTreeNode(SUMMARIES_NODE_LABEL, 'Temporal scene summaries and event records created by the AI.');
    tree.root.children.push(node);
    saveTree(bookName, tree);
    console.log(`[TunnelVision] Created "${SUMMARIES_NODE_LABEL}" category in "${bookName}"`);
    return node.id;
}

/**
 * Returns the tool definition for ToolManager.registerFunctionTool().
 * @returns {Object}
 */
export function getDefinition() {
    const bookDesc = getBookListWithDescriptions({ writableOnly: true });

    return {
        name: TOOL_NAME,
        displayName: 'TunnelVision Summarize',
        description: `Create a summary of a significant scene, event, or narrative beat for long-term memory. Use this when something important happens that should be remembered as a discrete event — a major conversation, a battle, a discovery, an emotional turning point, or any scene transition worth recording.

This is different from Remember: Remember stores facts and entity information (who someone is, what a place looks like). Summarize stores what happened (events, scenes, narrative beats).

Write summaries in past tense, third person, capturing the key actions, participants, outcomes, and emotional beats. Be concise but thorough — this summary replaces the need to re-read the full scene.

Available lorebooks:
${bookDesc}

Provide messages_back to indicate roughly how many messages this summary covers (counting back from current). Summarized messages may be hidden from chat to save tokens — the summary preserves them.

When you notice related events forming a pattern or storyline, group them into "arcs" (narrative threads). Proactively create a new arc with create_arc when a new story thread emerges, and assign subsequent related summaries to it with arc_node_id. You can also use TunnelVision_Reorganize to move earlier summaries into an arc retroactively.`,
        parameters: {
            type: 'object',
            properties: {
                lorebook: {
                    type: 'string',
                    description: `Which lorebook to save the summary to. Choose based on content type:\n${bookDesc}`,
                },
                title: {
                    type: 'string',
                    description: 'A short, descriptive title for this event/scene (e.g. "The Ambush at Thornfield Bridge", "Sable confesses her fears to Ren").',
                },
                summary: {
                    type: 'string',
                    description: `The scene/event summary. Write in past tense, third person. Include who was involved, what happened, key outcomes, and emotional beats.${getLanguageInstruction()}`,
                },
                participants: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Names of characters/entities involved in this event. Used as keywords for cross-referencing.',
                },
                significance: {
                    type: 'string',
                    enum: ['minor', 'moderate', 'major', 'critical'],
                    description: 'How significant is this event? Helps with future retrieval priority. "minor" = flavor/ambiance, "moderate" = plot-relevant, "major" = changes character/world state, "critical" = turning point.',
                },
                arc_node_id: {
                    type: 'string',
                    description: 'Optional: Assign this summary to an existing arc (narrative thread). Provide the arc node ID.',
                },
                create_arc: {
                    type: 'string',
                    description: 'Optional: Create a new arc (narrative thread) with this name. The summary will be the first entry in the arc. Use this when a new story thread begins.',
                },
                messages_back: {
                    type: 'number',
                    description: 'How many messages back this summary covers (from the current message). E.g. 15 means this summary covers the last 15 messages. Used to hide summarized messages from chat context.',
                },
            },
            required: ['lorebook', 'title', 'summary'],
        },
        action: async (args) => {
            if (!args?.title || !args?.summary) {
                return 'Missing required fields: title and summary are required.';
            }

            const { book: lorebook, error } = resolveTargetBook(args.lorebook, { checkWrite: true });
            if (error) return error;

            // Ensure the Summaries category exists
            const summariesNodeId = ensureSummariesNode(lorebook);

            // Determine target node (summaries, arc, or new arc)
            let targetNodeId = summariesNodeId;
            let arcLabel = null;

            if (args.create_arc) {
                // Create a new arc node under Summaries
                const tree = getTree(lorebook);
                if (tree && tree.root) {
                    const summNode = findNodeById(tree.root, summariesNodeId);
                    if (summNode) {
                        const arcNode = createTreeNode(args.create_arc, '');
                        arcNode.isArc = true;
                        summNode.children = summNode.children || [];
                        summNode.children.push(arcNode);
                        saveTree(lorebook, tree);
                        targetNodeId = arcNode.id;
                        arcLabel = args.create_arc;
                        console.log(`[TunnelVision] Created arc "${args.create_arc}" (${arcNode.id})`);
                    }
                }
            } else if (args.arc_node_id) {
                // Assign to existing arc
                const tree = getTree(lorebook);
                if (tree && tree.root) {
                    const arcNode = findNodeById(tree.root, args.arc_node_id);
                    if (arcNode) {
                        targetNodeId = args.arc_node_id;
                        arcLabel = arcNode.label;
                    }
                }
            }

            // Build content with metadata prefix
            const significance = args.significance || 'moderate';
            const participantList = Array.isArray(args.participants) && args.participants.length > 0
                ? args.participants.join(', ')
                : '(unspecified)';

            const content = `[Scene Summary — ${significance}]\nParticipants: ${participantList}\n\n${args.summary.trim()}`;

            // Build keys from participants + significance
            const keys = [];
            if (Array.isArray(args.participants)) {
                keys.push(...args.participants.map(p => String(p).trim()).filter(Boolean));
            }
            keys.push(`summary:${significance}`);

            try {
                const result = await createEntry(lorebook, {
                    content,
                    comment: `[Summary] ${args.title}`,
                    keys,
                    nodeId: targetNodeId,
                    tv_tracker: args.tv_tracker,
                });
                markAutoSummaryComplete();
                let response = `Summarized: "${args.title}" (UID ${result.uid}) → "${result.nodeLabel}" in "${lorebook}". Significance: ${significance}.`;
                if (arcLabel) {
                    response += ` Arc: "${arcLabel}".`;
                }

                // Defer hiding until after the final narrative response. Hiding
                // during a tool-call pass changes the context for ST's recursive
                // generation and can make the model continue from an old scene.
                const hideRange = getSummarizedHideRange(args.messages_back);
                if (hideRange) {
                    setPendingSummaryHide(hideRange);
                    response += ` ${hideRange.visibleCount} summarized messages will be hidden after the response.`;
                }

                return response;
            } catch (e) {
                console.error('[TunnelVision] Summarize failed:', e);
                return `Failed to save summary: ${e.message}`;
            }
        },
        formatMessage: async () => 'Summarizing scene for long-term memory...',
        shouldRegister: async () => {
            const settings = getSettings();
            if (settings.globalEnabled === false) return false;
            return getWritableBooks().length > 0;
        },
        stealth: false,
    };
}
