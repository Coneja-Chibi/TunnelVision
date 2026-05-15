/**
 * TunnelVision Tool Registry
 * Registers and unregisters all TunnelVision tools with ST's ToolManager.
 * Each tool lives in its own file under tools/ and exports getDefinition().
 * This file is the single point of contact with ToolManager.
 */

import { ToolManager } from '../../../tool-calling.js';
import { selected_world_info, world_info, loadWorldInfo, METADATA_KEY } from '../../../world-info.js';
import { characters, this_chid, chat_metadata } from '../../../../script.js';
import { selected_group, groups } from '../../../group-chats.js';
import { getCharaFilename } from '../../../utils.js';
import { callGenericPopup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { power_user } from '../../../power-user.js';
import { isLorebookEnabled, getSettings, getTree, getBookDescription, syncTrackerUidsForLorebook, getBookPermission, canReadBook, canWriteBook, isNativeInjectionBook } from './tree-store.js';
import { logToolCallStarted } from './activity-feed.js';
import { findEntry } from './entry-manager.js';

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
 * Checks global, character-attached (primary + extraBooks), chat-attached,
 * and persona-attached lorebooks.
 * Shared by all tools via import from this module.
 * @returns {string[]}
 */
export function getActiveTunnelVisionBooks() {
    const candidates = new Set();

    // 1. Global lorebooks (selected in World Info dropdown)
    if (Array.isArray(selected_world_info)) {
        for (const name of selected_world_info) candidates.add(name);
    }

    // 2. Character-attached lorebooks
    // In group chats, scan ALL group members instead of just this_chid
    // (this_chid rotates per character and would flip active books mid-generation)
    if (selected_group) {
        const group = groups?.find(g => g.id === selected_group);
        if (group?.members) {
            const disabledMembers = new Set(group.disabled_members || []);
            for (const memberAvatar of group.members) {
                if (disabledMembers.has(memberAvatar)) continue;
                const charIdx = characters.findIndex(c => c.avatar === memberAvatar);
                if (charIdx < 0) continue;
                _addCharacterBooks(candidates, charIdx);
            }
        }
    } else if (this_chid !== undefined && this_chid !== null) {
        _addCharacterBooks(candidates, this_chid);
    }

    // 3. Chat-attached lorebook (native ST + CarrotKernel multi-book)
    const chatWorld = chat_metadata?.[METADATA_KEY];
    if (chatWorld) candidates.add(chatWorld);
    if (Array.isArray(chat_metadata?.carrot_chat_books)) {
        for (const name of chat_metadata.carrot_chat_books) candidates.add(name);
    }

    // 4. Persona-attached lorebook
    const personaWorld = power_user?.persona_description_lorebook;
    if (personaWorld) candidates.add(personaWorld);

    // Filter to only TV-enabled books
    const active = [];
    for (const bookName of candidates) {
        if (isLorebookEnabled(bookName)) active.push(bookName);
    }
    return active;
}

/**
 * Add character-attached lorebooks (primary + extraBooks) to the candidates set.
 * @param {Set<string>} candidates
 * @param {number} charIdx - Character index in the characters array
 */
function _addCharacterBooks(candidates, charIdx) {
    const character = characters[charIdx];
    const primaryBook = character?.data?.extensions?.world;
    if (primaryBook) candidates.add(primaryBook);

    const charFilename = getCharaFilename(charIdx);
    const charLore = world_info?.charLore || [];
    const charEntry = charLore.find(e => e.name === charFilename);
    if (charEntry?.extraBooks) {
        for (const name of charEntry.extraBooks) candidates.add(name);
    }
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
        const desc = getBookListWithDescriptions({ writableOnly: checkWrite });
        return { book: '', error: `Multiple lorebooks active. You must specify which one.\n${desc}` };
    }
    if (!activeBooks.includes(requestedBook)) {
        const desc = getBookListWithDescriptions({ writableOnly: checkWrite });
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
 * Get active lorebooks that allow write operations.
 * Filters out read-only lorebooks.
 * @returns {string[]}
 */
export function getWritableBooks() {
    return getActiveTunnelVisionBooks().filter(canWriteBook);
}

/**
 * Get active lorebooks that TV manages injection for (excludes native-injection books).
 * Use this for smart-context and sidecar retrieval — these should NOT inject content
 * from books where ST handles injection natively (outlets, positions, etc.).
 * @returns {string[]}
 */
export function getInjectionManagedBooks() {
    return getActiveTunnelVisionBooks().filter(b => !isNativeInjectionBook(b));
}

/**
 * Build a descriptive list of active lorebooks for tool descriptions.
 * Uses user-set description, falls back to tree root summary, falls back to top-level labels.
 * @returns {string} Formatted multi-line description of available lorebooks.
 */
export function getBookListWithDescriptions({ readableOnly = false, writableOnly = false } = {}) {
    const activeBooks = getActiveTunnelVisionBooks();
    if (activeBooks.length === 0) return '(none active)';

    const lines = [];
    for (const bookName of activeBooks) {
        if (readableOnly && !canReadBook(bookName)) continue;
        if (writableOnly && !canWriteBook(bookName)) continue;

        const permission = getBookPermission(bookName);
        const permissionLabel = permission === 'read_only'
            ? ' [read-only]'
            : permission === 'write_only'
                ? ' [write-only]'
                : '';
        const userDesc = getBookDescription(bookName);
        if (userDesc) {
            lines.push(`- "${bookName}"${permissionLabel}: ${userDesc}`);
            continue;
        }

        // Fall back to tree root summary
        const tree = getTree(bookName);
        if (tree?.root?.summary && tree.root.summary !== `Top-level index for ${bookName}`) {
            lines.push(`- "${bookName}"${permissionLabel}: ${tree.root.summary}`);
            continue;
        }

        // Fall back to listing top-level category labels
        if (tree?.root?.children?.length > 0) {
            const labels = tree.root.children.map(c => c.label).slice(0, 6).join(', ');
            const more = tree.root.children.length > 6 ? ` (+${tree.root.children.length - 6} more)` : '';
            lines.push(`- "${bookName}"${permissionLabel}: Contains: ${labels}${more}`);
            continue;
        }

        lines.push(`- "${bookName}"${permissionLabel}`);
    }

    return lines.length > 0 ? lines.join('\n') : '(none available)';
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
 * Long string values get a collapsible <details> block instead of truncation.
 * @param {Object} args
 * @param {Set<string>} [skipKeys] - Keys to omit from generic display (handled separately)
 * @returns {string}
 */
function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Threshold above which a string value gets a collapsible block. */
const LONG_VALUE_THRESHOLD = 120;

function formatConfirmArgs(args, skipKeys = new Set()) {
    if (!args || typeof args !== 'object') return '';
    const lines = [];
    for (const [key, value] of Object.entries(args)) {
        if (skipKeys.has(key)) continue;
        let display;
        if (Array.isArray(value)) {
            display = `<span>${escapeHtml(value.join(', '))}</span>`;
        } else if (typeof value === 'string' && value.length > LONG_VALUE_THRESHOLD) {
            const escaped = escapeHtml(value);
            display = `<details class="tv-confirm-longval"><summary>${escapeHtml(value.substring(0, LONG_VALUE_THRESHOLD))}…</summary><pre class="tv-confirm-pre">${escaped}</pre></details>`;
        } else {
            display = `<span>${escapeHtml(value ?? '')}</span>`;
        }
        lines.push(`<div><strong>${escapeHtml(key)}:</strong> ${display}</div>`);
    }
    return lines.join('');
}

/**
 * Build a simple word-level diff between two strings.
 * Returns HTML with <ins> (additions) and <del> (removals) spans.
 * Uses a line-by-line diff so structural changes are clear.
 * @param {string} oldText
 * @param {string} newText
 * @returns {string} HTML diff
 */
function buildLineDiff(oldText, newText) {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');

    // LCS-based line diff (Myers-style simplified)
    const m = oldLines.length;
    const n = newLines.length;

    // Guard against huge entries — LCS is O(m*n) memory/time
    if (m + n > 500) {
        return `<div class="tv-diff-remove">${escapeHtml(oldText)}</div><div class="tv-diff-add">${escapeHtml(newText)}</div>`;
    }

    // Build LCS table
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            if (oldLines[i] === newLines[j]) {
                dp[i][j] = dp[i + 1][j + 1] + 1;
            } else {
                dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
            }
        }
    }

    // Trace back through LCS to build diff hunks
    const parts = [];
    let i = 0; let j = 0;
    while (i < m || j < n) {
        if (i < m && j < n && oldLines[i] === newLines[j]) {
            parts.push({ type: 'same', text: oldLines[i] });
            i++; j++;
        } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
            parts.push({ type: 'add', text: newLines[j] });
            j++;
        } else {
            parts.push({ type: 'remove', text: oldLines[i] });
            i++;
        }
    }

    // Render to HTML
    return parts.map(p => {
        const escaped = escapeHtml(p.text);
        if (p.type === 'add') return `<div class="tv-diff-add">+ ${escaped}</div>`;
        if (p.type === 'remove') return `<div class="tv-diff-remove">- ${escaped}</div>`;
        return `<div class="tv-diff-same">  ${escaped}</div>`;
    }).join('');
}

/**
 * Show a confirmation popup for a tool action.
 * For UPDATE operations, fetches the original entry and renders a diff.
 * @param {string} displayName - Human-readable tool name
 * @param {Object} args - Tool arguments from the AI
 * @param {string} [toolName] - Internal tool name (used to detect UPDATE)
 * @returns {Promise<boolean>} True if user approved
 */
async function showToolConfirmation(displayName, args, toolName) {
    let extraHtml = '';
    const skipKeys = new Set();

    // For UPDATE operations: fetch original entry and show a diff for the content field
    if (toolName === UPDATE_NAME && args?.uid !== undefined && args?.content) {
        try {
            const { book } = resolveTargetBook(args.lorebook);
            if (book) {
                const found = await findEntry(book, Number(args.uid));
                if (found?.entry) {
                    const originalContent = found.entry.content || '';
                    const newContent = args.content;

                    // Mark content key as handled — we render it in the diff block
                    skipKeys.add('content');

                    const diffHtml = buildLineDiff(originalContent, newContent);
                    const isLong = originalContent.length + newContent.length > 600;

                    const entryTitle = escapeHtml(found.entry.comment || `Entry #${args.uid}`);

                    if (isLong) {
                        extraHtml = `
<details class="tv-confirm-diff-wrap" open>
  <summary class="tv-confirm-diff-summary">Content diff for <strong>${entryTitle}</strong></summary>
  <div class="tv-confirm-diff">${diffHtml}</div>
</details>`;
                    } else {
                        extraHtml = `
<div class="tv-confirm-diff-wrap">
  <div class="tv-confirm-diff-label">Content diff for <strong>${entryTitle}</strong></div>
  <div class="tv-confirm-diff">${diffHtml}</div>
</div>`;
                    }
                }
            }
        } catch (e) {
            // Non-critical — diff display is best-effort
            console.warn('[TunnelVision] Failed to fetch original entry for diff:', e);
        }
    }

    const argsHtml = formatConfirmArgs(args, skipKeys);

    const html = `<div class="tv-confirm-popup">
    <div class="tv-confirm-title">TunnelVision wants to: <strong>${escapeHtml(displayName)}</strong></div>
    ${argsHtml ? `<div class="tv-confirm-args">${argsHtml}</div>` : ''}
    ${extraHtml}
    <div class="tv-confirm-hint">Approve this action?</div>
</div>`;
    const result = await callGenericPopup(html, POPUP_TYPE.CONFIRM);
    return result === POPUP_RESULT.AFFIRMATIVE;
}

/**
 * Wrap a tool's action with a confirmation gate.
 * @param {Function} originalAction - The tool's original action function
 * @param {string} displayName - Human-readable tool name
 * @param {string} toolName - Internal tool name (for diff-aware confirmation)
 * @returns {Function} Wrapped action that shows confirmation first
 */
function wrapWithConfirmation(originalAction, displayName, toolName) {
    return async function (args) {
        const approved = await showToolConfirmation(displayName, args, toolName);
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
            registrationDef.action = wrapWithConfirmation(registrationDef.action, registrationDef.displayName || name, name);
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
/**
 * Check if a tool requires confirmation and show the popup if so.
 * Used by the sidecar writer to respect the same confirmation settings as main model tools.
 * @param {string} toolName - The tool name (e.g. 'TunnelVision_Remember')
 * @param {Object} args - The tool arguments to display in the popup
 * @returns {Promise<boolean>} True if approved (or no confirmation needed)
 */
export async function checkToolConfirmation(toolName, args) {
    const settings = getSettings();
    const confirmTools = settings.confirmTools || {};
    if (!CONFIRMABLE_TOOLS.has(toolName) || !confirmTools[toolName]) return true;

    const displayNames = {
        [REMEMBER_NAME]: 'Remember (Sidecar)',
        [UPDATE_NAME]: 'Update (Sidecar)',
        [FORGET_NAME]: 'Forget (Sidecar)',
        [SUMMARIZE_NAME]: 'Summarize (Sidecar)',
        [REORGANIZE_NAME]: 'Reorganize (Sidecar)',
        [MERGESPLIT_NAME]: 'Merge/Split (Sidecar)',
    };
    return showToolConfirmation(displayNames[toolName] || toolName, args, toolName);
}

export { SEARCH_NAME, REMEMBER_NAME, UPDATE_NAME, FORGET_NAME, REORGANIZE_NAME, SUMMARIZE_NAME, MERGESPLIT_NAME, NOTEBOOK_NAME, ALL_TOOL_NAMES, CONFIRMABLE_TOOLS };
