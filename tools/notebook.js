/**
 * TunnelVision_Notebook Tool
 * A private scratchpad for the AI's own working memory.
 * Notes persist per-chat via chat_metadata and are injected into context
 * every turn so the AI always sees its own notes.
 *
 * Unlike Remember (permanent lorebook facts) or Summarize (event records),
 * Notebook is ephemeral and tactical: plans, follow-ups, things to weave
 * back in, questions to ask later, narrative threads to track.
 *
 * Data lives in chat_metadata.tunnelvision_notebook (array of note objects).
 * Not stealth by default (stealth breaks co-invocation with other tools in ST).
 * Use global Stealth Mode toggle to hide all tool calls including Notebook.
 */

import { getContext } from '../../../../st-context.js';
import { getSettings } from '../tree-store.js';
import { getActiveTunnelVisionBooks } from '../tool-registry.js';

export const TOOL_NAME = 'TunnelVision_Notebook';
export const COMPACT_DESCRIPTION = 'Read or write to the character notebook for freeform notes and planning.';

const METADATA_KEY = 'tunnelvision_notebook';
const MAX_NOTES = 50;

/**
 * Per-generation write guard — prevents the model from looping on Notebook
 * (write → see result → remove → rewrite → repeat until depth limit).
 * Tracks note IDs written this generation cycle. Reset on each new generation.
 */
let _writeGuard = { generationId: 0, writtenTitles: new Set(), writeCount: 0, operationCount: 0 };
const MAX_WRITES_PER_GENERATION = 3;
const MAX_OPS_PER_GENERATION = 10;

/** Call at the start of each generation to reset the write guard. */
export function resetNotebookWriteGuard() {
    _writeGuard = { generationId: Date.now(), writtenTitles: new Set(), writeCount: 0, operationCount: 0 };
}

/**
 * Get the notebook array from chat metadata. Creates it if missing.
 * @returns {Array<{id: string, title: string, content: string, created: number}>}
 */
function getNotebook() {
    const context = getContext();
    if (!context.chatMetadata[METADATA_KEY]) {
        context.chatMetadata[METADATA_KEY] = [];
    }
    return context.chatMetadata[METADATA_KEY];
}

/**
 * Save notebook changes to chat metadata.
 */
function saveNotebook() {
    const context = getContext();
    context.saveMetadataDebounced();
}

/**
 * Build the notebook content string for injection into the AI's context.
 * Returns empty string if no notes exist.
 * @returns {string}
 */
export function buildNotebookPrompt() {
    const context = getContext();
    const notes = context.chatMetadata?.[METADATA_KEY];
    if (!notes || notes.length === 0) return '';

    const lines = notes.map(n => `- [${n.id}] ${n.title}: ${n.content}`);
    return `[Your private notebook (only you can see this). These are notes you wrote to yourself. Use them to inform your responses, follow up on plans, and maintain narrative threads.]\n${lines.join('\n')}`;
}

/**
 * Returns the tool definition for ToolManager.registerFunctionTool().
 * @returns {Object}
 */
export function getDefinition() {
    return {
        name: TOOL_NAME,
        displayName: 'TunnelVision Notebook',
        description: `Your private scratchpad. Write notes to yourself that persist across turns. Use this for:
- Plans and intentions ("I should bring up the letter again in 2-3 turns")
- Follow-ups ("Ask about Sable's reaction to the bridge scene next time it's relevant")
- Narrative threads to weave back in ("Ren hasn't mentioned his sister since the argument")
- Reminders about tone, pacing, or character voice
- Any working memory that helps you write better responses

This is different from Remember: Remember saves permanent facts to the lorebook. Notebook is your private tactical scratchpad that only you see. Notes are injected into your context every turn.

Actions:
- "write": Add a new note (provide title and content)
- "read": View all your current notes
- "remove": Delete a note by ID (when it's no longer needed)
- "clear": Remove all notes (fresh start)`,
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['write', 'read', 'remove', 'clear'],
                    description: 'The notebook action to perform.',
                },
                title: {
                    type: 'string',
                    description: 'Short title for the note (required for "write").',
                },
                content: {
                    type: 'string',
                    description: 'Note content (required for "write").',
                },
                note_id: {
                    type: 'string',
                    description: 'ID of the note to remove (required for "remove").',
                },
            },
            required: ['action'],
        },
        action: async (args) => {
            if (!args?.action) {
                return 'Missing required field: action.';
            }

            switch (args.action) {
                case 'write': {
                    if (!args.title || !args.content) {
                        return 'Write requires both "title" and "content".';
                    }
                    // Total operation guard: cap all notebook mutations per generation
                    if (_writeGuard.operationCount >= MAX_OPS_PER_GENERATION) {
                        return `Notebook operation limit reached for this turn (${MAX_OPS_PER_GENERATION} ops). Your existing notes are preserved. Continue with your response.`;
                    }
                    // Loop guard: cap writes per generation to prevent write→remove→rewrite loops
                    if (_writeGuard.writeCount >= MAX_WRITES_PER_GENERATION) {
                        return `Notebook write limit reached for this turn (${MAX_WRITES_PER_GENERATION} writes). Your existing notes are preserved. Continue with your response.`;
                    }
                    const notebook = getNotebook();
                    if (notebook.length >= MAX_NOTES) {
                        return `Notebook is full (${MAX_NOTES} notes). Remove some old notes first.`;
                    }
                    const id = `note_${Date.now().toString(36)}`;
                    notebook.push({
                        id,
                        title: args.title.trim(),
                        content: args.content.trim(),
                        created: Date.now(),
                    });
                    _writeGuard.writeCount++;
                    _writeGuard.operationCount++;
                    _writeGuard.writtenTitles.add(args.title.trim().toLowerCase());
                    saveNotebook();
                    return `Note saved: "${args.title}" (ID: ${id}). You'll see it in your context every turn.`;
                }

                case 'read': {
                    const notebook = getNotebook();
                    if (notebook.length === 0) {
                        return 'Your notebook is empty.';
                    }
                    const lines = notebook.map(n =>
                        `- [${n.id}] ${n.title}: ${n.content}`,
                    );
                    return `Your notes (${notebook.length}):\n${lines.join('\n')}`;
                }

                case 'remove': {
                    if (!args.note_id) {
                        return 'Remove requires a "note_id".';
                    }
                    // Loop guard: cap total operations to prevent write→remove→rewrite loops
                    if (_writeGuard.operationCount >= MAX_OPS_PER_GENERATION) {
                        return `Notebook operation limit reached for this turn (${MAX_OPS_PER_GENERATION} ops). Continue with your response.`;
                    }
                    const notebook = getNotebook();
                    const idx = notebook.findIndex(n => n.id === args.note_id);
                    if (idx === -1) {
                        return `Note "${args.note_id}" not found. Use "read" to see current notes.`;
                    }
                    const removed = notebook.splice(idx, 1)[0];
                    _writeGuard.operationCount++;
                    saveNotebook();
                    return `Removed note: "${removed.title}" (${removed.id}).`;
                }

                case 'clear': {
                    if (_writeGuard.operationCount >= MAX_OPS_PER_GENERATION) {
                        return `Notebook operation limit reached for this turn (${MAX_OPS_PER_GENERATION} ops). Continue with your response.`;
                    }
                    const notebook = getNotebook();
                    const count = notebook.length;
                    notebook.length = 0;
                    _writeGuard.operationCount++;
                    saveNotebook();
                    return `Cleared ${count} note(s) from notebook.`;
                }

                default:
                    return `Unknown action "${args.action}". Use: write, read, remove, or clear.`;
            }
        },
        formatMessage: async (args) => {
            switch (args?.action) {
                case 'write': return 'Writing to notebook...';
                case 'read': return 'Reading notebook...';
                case 'remove': return 'Removing note...';
                case 'clear': return 'Clearing notebook...';
                default: return 'Using notebook...';
            }
        },
        shouldRegister: async () => {
            const settings = getSettings();
            if (settings.globalEnabled === false) return false;
            if (settings.notebookEnabled === false) return false;
            return getActiveTunnelVisionBooks().length > 0;
        },
    };
}
