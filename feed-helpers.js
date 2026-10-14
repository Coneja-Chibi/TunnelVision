/**
 * TunnelVision Activity Feed — Helper Utilities
 *
 * Parsing, tool summary, diff computation, and version history panel builders.
 * Extracted from activity-feed.js to keep the main file focused on orchestration.
 */

import { bumpNextId, getFeedItemsRaw, MAX_RENDERED_RETRIEVED_ENTRIES } from './feed-state.js';
import { formatShortDateTime } from './shared-utils.js';

// ── DOM Helpers (local) ──────────────────────────────────────────

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

// ── Truncate / Format ────────────────────────────────────────────

export function truncate(str, max) {
    if (!str) return '';
    return str.length > max ? str.substring(0, max) + '...' : str;
}

export function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Entry / Retrieved Entry Helpers ──────────────────────────────

/**
 * Create a feed item for a lorebook entry activation.
 */
export function createEntryFeedItem({ source, lorebook = '', uid = null, title = '', keys = [], timestamp }) {
    return {
        id: bumpNextId(),
        type: 'entry',
        source,
        icon: 'fa-book-open',
        verb: source === 'tunnelvision' ? 'Injected' : 'Triggered',
        color: source === 'smart-context' || source === 'tunnelvision' ? '#fdcb6e' : 'var(--tv-color-primary)',
        lorebook,
        uid,
        title,
        keys,
        timestamp,
    };
}

/**
 * Determine whether lorebook names should be shown in entry summaries
 * (only when entries span more than one lorebook).
 */
export function shouldIncludeLorebookForEntries() {
    const lorebooks = new Set(
        getFeedItemsRaw()
            .filter(item => item.type === 'entry' && typeof item.lorebook === 'string' && item.lorebook.trim())
            .map(item => item.lorebook.trim()),
    );
    return lorebooks.size > 1;
}

export function formatEntrySummary(item, includeLorebook) {
    const title = truncate(item.title || `UID ${item.uid ?? '?'}`, includeLorebook ? 42 : 52);
    const uidLabel = item.uid !== null && item.uid !== undefined ? `#${item.uid}` : '#?';

    if (includeLorebook && item.lorebook) {
        return `${item.lorebook}: ${title} (${uidLabel})`;
    }

    return `${title} (${uidLabel})`;
}

export function formatRetrievedEntryLabel(entry, includeLorebook) {
    const title = truncate(entry.title || `UID ${entry.uid ?? '?'}`, includeLorebook ? 42 : 52);
    const uidLabel = entry.uid !== null && entry.uid !== undefined ? `#${entry.uid}` : '#?';

    return includeLorebook
        ? `${entry.lorebook}: ${title} (${uidLabel})`
        : `${title} (${uidLabel})`;
}

// ── Retrieved Entry Parsing ──────────────────────────────────────

export function parseInvocationParameters(parameters) {
    if (!parameters) return {};
    if (typeof parameters === 'object') return parameters;

    try {
        return JSON.parse(parameters);
    } catch {
        return {};
    }
}

export function extractRetrievedEntries(result) {
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

export function parseRetrievedEntryHeader(line) {
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

// ── Tool Summary Builder ─────────────────────────────────────────

export function buildToolSummary(toolName, params, result, retrievedEntries = []) {
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
        case 'BlackBox_Pick': {
            const dir = params.director || '?';
            const mood = params.mood || '?';
            return `${dir} × ${mood}`;
        }
        default:
            return '';
    }
}

// ── Diff Computation ─────────────────────────────────────────────

/**
 * Compute a simple line-level diff between two texts.
 * Returns an array of { type: 'same'|'add'|'remove', text } objects.
 */
export function computeLineDiff(oldText, newText) {
    const oldLines = (oldText || '').split('\n');
    const newLines = (newText || '').split('\n');
    const result = [];

    // Greedy alignment: match lines exactly, with bounded lookahead
    let oi = 0, ni = 0;
    while (oi < oldLines.length && ni < newLines.length) {
        if (oldLines[oi] === newLines[ni]) {
            result.push({ type: 'same', text: oldLines[oi] });
            oi++;
            ni++;
        } else {
            // Look ahead in new for current old line
            let foundInNew = -1;
            for (let j = ni + 1; j < Math.min(ni + 5, newLines.length); j++) {
                if (newLines[j] === oldLines[oi]) { foundInNew = j; break; }
            }
            // Look ahead in old for current new line
            let foundInOld = -1;
            for (let j = oi + 1; j < Math.min(oi + 5, oldLines.length); j++) {
                if (oldLines[j] === newLines[ni]) { foundInOld = j; break; }
            }

            if (foundInNew >=0 && (foundInOld < 0 || (foundInNew - ni) <= (foundInOld - oi))) {
                while (ni < foundInNew) {
                    result.push({ type: 'add', text: newLines[ni] });
                    ni++;
                }
            } else if (foundInOld >= 0) {
                while (oi < foundInOld) {
                    result.push({ type: 'remove', text: oldLines[oi] });
                    oi++;
                }
            } else {
                result.push({ type: 'remove', text: oldLines[oi] });
                result.push({ type: 'add', text: newLines[ni] });
                oi++;
                ni++;
            }
        }
    }
    while (oi < oldLines.length) {
        result.push({ type: 'remove', text: oldLines[oi++] });
    }
    while (ni < newLines.length) {
        result.push({ type: 'add', text: newLines[ni++] });
    }

    return result;
}

/**
 * Build a color-coded diff view element from two texts.
 */
export function buildDiffView(oldText, newText) {
    const diff = computeLineDiff(oldText, newText);
    const container = el('div', 'tv-diff-view');

    for (const line of diff) {
        const lineEl = el('div', `tv-diff-line tv-diff-${line.type}`);
        const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
        lineEl.textContent = `${prefix} ${line.text}`;
        container.appendChild(lineEl);
    }

    return container;
}

// ── Version History Panel ────────────────────────────────────────

export function buildVersionHistoryPanel(versions, currentContent) {
    const panel = el('div', 'tv-version-history');
    const header = el('div', 'tv-version-history-header');
    header.appendChild(icon('fa-clock-rotate-left'));
    header.append(` Version History (${versions.length})`);
    panel.appendChild(header);

    // Show newest first
    const reversed = [...versions].reverse();
    for (let i = 0; i < reversed.length; i++) {
        const ver = reversed[i];
        const item = el('div', 'tv-version-history-item');

        const meta = el('div', 'tv-version-history-meta');
        const sourceBadge = el('span', 'tv-version-history-source', ver.source || 'unknown');
        meta.appendChild(sourceBadge);
        const time = new Date(ver.timestamp);
        meta.appendChild(el('span', 'tv-version-history-time', formatShortDateTime(time)));
        item.appendChild(meta);

        if (ver.previousTitle) {
            const titleRow = el('div', 'tv-version-history-title');
            titleRow.appendChild(el('span', 'tv-version-history-label', 'Title: '));
            titleRow.appendChild(el('span', null, ver.previousTitle));
            item.appendChild(titleRow);
        }

        if (ver.previousContent) {
            // Determine what this version was changed TO:
            // For the most recent version (i=0), it changed to the current content.
            // For older versions, it changed to the next version's previousContent.
            const changedTo = i === 0
                ? (currentContent || null)
                : (reversed[i - 1]?.previousContent || null);

            if (changedTo) {
                // Show diff toggle
                const diffToggle = el('button', 'tv-btn tv-btn-xs tv-btn-secondary tv-diff-toggle');
                diffToggle.appendChild(icon('fa-code-compare'));
                diffToggle.append(' Show diff');
                diffToggle.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const existing = item.querySelector('.tv-diff-view');
                    const existingRaw = item.querySelector('.tv-version-history-content');
                    if (existing) {
                        existing.remove();
                        diffToggle.replaceChildren(icon('fa-code-compare'));
                        diffToggle.append(' Show diff');
                        if (existingRaw) existingRaw.style.display = '';
                    } else {
                        if (existingRaw) existingRaw.style.display = 'none';
                        diffToggle.replaceChildren(icon('fa-code'));
                        diffToggle.append(' Show raw');
                        item.appendChild(buildDiffView(ver.previousContent, changedTo));
                    }
                });
                item.appendChild(diffToggle);
            }

            const contentDiv = el('div', 'tv-version-history-content');
            contentDiv.textContent = ver.previousContent;
            item.appendChild(contentDiv);
        }

        panel.appendChild(item);
    }

    return panel;
}