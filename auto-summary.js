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

const TV_AUTOSUMMARY_KEY = 'tunnelvision_autosummary';

/** Message count since last summary, keyed by chatId */
const counters = new Map();
const pendingSummaries = new Map();

let _autoSummaryInitialized = false;

export function initAutoSummary() {
    if (_autoSummaryInitialized) return;
    _autoSummaryInitialized = true;

    // Count user+AI messages
    if (event_types.MESSAGE_RECEIVED) {
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
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
}

function onGenerationForAutoSummary() {
    const settings = getSettings();
    if (!settings.autoSummaryEnabled || settings.globalEnabled === false) {
        clearPrompt();
        return;
    }

    const chatId = getChatId();
    if (!chatId) return;

    const count = counters.get(chatId) || 0;
    const interval = settings.autoSummaryInterval || 20;
    const activeBooks = getActiveTunnelVisionBooks();
    if (activeBooks.length === 0) {
        clearPrompt();
        return;
    }

    if (count >= interval) {
        if (!pendingSummaries.has(chatId)) {
            pendingSummaries.set(chatId, { triggeredAt: count });
            console.log(`[TunnelVision] Auto-summary pending after ${count} messages`);
        }

        const prompt = `[AUTO-SUMMARY INSTRUCTION: ${count} messages have passed since the last summary. You MUST call TunnelVision_Summarize this turn to create a summary of recent events. Write a descriptive title and thorough summary of what has happened in the last ~${count} messages. After summarizing, continue responding to the user normally.]`;
        setExtensionPrompt(TV_AUTOSUMMARY_KEY, prompt, extension_prompt_types.IN_PROMPT, 0);
        return;
    }

    clearPrompt();
}

function onChatChanged() {
    clearPrompt();
}

function clearPrompt() {
    setExtensionPrompt(TV_AUTOSUMMARY_KEY, '', extension_prompt_types.IN_PROMPT, 0);
}

export function markAutoSummaryComplete() {
    const chatId = getChatId();
    if (!chatId) return;

    counters.set(chatId, 0);
    pendingSummaries.delete(chatId);
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
    clearPrompt();
}
