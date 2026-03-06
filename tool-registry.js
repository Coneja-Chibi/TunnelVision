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
import { isLorebookEnabled, getSettings, getTree, getBookDescription } from './tree-store.js';

import { getDefinition as getSearchDef, TOOL_NAME as SEARCH_NAME } from './tools/search.js';
import { getDefinition as getRememberDef, TOOL_NAME as REMEMBER_NAME } from './tools/remember.js';
import { getDefinition as getUpdateDef, TOOL_NAME as UPDATE_NAME } from './tools/update.js';
import { getDefinition as getForgetDef, TOOL_NAME as FORGET_NAME } from './tools/forget.js';
import { getDefinition as getReorganizeDef, TOOL_NAME as REORGANIZE_NAME } from './tools/reorganize.js';
import { getDefinition as getSummarizeDef, TOOL_NAME as SUMMARIZE_NAME } from './tools/summarize.js';
import { getDefinition as getMergeSplitDef, TOOL_NAME as MERGESPLIT_NAME } from './tools/merge-split.js';
import { getDefinition as getNotebookDef, TOOL_NAME as NOTEBOOK_NAME } from './tools/notebook.js';

/** All tool names for bulk unregister. */
const ALL_TOOL_NAMES = [SEARCH_NAME, REMEMBER_NAME, UPDATE_NAME, FORGET_NAME, REORGANIZE_NAME, SUMMARIZE_NAME, MERGESPLIT_NAME, NOTEBOOK_NAME];

/** Cached tracker list string — refreshed on each registerTools() call. */
let _trackerListCache = '';

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
    const settings = getSettings();
    const trackerUids = settings.trackerUids || {};
    const trackerNames = [];

    for (const bookName of getActiveTunnelVisionBooks()) {
        const bookTrackers = trackerUids[bookName];
        if (!bookTrackers || !Array.isArray(bookTrackers) || bookTrackers.length === 0) continue;

        try {
            const bookData = await loadWorldInfo(bookName);
            if (!bookData?.entries) continue;

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

/**
 * Resolve which lorebook to write to. Auto-corrects when only one book is active.
 * @param {string|undefined} requestedBook - The lorebook name the AI provided.
 * @returns {{ book: string, error: string|null }} The resolved book name, or an error message.
 */
export function resolveTargetBook(requestedBook) {
    const activeBooks = getActiveTunnelVisionBooks();
    if (activeBooks.length === 0) {
        return { book: '', error: 'No active TunnelVision lorebooks.' };
    }

    // Single book: always use it, regardless of what the AI typed
    if (activeBooks.length === 1) {
        return { book: activeBooks[0], error: null };
    }

    // Multiple books: validate the AI's choice
    if (!requestedBook) {
        const desc = getBookListWithDescriptions();
        return { book: '', error: `Multiple lorebooks active. You must specify which one.\n${desc}` };
    }
    if (!activeBooks.includes(requestedBook)) {
        const desc = getBookListWithDescriptions();
        return { book: '', error: `Lorebook "${requestedBook}" is not active.\n${desc}` };
    }
    return { book: requestedBook, error: null };
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
 * Register all TunnelVision tools with ToolManager.
 * Each tool's getDefinition() may return null if preconditions aren't met
 * (e.g. Search returns null if no valid trees exist).
 */
export async function registerTools() {
    const activeBooks = getActiveTunnelVisionBooks();
    if (activeBooks.length === 0) {
        unregisterTools();
        _trackerListCache = '';
        return;
    }

    // Pre-fetch tracker list for injection into Search and Update descriptions
    _trackerListCache = await getTrackerList();

    const settings = getSettings();
    const disabled = settings.disabledTools || {};

    const allDefs = [
        { def: getSearchDef(), name: SEARCH_NAME },
        { def: getRememberDef(), name: REMEMBER_NAME },
        { def: getUpdateDef(), name: UPDATE_NAME },
        { def: getForgetDef(), name: FORGET_NAME },
        { def: getReorganizeDef(), name: REORGANIZE_NAME },
        { def: getSummarizeDef(), name: SUMMARIZE_NAME },
        { def: getMergeSplitDef(), name: MERGESPLIT_NAME },
        { def: getNotebookDef(), name: NOTEBOOK_NAME },
    ];

    const stealthMode = settings.stealthMode === true;

    let registered = 0;
    for (const { def, name } of allDefs) {
        if (disabled[name]) {
            // Unregister if it was previously registered
            try { ToolManager.unregisterFunctionTool(name); } catch { /* noop */ }
            continue;
        }
        if (!def) continue;

        // Clone def to avoid mutating the original
        let registrationDef = { ...def };

        // Inject tracker list into Search and Update descriptions
        if (_trackerListCache && (name === SEARCH_NAME || name === UPDATE_NAME)) {
            registrationDef.description = def.description + _trackerListCache;
        }

        // Apply global stealth mode override (forces all tools to stealth)
        if (stealthMode) {
            registrationDef.stealth = true;
        }

        try {
            ToolManager.registerFunctionTool(registrationDef);
            registered++;
        } catch (e) {
            console.error(`[TunnelVision] Failed to register tool "${def.name}":`, e);
        }
    }

    const eligible = allDefs.filter(({ def, name }) => def && !disabled[name]).length;
    console.log(`[TunnelVision] Registered ${registered}/${eligible} tools for ${activeBooks.length} lorebook(s)`);
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
}

// Re-export tool names for diagnostics
export { SEARCH_NAME, REMEMBER_NAME, UPDATE_NAME, FORGET_NAME, REORGANIZE_NAME, SUMMARIZE_NAME, MERGESPLIT_NAME, NOTEBOOK_NAME, ALL_TOOL_NAMES };
