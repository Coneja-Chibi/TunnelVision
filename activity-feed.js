/**
 * TunnelVision Activity Feed
 * Floating widget that shows real-time worldbook entry activations and tool call activity.
 * Lives on document.body as a draggable trigger button + expandable panel.
 */

import { chat, eventSource, event_types, saveChatConditional } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { ALL_TOOL_NAMES, getActiveTunnelVisionBooks } from './tool-registry.js';
import { getSettings, isLorebookEnabled, getTree } from './tree-store.js';
import { openTreeEditorForBook } from './ui-controller.js';

const MAX_FEED_ITEMS = 50;
const MAX_RENDERED_RETRIEVED_ENTRIES = 5;
const STORAGE_KEY_POS = 'tv-feed-trigger-position';
const METADATA_KEY = 'tunnelvision_feed';
const HIDDEN_TOOL_CALL_FLAG = 'tvHiddenToolCalls';

/** Track which chatId the current feedItems belong to, prevents cross-chat bleed. */
let activeChatId = null;

// Turn-level tool call accumulator for console summary
/** @type {Array<{name: string, verb: string, summary: string}>} */
let turnToolCalls = [];

/**
 * @typedef {Object} RetrievedEntry
 * @property {string} lorebook
 * @property {number|null} uid
 * @property {string} title
 */

/**
 * @typedef {Object} FeedItem
 * @property {number} id
 * @property {'entry'|'tool'} type
 * @property {string} icon
 * @property {string} verb
 * @property {string} color
 * @property {string} [summary]
 * @property {number} timestamp
 * @property {'native'|'tunnelvision'} [source]
 * @property {string} [lorebook]
 * @property {number|null} [uid]
 * @property {string} [title]
 * @property {string[]} [keys]
 * @property {RetrievedEntry[]} [retrievedEntries]
 */

/** @type {FeedItem[]} */
let feedItems = [];
let nextId = 0;
let feedInitialized = false;
let hiddenToolCallRefreshTimer = null;
let hiddenToolCallRefreshNeedsSync = false;

/** @type {HTMLElement|null} */
let triggerEl = null;
/** @type {HTMLElement|null} */
let panelEl = null;
/** @type {HTMLElement|null} */
let panelBody = null;

// Tool display config
const TOOL_DISPLAY = {
    'TunnelVision_Search':     { icon: 'fa-magnifying-glass', verb: 'Searched', color: '#e84393' },
    'TunnelVision_Remember':   { icon: 'fa-brain',           verb: 'Remembered', color: '#6c5ce7' },
    'TunnelVision_Update':     { icon: 'fa-pen',             verb: 'Updated', color: '#f0946c' },
    'TunnelVision_Forget':     { icon: 'fa-eraser',          verb: 'Forgot', color: '#ef4444' },
    'TunnelVision_Reorganize': { icon: 'fa-arrows-rotate',   verb: 'Reorganized', color: '#00b894' },
    'TunnelVision_Summarize':  { icon: 'fa-file-lines',      verb: 'Summarized', color: '#fdcb6e' },
    'TunnelVision_MergeSplit': { icon: 'fa-code-merge',       verb: 'Merged/Split', color: '#0984e3' },
    'TunnelVision_Notebook':   { icon: 'fa-note-sticky',     verb: 'Noted', color: '#a29bfe' },
};

/**
 * Initialize the activity feed — create floating widget and bind events.
 * Called once from index.js init.
 */
export function initActivityFeed() {
    if (feedInitialized) return;
    feedInitialized = true;

    loadFeed();
    createTriggerButton();
    createPanel();

    // Listen for WI activations (primary — shows what entries triggered)
    if (event_types.WORLD_INFO_ACTIVATED) {
        eventSource.on(event_types.WORLD_INFO_ACTIVATED, onWorldInfoActivated);
    }

    // Listen for TV tool calls (secondary)
    if (event_types.TOOL_CALLS_PERFORMED) {
        eventSource.on(event_types.TOOL_CALLS_PERFORMED, onToolCallsPerformed);
    }

    // Listen for tool call rendering to apply visual hiding
    if (event_types.TOOL_CALLS_RENDERED) {
        eventSource.on(event_types.TOOL_CALLS_RENDERED, onToolCallsRendered);
    }

    // Reload feed from chat metadata on chat switch
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            loadFeed();
            if (panelEl?.classList.contains('open')) renderAllItems();
            queueHiddenToolCallRefresh(false);
        });
    }

    // Reset turn accumulator each generation
    if (event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, () => {
            turnToolCalls = [];
        });
    }
    if (event_types.MESSAGE_RECEIVED) {
        eventSource.on(event_types.MESSAGE_RECEIVED, printTurnSummary);
    }

    queueHiddenToolCallRefresh(false);
}

// ── Persistence (chat metadata) ──

function saveFeed() {
    try {
        const context = getContext();
        if (!context.chatMetadata || !context.chatId) return;
        if (activeChatId && context.chatId !== activeChatId) return;
        context.chatMetadata[METADATA_KEY] = { items: feedItems, nextId };
        context.saveMetadataDebounced();
    } catch { /* no active chat */ }
}

function loadFeed() {
    feedItems = [];
    nextId = 0;
    activeChatId = null;
    try {
        const context = getContext();
        if (!context.chatId) return;
        activeChatId = context.chatId;
        const data = context.chatMetadata?.[METADATA_KEY];
        if (data && Array.isArray(data.items)) {
            feedItems = data.items;
            nextId = typeof data.nextId === 'number' ? data.nextId : feedItems.length;
        }
    } catch { /* no active chat */ }
}

// ── DOM Helpers ──

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
}

function icon(iconClass) {
    const i = document.createElement('i');
    i.className = `fa-solid ${iconClass}`;
    return i;
}

// ── Tree editor shortcut ──

/**
 * Open the tree editor for an active TV lorebook.
 * Single book → opens directly. Multiple → shows a quick picker dropdown.
 */
function openTreeEditorFromFeed() {
    const books = getActiveTunnelVisionBooks().filter(b => {
        const tree = getTree(b);
        return tree && tree.root;
    });

    if (books.length === 0) {
        toastr.info('No lorebooks with built trees. Build a tree first in TunnelVision settings.', 'TunnelVision');
        return;
    }

    if (books.length === 1) {
        openTreeEditorForBook(books[0]);
        return;
    }

    // Multiple books — show a quick picker
    const picker = el('div', 'tv-book-picker');
    const label = el('div', 'tv-book-picker-label');
    label.textContent = 'Choose lorebook:';
    picker.appendChild(label);

    for (const name of books) {
        const btn = el('button', 'tv-book-picker-btn');
        btn.textContent = name;
        btn.addEventListener('click', () => {
            picker.remove();
            openTreeEditorForBook(name);
        });
        picker.appendChild(btn);
    }

    const panelHeader = panelEl?.querySelector('.tv-float-panel-header');
    if (panelHeader) {
        panelHeader.appendChild(picker);
        const dismiss = (e) => {
            if (!picker.contains(e.target)) {
                picker.remove();
                document.removeEventListener('click', dismiss, true);
            }
        };
        setTimeout(() => document.addEventListener('click', dismiss, true), 0);
    }
}

// ── Trigger Button ──

function createTriggerButton() {
    triggerEl = el('div', 'tv-float-trigger');
    triggerEl.title = 'TunnelVision Activity Feed';
    triggerEl.setAttribute('data-tv-count', '0');
    triggerEl.appendChild(icon('fa-satellite-dish'));

    // Load saved position
    const saved = localStorage.getItem(STORAGE_KEY_POS);
    if (saved) {
        try {
            const pos = JSON.parse(saved);
            triggerEl.style.left = pos.left;
            triggerEl.style.top = pos.top;
            triggerEl.style.bottom = 'auto';
            triggerEl.style.right = 'auto';
        } catch { /* use default */ }
    }

    // Drag support
    let dragging = false;
    let offsetX = 0, offsetY = 0;

    triggerEl.addEventListener('pointerdown', (e) => {
        dragging = false;
        offsetX = e.clientX - triggerEl.getBoundingClientRect().left;
        offsetY = e.clientY - triggerEl.getBoundingClientRect().top;
        triggerEl.setPointerCapture(e.pointerId);
    });

    triggerEl.addEventListener('pointermove', (e) => {
        if (!triggerEl.hasPointerCapture(e.pointerId)) return;
        const dx = e.clientX - triggerEl.getBoundingClientRect().left - offsetX;
        const dy = e.clientY - triggerEl.getBoundingClientRect().top - offsetY;
        if (!dragging && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
            dragging = true;
        }
        if (dragging) {
            const x = Math.max(0, Math.min(window.innerWidth - 40, e.clientX - offsetX));
            const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - offsetY));
            triggerEl.style.left = `${x}px`;
            triggerEl.style.top = `${y}px`;
            triggerEl.style.bottom = 'auto';
            triggerEl.style.right = 'auto';
        }
    });

    triggerEl.addEventListener('pointerup', (e) => {
        triggerEl.releasePointerCapture(e.pointerId);
        if (dragging) {
            localStorage.setItem(STORAGE_KEY_POS, JSON.stringify({
                left: triggerEl.style.left,
                top: triggerEl.style.top,
            }));
            dragging = false;
        } else {
            togglePanel();
        }
    });

    document.body.appendChild(triggerEl);
}

// ── Panel ──

function createPanel() {
    panelEl = el('div', 'tv-float-panel');

    // Header
    const header = el('div', 'tv-float-panel-header');
    const title = el('span', 'tv-float-panel-title');
    title.appendChild(icon('fa-satellite-dish'));
    title.append(' TunnelVision Feed');
    header.appendChild(title);
    const settingsBtn = el('button', 'tv-float-panel-btn');
    settingsBtn.title = 'Open tree editor';
    settingsBtn.appendChild(icon('fa-folder-tree'));
    settingsBtn.addEventListener('click', openTreeEditorFromFeed);
    header.appendChild(settingsBtn);

    const clearBtn = el('button', 'tv-float-panel-btn');
    clearBtn.title = 'Clear feed';
    clearBtn.appendChild(icon('fa-trash-can'));
    clearBtn.addEventListener('click', () => clearFeed());
    header.appendChild(clearBtn);

    const closeBtn = el('button', 'tv-float-panel-btn');
    closeBtn.title = 'Close';
    closeBtn.appendChild(icon('fa-xmark'));
    closeBtn.addEventListener('click', () => {
        panelEl.classList.remove('open');
    });
    header.appendChild(closeBtn);
    panelEl.appendChild(header);

    // Tabs
    const tabs = el('div', 'tv-float-panel-tabs');
    for (const [key, label] of [['all', 'All'], ['wi', 'Entries'], ['tools', 'Tools']]) {
        const tab = el('button', `tv-float-tab${key === 'all' ? ' active' : ''}`, label);
        tab.dataset.tab = key;
        tab.addEventListener('click', () => {
            tabs.querySelectorAll('.tv-float-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            renderAllItems();
        });
        tabs.appendChild(tab);
    }
    panelEl.appendChild(tabs);

    // Body
    panelBody = el('div', 'tv-float-panel-body');
    panelEl.appendChild(panelBody);

    renderEmptyState('all');

    document.body.appendChild(panelEl);
}

function togglePanel() {
    if (!panelEl) return;
    const isOpen = panelEl.classList.toggle('open');
    if (isOpen) {
        positionPanel();
        renderAllItems();
        if (triggerEl) triggerEl.setAttribute('data-tv-count', '0');
    }
}

function positionPanel() {
    if (!triggerEl || !panelEl) return;
    const rect = triggerEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pw = 340;
    const ph = 420;

    let left = rect.right + 8;
    if (left + pw > vw - 16) left = rect.left - pw - 8;
    if (left < 16) left = 16;

    let top = rect.top;
    if (top + ph > vh - 16) top = vh - ph - 16;
    if (top < 16) top = 16;

    panelEl.style.left = `${left}px`;
    panelEl.style.top = `${top}px`;
}

// ── Event Handlers ──

function onWorldInfoActivated(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return;

    const settings = getSettings();
    if (settings.globalEnabled === false) return;

    // Guard: ignore callbacks from a chat we've already switched away from
    try {
        const currentChatId = getContext().chatId;
        if (activeChatId && currentChatId !== activeChatId) return;
    } catch { /* no chat context */ }

    const activeBooks = getActiveTunnelVisionBooks();
    if (activeBooks.length === 0) return;

    const timestamp = Date.now();
    const items = [];
    for (const entry of entries) {
        // Only show entries from TV-managed lorebooks
        if (entry.world && !isLorebookEnabled(entry.world)) continue;

        items.push(createEntryFeedItem({
            source: 'native',
            lorebook: typeof entry?.world === 'string' ? entry.world : '',
            uid: Number.isFinite(entry?.uid) ? entry.uid : null,
            title: entry.comment || entry.key?.[0] || `UID ${entry.uid}`,
            keys: Array.isArray(entry.key) ? entry.key : [],
            timestamp,
        }));
    }

    addFeedItems(items);
}

function onToolCallsPerformed(invocations) {
    if (!Array.isArray(invocations) || invocations.length === 0) return;

    const settings = getSettings();
    if (settings.globalEnabled === false) return;

    // Guard: ignore callbacks from a chat we've already switched away from
    try {
        const currentChatId = getContext().chatId;
        if (activeChatId && currentChatId !== activeChatId) return;
    } catch { /* no chat context */ }

    const timestamp = Date.now();
    const items = [];

    for (const invocation of invocations) {
        if (!ALL_TOOL_NAMES.includes(invocation?.name)) continue;

        const params = parseInvocationParameters(invocation.parameters);
        const retrievedEntries = invocation.name === 'TunnelVision_Search'
            ? extractRetrievedEntries(invocation.result)
            : [];

        // Create feed items for each retrieved entry
        for (const entry of retrievedEntries) {
            items.push(createEntryFeedItem({
                source: 'tunnelvision',
                lorebook: entry.lorebook,
                uid: entry.uid,
                title: entry.title || `UID ${entry.uid ?? '?'}`,
                timestamp,
            }));
        }

        const display = TOOL_DISPLAY[invocation.name] || { icon: 'fa-gear', verb: 'Used', color: '#888' };
        const summary = buildToolSummary(invocation.name, params, invocation.result || '', retrievedEntries);
        items.push({
            id: nextId++,
            type: 'tool',
            icon: display.icon,
            verb: display.verb,
            color: display.color,
            summary,
            timestamp,
            retrievedEntries,
        });

        // Accumulate for end-of-turn console summary
        turnToolCalls.push({ name: invocation.name, verb: display.verb, summary });
    }

    addFeedItems(items);
}

function onToolCallsRendered(invocations) {
    if (!Array.isArray(invocations) || invocations.length === 0) return;

    if (!areTunnelVisionInvocations(invocations) || getSettings().stealthMode !== true) {
        queueHiddenToolCallRefresh(false);
        return;
    }

    const messageIndex = findRenderedToolCallMessageIndex(invocations);
    if (messageIndex < 0) {
        queueHiddenToolCallRefresh(false);
        return;
    }

    const message = chat[messageIndex];
    if (!message.extra) {
        message.extra = {};
    }
    message.extra[HIDDEN_TOOL_CALL_FLAG] = true;

    applyHiddenToolCallVisibility(messageIndex, true);
}

// ── Rendering ──

function getActiveTab() {
    return panelEl?.querySelector('.tv-float-tab.active')?.dataset.tab || 'all';
}

function renderEmptyState(tab) {
    if (!panelBody) return;
    panelBody.replaceChildren();
    const empty = el('div', 'tv-float-empty');
    empty.appendChild(icon('fa-satellite-dish'));

    let message = 'No activity yet';
    let subMessage = 'Injected entries and tool calls will appear here during generation';

    if (tab === 'tools') {
        message = 'No tool calls yet';
        subMessage = 'Tool calls will appear here during generation';
    } else if (tab === 'wi') {
        message = 'No injected entries yet';
        subMessage = 'Native activations and TunnelVision retrievals will appear here';
    }

    empty.appendChild(el('span', null, message));
    empty.appendChild(el('span', 'tv-float-empty-sub', subMessage));
    panelBody.appendChild(empty);
}

function renderAllItems() {
    if (!panelBody) return;
    const tab = getActiveTab();
    const filtered = feedItems.filter(item => {
        if (tab === 'all') return true;
        if (tab === 'wi') return item.type === 'entry' || item.type === 'wi';
        if (tab === 'tools') return item.type === 'tool';
        return true;
    });

    if (filtered.length === 0) {
        renderEmptyState(tab);
        return;
    }

    panelBody.replaceChildren();
    for (const item of filtered) {
        panelBody.appendChild(buildItemElement(item));
    }
}

function buildItemElement(item) {
    const rowClasses = ['tv-float-item'];
    if (item.type === 'entry') {
        rowClasses.push('tv-float-item-entry');
        rowClasses.push(item.source === 'native' ? 'tv-float-item-entry-native' : 'tv-float-item-entry-tv');
    } else if (item.type === 'wi') {
        // Legacy feed items from before the type rename
        rowClasses.push('tv-float-item-wi');
    }

    const row = el('div', rowClasses.join(' '));

    // Icon
    const iconWrap = el('div', 'tv-float-item-icon');
    iconWrap.style.color = item.color;
    iconWrap.appendChild(icon(item.icon));
    row.appendChild(iconWrap);

    // Body
    const body = el('div', 'tv-float-item-body');
    const textRow = el('div', 'tv-float-item-row');
    const verb = el('span', 'tv-float-item-verb', item.verb);
    verb.style.color = item.color;
    textRow.appendChild(verb);

    const summaryText = (item.type === 'entry')
        ? formatEntrySummary(item, shouldIncludeLorebookForEntries())
        : (item.summary || '');
    textRow.appendChild(el('span', 'tv-float-item-summary', summaryText));
    body.appendChild(textRow);

    // Keys (for entry items)
    if (item.keys?.length > 0) {
        const keysRow = el('div', 'tv-float-item-keys');
        const shown = item.keys.slice(0, 4);
        for (const k of shown) {
            keysRow.appendChild(el('span', 'tv-float-key-tag', k));
        }
        if (item.keys.length > 4) {
            keysRow.appendChild(el('span', 'tv-float-key-more', `+${item.keys.length - 4}`));
        }
        body.appendChild(keysRow);
    }

    // Retrieved entries (for tool items from search)
    if (item.type === 'tool' && item.retrievedEntries?.length) {
        const entriesRow = el('div', 'tv-float-item-entries');
        const uniqueBooks = new Set(item.retrievedEntries.map(entry => entry.lorebook).filter(Boolean));
        const includeLorebook = uniqueBooks.size > 1;
        const shown = item.retrievedEntries.slice(0, MAX_RENDERED_RETRIEVED_ENTRIES);

        for (const entry of shown) {
            const chip = el('div', 'tv-float-entry-tag', formatRetrievedEntryLabel(entry, includeLorebook));
            chip.title = `${entry.lorebook || 'Lorebook'} | UID ${entry.uid ?? '?'}${entry.title ? ` | ${entry.title}` : ''}`;
            entriesRow.appendChild(chip);
        }

        if (item.retrievedEntries.length > MAX_RENDERED_RETRIEVED_ENTRIES) {
            const remaining = item.retrievedEntries.length - MAX_RENDERED_RETRIEVED_ENTRIES;
            entriesRow.appendChild(
                el('div', 'tv-float-entry-more', `+${remaining} more retrieved entr${remaining === 1 ? 'y' : 'ies'}`),
            );
        }

        body.appendChild(entriesRow);
    }

    row.appendChild(body);

    // Time
    row.appendChild(el('div', 'tv-float-item-time', formatTime(item.timestamp)));

    return row;
}

function updateBadge(count) {
    if (!triggerEl || panelEl?.classList.contains('open')) return;
    const current = parseInt(triggerEl.getAttribute('data-tv-count') || '0', 10);
    triggerEl.setAttribute('data-tv-count', String(current + count));
}

function pulseTrigger() {
    if (!triggerEl) return;
    triggerEl.classList.add('tv-float-pulse');
    setTimeout(() => triggerEl.classList.remove('tv-float-pulse'), 600);
}

function trimFeed() {
    if (feedItems.length > MAX_FEED_ITEMS) {
        feedItems = feedItems.slice(0, MAX_FEED_ITEMS);
    }
    saveFeed();
}

function addFeedItems(items) {
    if (!Array.isArray(items) || items.length === 0) return;

    feedItems = [...items, ...feedItems];
    trimFeed();
    updateBadge(items.length);
    if (panelEl?.classList.contains('open')) renderAllItems();
    pulseTrigger();
}

// ── Hidden Tool Call (Visual Hiding) ──

export async function refreshHiddenToolCallMessages({ syncFlags = false } = {}) {
    const hideMode = getSettings().stealthMode === true;
    let flagsMutated = false;

    for (let messageIndex = 0; messageIndex < chat.length; messageIndex++) {
        const message = chat[messageIndex];
        const invocations = Array.isArray(message?.extra?.tool_invocations) ? message.extra.tool_invocations : null;
        if (!invocations?.length) continue;

        const isPureTunnelVision = areTunnelVisionInvocations(invocations);
        if (!message.extra) {
            message.extra = {};
        }

        if (syncFlags && !isPureTunnelVision && message.extra[HIDDEN_TOOL_CALL_FLAG]) {
            delete message.extra[HIDDEN_TOOL_CALL_FLAG];
            flagsMutated = true;
        }

        if (syncFlags && hideMode && isPureTunnelVision && message.extra[HIDDEN_TOOL_CALL_FLAG] !== true) {
            message.extra[HIDDEN_TOOL_CALL_FLAG] = true;
            flagsMutated = true;
        }

        const shouldHide = hideMode
            && isPureTunnelVision
            && message.extra[HIDDEN_TOOL_CALL_FLAG] === true;
        applyHiddenToolCallVisibility(messageIndex, shouldHide);
    }

    if (flagsMutated) {
        await saveChatConditional();
    }
}

function queueHiddenToolCallRefresh(syncFlags = false) {
    hiddenToolCallRefreshNeedsSync = hiddenToolCallRefreshNeedsSync || syncFlags;
    if (hiddenToolCallRefreshTimer !== null) return;

    hiddenToolCallRefreshTimer = window.setTimeout(async () => {
        const shouldSync = hiddenToolCallRefreshNeedsSync;
        hiddenToolCallRefreshTimer = null;
        hiddenToolCallRefreshNeedsSync = false;
        await refreshHiddenToolCallMessages({ syncFlags: shouldSync });
    }, 50);
}

function applyHiddenToolCallVisibility(messageIndex, shouldHide) {
    const messageElement = document.querySelector(`.mes[mesid="${messageIndex}"]`);
    if (!(messageElement instanceof HTMLElement)) return;

    messageElement.classList.toggle('tv-hidden-tool-call', shouldHide);
    if (shouldHide) {
        messageElement.dataset.tvHiddenToolCalls = 'true';
    } else {
        delete messageElement.dataset.tvHiddenToolCalls;
    }
}

function findRenderedToolCallMessageIndex(invocations) {
    for (let messageIndex = chat.length - 1; messageIndex >= 0; messageIndex--) {
        const messageInvocations = chat[messageIndex]?.extra?.tool_invocations;
        if (!Array.isArray(messageInvocations)) continue;

        if (messageInvocations === invocations || toolInvocationArraysMatch(messageInvocations, invocations)) {
            return messageIndex;
        }
    }

    return -1;
}

function toolInvocationArraysMatch(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
        return false;
    }

    return left.every((leftInvocation, index) => {
        const rightInvocation = right[index];
        return leftInvocation?.name === rightInvocation?.name
            && String(leftInvocation?.id ?? '') === String(rightInvocation?.id ?? '')
            && normalizeInvocationField(leftInvocation?.parameters) === normalizeInvocationField(rightInvocation?.parameters);
    });
}

function normalizeInvocationField(value) {
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) return '';

    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function areTunnelVisionInvocations(invocations) {
    return Array.isArray(invocations)
        && invocations.length > 0
        && invocations.every(invocation => ALL_TOOL_NAMES.includes(invocation?.name));
}

// ── Public API ──

export function clearFeed() {
    feedItems = [];
    saveFeed();
    if (triggerEl) triggerEl.setAttribute('data-tv-count', '0');
    if (panelEl?.classList.contains('open')) renderAllItems();
}

export function getFeedItems() {
    return [...feedItems];
}

// ── Entry / Retrieved Entry Helpers ──

function createEntryFeedItem({ source, lorebook = '', uid = null, title = '', keys = [], timestamp }) {
    return {
        id: nextId++,
        type: 'entry',
        source,
        icon: 'fa-book-open',
        verb: source === 'native' ? 'Triggered' : 'Injected',
        color: source === 'native' ? '#e84393' : '#fdcb6e',
        lorebook,
        uid,
        title,
        keys,
        timestamp,
    };
}

function shouldIncludeLorebookForEntries() {
    const lorebooks = new Set(
        feedItems
            .filter(item => item.type === 'entry' && typeof item.lorebook === 'string' && item.lorebook.trim())
            .map(item => item.lorebook.trim()),
    );
    return lorebooks.size > 1;
}

function formatEntrySummary(item, includeLorebook) {
    const title = truncate(item.title || `UID ${item.uid ?? '?'}`, includeLorebook ? 42 : 52);
    const uidLabel = item.uid !== null && item.uid !== undefined ? `#${item.uid}` : '#?';

    if (includeLorebook && item.lorebook) {
        return `${item.lorebook}: ${title} (${uidLabel})`;
    }

    return `${title} (${uidLabel})`;
}

function formatRetrievedEntryLabel(entry, includeLorebook) {
    const title = truncate(entry.title || `UID ${entry.uid ?? '?'}`, includeLorebook ? 42 : 52);
    const uidLabel = entry.uid !== null && entry.uid !== undefined ? `#${entry.uid}` : '#?';

    return includeLorebook
        ? `${entry.lorebook}: ${title} (${uidLabel})`
        : `${title} (${uidLabel})`;
}

// ── Retrieved Entry Parsing ──

function parseInvocationParameters(parameters) {
    if (!parameters) return {};
    if (typeof parameters === 'object') return parameters;

    try {
        return JSON.parse(parameters);
    } catch {
        return {};
    }
}

function extractRetrievedEntries(result) {
    if (!result) return [];

    const text = typeof result === 'string' ? result : JSON.stringify(result);
    const entries = [];
    const seen = new Set();

    for (const line of text.split(/\r?\n/)) {
        const entry = parseRetrievedEntryHeader(line.trim());
        if (!entry) continue;

        const key = `${entry.lorebook}:${entry.uid ?? '?'}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push(entry);
    }

    return entries;
}

function parseRetrievedEntryHeader(line) {
    if (!line.startsWith('[Lorebook: ') || !line.endsWith(']')) {
        return null;
    }

    const body = line.slice(1, -1);
    const parts = body.split(' | ');
    if (parts.length < 3) {
        return null;
    }

    const lorebook = parts[0].replace(/^Lorebook:\s*/, '').trim();
    const uidRaw = parts[1].replace(/^UID:\s*/, '').trim();
    const title = parts.slice(2).join(' | ').replace(/^Title:\s*/, '').trim();
    const uid = parseInt(uidRaw, 10);

    return {
        lorebook,
        uid: Number.isFinite(uid) ? uid : null,
        title,
    };
}

// ── Tool Summary Builder ──

function buildToolSummary(toolName, params, result, retrievedEntries = []) {
    switch (toolName) {
        case 'TunnelVision_Search': {
            const action = params.action || 'retrieve';
            const nodeIds = Array.isArray(params.node_ids) ? params.node_ids : (params.node_id ? [params.node_id] : []);
            if (action === 'navigate') {
                return nodeIds.length > 0 ? `navigate ${nodeIds[0]}` : 'navigate tree';
            }
            if (retrievedEntries.length > 0) {
                if (retrievedEntries.length === 1) {
                    const entry = retrievedEntries[0];
                    return `retrieved "${truncate(entry.title || `UID ${entry.uid ?? '?'}`, 42)}"`;
                }
                const lorebooks = new Set(retrievedEntries.map(entry => entry.lorebook).filter(Boolean));
                if (lorebooks.size === 1) {
                    return `retrieved ${retrievedEntries.length} entries from ${Array.from(lorebooks)[0]}`;
                }
                return `retrieved ${retrievedEntries.length} entries from ${lorebooks.size} lorebooks`;
            }
            if (typeof result === 'string' && result.startsWith('Node(s) not found:')) {
                return truncate(result, 60);
            }
            return nodeIds.length > 0 ? `retrieve ${nodeIds.join(', ')}` : 'search tree';
        }
        case 'TunnelVision_Remember': {
            const title = params.title || '';
            return title ? `"${truncate(title, 50)}"` : 'new entry';
        }
        case 'TunnelVision_Update': {
            const uid = params.uid ?? '';
            const title = params.title || '';
            if (title) return `UID ${uid || '?'} -> "${truncate(title, 40)}"`;
            return uid ? `UID ${uid}` : 'existing entry';
        }
        case 'TunnelVision_Forget': {
            const uid = params.uid ?? '';
            const reason = params.reason || '';
            if (uid && reason) return `UID ${uid} (${truncate(reason, 30)})`;
            return uid ? `UID ${uid}` : 'an entry';
        }
        case 'TunnelVision_Reorganize':
            switch (params.action) {
                case 'move':
                    return `UID ${params.uid ?? '?'} -> ${params.target_node_id || '?'}`;
                case 'create_category':
                    return params.label ? `create "${truncate(params.label, 40)}"` : 'create category';
                case 'list_entries':
                    return params.node_id ? `list ${params.node_id}` : 'list entries';
                default:
                    return params.action || 'tree structure';
            }
        case 'TunnelVision_Summarize': {
            const title = params.title || '';
            return title ? `"${truncate(title, 50)}"` : 'scene summary';
        }
        case 'TunnelVision_MergeSplit': {
            const action = params.action || '';
            if (action === 'merge') {
                return `merge ${params.keep_uid ?? '?'} + ${params.remove_uid ?? '?'}`;
            }
            if (action === 'split') {
                return `split ${params.uid ?? '?'}`;
            }
            return 'entries';
        }
        case 'TunnelVision_Notebook': {
            const action = params.action || 'write';
            const title = params.title || '';
            return title ? `${action}: "${truncate(title, 40)}"` : action;
        }
        default:
            return '';
    }
}

function truncate(str, max) {
    if (!str) return '';
    return str.length > max ? str.substring(0, max) + '...' : str;
}

function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Print a concise console summary of all TV tool calls made this turn.
 * Fires on MESSAGE_RECEIVED (after all tool recursion completes).
 */
function printTurnSummary() {
    if (turnToolCalls.length === 0) return;
    const lines = turnToolCalls.map((tc, i) => `  ${i + 1}. ${tc.verb} ${tc.summary}`);
    console.log(`[TunnelVision] Turn summary (${turnToolCalls.length} tool calls):\n${lines.join('\n')}`);
    turnToolCalls = [];
}
