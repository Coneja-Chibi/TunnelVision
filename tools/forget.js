/**
 * TunnelVision_Forget Tool
 * Allows the model to disable or remove lorebook entries mid-generation.
 * Use when information becomes irrelevant — a character dies permanently,
 * a location is destroyed, or a fact is proven false.
 *
 * Default is soft-delete (disable). Hard delete requires explicit flag.
 */

import { getSettings } from '../tree-store.js';
import { forgetEntry } from '../entry-manager.js';
import { getActiveTunnelVisionBooks, resolveTargetBook, getBookListWithDescriptions } from '../tool-registry.js';

export const TOOL_NAME = 'TunnelVision_Forget';

/**
 * Returns the tool definition for ToolManager.registerFunctionTool().
 * @returns {Object}
 */
export function getDefinition() {
    const bookDesc = getBookListWithDescriptions();

    return {
        name: TOOL_NAME,
        displayName: 'TunnelVision Forget',
        description: `Remove outdated or irrelevant information from long-term memory. Use when a character dies permanently, a location is destroyed, a fact is proven false, or stored information is no longer relevant.

By default, entries are disabled (soft-deleted) and can be re-enabled by the user. Use permanent=true only when the information is definitively wrong or harmful.

Available lorebooks:
${bookDesc}`,
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                lorebook: {
                    type: 'string',
                    description: `Which lorebook the entry belongs to:\n${bookDesc}`,
                },
                uid: {
                    type: 'number',
                    description: 'The UID of the entry to forget (from a previous search/retrieve result).',
                },
                reason: {
                    type: 'string',
                    description: 'Brief explanation of why this memory is being removed.',
                },
                permanent: {
                    type: 'boolean',
                    description: 'If true, permanently delete instead of just disabling. Default: false.',
                },
            },
            required: ['lorebook', 'uid', 'reason'],
        },
        action: async (args) => {
            if (args?.uid === undefined || args?.uid === null || !args?.reason) {
                return 'Missing required fields: uid and reason are required.';
            }

            const { book: lorebook, error } = resolveTargetBook(args.lorebook);
            if (error) return error;

            try {
                const result = await forgetEntry(
                    lorebook,
                    Number(args.uid),
                    args.permanent === true,
                );
                console.log(`[TunnelVision] Forget reason: ${args.reason}`);
                return `${result.action === 'deleted' ? 'Permanently deleted' : 'Disabled'} memory: "${result.comment}" (UID ${result.uid}). Reason: ${args.reason}`;
            } catch (e) {
                console.error('[TunnelVision] Forget failed:', e);
                return `Failed to forget entry: ${e.message}`;
            }
        },
        formatMessage: async () => 'Removing from long-term memory...',
        shouldRegister: async () => {
            const settings = getSettings();
            if (settings.globalEnabled === false) return false;
            return getActiveTunnelVisionBooks().length > 0;
        },
        stealth: false,
    };
}
