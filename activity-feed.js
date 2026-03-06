/**
 * TunnelVision Activity Feed
 * Floating widget that shows real-time worldbook entry activations and tool call activity.
 * Lives on document.body as a draggable trigger button + expandable panel.
 */

import { eventSource, event_types } from '../../../../script.js';
import { getContext } from '../../../st-context.js';
import { ALL_TOOL_NAMES, getActiveTunnelVisionBooks } from './tool-registry.js';
import { getSettings, isLorebookEnabled, getTree } from './tree-store.js';
import { openTreeEditorForBook } from './ui-controller.js';

const MAX_FEED_ITEMS = 50;
const STORAGE_KEY_POS = 'tv-feed-trigger-position';
const METADATA_KEY = 'tunnelvision_feed';

/** Track which chatId the current feedItems belong to, prevents cross-chat bleed. */
let activeChatId = null;

// Turn-level tool call accumulator for console summary
/** @type {Array<{name: string, verb: string, summary: string}>} */
let turnToolCalls = [];

/** @type {Array<{id: number, type: string, icon: string, verb: string, color: string, summary: string, timestamp: number, keys?: string[], uid?: number}>} */
let feedItems = [];
let nextId = 0;
let feedInitialized = false;

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

    // Reload feed from chat metadata on chat switch
    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => {
            loadFeed();
            if (panelEl?.classList.contains('open')) renderAllItems();
        });
    }

    // Reset feed and console accumulator each turn
    if (event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, () => {
            turnToolCalls = [];
            feedItems = [];
            nextId = 0;
            saveFeed();
            if (panelEl?.classList.contains('open')) renderAllItems();
        });
    }
    if (event_types.MESSAGE_RECEIVED) {
        eventSource.on(event_types.MESSAGE_RECEIVED, printTurnSummary);
    }
}

// ── Persistence (chat metadata) ──

function saveFeed() {
    try {
        const context = getContext();
        if (!context.chatMetadata || !context.chatId) return;
        // Don't save if the active chat changed out from under us (e.g. late callback)
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

    // Position near the settings button in the panel header
    const panelHeader = panelEl?.querySelector('.tv-float-panel-header');
    if (panelHeader) {
        panelHeader.appendChild(picker);
        // Auto-dismiss on outside click
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

    for (const entry of entries) {
        // Only show entries from TV-managed lorebooks
        if (entry.world && !isLorebookEnabled(entry.world)) continue;

        const label = entry.comment || entry.key?.[0] || `UID ${entry.uid}`;
        feedItems.unshift({
            id: nextId++,
            type: 'wi',
            icon: 'fa-book-open',
            verb: 'Triggered',
            color: '#e84393',
            summary: label,
            uid: entry.uid,
            keys: entry.key || [],
            timestamp: Date.now(),
        });
    }

    trimFeed();
    updateBadge(entries.length);
    if (panelEl?.classList.contains('open')) renderAllItems();
    pulseTrigger();
}

function onToolCallsPerformed(invocations) {
    if (!Array.isArray(invocations)) return;

    const settings = getSettings();
    if (settings.globalEnabled === false) return;

    // Guard: ignore callbacks from a chat we've already switched away from
    try {
        const currentChatId = getContext().chatId;
        if (activeChatId && currentChatId !== activeChatId) return;
    } catch { /* no chat context */ }

    for (const inv of invocations) {
        if (!ALL_TOOL_NAMES.includes(inv.name)) continue;

        let params = {};
        try { params = JSON.parse(inv.parameters || '{}'); } catch { /* noop */ }

        const display = TOOL_DISPLAY[inv.name] || { icon: 'fa-gear', verb: 'Used', color: '#888' };
        const summary = buildToolSummary(inv.name, params, inv.result || '');
        feedItems.unshift({
            id: nextId++,
            type: 'tool',
            icon: display.icon,
            verb: display.verb,
            color: display.color,
            summary,
            timestamp: Date.now(),
        });

        // Accumulate for end-of-turn console summary
        turnToolCalls.push({ name: inv.name, verb: display.verb, summary });
    }

    trimFeed();
    if (panelEl?.classList.contains('open')) renderAllItems();
    pulseTrigger();
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
    const msg = tab === 'tools' ? 'No tool calls yet' : 'No WorldBook entries active';
    const sub = tab === 'tools' ? 'Tool calls will appear here during generation' : 'Start chatting to trigger worldbook entries';
    empty.appendChild(el('span', null, msg));
    empty.appendChild(el('span', 'tv-float-empty-sub', sub));
    panelBody.appendChild(empty);
}

function renderAllItems() {
    if (!panelBody) return;
    const tab = getActiveTab();
    const filtered = feedItems.filter(item => {
        if (tab === 'all') return true;
        if (tab === 'wi') return item.type === 'wi';
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
    const row = el('div', `tv-float-item${item.type === 'wi' ? ' tv-float-item-wi' : ''}`);

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
    textRow.appendChild(el('span', 'tv-float-item-summary', item.summary));
    body.appendChild(textRow);

    // Keys (for WI entries)
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

// ── Utilities ──

function buildToolSummary(toolName, params, result) {
    switch (toolName) {
        case 'TunnelVision_Search': {
            const action = params.action || 'navigate';
            const reasoning = params.reasoning || '';
            const nodeIds = params.node_ids || (params.node_id ? [params.node_id] : []);
            let count = '';
            try {
                const parsed = JSON.parse(result);
                if (Array.isArray(parsed)) count = ` → ${parsed.length} entries`;
                else if (parsed.entries) count = ` → ${parsed.entries.length} entries`;
            } catch { /* noop */ }
            if (reasoning) return `${truncate(reasoning, 50)}${count}`;
            if (nodeIds.length > 0) return `${action} [${nodeIds.slice(0, 3).join(', ')}${nodeIds.length > 3 ? '...' : ''}]${count}`;
            return `${action}${count}`;
        }
        case 'TunnelVision_Remember': {
            const title = params.title || params.comment || params.name || params.key || '';
            return title ? `"${truncate(title, 50)}"` : 'new entry';
        }
        case 'TunnelVision_Update': {
            const title = params.title || params.comment || params.name || '';
            const uid = params.uid;
            if (title) return `"${truncate(title, 50)}"`;
            return uid !== undefined ? `UID ${uid}` : 'existing entry';
        }
        case 'TunnelVision_Forget': {
            const target = params.name || params.title || '';
            const uid = params.uid;
            if (target) return `"${truncate(target, 50)}"`;
            return uid !== undefined ? `UID ${uid}` : 'an entry';
        }
        case 'TunnelVision_Reorganize': {
            const action = params.action || '';
            const target = params.node_id || params.entry_uid || '';
            if (action && target) return `${action} → ${truncate(String(target), 30)}`;
            return action || 'tree structure';
        }
        case 'TunnelVision_Summarize': {
            const scene = params.title || params.scene || '';
            return scene ? `"${truncate(scene, 50)}"` : 'scene summary';
        }
        case 'TunnelVision_MergeSplit': {
            const action = params.action || 'merge';
            const title = params.merged_title || params.new_title || '';
            if (title) return `${action}: "${truncate(title, 40)}"`;
            const uids = [params.keep_uid, params.remove_uid, params.uid].filter(u => u !== undefined);
            if (uids.length > 0) return `${action} UIDs [${uids.join(', ')}]`;
            return action;
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
