/**
 * TunnelVision Auto-Summary
 * Tracks message count and injects a forced summarize instruction
 * every N messages. Lightweight — no LLM calls of its own, just
 * piggybacks on the next generation by injecting an extension prompt.
 */

import { eventSource, event_types, setExtensionPrompt, extension_prompt_types } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { getSettings } from './tree-store.js';
import { getActiveTunnelVisionBooks } from './tool-registry.js';
import { runSummary } from './summary-runner.js';

const TV_AUTOSUMMARY_KEY = 'tunnelvision_autosummary';
const TV_AUTOSUMMARY_COUNTER_KEY = 'tunnelvision_autosummary_counter';

/** Message count since last summary, keyed by chatId */
const counters = new Map();
const pendingSummaries = new Map();

let _autoSummaryInitialized = false;

export function initAutoSummary() {
    if (_autoSummaryInitialized) return;
    _autoSummaryInitialized = true;

    // Restore the counter for whatever chat is already loaded (CHAT_CHANGED
    // may not fire again for a chat that was loaded before this ran).
    hydrateCounterFromMetadata();

    // Count user+AI messages. Only the AI-reply event may TRIGGER a run — firing
    // on MESSAGE_SENT would summarize a turn that has not been answered yet.
    if (event_types.MESSAGE_RECEIVED) {
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceivedAndMaybeRun);
    }
    // Also count user messages sent
    if (event_types.MESSAGE_SENT) {
        eventSource.on(event_types.MESSAGE_SENT, onMessageReceived);
    }
    // Inject prompt before generation when threshold hit
    if (event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, onGenerationForAutoSummary);
    }
    // Reset pending flag on chat change
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    }
}

function getChatId() {
    try {
        return getContext().chatId || null;
    } catch {
        return null;
    }
}

function onMessageReceived() {
    const settings = getSettings();
    if (!settings.autoSummaryEnabled || settings.globalEnabled === false) return;

    const chatId = getChatId();
    if (!chatId) return;

    const count = (counters.get(chatId) || 0) + 1;
    counters.set(chatId, count);
    persistCounter(chatId, count);
}

/**
 * ⚠️ This used to inject an [AUTO-SUMMARY INSTRUCTION] telling the CHAT model it
 * MUST call TunnelVision_Summarize. That only ever worked when the host had
 * function calling enabled; with it off (a supported, commonly recommended
 * configuration) the request carries no tools array, the model cannot comply,
 * and it types the tool call into the scene as narrative text instead.
 *
 * Auto-summary now performs the summary itself via the analytical connection
 * (see summary-runner.js), so it no longer depends on host tool support at all.
 * This handler survives only to purge any stale injected prompt.
 */
function onGenerationForAutoSummary() {
    clearPrompt();
}

/** True while a summary is in flight, so overlapping turns cannot double-fire. */
let _summaryInFlight = false;

/** Count the AI reply, then run a summary if the interval has been reached. */
async function onMessageReceivedAndMaybeRun() {
    onMessageReceived();
    await maybeRunAutoSummary();
}

async function maybeRunAutoSummary() {
    const settings = getSettings();
    if (!settings.autoSummaryEnabled || settings.globalEnabled === false) return;
    if (_summaryInFlight) return;

    const chatId = getChatId();
    if (!chatId) return;

    const count = counters.get(chatId) || 0;
    const interval = settings.autoSummaryInterval || 20;
    if (count < interval) return;

    if (getActiveTunnelVisionBooks().length === 0) return;

    _summaryInFlight = true;
    pendingSummaries.set(chatId, { triggeredAt: count });
    try {
        console.log(`[TunnelVision] Auto-summary firing at ${count}/${interval} messages`);
        const result = await runSummary({ source: 'auto' });
        if (result.ok) {
            toastr?.success?.(`Summary saved: "${result.title}" (UID ${result.uid})`, 'TunnelVision');
            markAutoSummaryComplete();
        } else {
            // Do NOT reset the counter — a failed run should retry next turn
            // rather than silently swallowing the interval.
            console.warn(`[TunnelVision] Auto-summary did not run: ${result.reason}`);
            pendingSummaries.delete(chatId);
        }
    } catch (e) {
        console.error('[TunnelVision] Auto-summary failed:', e);
        pendingSummaries.delete(chatId);
    } finally {
        _summaryInFlight = false;
    }
}

function onChatChanged() {
    hydrateCounterFromMetadata();
    clearPrompt();
}

function clearPrompt() {
    setExtensionPrompt(TV_AUTOSUMMARY_KEY, '', extension_prompt_types.IN_PROMPT, 0);
}

/**
 * Persist the message counter to this chat's metadata so it survives a
 * page reload or chat switch-away-and-back instead of resetting to 0.
 */
function persistCounter(chatId, count) {
    try {
        const context = getContext();
        if (!context.chatMetadata || context.chatId !== chatId) return;
        context.chatMetadata[TV_AUTOSUMMARY_COUNTER_KEY] = count;
        context.saveMetadataDebounced();
    } catch { /* no active chat */ }
}

/** Restore the in-memory counter for the active chat from its metadata. */
function hydrateCounterFromMetadata() {
    const chatId = getChatId();
    if (!chatId) return;
    try {
        const context = getContext();
        const stored = context.chatMetadata?.[TV_AUTOSUMMARY_COUNTER_KEY];
        if (typeof stored === 'number' && Number.isFinite(stored)) {
            counters.set(chatId, stored);
        }
    } catch { /* no active chat */ }
}

export function markAutoSummaryComplete() {
    const chatId = getChatId();
    if (!chatId) return;

    counters.set(chatId, 0);
    pendingSummaries.delete(chatId);
    persistCounter(chatId, 0);
    clearPrompt();
}

/** Get the current counter for the active chat. Used by UI. */
export function getAutoSummaryCount() {
    const chatId = getChatId();
    if (!chatId) return 0;
    return counters.get(chatId) || 0;
}

/** Reset the counter for the active chat. Used by UI and diagnostics. */
export function resetAutoSummaryCount() {
    const chatId = getChatId();
    if (!chatId) return;

    counters.set(chatId, 0);
    pendingSummaries.delete(chatId);
    persistCounter(chatId, 0);
    clearPrompt();
}
