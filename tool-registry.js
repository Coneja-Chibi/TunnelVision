/**
 * TunnelVision Tool Registry
 * Registers and unregisters all TunnelVision tools with ST's ToolManager.
 * Each tool lives in its own file under tools/ and exports getDefinition().
 * This file is the single point of contact with ToolManager.
 */

import { ToolManager } from '../../../tool-calling.js';
import { selected_world_info, world_info, loadWorldInfo, METADATA_KEY } from '../../../world-info.js';
import { characters, this_chid, chat_metadata } from '../../../../script.js';
import { getCharaFilename } from '../../../utils.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { isLorebookEnabled, getSettings, getTree, getBookDescription, syncTrackerUidsForLorebook, canReadBook, canWriteBook } from './tree-store.js';
import { logToolCallStarted } from './activity-feed.js';

import { getDefinition as getSearchDef, getTreeOverview, TOOL_NAME as SEARCH_NAME, COMPACT_DESCRIPTION as SEARCH_COMPACT } from './tools/search.js';
import { getDefinition as getRememberDef, TOOL_NAME as REMEMBER_NAME, COMPACT_DESCRIPTION as REMEMBER_COMPACT } from './tools/remember.js';
import { getDefinition as getUpdateDef, TOOL_NAME as UPDATE_NAME, COMPACT_DESCRIPTION as UPDATE_COMPACT } from './tools/update.js';
import { getDefinition as getForgetDef, TOOL_NAME as FORGET_NAME, COMPACT_DESCRIPTION as FORGET_COMPACT } from './tools/forget.js';
import { getDefinition as getReorganizeDef, TOOL_NAME as REORGANIZE_NAME, COMPACT_DESCRIPTION as REORGANIZE_COMPACT } from './tools/reorganize.js';
import { getDefinition as getSummarizeDef, TOOL_NAME as SUMMARIZE_NAME, COMPACT_DESCRIPTION as SUMMARIZE_COMPACT } from './tools/summarize.js';
import { getDefinition as getMergeSplitDef, TOOL_NAME as MERGESPLIT_NAME, COMPACT_DESCRIPTION as MERGESPLIT_COMPACT } from './tools/merge-split.js';
import { getDefinition as getNotebookDef, TOOL_NAME as NOTEBOOK_NAME, COMPACT_DESCRIPTION as NOTEBOOK_COMPACT } from './tools/notebook.js';

/** All tool names for bulk unregister. */
const ALL_TOOL_NAMES = [SEARCH_NAME, REMEMBER_NAME, UPDATE_NAME, FORGET_NAME, REORGANIZE_NAME, SUMMARIZE_NAME, MERGESPLIT_NAME, NOTEBOOK_NAME];

/**
 * Delimiter that separates user-editable prompt text from dynamically injected content
 * (tree overview, tracker list). Everything after this marker is regenerated on each
 * registerTools() call, so user edits above the line persist across chat switches.
 */
export const DYNAMIC_DELIMITER = '\n\n---TV_DYNAMIC_BELOW---\n';

/**
 * Strip dynamic content (tree overview, tracker list) from a description string.
 * Returns only the user-editable portion above the delimiter.
 * Also handles legacy format where tree overview was baked in without a delimiter.
 * @param {string} text
 * @returns {string}
 */
export function stripDynamicContent(text) {
    if (!text) return text;
    // New delimiter
    let idx = text.indexOf('---TV_DYNAMIC_BELOW---');
    // Legacy: tree overview baked in before delimiter existed
    if (idx < 0) idx = text.indexOf('\n\nFull tree index:\n');
    if (idx < 0) idx = text.indexOf('\n\nTop-level tree:\n');
    return idx >= 0 ? text.substring(0, idx).trimEnd() : text;
}

/** Tools that can be gated with per-tool confirmation. Only destructive/mutating tools. */
const CONFIRMABLE_TOOLS = new Set([REMEMBER_NAME, UPDATE_NAME, FORGET_NAME, SUMMARIZE_NAME, REORGANIZE_NAME, MERGESPLIT_NAME]);

/** Map from tool name to compact one-liner description. */
const COMPACT_DESCRIPTIONS = {
    [SEARCH_NAME]: SEARCH_COMPACT,
    [REMEMBER_NAME]: REMEMBER_COMPACT,
    [UPDATE_NAME]: UPDATE_COMPACT,
    [FORGET_NAME]: FORGET_COMPACT,
    [REORGANIZE_NAME]: REORGANIZE_COMPACT,
    [SUMMARIZE_NAME]: SUMMARIZE_COMPACT,
    [MERGESPLIT_NAME]: MERGESPLIT_COMPACT,
    [NOTEBOOK_NAME]: NOTEBOOK_COMPACT,
};

/** Guide tool name — registered in compact mode to provide full tool details on demand. */
const GUIDE_NAME = 'TunnelVision_Guide';

/** Cached tracker list string — refreshed on each registerTools() call. */
let _trackerListCache = '';

function getAllToolDefinitions() {
    return [
        { def: getSearchDef(), name: SEARCH_NAME },
        { def: getRememberDef(), name: REMEMBER_NAME },
        { def: getUpdateDef(), name: UPDATE_NAME },
        { def: getForgetDef(), name: FORGET_NAME },
        { def: getReorganizeDef(), name: REORGANIZE_NAME },
        { def: getSummarizeDef(), name: SUMMARIZE_NAME },
        { def: getMergeSplitDef(), name: MERGESPLIT_NAME },
        { def: getNotebookDef(), name: NOTEBOOK_NAME },
    ];
}

function getToolDefinitionName(tool) {
    return tool?.toFunctionOpenAI?.()?.function?.name || '';
}

function getRegisteredTunnelVisionTools() {
    return ToolManager.tools.filter(tool => ALL_TOOL_NAMES.includes(getToolDefinitionName(tool)));
}

/** Get cached tracker list string. Updated during registerTools(). */
export function getTrackerListString() {
    return _trackerListCache;
}

/**
 * Get the names/comments of entries flagged as trackers.
 * Returns a formatted string for injection into tool descriptions.
 * @returns {Promise<string>}
 */
async function getTrackerList() {
    const trackerNames = [];

    for (const bookName of getActiveTunnelVisionBooks()) {
        try {
            const bookData = await loadWorldInfo(bookName);
            if (!bookData?.entries) continue;
            const bookTrackers = await syncTrackerUidsForLorebook(bookName, bookData.entries);
            if (!bookTrackers.length) continue;

            for (const key of Object.keys(bookData.entries)) {
                const entry = bookData.entries[key];
                if (bookTrackers.includes(entry.uid) && !entry.disable) {
                    const name = entry.comment || entry.key?.[0] || `#${entry.uid}`;
                    trackerNames.push(name);
                }
            }
        } catch {
            // Lorebook might not be loadable — skip silently
        }
    }

    return trackerNames.length > 0
        ? `\n\nTracked entries (check/update these when relevant): ${trackerNames.join(', ')}`
        : '';
}

/**
 * Get all active lorebooks that have TunnelVision enabled.
 * Checks global, character-attached (primary + extraBooks), and chat-attached lorebooks.
 * Shared by all tools via import from this module.
 * @returns {string[]}
 */
export function getActiveTunnelVisionBooks() {
    const candidates = new Set();

    // 1. Global lorebooks (selected in World Info dropdown)
    if (Array.isArray(selected_world_info)) {
        for (const name of selected_world_info) candidates.add(name);
    }

    // 2. Character-attached lorebooks (primary + extraBooks via charLore)
    if (this_chid !== undefined && this_chid !== null) {
        const character = characters[this_chid];
        const primaryBook = character?.data?.extensions?.world;
        if (primaryBook) candidates.add(primaryBook);

        const charFilename = getCharaFilename(this_chid);
        const charLore = world_info?.charLore || [];
        const charEntry = charLore.find(e => e.name === charFilename);
        if (charEntry?.extraBooks) {
            for (const name of charEntry.extraBooks) candidates.add(name);
        }
    }

    // 3. Chat-attached lorebook (native ST + CarrotKernel multi-book)
    const chatWorld = chat_metadata?.[METADATA_KEY];
    if (chatWorld) candidates.add(chatWorld);
    if (Array.isArray(chat_metadata?.carrot_chat_books)) {
        for (const name of chat_metadata.carrot_chat_books) candidates.add(name);
    }

    // Filter to only TV-enabled books
    const active = [];
    for (const bookName of candidates) {
        if (isLorebookEnabled(bookName)) active.push(bookName);
    }
    return active;
}

export async function inspectToolRuntimeState() {
    const settings = getSettings();
    const disabled = settings.disabledTools || {};
    const activeBooks = getActiveTunnelVisionBooks();
    const disabledToolNames = ALL_TOOL_NAMES.filter(name => disabled[name]);
    const expectedToolNames = ALL_TOOL_NAMES.filter(name => !disabled[name]);
    const registeredTools = getRegisteredTunnelVisionTools();
    const registeredToolNames = registeredTools.map(getToolDefinitionName);
    const missingToolNames = expectedToolNames.filter(name => !registeredToolNames.includes(name));
    const stealthToolNames = registeredTools
        .filter(tool => tool.stealth)
        .map(getToolDefinitionName);
    const eligibleToolNames = [];
    const eligibilityErrors = [];

    for (const tool of registeredTools) {
        const name = getToolDefinitionName(tool);
        try {
            if (await tool.shouldRegister()) {
                eligibleToolNames.push(name);
            }
        } catch (error) {
            eligibilityErrors.push(`${name}: ${error?.message || String(error)}`);
        }
    }

    return {
        activeBooks,
        disabledToolNames,
        expectedToolNames,
        registeredToolNames,
        missingToolNames,
        stealthToolNames,
        eligibleToolNames,
        eligibilityErrors,
    };
}

function logToolRuntimeSnapshot(snapshot, reason = 'runtime') {
    const parts = [
        `active=[${snapshot.activeBooks.join(', ') || '(none)'}]`,
        `registered=[${snapshot.registeredToolNames.join(', ') || '(none)'}]`,
        `missing=[${snapshot.missingToolNames.join(', ') || '(none)'}]`,
        `stealth=[${snapshot.stealthToolNames.join(', ') || '(none)'}]`,
        `eligible=[${snapshot.eligibleToolNames.join(', ') || '(none)'}]`,
        `repaired=${snapshot.repairApplied ? 'yes' : 'no'}`,
    ];

    if (snapshot.eligibilityErrors?.length) {
        parts.push(`eligibilityErrors=[${snapshot.eligibilityErrors.join('; ')}]`);
    }

    const message = `[TunnelVision] Tool preflight (${reason}) ${parts.join(' | ')}`;
    if (snapshot.failureReasons?.length) {
        console.warn(`${message} | failures=[${snapshot.failureReasons.join('; ')}]`);
    } else {
        console.log(message);
    }
}

export async function preflightToolRuntimeState({ repair = true, reason = 'generation', log = true } = {}) {
    let snapshot = await inspectToolRuntimeState();
    let repairApplied = false;

    if (
        repair
        && snapshot.activeBooks.length > 0
        && (snapshot.missingToolNames.length > 0 || snapshot.stealthToolNames.length > 0)
    ) {
        await registerTools();
        repairApplied = true;
        snapshot = await inspectToolRuntimeState();
    }

    const failureReasons = [];
    if (snapshot.activeBooks.length > 0 && snapshot.expectedToolNames.length > 0) {
        if (snapshot.registeredToolNames.length === 0) {
            failureReasons.push('no_registered_tools');
        }
        if (snapshot.missingToolNames.length > 0) {
            failureReasons.push(`missing_tools:${snapshot.missingToolNames.join(', ')}`);
        }
        if (snapshot.stealthToolNames.length > 0) {
            failureReasons.push(`stealth_tools:${snapshot.stealthToolNames.join(', ')}`);
        }
        if (snapshot.eligibilityErrors.length > 0) {
            failureReasons.push(`eligibility_errors:${snapshot.eligibilityErrors.join(' | ')}`);
        }
        if (snapshot.eligibleToolNames.length === 0) {
            failureReasons.push('no_eligible_tools');
        }
    }

    const result = { ...snapshot, repairApplied, failureReasons };
    if (log) {
        logToolRuntimeSnapshot(result, reason);
    }
    return result;
}

/**
 * Resolve which lorebook to write to. Auto-corrects when only one book is active.
 * Enforces write permissions when checkWrite=true.
 * @param {string|undefined} requestedBook - The lorebook name the AI provided.
 * @param {{ checkWrite?: boolean }} [opts]
 * @returns {{ book: string, error: string|null }} The resolved book name, or an error message.
 */
export function resolveTargetBook(requestedBook, { checkWrite = false } = {}) {
    const activeBooks = getActiveTunnelVisionBooks();
    if (activeBooks.length === 0) {
        return { book: '', error: 'No active TunnelVision lorebooks.' };
    }

    // Filter to writable books if checking permissions
    const candidateBooks = checkWrite ? activeBooks.filter(canWriteBook) : activeBooks;
    if (checkWrite && candidateBooks.length === 0) {
        return { book: '', error: 'No writable lorebooks. All active lorebooks are set to read-only.' };
    }

    // Single candidate: always use it, regardless of what the AI typed
    if (candidateBooks.length === 1) {
        return { book: candidateBooks[0], error: null };
    }

    // Multiple candidates: validate the AI's choice
    if (!requestedBook) {
        const desc = getBookListWithDescriptions();
        return { book: '', error: `Multiple lorebooks active. You must specify which one.\n${desc}` };
    }
    if (!activeBooks.includes(requestedBook)) {
        const desc = getBookListWithDescriptions();
        return { book: '', error: `Lorebook "${requestedBook}" is not active.\n${desc}` };
    }
    if (checkWrite && !canWriteBook(requestedBook)) {
        return { book: '', error: `Lorebook "${requestedBook}" is read-only. Write operations are not allowed.` };
    }
    return { book: requestedBook, error: null };
}

/**
 * Get active lorebooks that allow read (Search) operations.
 * Filters out write-only lorebooks.
 * @returns {string[]}
 */
export function getReadableBooks() {
    return getActiveTunnelVisionBooks().filter(canReadBook);
}

/**
 * Build a descriptive list of active lorebooks for tool descriptions.
 * Uses user-set description, falls back to tree root summary, falls back to top-level labels.
 * @returns {string} Formatted multi-line description of available lorebooks.
 */
export function getBookListWithDescriptions() {
    const activeBooks = getActiveTunnelVisionBooks();
    if (activeBooks.length === 0) return '(none active)';

    const lines = [];
    for (const bookName of activeBooks) {
        const userDesc = getBookDescription(bookName);
        if (userDesc) {
            lines.push(`- "${bookName}": ${userDesc}`);
            continue;
        }

        // Fall back to tree root summary
        const tree = getTree(bookName);
        if (tree?.root?.summary && tree.root.summary !== `Top-level index for ${bookName}`) {
            lines.push(`- "${bookName}": ${tree.root.summary}`);
            continue;
        }

        // Fall back to listing top-level category labels
        if (tree?.root?.children?.length > 0) {
            const labels = tree.root.children.map(c => c.label).slice(0, 6).join(', ');
            const more = tree.root.children.length > 6 ? ` (+${tree.root.children.length - 6} more)` : '';
            lines.push(`- "${bookName}": Contains: ${labels}${more}`);
            continue;
        }

        lines.push(`- "${bookName}"`);
    }

    return lines.join('\n');
}

/**
 * Returns the default (built-in) description for every tool.
 * Used by the UI to show defaults and allow reset.
 * @returns {{ [toolName: string]: string }}
 */
export function getDefaultToolDescriptions() {
    const result = {};
    for (const { def, name } of getAllToolDefinitions()) {
        if (def) {
            result[name] = def.description;
        }
    }
    return result;
}

/**
 * Format args object into readable HTML for the confirmation popup.
 * @param {Object} args
 * @returns {string}
 */
function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatConfirmArgs(args) {
    if (!args || typeof args !== 'object') return '';
    const lines = [];
    for (const [key, value] of Object.entries(args)) {
        let display;
        if (Array.isArray(value)) {
            display = escapeHtml(value.join(', '));
        } else if (typeof value === 'string' && value.length > 200) {
            display = escapeHtml(value.substring(0, 200)) + '...';
        } else {
            display = escapeHtml(value ?? '');
        }
        lines.push(`<div><strong>${escapeHtml(key)}:</strong> ${display}</div>`);
    }
    return lines.join('');
}

/**
 * Show a confirmation popup for a tool action.
 * @param {string} displayName - Human-readable tool name
 * @param {Object} args - Tool arguments from the AI
 * @returns {Promise<boolean>} True if user approved
 */
async function showToolConfirmation(displayName, args) {
    const html = `<div class="tv-confirm-popup">
    <div class="tv-confirm-title">TunnelVision wants to: <strong>${displayName}</strong></div>
    <div class="tv-confirm-args">${formatConfirmArgs(args)}</div>
    <div class="tv-confirm-hint">Approve this action?</div>
</div>`;
    const result = await callGenericPopup(html, POPUP_TYPE.CONFIRM);
    return result === POPUP_RESULT.AFFIRMATIVE;
}

/**
 * Wrap a tool's action with a confirmation gate.
 * @param {Function} originalAction - The tool's original action function
 * @param {string} displayName - Human-readable tool name
 * @returns {Function} Wrapped action that shows confirmation first
 */
function wrapWithConfirmation(originalAction, displayName) {
    return async function (args) {
        const approved = await showToolConfirmation(displayName, args);
        if (!approved) {
            return 'Action denied by user. The user chose not to allow this operation. Try a different approach or ask the user what they want.';
        }
        return originalAction(args);
    };
}

/**
 * Wrap a tool's action to fire a live feed item the instant it's invoked.
 * The in-progress item is automatically replaced when TOOL_CALLS_PERFORMED fires.
 * @param {Function} originalAction
 * @param {string} toolName
 * @returns {Function}
 */
function wrapWithLiveFeed(originalAction, toolName) {
    return async function (args) {
        try { logToolCallStarted(toolName, args || {}); } catch { /* feed not critical */ }
        return originalAction(args);
    };
}

/**
 * Build the guide tool description listing all enabled tools with usage guidance.
 * @param {Array} allDefs - All tool definitions
 * @param {Object} disabled - Disabled tools map
 * @returns {string}
 */
function buildGuideDescription(allDefs, disabled) {
    const bookDesc = getBookListWithDescriptions();
    const enabledTools = allDefs.filter(({ name, def }) => def && !disabled[name]);

    let desc = `TunnelVision manages long-term memory in lorebooks. Call this tool with a tool name to get detailed usage instructions.\n\nAvailable lorebooks:\n${bookDesc}\n\nAvailable tools:\n`;

    for (const { def, name } of enabledTools) {
        const compact = COMPACT_DESCRIPTIONS[name] || def.description.split('\n')[0];
        desc += `- ${name}: ${compact}\n`;
    }

    desc += `\nUsage guidelines:
- ALWAYS Search before Remember to avoid duplicates
- Prefer Update over Remember when information already exists
- Use Merge to consolidate overlapping entries
- Use Forget only when information is definitively wrong or irrelevant
- Use Summarize for significant scenes and narrative beats
- Keep entries broad — combine related facts rather than creating many small entries`;

    // Add dynamic content (tree overview, tracker list) to the guide
    const treeOverview = getTreeOverview();
    if (treeOverview) {
        desc += DYNAMIC_DELIMITER + treeOverview;
    }
    if (_trackerListCache) {
        desc += _trackerListCache;
    }

    return desc;
}

/**
 * Register all TunnelVision tools with ToolManager.
 * Each tool's getDefinition() may return null if preconditions aren't met
 * (e.g. Search returns null if no valid trees exist).
 */
export async function registerTools() {
    unregisterTools();

    const activeBooks = getActiveTunnelVisionBooks();
    if (activeBooks.length === 0) {
        _trackerListCache = '';
        return;
    }

    // Pre-fetch tracker list for injection into Search and Update descriptions
    _trackerListCache = await getTrackerList();

    const settings = getSettings();
    const disabled = settings.disabledTools || {};

    const allDefs = getAllToolDefinitions();

    const confirmTools = settings.confirmTools || {};
    const promptOverrides = settings.toolPromptOverrides || {};
    const compact = settings.compactToolPrompts === true;

    let registered = 0;
    for (const { def, name } of allDefs) {
        if (disabled[name]) {
            continue;
        }
        if (!def) continue;

        // Clone def to avoid mutating the original
        let registrationDef = { ...def };

        // Apply user prompt override (always wins, regardless of compact mode)
        if (promptOverrides[name] && typeof promptOverrides[name] === 'string') {
            registrationDef.description = stripDynamicContent(promptOverrides[name]);
        } else if (compact && COMPACT_DESCRIPTIONS[name]) {
            // Compact mode: use one-liner description
            registrationDef.description = COMPACT_DESCRIPTIONS[name];
        }

        // Build dynamic suffix (tree overview + tracker list) — injected after delimiter
        // In compact mode, dynamic content goes on the guide tool instead
        if (!compact) {
            let dynamicSuffix = '';
            if (name === SEARCH_NAME) {
                const treeOverview = getTreeOverview();
                if (treeOverview) dynamicSuffix += treeOverview;
            }
            if (_trackerListCache && (name === SEARCH_NAME || name === UPDATE_NAME)) {
                dynamicSuffix += _trackerListCache;
            }
            if (dynamicSuffix) {
                registrationDef.description = registrationDef.description + DYNAMIC_DELIMITER + dynamicSuffix;
            }
        }

        // Wrap action with confirmation gate for confirmable tools
        if (CONFIRMABLE_TOOLS.has(name) && confirmTools[name]) {
            registrationDef.action = wrapWithConfirmation(registrationDef.action, registrationDef.displayName || name);
        }

        // Wrap action to fire a live feed item the instant the tool is invoked
        registrationDef.action = wrapWithLiveFeed(registrationDef.action, name);

        try {
            ToolManager.registerFunctionTool(registrationDef);
            registered++;
        } catch (e) {
            console.error(`[TunnelVision] Failed to register tool "${def.name}":`, e);
        }
    }

    // Register guide tool in compact mode
    if (compact && registered > 0) {
        try {
            const guideDesc = buildGuideDescription(allDefs, disabled);
            ToolManager.registerFunctionTool({
                name: GUIDE_NAME,
                displayName: 'TunnelVision Guide',
                description: guideDesc,
                parameters: {
                    type: 'object',
                    properties: {
                        tool: {
                            type: 'string',
                            description: 'Optional: name of a specific tool to get detailed instructions for.',
                        },
                    },
                    required: [],
                },
                action: async (args) => {
                    // Return full descriptions on demand
                    if (args?.tool) {
                        const match = allDefs.find(({ name }) => name === args.tool || name.toLowerCase().includes(String(args.tool).toLowerCase()));
                        if (match?.def) {
                            return `Full instructions for ${match.name}:\n\n${match.def.description}`;
                        }
                        return `Tool "${args.tool}" not found. Available: ${allDefs.filter(({ name }) => !disabled[name]).map(({ name }) => name).join(', ')}`;
                    }
                    return guideDesc;
                },
                formatMessage: async () => 'Checking TunnelVision tool guide...',
                shouldRegister: async () => true,
                stealth: false,
            });
            registered++;
        } catch (e) {
            console.error('[TunnelVision] Failed to register guide tool:', e);
        }
    }

    const eligible = allDefs.filter(({ def, name }) => def && !disabled[name]).length;
    const snapshot = await inspectToolRuntimeState();
    console.log(`[TunnelVision] Registered ${registered}/${eligible} tools for ${activeBooks.length} lorebook(s)${compact ? ' (compact mode)' : ''}`);
    logToolRuntimeSnapshot({ ...snapshot, repairApplied: false, failureReasons: [] }, 'register');
}

/**
 * Unregister all TunnelVision tools.
 */
export function unregisterTools() {
    for (const name of ALL_TOOL_NAMES) {
        try {
            ToolManager.unregisterFunctionTool(name);
        } catch {
            // Tool may not be registered — that's fine
        }
    }
    try { ToolManager.unregisterFunctionTool(GUIDE_NAME); } catch { /* not registered */ }
}

// Re-export tool names and constants for diagnostics/UI
export { SEARCH_NAME, REMEMBER_NAME, UPDATE_NAME, FORGET_NAME, REORGANIZE_NAME, SUMMARIZE_NAME, MERGESPLIT_NAME, NOTEBOOK_NAME, ALL_TOOL_NAMES, CONFIRMABLE_TOOLS };
