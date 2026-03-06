/**
 * TunnelVision_Update Tool
 * Allows the model to edit existing lorebook entries mid-generation.
 * Use when information changes — character status, relationship evolution,
 * location changes, correcting outdated facts.
 */

import { getSettings } from '../tree-store.js';
import { updateEntry } from '../entry-manager.js';
import { getActiveTunnelVisionBooks, resolveTargetBook, getBookListWithDescriptions } from '../tool-registry.js';

export const TOOL_NAME = 'TunnelVision_Update';

/**
 * Returns the tool definition for ToolManager.registerFunctionTool().
 * @returns {Object}
 */
export function getDefinition() {
    const bookDesc = getBookListWithDescriptions();

    return {
        name: TOOL_NAME,
        displayName: 'TunnelVision Update',
        description: `Update an existing memory entry when information has changed. Use this when a character's status changes, a relationship evolves, a location is altered, or any previously stored fact becomes outdated.

This is especially important for TRACKER entries — structured entries that track character moods, inventory, relationships, positions, stats, etc. When updating a tracker, preserve its schema format (headers, key:value pairs, structure) and only change the values that actually changed. Do not rewrite the entire tracker unless the schema itself needs revision.

You must know the entry's UID (obtained from a previous TunnelVision_Search retrieve action) and which lorebook it belongs to.

Available lorebooks:
${bookDesc}`,
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                lorebook: {
                    type: 'string',
                    description: `Which lorebook the entry belongs to. Choose based on where the entry lives:\n${bookDesc}`,
                },
                uid: {
                    type: 'number',
                    description: 'The UID of the entry to update (from a previous search/retrieve result).',
                },
                content: {
                    type: 'string',
                    description: 'New content to replace the existing entry content. Write the complete updated version.',
                },
                title: {
                    type: 'string',
                    description: 'Optional new title/comment for the entry.',
                },
                keys: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional new keywords to replace existing ones.',
                },
            },
            required: ['lorebook', 'uid'],
        },
        action: async (args) => {
            if (args?.uid === undefined || args?.uid === null) {
                return 'Missing required field: uid is required.';
            }

            const { book: lorebook, error } = resolveTargetBook(args.lorebook);
            if (error) return error;

            // Must provide at least one thing to update
            if (!args.content && !args.title && !args.keys) {
                return 'Nothing to update. Provide at least one of: content, title, or keys.';
            }

            try {
                const updates = {};
                if (args.content) updates.content = args.content;
                if (args.title) updates.comment = args.title;
                if (args.keys) updates.keys = args.keys;

                const result = await updateEntry(lorebook, Number(args.uid), updates);
                return `Updated entry "${result.comment}" (UID ${result.uid}): changed ${result.updated.join(', ')}.`;
            } catch (e) {
                console.error('[TunnelVision] Update failed:', e);
                return `Failed to update entry: ${e.message}`;
            }
        },
        formatMessage: async () => 'Updating memory entry...',
        shouldRegister: async () => {
            const settings = getSettings();
            if (settings.globalEnabled === false) return false;
            return getActiveTunnelVisionBooks().length > 0;
        },
        stealth: false,
    };
}
