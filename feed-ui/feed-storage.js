/**
 * TunnelVision Activity Feed — Storage Module
 *
 * Persists the feed data into the active chat's metadata and restores it on load.
 * Also includes lightweight migrations for older stored item formats.
 *
 * NOTE:
 * - This module does not touch DOM/UI.
 * - It operates on shared feed state (feed-state.js) and the host chat metadata (st-context).
 */

import { getContext } from '../../../../st-context.js';
import {
    getActiveChatId,
    setActiveChatId,
    getFeedItemsRaw,
    setFeedItems,
    getNextId,
    setNextId,
} from '../feed-state.js';
import { migrateLegacyThemeColors } from '../theme.js';

// Storage key used inside chat metadata
export const METADATA_KEY = 'tunnelvision_feed';

/**
 * Persist current feed state to chat metadata.
 * Safe to call frequently; uses the host's debounced metadata saver when available.
 *
 * @param {Object} opts
 * @param {string} [opts.metadataKey] - Override metadata key (primarily for testing)
 */
export function saveFeed({ metadataKey = METADATA_KEY } = {}) {
    try {
        const context = getContext();
        if (!context?.chatMetadata || !context?.chatId) return;

        // Guard: avoid overwriting metadata if we've already switched chats
        if (getActiveChatId() && context.chatId !== getActiveChatId()) return;

        context.chatMetadata[metadataKey] = {
            items: getFeedItemsRaw(),
            nextId: getNextId(),
        };

        // Prefer host debounced method when present
        context.saveMetadataDebounced?.();
    } catch {
        // No active chat / host not ready
    }
}

/**
 * Load feed state from chat metadata for the current chat.
 * Resets state when chat changes or metadata is absent.
 *
 * @param {Object} opts
 * @param {string} [opts.metadataKey] - Override metadata key (primarily for testing)
 * @param {RegExp} [opts.trackerSuggestionNameRe] - Migration regex for old tracker suggestion format
 * @param {(items: any[]) => void} [opts.onAfterLoad] - Optional hook after load+set for additional processing
 */
export function loadFeed({
    metadataKey = METADATA_KEY,
    trackerSuggestionNameRe = null,
    onAfterLoad = null,
} = {}) {
    // Always reset in-memory state first
    setFeedItems([]);
    setNextId(0);
    setActiveChatId(null);

    try {
        const context = getContext();
        if (!context?.chatId) return;

        setActiveChatId(context.chatId);

        const data = context.chatMetadata?.[metadataKey];
        if (!data || !Array.isArray(data.items)) return;

        // Load stored items
        setFeedItems(data.items);

        // Restore nextId with reasonable fallback
        if (typeof data.nextId === 'number') {
            setNextId(data.nextId);
        } else {
            setNextId(data.items.length);
        }

        // Run migrations in-place (may trigger save)
        migrateFeedItems(getFeedItemsRaw(), {
            trackerSuggestionNameRe,
            save: () => saveFeed({ metadataKey }),
        });

        onAfterLoad?.(getFeedItemsRaw());
    } catch {
        // host not ready / metadata unavailable
    }
}

/**
 * Migrate feed items loaded from metadata in-place.
 * If any migration mutates items, calls the provided save() callback.
 *
 * @param {any[]} items
 * @param {Object} opts
 * @param {RegExp|null} [opts.trackerSuggestionNameRe]
 * @param {() => void} [opts.save]
 */
export function migrateFeedItems(items, { trackerSuggestionNameRe = null, save = null } = {}) {
    if (!Array.isArray(items) || items.length === 0) return;

    let mutated = migrateLegacyThemeColors(items);

    for (const item of items) {
        if (!item || typeof item !== 'object') continue;

        // Migration: legacy entry-like items without a modern type marker.
        if (!item.type && (item.lorebook || item.uid != null || item.title || Array.isArray(item.keys))) {
            item.type = 'entry';
            mutated = true;
        }

        // Migration: backfill defaults for legacy entry items so they continue
        // rendering after source-specific feed UI changes.
        if (item.type === 'entry') {
            const inferredSource = item.source
                || (item.verb === 'Injected' ? 'tunnelvision' : 'native');
            if (item.source !== inferredSource) {
                item.source = inferredSource;
                mutated = true;
            }

            if (!item.icon) {
                item.icon = 'fa-book-open';
                mutated = true;
            }

            const expectedVerb = inferredSource === 'tunnelvision' ? 'Injected' : 'Triggered';
            if (!item.verb) {
                item.verb = expectedVerb;
                mutated = true;
            }

            const expectedColor = inferredSource === 'tunnelvision' || inferredSource === 'smart-context'
                ? '#fdcb6e'
                : 'var(--tv-color-primary)';
            if (!item.color) {
                item.color = expectedColor;
                mutated = true;
            }

            if (!Array.isArray(item.keys)) {
                item.keys = [];
                mutated = true;
            }
        }

        // Migration: old "Tracker suggested" background items without action
        // used to encode the character name in the summary.
        if (
            item.type === 'background' &&
            item.verb === 'Tracker suggested' &&
            !item.action &&
            typeof item.summary === 'string' &&
            item.summary
        ) {
            const re = trackerSuggestionNameRe;
            if (re instanceof RegExp) {
                const m = item.summary.match(re);
                if (m && m[1]) {
                    item.action = {
                        type: 'create-tracker',
                        label: 'Create Tracker',
                        icon: 'fa-address-card',
                        characterName: m[1],
                    };
                    mutated = true;
                }
            }
        }

        // Future migrations can be added here with similar guarded logic.
    }

    if (mutated) {
        try {
            save?.();
        } catch {
            // ignore persistence failures
        }
    }
}