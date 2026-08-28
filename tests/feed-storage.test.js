import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock host context used by feed-storage.js
vi.mock('../../../st-context.js', () => ({
    getContext: vi.fn(),
}));

import { getContext } from '../../../st-context.js';
import { saveFeed, loadFeed, migrateFeedItems, METADATA_KEY } from '../feed-ui/feed-storage.js';
import {
    getActiveChatId,
    setActiveChatId,
    getFeedItemsRaw,
    setFeedItems,
    getNextId,
    setNextId,
} from '../feed-state.js';

describe('feed-storage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setActiveChatId(null);
        setFeedItems([]);
        setNextId(0);
    });

    describe('saveFeed', () => {
        it('writes current feed state into chat metadata and calls debounced save', () => {
            const saveMetadataDebounced = vi.fn();
            const context = {
                chatId: 'chat-1',
                chatMetadata: {},
                saveMetadataDebounced,
            };
            getContext.mockReturnValue(context);

            setActiveChatId('chat-1');
            setFeedItems([{ id: 1, type: 'entry', title: 'A' }]);
            setNextId(42);

            saveFeed();

            expect(context.chatMetadata[METADATA_KEY]).toEqual({
                items: [{ id: 1, type: 'entry', title: 'A' }],
                nextId: 42,
            });
            expect(saveMetadataDebounced).toHaveBeenCalledTimes(1);
        });

        it('does nothing when there is no active chat metadata', () => {
            const context = {
                chatId: 'chat-1',
                chatMetadata: null,
                saveMetadataDebounced: vi.fn(),
            };
            getContext.mockReturnValue(context);

            setActiveChatId('chat-1');
            setFeedItems([{ id: 1 }]);
            setNextId(2);

            expect(() => saveFeed()).not.toThrow();
            expect(context.saveMetadataDebounced).not.toHaveBeenCalled();
        });

        it('does nothing when current chat does not match activeChatId', () => {
            const saveMetadataDebounced = vi.fn();
            const context = {
                chatId: 'chat-2',
                chatMetadata: {},
                saveMetadataDebounced,
            };
            getContext.mockReturnValue(context);

            setActiveChatId('chat-1');
            setFeedItems([{ id: 1, type: 'entry' }]);
            setNextId(9);

            saveFeed();

            expect(context.chatMetadata[METADATA_KEY]).toBeUndefined();
            expect(saveMetadataDebounced).not.toHaveBeenCalled();
        });

        it('allows metadata key override', () => {
            const saveMetadataDebounced = vi.fn();
            const context = {
                chatId: 'chat-1',
                chatMetadata: {},
                saveMetadataDebounced,
            };
            getContext.mockReturnValue(context);

            setActiveChatId('chat-1');
            setFeedItems([{ id: 7 }]);
            setNextId(8);

            saveFeed({ metadataKey: 'custom_feed_key' });

            expect(context.chatMetadata.custom_feed_key).toEqual({
                items: [{ id: 7 }],
                nextId: 8,
            });
            expect(context.chatMetadata[METADATA_KEY]).toBeUndefined();
        });
    });

    describe('loadFeed', () => {
        it('resets state when there is no chat id', () => {
            getContext.mockReturnValue({
                chatId: null,
                chatMetadata: {},
            });

            setActiveChatId('old-chat');
            setFeedItems([{ id: 123 }]);
            setNextId(55);

            loadFeed();

            expect(getActiveChatId()).toBeNull();
            expect(getFeedItemsRaw()).toEqual([]);
            expect(getNextId()).toBe(0);
        });

        it('loads items and nextId from metadata', () => {
            const items = [{ id: 1, type: 'entry', title: 'Loaded' }];
            getContext.mockReturnValue({
                chatId: 'chat-1',
                chatMetadata: {
                    [METADATA_KEY]: {
                        items,
                        nextId: 99,
                    },
                },
            });

            loadFeed();

            expect(getActiveChatId()).toBe('chat-1');
            expect(getFeedItemsRaw()).toEqual(items);
            expect(getNextId()).toBe(99);
        });

        it('falls back to items.length when nextId is missing', () => {
            const items = [
                { id: 1, type: 'entry' },
                { id: 2, type: 'tool' },
                { id: 3, type: 'background' },
            ];

            getContext.mockReturnValue({
                chatId: 'chat-1',
                chatMetadata: {
                    [METADATA_KEY]: {
                        items,
                    },
                },
            });

            loadFeed();

            expect(getActiveChatId()).toBe('chat-1');
            expect(getFeedItemsRaw()).toEqual(items);
            expect(getNextId()).toBe(items.length);
        });

        it('leaves empty state when metadata key is absent', () => {
            getContext.mockReturnValue({
                chatId: 'chat-1',
                chatMetadata: {},
            });

            loadFeed();

            expect(getActiveChatId()).toBe('chat-1');
            expect(getFeedItemsRaw()).toEqual([]);
            expect(getNextId()).toBe(0);
        });

        it('runs migration for old tracker suggestion items and saves the result', () => {
            const saveMetadataDebounced = vi.fn();
            const oldItem = {
                id: 10,
                type: 'background',
                verb: 'Tracker suggested',
                summary: '"Elena" might need a tracker',
            };

            const context = {
                chatId: 'chat-1',
                chatMetadata: {
                    [METADATA_KEY]: {
                        items: [oldItem],
                        nextId: 11,
                    },
                },
                saveMetadataDebounced,
            };
            getContext.mockReturnValue(context);

            loadFeed({
                trackerSuggestionNameRe: /^"([^"]+)"/,
            });

            const [loaded] = getFeedItemsRaw();
            expect(loaded.action).toEqual({
                type: 'create-tracker',
                label: 'Create Tracker',
                icon: 'fa-address-card',
                characterName: 'Elena',
            });

            expect(saveMetadataDebounced).toHaveBeenCalledTimes(1);
            expect(context.chatMetadata[METADATA_KEY].items[0].action).toEqual({
                type: 'create-tracker',
                label: 'Create Tracker',
                icon: 'fa-address-card',
                characterName: 'Elena',
            });
        });

        it('calls onAfterLoad hook after successful load', () => {
            const items = [{ id: 1, type: 'entry' }];
            const onAfterLoad = vi.fn();

            getContext.mockReturnValue({
                chatId: 'chat-1',
                chatMetadata: {
                    [METADATA_KEY]: {
                        items,
                        nextId: 4,
                    },
                },
            });

            loadFeed({ onAfterLoad });

            expect(onAfterLoad).toHaveBeenCalledTimes(1);
            expect(onAfterLoad).toHaveBeenCalledWith(items);
        });

        it('supports metadata key override', () => {
            const items = [{ id: 5, type: 'entry', title: 'Custom' }];
            getContext.mockReturnValue({
                chatId: 'chat-1',
                chatMetadata: {
                    custom_feed_key: {
                        items,
                        nextId: 6,
                    },
                },
            });

            loadFeed({ metadataKey: 'custom_feed_key' });

            expect(getActiveChatId()).toBe('chat-1');
            expect(getFeedItemsRaw()).toEqual(items);
            expect(getNextId()).toBe(6);
        });
    });

    describe('migrateFeedItems', () => {
        it('adds create-tracker action to legacy tracker suggestion items', () => {
            const items = [{
                id: 1,
                type: 'background',
                verb: 'Tracker suggested',
                summary: '"Mira" should get a tracker',
            }];
            const save = vi.fn();

            migrateFeedItems(items, {
                trackerSuggestionNameRe: /^"([^"]+)"/,
                save,
            });

            expect(items[0].action).toEqual({
                type: 'create-tracker',
                label: 'Create Tracker',
                icon: 'fa-address-card',
                characterName: 'Mira',
            });
            expect(save).toHaveBeenCalledTimes(1);
        });

        it('replaces saved brand colors with live theme tokens', () => {
            const items = [
                { id: 2, type: 'tool', color: '#e84393' },
                { id: 3, type: 'tool', color: '#f0946c' },
            ];
            const save = vi.fn();

            migrateFeedItems(items, { save });

            expect(items.map(item => item.color)).toEqual([
                'var(--tv-color-primary)',
                'var(--tv-color-secondary)',
            ]);
            expect(save).toHaveBeenCalledTimes(1);
        });

        it('backfills legacy entry items so they still render as feed entries', () => {
            const items = [{
                id: 2,
                lorebook: 'BookA',
                uid: 17,
                title: 'Legacy Fact',
                verb: 'Triggered',
            }];
            const save = vi.fn();

            migrateFeedItems(items, { save });

            expect(items[0]).toMatchObject({
                type: 'entry',
                source: 'native',
                icon: 'fa-book-open',
                verb: 'Triggered',
                color: 'var(--tv-color-primary)',
                keys: [],
            });
            expect(save).toHaveBeenCalledTimes(1);
        });

        it('backfills source defaults for legacy injected entry items', () => {
            const items = [{
                id: 3,
                type: 'entry',
                lorebook: 'BookA',
                uid: 18,
                title: 'Legacy Injected Fact',
                verb: 'Injected',
            }];
            const save = vi.fn();

            migrateFeedItems(items, { save });

            expect(items[0]).toMatchObject({
                type: 'entry',
                source: 'tunnelvision',
                icon: 'fa-book-open',
                verb: 'Injected',
                color: '#fdcb6e',
                keys: [],
            });
            expect(save).toHaveBeenCalledTimes(1);
        });

        it('does not mutate unrelated items', () => {
            const original = {
                id: 2,
                type: 'background',
                verb: 'Something else',
                summary: '"Mira" should get a tracker',
            };
            const items = [structuredClone(original)];
            const save = vi.fn();

            migrateFeedItems(items, {
                trackerSuggestionNameRe: /^"([^"]+)"/,
                save,
            });

            expect(items[0]).toEqual(original);
            expect(save).not.toHaveBeenCalled();
        });

        it('does nothing when regex is missing', () => {
            const items = [{
                id: 3,
                type: 'background',
                verb: 'Tracker suggested',
                summary: '"Nora" should get a tracker',
            }];
            const save = vi.fn();

            migrateFeedItems(items, { save });

            expect(items[0].action).toBeUndefined();
            expect(save).not.toHaveBeenCalled();
        });

        it('ignores empty or invalid item lists', () => {
            const save = vi.fn();

            expect(() => migrateFeedItems(null, { save })).not.toThrow();
            expect(() => migrateFeedItems([], { save })).not.toThrow();
            expect(save).not.toHaveBeenCalled();
        });
    });
});