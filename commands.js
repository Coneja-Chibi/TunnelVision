/**
 * TunnelVision Slash Commands
 * Registers /tv-* slash commands for forcing tool actions.
 * Uses generateQuietPrompt for silent tool execution — no visible messages, no narrative output.
 *
 * Commands:
 *   /tv-search [query]     — Force a lorebook search
 *   /tv-remember [content] — Force saving to memory (detects schema design requests)
 *   /tv-summarize [title]  — Force a scene summary
 *   /tv-forget [name]      — Force forgetting an entry
 *   /tv-merge [entries]    — Force merging entries
 *   /tv-split [entry]      — Force splitting an entry
 *   /tv-ingest [lorebook]  — Ingest recent chat messages (no generation)
 *
 * Settings consumed (from tree-store.js getSettings()):
 *   commandContextMessages number   default 50
 */

import { generateQuietPrompt } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandArgument, ARGUMENT_TYPE } from '../../../slash-commands/SlashCommandArgument.js';
import { getSettings, getSelectedLorebook } from './tree-store.js';
import { getActiveTunnelVisionBooks } from './tool-registry.js';
import { ingestChatMessages } from './tree-builder.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let _initialized = false;

/**
 * Register all /tv-* slash commands.
 * Safe to call multiple times — idempotency guard prevents duplicate registration.
 */
export function initCommands() {
    if (_initialized) return;
    _initialized = true;

    registerSlashCommands();
}

// ---------------------------------------------------------------------------
// Slash command registration
// ---------------------------------------------------------------------------

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tv-search',
        callback: wrapCallback(handleSearch),
        helpString: 'Force a TunnelVision lorebook search.',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Search query',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        returns: 'empty string',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tv-remember',
        callback: wrapCallback(handleRemember),
        helpString: 'Force saving content to TunnelVision memory. Detects schema/tracker design requests.',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Content to remember',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        returns: 'empty string',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tv-summarize',
        callback: wrapCallback(handleSummarize),
        helpString: 'Force a TunnelVision scene summary.',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Summary title',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        returns: 'empty string',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tv-forget',
        callback: wrapCallback(handleForget),
        helpString: 'Force forgetting a TunnelVision lorebook entry.',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Entry name to forget',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        returns: 'empty string',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tv-merge',
        callback: wrapCallback(handleMerge),
        helpString: 'Force merging TunnelVision lorebook entries.',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Entries to merge',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        returns: 'empty string',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tv-split',
        callback: wrapCallback(handleSplit),
        helpString: 'Force splitting a TunnelVision lorebook entry.',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Entry to split',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        returns: 'empty string',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tv-ingest',
        callback: wrapCallback(handleIngestCommand),
        helpString: 'Ingest recent chat messages into a TunnelVision lorebook (no generation).',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Target lorebook name (optional if only one active)',
                typeList: [ARGUMENT_TYPE.STRING],
                isRequired: false,
            }),
        ],
        returns: 'empty string',
    }));
}

// ---------------------------------------------------------------------------
// Callback wrapper — shared precondition checks + error handling
// ---------------------------------------------------------------------------

/**
 * Wrap a command handler with standard precondition checks and error handling.
 * @param {function} handler - The actual command handler (receives namedArgs, unnamedArg).
 * @returns {function} Wrapped callback compatible with SlashCommand.
 */
function wrapCallback(handler) {
    return async function (namedArgs, unnamedArg) {
        try {
            const settings = getSettings();
            if (settings.globalEnabled === false) {
                toastr.warning('TunnelVision is disabled.', 'TunnelVision');
                return '';
            }

            const activeBooks = getActiveTunnelVisionBooks();
            if (activeBooks.length === 0) {
                toastr.warning('No active TunnelVision lorebooks.', 'TunnelVision');
                return '';
            }

            await handler(namedArgs, unnamedArg, { settings, activeBooks });
        } catch (err) {
            console.error('[TunnelVision] Slash command failed:', err);
            toastr.error(`Command failed: ${err.message}`, 'TunnelVision');
        }
        return '';
    };
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleSearch(_namedArgs, unnamedArg, { activeBooks }) {
    const targetLorebook = resolveCurrentLorebook(activeBooks);
    const query = String(unnamedArg || '').trim() || 'recent relevant information';
    const prompt = buildCommandPrompt({ command: 'search', arg: query }, getContextMessages(), activeBooks, targetLorebook);

    toastr.info('Searching lorebook...', 'TunnelVision');
    await generateQuietPrompt(prompt);
    toastr.success('Search complete.', 'TunnelVision');
}

async function handleRemember(_namedArgs, unnamedArg, { activeBooks }) {
    const targetLorebook = resolveCurrentLorebook(activeBooks);
    const content = String(unnamedArg || '').trim() || 'Remember important details from the recent conversation';
    const prompt = buildCommandPrompt({ command: 'remember', arg: content }, getContextMessages(), activeBooks, targetLorebook);

    toastr.info('Saving to memory...', 'TunnelVision');
    await generateQuietPrompt(prompt);
    toastr.success('Memory saved.', 'TunnelVision');
}

async function handleSummarize(_namedArgs, unnamedArg, { activeBooks }) {
    const targetLorebook = resolveCurrentLorebook(activeBooks);
    const title = String(unnamedArg || '').trim() || 'Summarize recent events';
    const prompt = buildCommandPrompt({ command: 'summarize', arg: title }, getContextMessages(), activeBooks, targetLorebook);

    toastr.info('Creating summary...', 'TunnelVision');
    await generateQuietPrompt(prompt);
    toastr.success('Summary created.', 'TunnelVision');
}

async function handleForget(_namedArgs, unnamedArg, { activeBooks }) {
    const targetLorebook = resolveCurrentLorebook(activeBooks);
    const name = String(unnamedArg || '').trim() || 'the specified entry';
    const prompt = buildCommandPrompt({ command: 'forget', arg: name }, getContextMessages(), activeBooks, targetLorebook);

    toastr.info('Forgetting entry...', 'TunnelVision');
    await generateQuietPrompt(prompt);
    toastr.success('Entry forgotten.', 'TunnelVision');
}

async function handleMerge(_namedArgs, unnamedArg, { activeBooks }) {
    const targetLorebook = resolveCurrentLorebook(activeBooks);
    const target = String(unnamedArg || '').trim() || 'the two most related or overlapping entries';
    const prompt = buildCommandPrompt({ command: 'merge', arg: target }, getContextMessages(), activeBooks, targetLorebook);

    toastr.info('Merging entries...', 'TunnelVision');
    await generateQuietPrompt(prompt);
    toastr.success('Entries merged.', 'TunnelVision');
}

async function handleSplit(_namedArgs, unnamedArg, { activeBooks }) {
    const targetLorebook = resolveCurrentLorebook(activeBooks);
    const target = String(unnamedArg || '').trim() || 'the entry that covers too many topics';
    const prompt = buildCommandPrompt({ command: 'split', arg: target }, getContextMessages(), activeBooks, targetLorebook);

    toastr.info('Splitting entry...', 'TunnelVision');
    await generateQuietPrompt(prompt);
    toastr.success('Entry split.', 'TunnelVision');
}

async function handleIngestCommand(_namedArgs, unnamedArg, { activeBooks }) {
    const targetLorebook = resolveIngestLorebook(activeBooks, String(unnamedArg || '').trim());
    if (!targetLorebook) {
        toastr.warning(
            'Multiple TunnelVision lorebooks are active. Use "/tv-ingest <lorebook name>" or select the lorebook in TunnelVision first.',
            'TunnelVision',
        );
        return;
    }

    await handleIngest(targetLorebook, getContextMessages());
}

// ---------------------------------------------------------------------------
// Lorebook resolvers
// ---------------------------------------------------------------------------

function resolveCurrentLorebook(activeBooks) {
    const selectedLorebook = getSelectedLorebook();
    if (selectedLorebook && activeBooks.includes(selectedLorebook)) {
        return selectedLorebook;
    }

    return activeBooks.length === 1 ? activeBooks[0] : null;
}

function resolveIngestLorebook(activeBooks, arg) {
    const requested = String(arg || '').trim();
    if (requested) {
        return activeBooks.find(bookName => bookName.toLowerCase() === requested.toLowerCase()) || null;
    }

    return resolveCurrentLorebook(activeBooks);
}

function buildLorebookInstruction(activeBooks, targetLorebook) {
    if (targetLorebook) {
        return `Use lorebook "${targetLorebook}". `;
    }

    if (activeBooks.length > 1) {
        return `Active lorebooks: ${activeBooks.join(', ')}. Choose the correct lorebook explicitly for any tool that requires a lorebook argument. `;
    }

    if (activeBooks.length === 1) {
        return `Use lorebook "${activeBooks[0]}". `;
    }

    return '';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the configured context message count from settings.
 * @returns {number}
 */
function getContextMessages() {
    const settings = getSettings();
    return Number(settings.commandContextMessages) || 50;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

function buildCommandPrompt({ command, arg }, contextMessages, activeBooks, targetLorebook) {
    const lorebookInstruction = buildLorebookInstruction(activeBooks, targetLorebook);

    switch (command) {
        case 'summarize': {
            const title = arg || 'Summarize recent events';
            return (
                `[INSTRUCTION: You MUST call TunnelVision_Summarize this turn. ` +
                lorebookInstruction +
                `Title: "${title}". ` +
                `Review the last ${contextMessages} messages and create a thorough summary. ` +
                `Provide the lorebook, title, and summary fields explicitly.]`
            );
        }
        case 'remember': {
            const content = arg || 'Remember important details from the recent conversation';
            const isSchemaRequest = /\b(design|schema|track(er|ing)?|template|format|struct(ure)?)\b/i.test(content);
            if (isSchemaRequest) {
                return (
                    `[INSTRUCTION: You MUST call TunnelVision_Remember this turn. ` +
                    lorebookInstruction +
                    `The user wants you to design a tracker schema. Based on their request: "${content}" - ` +
                    `propose a well-structured format using headers, bullet points, and key:value pairs that will be easy to update each turn with TunnelVision_Update. ` +
                    `Include placeholder values that demonstrate the format. Make it comprehensive but organized. ` +
                    `Save it with a clear "[Tracker]" prefix in the title.]`
                );
            }

            return (
                `[INSTRUCTION: You MUST call TunnelVision_Remember this turn. ` +
                lorebookInstruction +
                `Save the following to memory with explicit lorebook, title, and content fields: "${content}".]`
            );
        }
        case 'search': {
            const query = arg || 'recent relevant information';
            return (
                `[INSTRUCTION: You MUST call TunnelVision_Search this turn. ` +
                `Navigate the TunnelVision tree, then retrieve the most relevant node content for: "${query}". ` +
                (targetLorebook ? `If multiple lorebooks are active, prefer "${targetLorebook}" when the query is ambiguous. ` : '') +
                `Use the node_id/node_ids and action fields that the search tool expects.]`
            );
        }
        case 'forget': {
            const name = arg || 'the specified entry';
            return (
                `[INSTRUCTION: You MUST call TunnelVision_Forget this turn. ` +
                lorebookInstruction +
                `First use TunnelVision_Search to locate the correct entry for "${name}". ` +
                `Then call TunnelVision_Forget with the exact lorebook, uid, and a brief reason.]`
            );
        }
        case 'merge': {
            const target = arg || 'the two most related or overlapping entries';
            return (
                `[INSTRUCTION: You MUST call TunnelVision_MergeSplit with action "merge" this turn. ` +
                lorebookInstruction +
                `First use TunnelVision_Search to find the exact lorebook and UIDs for: "${target}". ` +
                `Then call TunnelVision_MergeSplit with action "merge", keep_uid, remove_uid, and rewritten merged content/title if needed. ` +
                `Rewrite the merged content to be clean and consolidated.]`
            );
        }
        case 'split': {
            const target = arg || 'the entry that covers too many topics';
            return (
                `[INSTRUCTION: You MUST call TunnelVision_MergeSplit with action "split" this turn. ` +
                lorebookInstruction +
                `First use TunnelVision_Search to find the exact lorebook and UID for: "${target}". ` +
                `Then call TunnelVision_MergeSplit with action "split", uid, keep_content, new_content, and new_title. ` +
                `Each resulting entry should cover one focused topic.]`
            );
        }
        default:
            return '';
    }
}

// ---------------------------------------------------------------------------
// Ingest handler
// ---------------------------------------------------------------------------

/**
 * Ingest recent chat messages into the given lorebook without sending a generation.
 * @param {string} bookName - Active TunnelVision lorebook name.
 * @param {number} contextMessages - How many recent messages to ingest.
 */
async function handleIngest(bookName, contextMessages) {
    try {
        const context = getContext();
        const chat = context?.chat;

        if (!chat || chat.length === 0) {
            toastr.error('No chat is open. Open a chat before ingesting.', 'TunnelVision');
            return;
        }

        const from = Math.max(0, chat.length - contextMessages);
        const to = chat.length - 1;

        toastr.info(`Ingesting messages ${from}\u2013${to} into "${bookName}"\u2026`, 'TunnelVision');

        const result = await ingestChatMessages(bookName, {
            from,
            to,
            progress: (msg) => toastr.info(msg, 'TunnelVision'),
            detail: () => {},
        });

        toastr.success(
            `Ingested ${result.created} entr${result.created === 1 ? 'y' : 'ies'} ` +
            `(${result.errors} error${result.errors === 1 ? '' : 's'}).`,
            'TunnelVision',
        );
    } catch (err) {
        console.error('[TunnelVision] /tv-ingest failed:', err);
        toastr.error(`Ingest failed: ${err.message}`, 'TunnelVision');
    }
}
