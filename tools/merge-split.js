/**
 * TunnelVision_MergeSplit Tool
 * Allows the model to merge two related entries into one or split
 * a bloated entry into focused pieces. Keeps the tree index consistent.
 *
 * Actions:
 * - "merge": Combine two entries. Keeps one, absorbs+disables the other.
 * - "split": Split one entry into two. Original keeps part, new entry gets the rest.
 */

import { getSettings } from '../tree-store.js';
import { mergeEntries, splitEntry, findEntry } from '../entry-manager.js';
import { getActiveTunnelVisionBooks, resolveTargetBook, getBookListWithDescriptions } from '../tool-registry.js';

export const TOOL_NAME = 'TunnelVision_MergeSplit';

/**
 * Returns the tool definition for ToolManager.registerFunctionTool().
 * @returns {Object}
 */
export function getDefinition() {
    const bookDesc = getBookListWithDescriptions();

    return {
        name: TOOL_NAME,
        displayName: 'TunnelVision Merge/Split',
        description: `Merge two related memory entries into one, or split a large entry into focused pieces. Use merge when two entries cover the same topic and should be consolidated. Use split when one entry covers multiple distinct topics and would be better as separate entries.

Actions:
- "merge": Combine two entries into one. You must provide keep_uid (entry to keep) and remove_uid (entry to absorb). Optionally provide a rewritten merged_content and merged_title.
- "split": Divide one entry into two. You must provide the uid to split and specify what content stays (keep_content) vs. what becomes a new entry (new_content, new_title).

Available lorebooks:
${bookDesc}`,
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                lorebook: {
                    type: 'string',
                    description: `Which lorebook the entries belong to:\n${bookDesc}`,
                },
                action: {
                    type: 'string',
                    enum: ['merge', 'split'],
                    description: 'Whether to merge two entries or split one entry.',
                },
                // Merge parameters
                keep_uid: {
                    type: 'number',
                    description: 'For merge: UID of the entry to keep (receives merged content).',
                },
                remove_uid: {
                    type: 'number',
                    description: 'For merge: UID of the entry to absorb and disable.',
                },
                merged_content: {
                    type: 'string',
                    description: 'For merge: Optional rewritten content for the merged entry. If omitted, contents are concatenated.',
                },
                merged_title: {
                    type: 'string',
                    description: 'For merge: Optional new title for the merged entry.',
                },
                // Split parameters
                uid: {
                    type: 'number',
                    description: 'For split: UID of the entry to split.',
                },
                keep_content: {
                    type: 'string',
                    description: 'For split: Content that stays in the original entry.',
                },
                keep_title: {
                    type: 'string',
                    description: 'For split: Title for the original entry after splitting.',
                },
                new_content: {
                    type: 'string',
                    description: 'For split: Content for the new split-off entry.',
                },
                new_title: {
                    type: 'string',
                    description: 'For split: Title for the new split-off entry.',
                },
                new_keys: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'For split: Optional keywords for the new entry.',
                },
            },
            required: ['lorebook', 'action'],
        },
        action: async (args) => {
            if (!args?.action) {
                return 'Missing required field: action is required.';
            }

            const { book: lorebook, error } = resolveTargetBook(args.lorebook);
            if (error) return error;

            switch (args.action) {
                case 'merge': {
                    if (args.keep_uid === undefined || args.keep_uid === null) {
                        return 'Merge requires "keep_uid" — the UID of the entry to keep.';
                    }
                    if (args.remove_uid === undefined || args.remove_uid === null) {
                        return 'Merge requires "remove_uid" — the UID of the entry to absorb.';
                    }
                    try {
                        const result = await mergeEntries(
                            lorebook,
                            Number(args.keep_uid),
                            Number(args.remove_uid),
                            {
                                mergedContent: args.merged_content || null,
                                mergedTitle: args.merged_title || null,
                                hardDelete: false,
                            },
                        );
                        return `Merged entries: kept "${result.comment}" (UID ${result.uid}), absorbed "${result.removedComment}" (UID ${result.removedUid}, now disabled).`;
                    } catch (e) {
                        console.error('[TunnelVision] Merge failed:', e);
                        return `Failed to merge entries: ${e.message}`;
                    }
                }

                case 'split': {
                    if (args.uid === undefined || args.uid === null) {
                        return 'Split requires "uid" — the UID of the entry to split.';
                    }
                    if (!args.keep_content) {
                        return 'Split requires "keep_content" — what stays in the original entry.';
                    }
                    if (!args.new_content) {
                        return 'Split requires "new_content" — content for the new entry.';
                    }
                    if (!args.new_title) {
                        return 'Split requires "new_title" — title for the new entry.';
                    }
                    try {
                        const result = await splitEntry(
                            lorebook,
                            Number(args.uid),
                            {
                                keepContent: args.keep_content,
                                keepTitle: args.keep_title || null,
                                newContent: args.new_content,
                                newTitle: args.new_title,
                                newKeys: args.new_keys || [],
                            },
                        );
                        return `Split entry: original "${result.originalTitle}" (UID ${result.originalUid}) updated, new "${result.newTitle}" (UID ${result.newUid}) created in "${result.nodeLabel}".`;
                    } catch (e) {
                        console.error('[TunnelVision] Split failed:', e);
                        return `Failed to split entry: ${e.message}`;
                    }
                }

                default:
                    return `Unknown action "${args.action}". Use: merge or split.`;
            }
        },
        formatMessage: async (args) => {
            switch (args?.action) {
                case 'merge': return 'Merging memory entries...';
                case 'split': return 'Splitting memory entry...';
                default: return 'Processing entry merge/split...';
            }
        },
        shouldRegister: async () => {
            const settings = getSettings();
            if (settings.globalEnabled === false) return false;
            return getActiveTunnelVisionBooks().length > 0;
        },
        stealth: false,
    };
}
