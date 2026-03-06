/**
 * TunnelVision Commands
 * Intercepts !command syntax typed in the chat textarea before generation.
 * Commands are parsed on GENERATION_STARTED, stripped from the textarea,
 * and replaced with a forced tool-call instruction via setExtensionPrompt.
 *
 * Supported commands (prefix configurable, default "!"):
 *   !summarize [title]  — Force TunnelVision_Summarize with the given title
 *   !remember [content] — Force TunnelVision_Remember with the given content
 *   !search [query]     — Force TunnelVision_Search for the given query
 *   !forget [name]      — Force TunnelVision_Forget for the named entry
 *   !merge [entries]    — Force TunnelVision_MergeSplit merge for the named entries
 *   !split [entry]      — Force TunnelVision_MergeSplit split for the named entry
 *   !ingest             — Ingest recent chat messages into the active lorebook (no generation)
 *
 * Settings consumed (from tree-store.js getSettings()):
 *   commandsEnabled        boolean  default true
 *   commandPrefix          string   default '!'
 *   commandContextMessages number   default 50
 */

import { eventSource, event_types, setExtensionPrompt, extension_prompt_types } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { getSettings, getSelectedLorebook } from './tree-store.js';
import { getActiveTunnelVisionBooks } from './tool-registry.js';
import { ingestChatMessages } from './tree-builder.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Extension prompt key — must be unique across all TV prompts. */
const TV_CMD_PROMPT_KEY = 'tunnelvision_command';

/** Canonical command names, lowercase. */
const KNOWN_COMMANDS = ['summarize', 'remember', 'search', 'forget', 'merge', 'split', 'ingest'];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let _commandsInitialized = false;

/**
 * Wire up the GENERATION_STARTED listener.
 * Safe to call multiple times — idempotency guard prevents duplicate listeners.
 */
export function initCommands() {
    if (_commandsInitialized) return;
    _commandsInitialized = true;

    if (!event_types.GENERATION_STARTED) {
        console.warn('[TunnelVision] GENERATION_STARTED event not available — commands disabled.');
        return;
    }

    eventSource.on(event_types.GENERATION_STARTED, onGenerationStartedCommand);
    document.querySelector('#send_textarea')?.addEventListener('keydown', onTextareaKeydownCapture, true);
    document.querySelector('#send_but')?.addEventListener('click', onSendButtonCapture, true);
}

// ---------------------------------------------------------------------------
// Capture handlers — intercept !ingest before ST fires generation
// ---------------------------------------------------------------------------

function onTextareaKeydownCapture(event) {
    if (event.defaultPrevented) return;
    if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) {
        return;
    }

    tryHandleImmediateIngestCommand(event).catch(error => {
        console.error('[TunnelVision] Immediate !ingest handling failed:', error);
    });
}

function onSendButtonCapture(event) {
    if (event.defaultPrevented) return;
    tryHandleImmediateIngestCommand(event).catch(error => {
        console.error('[TunnelVision] Immediate !ingest handling failed:', error);
    });
}

async function tryHandleImmediateIngestCommand(event) {
    const settings = getSettings();
    if (!settings.commandsEnabled) return false;

    const prefix = settings.commandPrefix || '!';
    const $textarea = $('#send_textarea');
    const text = $textarea.val()?.trim() ?? '';
    if (!text.startsWith(prefix)) return false;

    const parsed = parseCommand(text.slice(prefix.length).trim());
    if (!parsed || parsed.command !== 'ingest') return false;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();

    const activeBooks = getActiveTunnelVisionBooks();
    if (activeBooks.length === 0) {
        toastr.warning('No active TunnelVision lorebooks.', 'TunnelVision');
        return true;
    }

    const targetLorebook = resolveIngestLorebook(activeBooks, parsed.arg);
    if (!targetLorebook) {
        toastr.warning(
            `Multiple TunnelVision lorebooks are active. Use "${prefix}ingest <lorebook name>" or select the lorebook in TunnelVision first.`,
            'TunnelVision',
        );
        return true;
    }

    const contextMessages = Number(settings.commandContextMessages) || 50;
    $textarea.val('').trigger('input');
    clearCommandPrompt();
    await handleIngest(targetLorebook, contextMessages);
    return true;
}

// ---------------------------------------------------------------------------
// Event handler
// ---------------------------------------------------------------------------

function onGenerationStartedCommand() {
    const settings = getSettings();

    if (!settings.commandsEnabled) {
        clearCommandPrompt();
        return;
    }

    const prefix = settings.commandPrefix || '!';
    const $textarea = $('#send_textarea');
    const text = $textarea.val()?.trim() ?? '';

    if (!text.startsWith(prefix)) {
        clearCommandPrompt();
        return;
    }

    const parsed = parseCommand(text.slice(prefix.length).trim());
    if (!parsed) {
        clearCommandPrompt();
        return;
    }

    // !ingest is handled by capture handlers — skip here
    if (parsed.command === 'ingest') {
        clearCommandPrompt();
        return;
    }

    const activeBooks = getActiveTunnelVisionBooks();
    if (activeBooks.length === 0) {
        toastr.warning('No active TunnelVision lorebooks.', 'TunnelVision');
        clearCommandPrompt();
        return;
    }

    const contextMessages = Number(settings.commandContextMessages) || 50;
    const targetLorebook = resolveCurrentLorebook(activeBooks);
    const prompt = buildCommandPrompt(parsed, contextMessages, activeBooks, targetLorebook);

    $textarea.val('').trigger('input');
    setExtensionPrompt(TV_CMD_PROMPT_KEY, prompt, extension_prompt_types.IN_PROMPT, 0);
}

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

/**
 * Parse raw text (after the prefix has been removed) into a command + arg.
 *
 * Handles:
 *   summarize "The Battle at Dawn"  → { command: 'summarize', arg: 'The Battle at Dawn' }
 *   summarize The Battle at Dawn    → { command: 'summarize', arg: 'The Battle at Dawn' }
 *   ingest                          → { command: 'ingest',    arg: '' }
 *
 * @param {string} text - Raw text with prefix already stripped.
 * @returns {{ command: string, arg: string }|null}
 */
function parseCommand(text) {
    if (!text) return null;

    // Split on first whitespace to isolate the command word.
    const spaceIdx = text.search(/\s/);
    const commandWord = (spaceIdx === -1 ? text : text.slice(0, spaceIdx)).toLowerCase();

    if (!KNOWN_COMMANDS.includes(commandWord)) return null;

    // Everything after the command word is the raw argument string.
    const rawArg = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

    // Strip surrounding matching quotes if present (require open/close to match).
    const arg = rawArg.replace(/^(["'])(.*)\1$/, '$2').trim();

    return { command: commandWord, arg };
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

        toastr.info(`Ingesting messages ${from}–${to} into "${bookName}"…`, 'TunnelVision');

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
        console.error('[TunnelVision] !ingest failed:', err);
        toastr.error(`Ingest failed: ${err.message}`, 'TunnelVision');
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Remove any previously injected command prompt so it doesn't bleed across turns. */
function clearCommandPrompt() {
    setExtensionPrompt(TV_CMD_PROMPT_KEY, '', extension_prompt_types.IN_PROMPT, 0);
}
