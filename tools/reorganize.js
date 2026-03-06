/**
 * TunnelVision_Reorganize Tool
 * Allows the model to restructure the tree index mid-generation.
 * Move entries between categories or create new categories as the
 * lorebook grows and the existing structure no longer fits.
 */

import { getTree, findNodeById, getSettings, getAllEntryUids } from '../tree-store.js';
import { moveEntry, createCategory, listNodeEntries } from '../entry-manager.js';
import { getActiveTunnelVisionBooks, resolveTargetBook, getBookListWithDescriptions } from '../tool-registry.js';

export const TOOL_NAME = 'TunnelVision_Reorganize';

/**
 * Returns the tool definition for ToolManager.registerFunctionTool().
 * @returns {Object}
 */
export function getDefinition() {
    const bookDesc = getBookListWithDescriptions();

    return {
        name: TOOL_NAME,
        displayName: 'TunnelVision Reorganize',
        description: `Reorganize the knowledge tree structure. Use this to move entries between categories or create new categories when the existing tree structure doesn't adequately organize the stored knowledge.

Actions:
- "move": Move an entry from its current node to a different node
- "create_category": Create a new category node under a parent
- "list_entries": List entries in a specific node (to find UIDs for moving)

Available lorebooks:
${bookDesc}`,
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                lorebook: {
                    type: 'string',
                    description: `Which lorebook to reorganize:\n${bookDesc}`,
                },
                action: {
                    type: 'string',
                    enum: ['move', 'create_category', 'list_entries'],
                    description: 'The reorganization action to perform.',
                },
                uid: {
                    type: 'number',
                    description: 'Entry UID to move (required for "move" action).',
                },
                target_node_id: {
                    type: 'string',
                    description: 'Destination node ID for "move", or parent node ID for "create_category".',
                },
                label: {
                    type: 'string',
                    description: 'Name for the new category (required for "create_category").',
                },
                node_id: {
                    type: 'string',
                    description: 'Node ID to list entries from (required for "list_entries").',
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
                case 'move': {
                    if (args.uid === undefined || args.uid === null || !args.target_node_id) {
                        return 'Move requires both "uid" and "target_node_id".';
                    }
                    try {
                        const result = await moveEntry(lorebook, Number(args.uid), args.target_node_id);
                        return `Moved entry UID ${result.uid}: "${result.fromLabel}" → "${result.toLabel}".`;
                    } catch (e) {
                        console.error('[TunnelVision] Move failed:', e);
                        return `Failed to move entry: ${e.message}`;
                    }
                }

                case 'create_category': {
                    if (!args.label) {
                        return 'create_category requires a "label" for the new category.';
                    }
                    try {
                        const result = createCategory(lorebook, args.label, args.target_node_id || null);
                        return `Created category "${result.label}" (ID: ${result.nodeId}) under "${result.parentLabel}".`;
                    } catch (e) {
                        console.error('[TunnelVision] Create category failed:', e);
                        return `Failed to create category: ${e.message}`;
                    }
                }

                case 'list_entries': {
                    if (!args.node_id) {
                        return 'list_entries requires a "node_id" to list entries from.';
                    }
                    try {
                        const entries = await listNodeEntries(lorebook, args.node_id);
                        if (entries.length === 0) {
                            return `Node has no entries.`;
                        }
                        const lines = entries.map(e =>
                            `  - UID ${e.uid}: "${e.comment}" — ${e.contentPreview}...`,
                        );
                        return `Entries in node (${entries.length}):\n${lines.join('\n')}`;
                    } catch (e) {
                        console.error('[TunnelVision] List entries failed:', e);
                        return `Failed to list entries: ${e.message}`;
                    }
                }

                default:
                    return `Unknown action "${args.action}". Use: move, create_category, or list_entries.`;
            }
        },
        formatMessage: async (args) => {
            switch (args?.action) {
                case 'move': return 'Moving memory entry...';
                case 'create_category': return 'Creating new category...';
                case 'list_entries': return 'Listing entries...';
                default: return 'Reorganizing knowledge tree...';
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
