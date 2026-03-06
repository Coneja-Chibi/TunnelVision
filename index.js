/**
 * TunnelVision - Reasoning-Based Lorebook Retrieval
 *
 * Replaces keyword-based lorebook activation with LLM-driven hierarchical
 * tree search via tool calls. The model navigates a tree index to find
 * contextually relevant entries instead of relying on brittle keyword triggers.
 *
 * Architecture:
 *   index.js        — Lean orchestrator (this file). Init, events, wiring only.
 *   tree-store.js   — Tree data structure, CRUD, serialization.
 *   tree-builder.js — Auto-build trees from metadata or LLM.
 *   tool-registry.js— ToolManager registration for all TunnelVision tools.
 *   tools/          — One file per tool (search, remember, update, forget, reorganize, notebook).
 *   entry-manager.js— Lorebook CRUD operations shared by memory tools.
 *   ui-controller.js— Settings panel rendering, tree editor, drag-and-drop.
 *   diagnostics.js  — Failure point checks and auto-fixes.
 *   commands.js     — !command syntax interceptor (summarize, remember, search, forget, ingest).
 *   auto-summary.js — Automatic summary injection every N messages.
 */

import { eventSource, event_types, extension_prompt_types, setExtensionPrompt } from '../../../../script.js';
import { ToolManager } from '../../../tool-calling.js';
import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { getSettings, isLorebookEnabled } from './tree-store.js';
import { preflightToolRuntimeState, registerTools } from './tool-registry.js';
import { buildNotebookPrompt } from './tools/notebook.js';
import { bindUIEvents, refreshUI } from './ui-controller.js';
import { initActivityFeed } from './activity-feed.js';
import { initCommands } from './commands.js';
import { initAutoSummary } from './auto-summary.js';

const EXTENSION_NAME = 'tunnelvision';
const EXTENSION_FOLDER = `third-party/TunnelVision`;

async function init() {
    // Ensure settings exist
    getSettings();

    // Render settings panel
    const settingsHtml = $(await renderExtensionTemplateAsync(EXTENSION_FOLDER, 'settings'));
    const container = document.getElementById('extensions_settings2');
    if (container) {
        container.appendChild(settingsHtml[0]);
    } else {
        console.error('[TunnelVision] Could not find extensions_settings2 container');
        return;
    }

    // Bind UI events
    bindUIEvents();

    // Initialize activity feed (listens for tool call events)
    initActivityFeed();

    // Wire up !command interception
    initCommands();

    // Wire up auto-summary interval tracking
    initAutoSummary();

    // Load initial state
    refreshUI();

    // Apply recurse limit override and register tools
    const settings = getSettings();
    applyRecurseLimit(settings);
    if (settings.globalEnabled !== false) {
        await registerTools();
    }

    // Listen for relevant events
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.WORLDINFO_UPDATED, onWorldInfoUpdated);
    if (event_types.WORLDINFO_SETTINGS_UPDATED) {
        eventSource.on(event_types.WORLDINFO_SETTINGS_UPDATED, onWorldInfoUpdated);
    }
    eventSource.on(event_types.APP_READY, onAppReady);

    // Suppress normal WI keyword scanning for TV-managed lorebooks
    if (event_types.WORLDINFO_ENTRIES_LOADED) {
        eventSource.on(event_types.WORLDINFO_ENTRIES_LOADED, onWorldInfoEntriesLoaded);
        console.debug('[TunnelVision] WI suppression listener registered');
    } else {
        console.warn('[TunnelVision] WORLDINFO_ENTRIES_LOADED event not found, WI suppression disabled');
    }

    // Inject mandatory tool call instruction when enabled
    if (event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    }

    console.log('[TunnelVision] Extension loaded');
}

async function onChatChanged() {
    refreshUI();
    await registerTools();
}

async function onWorldInfoUpdated() {
    refreshUI();
    await registerTools();
}

async function onAppReady() {
    await registerTools();
}

/**
 * Suppress normal WI keyword scanning for entries belonging to TV-managed lorebooks.
 * TV retrieves these entries via tool calls instead — letting them also trigger via
 * keywords would double-inject them into context.
 * @param {{ globalLore: Array, characterLore: Array, chatLore: Array, personaLore: Array }} data
 */
function onWorldInfoEntriesLoaded(data) {
    const settings = getSettings();
    if (settings.globalEnabled === false) return;

    const passthrough = settings.passthroughConstant !== false;
    let removed = 0;
    let passed = 0;
    const filterTvEntries = (arr) => {
        for (let i = arr.length - 1; i >= 0; i--) {
            if (arr[i].world && isLorebookEnabled(arr[i].world)) {
                // Let constant (always-active) entries through if the toggle is on
                if (passthrough && arr[i].constant) {
                    passed++;
                    continue;
                }
                arr.splice(i, 1);
                removed++;
            }
        }
    };

    filterTvEntries(data.globalLore);
    filterTvEntries(data.characterLore);
    filterTvEntries(data.chatLore);
    filterTvEntries(data.personaLore);

    if (removed > 0 || passed > 0) {
        console.log(`[TunnelVision] Suppressed ${removed} TV-managed entries from normal WI scanning` + (passed > 0 ? `, passed through ${passed} constant entries` : ''));
    }
}

const TV_PROMPT_KEY = 'tunnelvision_mandatory';
const TV_NOTEBOOK_KEY = 'tunnelvision_notebook';

/**
 * Inject or clear the mandatory tool call system prompt before each generation.
 * Runs before ST assembles the next request, so it can validate TV tool state first.
 */
async function onGenerationStarted() {
    const settings = getSettings();
    let runtimeState = null;

    if (settings.globalEnabled !== false) {
        runtimeState = await preflightToolRuntimeState({ repair: true, reason: 'generation', log: true });
    }

    // Mandatory tool call instruction
    if (
        settings.globalEnabled !== false
        && settings.mandatoryTools
        && runtimeState?.activeBooks?.length > 0
        && runtimeState.expectedToolNames.length > 0
        && runtimeState.eligibleToolNames.length > 0
    ) {
        const prompt = `[IMPORTANT INSTRUCTION: You MUST use at least one TunnelVision tool call this turn. Before responding to the user, search the lorebook for relevant context using TunnelVision_Search. If important new information emerged in the conversation, also use TunnelVision_Remember to save it. Do NOT skip tool calls — they are mandatory every generation.]`;
        setExtensionPrompt(TV_PROMPT_KEY, prompt, extension_prompt_types.IN_PROMPT, 0);
    } else {
        setExtensionPrompt(TV_PROMPT_KEY, '', extension_prompt_types.IN_PROMPT, 0);
        if (
            settings.globalEnabled !== false
            && settings.mandatoryTools
            && runtimeState
            && runtimeState.activeBooks.length > 0
            && runtimeState.expectedToolNames.length > 0
            && runtimeState.eligibleToolNames.length === 0
        ) {
            console.warn('[TunnelVision] Mandatory tools enabled, but no eligible TunnelVision tools are available for this generation.');
        }
    }

    // Inject notebook contents every turn (if enabled and notes exist)
    if (settings.globalEnabled !== false && settings.notebookEnabled !== false) {
        const notebookPrompt = buildNotebookPrompt();
        setExtensionPrompt(TV_NOTEBOOK_KEY, notebookPrompt, extension_prompt_types.IN_PROMPT, 0);
    } else {
        setExtensionPrompt(TV_NOTEBOOK_KEY, '', extension_prompt_types.IN_PROMPT, 0);
    }
}

/**
 * Apply the user's RECURSE_LIMIT override to ToolManager.
 * Only overrides when the user has set a value different from the default (5).
 * Stores the original value so we can restore on disable.
 * @param {Object} settings
 */
const ST_DEFAULT_RECURSE_LIMIT = 5;
function applyRecurseLimit(settings) {
    const limit = Number(settings.recurseLimit);
    if (!isFinite(limit) || limit < 1) {
        ToolManager.RECURSE_LIMIT = ST_DEFAULT_RECURSE_LIMIT;
        return;
    }
    // Clamp to sane range: 1–50. Over 50 is almost certainly a mistake.
    ToolManager.RECURSE_LIMIT = Math.min(Math.max(Math.round(limit), 1), 50);
}

// Exported so ui-controller can call it when the setting changes
export { applyRecurseLimit };

// Initialize
await init();
