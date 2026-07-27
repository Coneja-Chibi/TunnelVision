/**
 * TunnelVision_Remember Tool
 * Allows the model to create new lorebook entries mid-generation.
 * The entry is saved to the lorebook and automatically assigned to a tree node.
 *
 * Duplicate detection prefers embedding cosine when an embedding profile is
 * configured, since character overlap cannot see a duplicate that was reworded.
 * It falls back to trigram similarity — fast character n-gram overlap that
 * catches morphological variants — when no embedding endpoint is available, or
 * if embedding fails.
 *
 * Each metric has its own threshold: `vectorDedupThreshold` (cosine, default
 * 0.85) and `trigramDedupThreshold` (Jaccard, default 0.6). They are not
 * interchangeable — 0.85 cosine means "these mean the same thing", while 0.85
 * trigram means "these are nearly the same string".
 *
 * The warning is non-blocking: the entry is always saved regardless of duplicates found.
 */

import { loadWorldInfo } from '../../../../world-info.js';
import { getSettings } from '../tree-store.js';
import { isEmbeddingAvailable, findSimilarByEmbedding } from '../embedding-cache.js';
import { createEntry } from '../entry-manager.js';
import { getWritableBooks, resolveTargetBook, getBookListWithDescriptions } from '../tool-registry.js';
import { getLanguageInstruction } from '../agent-utils.js';
import { SECRET_AUTHORING_INSTRUCTION } from '../shared-utils.js';
import { TOOL_NAME as UPDATE_TOOL_NAME } from './update.js';

export const TOOL_NAME = 'TunnelVision_Remember';
export const COMPACT_DESCRIPTION = 'Save a new fact, character detail, relationship, or world-building info to long-term memory.';

// ─── Trigram Similarity ─────────────────────────────────────────

/**
 * Build a set of character trigrams from a string.
 * Pads with spaces so edge characters get represented.
 * @param {string} s
 * @returns {Set<string>}
 */
function trigrams(s) {
    const norm = `  ${s.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()}  `;
    const set = new Set();
    for (let i = 0; i <= norm.length - 3; i++) {
        set.add(norm.substring(i, i + 3));
    }
    return set;
}

/**
 * Compute trigram similarity between two strings.
 * Returns 0-1 where 1 = identical trigram sets.
 * Catches partial words, typos, and morphological variants.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function trigramSimilarity(a, b) {
    const setA = trigrams(a);
    const setB = trigrams(b);
    if (setA.size === 0 && setB.size === 0) return 1;
    if (setA.size === 0 || setB.size === 0) return 0;

    let intersection = 0;
    for (const tri of setA) {
        if (setB.has(tri)) intersection++;
    }
    return intersection / (setA.size + setB.size - intersection);
}

// ─── Dedup ──────────────────────────────────────────────────────

/**
 * Find similar entries by embedding cosine — catches reworded duplicates that
 * character-trigram overlap cannot ("Keppler's Drift" vs "Keppler's Drift as a
 * Potential Destination" share little literal text but describe one subject).
 *
 * Delegates to embedding-cache.js so entry vectors are shared with the smart
 * context pipeline: same two-tier cache, same content-hash invalidation, so a
 * Remember call costs one embedding for the new text rather than re-embedding
 * the whole book.
 * @param {string} bookName
 * @param {string} newContent
 * @param {string} newTitle
 * @param {number} threshold - 0-1 cosine threshold
 * @returns {Promise<Array<{uid: number, comment: string, similarity: number}>>}
 */
async function findSimilarEntriesSemantic(bookName, newContent, newTitle, threshold) {
    const bookData = await loadWorldInfo(bookName);
    if (!bookData?.entries) return [];

    const candidates = Object.keys(bookData.entries)
        .map(key => bookData.entries[key])
        .filter(entry => !entry.disable && (entry.content || entry.comment))
        .map(entry => ({ entry, bookName }));
    if (candidates.length === 0) return [];

    return findSimilarByEmbedding(candidates, `${newTitle} ${newContent}`, threshold);
}

/**
 * Find similar entries in a lorebook using trigram similarity.
 * @param {string} bookName
 * @param {string} newContent
 * @param {string} newTitle
 * @param {number} threshold - 0-1 similarity threshold
 * @returns {Promise<Array<{uid: number, comment: string, similarity: number}>>}
 */
async function findSimilarEntries(bookName, newContent, newTitle, threshold) {
    const bookData = await loadWorldInfo(bookName);
    if (!bookData?.entries) return [];

    const newText = `${newTitle} ${newContent}`;
    const matches = [];

    for (const key of Object.keys(bookData.entries)) {
        const entry = bookData.entries[key];
        if (entry.disable) continue;

        const existingText = `${entry.comment || ''} ${entry.content || ''}`;
        const sim = trigramSimilarity(newText, existingText);

        if (sim >= threshold) {
            matches.push({
                uid: entry.uid,
                comment: entry.comment || `Entry #${entry.uid}`,
                similarity: Math.round(sim * 100),
            });
        }
    }

    matches.sort((a, b) => b.similarity - a.similarity);
    return matches.slice(0, 3);
}

// ─── Tool Definition ────────────────────────────────────────────

/**
 * Returns the tool definition for ToolManager.registerFunctionTool().
 * @returns {Object}
 */
export function getDefinition() {
    const bookDesc = getBookListWithDescriptions({ writableOnly: true });

    return {
        name: TOOL_NAME,
        displayName: 'TunnelVision Remember',
        description: `Save new information to long-term memory. Use this when important new facts, events, character developments, relationship changes, or world details emerge in the conversation that should be remembered for future scenes.

You can also use this to create TRACKER entries — structured schemas for tracking things like character moods, inventory, relationships, positions, or any other state that changes over time. When creating a tracker, design a clear structured format (use headers, bullet points, key:value pairs) that will be easy to update later with TunnelVision_Update. The user may ask you to help design a tracker schema — propose a structured format, discuss it with them, and save the final version.

Available lorebooks:
${bookDesc}

Save entries to the lorebook where they belong based on the descriptions above. Provide a descriptive title, the content to remember, optional keywords for cross-referencing, and optionally a tree node_id to file it under (omit to place at root).`,
        parameters: {
            type: 'object',
            properties: {
                lorebook: {
                    type: 'string',
                    description: `Which lorebook to save to. Choose based on content type:\n${bookDesc}`,
                },
                title: {
                    type: 'string',
                    description: 'A short, descriptive title for this memory (e.g. "Elena learned about the curse", "Tavern layout").',
                },
                content: {
                    type: 'string',
                    description: `The information to store. Write in third person, factual style. Include relevant names, places, and details.${SECRET_AUTHORING_INSTRUCTION}${getLanguageInstruction()}`,
                },
                keys: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional keywords for cross-referencing (e.g. ["Elena", "curse", "dark magic"]).',
                },
                node_id: {
                    type: 'string',
                    description: 'Optional tree node ID to file this entry under. Omit to place at the root level.',
                },
                force: {
                    type: 'boolean',
                    description: 'Save even if this closely matches an existing entry. Only set this after being shown near-duplicates and deciding the new information is genuinely distinct — otherwise prefer updating the existing entry.',
                },
            },
            required: ['lorebook', 'title', 'content'],
        },
        action: async (args) => {
            if (!args?.title || !args?.content) {
                return 'Missing required fields: title and content are required.';
            }

            const { book: lorebook, error } = resolveTargetBook(args.lorebook, { checkWrite: true });
            if (error) return error;

            // Dedup check (non-blocking — warns but still saves).
            //
            // Two metrics, two thresholds. `vectorDedupThreshold` (0.85) is a
            // COSINE threshold: as trigram-Jaccard it means "nearly the same
            // string", which reworded duplicates never reach — so applying it to
            // the trigram path made the check silently inert. Use embeddings when
            // an embedding profile is configured; fall back to trigram at its own,
            // looser default otherwise.
            let dedupWarning = '';
            const settings = getSettings();
            if (settings.enableVectorDedup) {
                let matches = [];
                let metric = 'trigram';
                if (isEmbeddingAvailable()) {
                    const threshold = settings.vectorDedupThreshold || 0.85;
                    try {
                        matches = await findSimilarEntriesSemantic(
                            lorebook, args.content, args.title, threshold,
                        );
                        metric = 'embedding';
                    } catch (e) {
                        // A dedup failure must never cost the caller their memory.
                        console.warn('[TunnelVision] Embedding dedup failed, falling back to trigram:', e);
                    }
                }
                if (metric === 'trigram') {
                    const threshold = settings.trigramDedupThreshold || 0.6;
                    matches = await findSimilarEntries(
                        lorebook, args.content, args.title, threshold,
                    );
                }
                if (matches.length > 0) {
                    const lines = matches.map(
                        m => `  - "${m.comment}" (UID ${m.uid}, ${m.similarity}% match)`,
                    );
                    console.log(`[TunnelVision] Dedup (${metric}): ${matches.length} similar entries for "${args.title}"`);

                    // 'redirect' declines the write and hands back the UIDs, so the
                    // model has to choose Update. Advisory text appended AFTER a
                    // successful save is ignored in practice — the entry already
                    // exists by the time the model reads it, and nothing makes it
                    // go back. `force` is the escape hatch for a genuine near-miss.
                    const mode = settings.rememberDedupMode || 'warn';
                    if (mode === 'redirect' && !args.force) {
                        return `Not saved — "${args.title}" closely matches existing entries:\n${lines.join('\n')}\n`
                            + `Use ${UPDATE_TOOL_NAME} with the correct UID to revise or extend one of them. `
                            + `If this really is distinct information, call this tool again with force=true.`;
                    }
                    dedupWarning = `\n⚠ Similar entries found:\n${lines.join('\n')}\nConsider using the Update tool instead if this is the same information.`;
                }
            }

            try {
                const result = await createEntry(lorebook, {
                    content: args.content,
                    comment: args.title,
                    keys: args.keys || [],
                    nodeId: args.node_id,
                    tv_tracker: args.tv_tracker,
                });
                return `Saved memory: "${result.comment}" (UID ${result.uid}) → category "${result.nodeLabel}" in "${lorebook}".${dedupWarning}`;
            } catch (e) {
                console.error('[TunnelVision] Remember failed:', e);
                return `Failed to save memory: ${e.message}`;
            }
        },
        formatMessage: async () => 'Saving to long-term memory...',
        shouldRegister: async () => {
            const settings = getSettings();
            if (settings.globalEnabled === false) return false;
            return getWritableBooks().length > 0;
        },
        stealth: false,
    };
}
