import { describe, it, expect, beforeEach } from 'vitest';
import { extension_settings } from '../../../extensions.js';
import {
    SETTING_DEFAULTS,
    addEntryToNode,
    createEmptyTree,
    createTreeNode,
    findNodeById,
    getSettings,
    getTrackerUids,
    isSummaryTitle,
    isTrackerTitle,
    removeNode,
    saveTree,
    setTrackerUid,
    syncTrackerUidsForLorebook,
} from '../tree-store.js';

beforeEach(() => {
    extension_settings.tunnelvision = {
        trees: {},
        trackerUids: {},
    };
});

// ── settings normalization ───────────────────────────────────────

describe('getSettings normalization', () => {
    it('fills missing defaults and migrates legacy values', () => {
        extension_settings.tunnelvision = {
            llmBuildDetail: 'keys',
            trackerUids: ['bad-shape'],
        };

        const settings = getSettings();

        expect(settings.globalEnabled).toBe(SETTING_DEFAULTS.globalEnabled);
        expect(settings.llmBuildDetail).toBe('lite');
        expect(settings.trackerUids).toEqual({});
        expect(settings.ephemeralToolFilter).toEqual(SETTING_DEFAULTS.ephemeralToolFilter);
    });
});

// ── tree normalization / index invariants ───────────────────────

describe('isSummaryTitle', () => {
    it('matches [Summary ...] titles', () => {
        expect(isSummaryTitle('[Summary of the battle]')).toBe(true);
    });

    it('matches [Scene Summary ...] titles', () => {
        expect(isSummaryTitle('[Scene Summary: The meeting]')).toBe(true);
    });

    it('is case-insensitive', () => {
        expect(isSummaryTitle('[SUMMARY something]')).toBe(true);
        expect(isSummaryTitle('[scene summary ...]')).toBe(true);
    });

    it('matches [Act Summary ...] titles', () => {
        expect(isSummaryTitle('[Act Summary] Act 1: The Beginning')).toBe(true);
    });

    it('matches [Story Summary ...] titles', () => {
        expect(isSummaryTitle('[Story Summary] Story So Far')).toBe(true);
    });

    it('rejects non-summary titles', () => {
        expect(isSummaryTitle('Elena hair color')).toBe(false);
        expect(isSummaryTitle('[Tracker: Elena]')).toBe(false);
    });

    it('handles null, undefined, and empty string', () => {
        expect(isSummaryTitle(null)).toBe(false);
        expect(isSummaryTitle(undefined)).toBe(false);
        expect(isSummaryTitle('')).toBe(false);
    });
});

// ── isTrackerTitle ───────────────────────────────────────────────

describe('isTrackerTitle', () => {
    it('matches [Tracker: ...] titles', () => {
        expect(isTrackerTitle('[Tracker: Elena]')).toBe(true);
    });

    it('matches bare [Tracker]', () => {
        expect(isTrackerTitle('[Tracker]')).toBe(true);
    });

    it('is case-insensitive', () => {
        expect(isTrackerTitle('[TRACKER: Elena]')).toBe(true);
        expect(isTrackerTitle('[tracker: elena]')).toBe(true);
    });

    it('rejects non-tracker titles', () => {
        expect(isTrackerTitle('Elena personality')).toBe(false);
        expect(isTrackerTitle('[Summary of events]')).toBe(false);
    });

    it('handles null, undefined, and empty string', () => {
        expect(isTrackerTitle(null)).toBe(false);
        expect(isTrackerTitle(undefined)).toBe(false);
        expect(isTrackerTitle('')).toBe(false);
    });
});

// ── findNodeById / node index invalidation ───────────────────────

describe('findNodeById', () => {
    const tree = {
        id: 'root',
        label: 'Root',
        summary: '',
        entryUids: [],
        collapsed: false,
        children: [
            {
                id: 'child-1',
                label: 'Characters',
                summary: 'Character info',
                entryUids: [1, 2],
                collapsed: false,
                children: [
                    {
                        id: 'grandchild-1',
                        label: 'Elena',
                        summary: 'Elena details',
                        entryUids: [3],
                        collapsed: false,
                        children: [],
                    },
                ],
            },
            {
                id: 'child-2',
                label: 'Locations',
                summary: 'Location info',
                entryUids: [4, 5],
                collapsed: false,
                children: [],
            },
        ],
    };

    it('finds the root node', () => {
        expect(findNodeById(tree, 'root')).toBe(tree);
    });

    it('finds a direct child', () => {
        expect(findNodeById(tree, 'child-1')).toBe(tree.children[0]);
    });

    it('finds a deeply nested node', () => {
        expect(findNodeById(tree, 'grandchild-1')).toBe(tree.children[0].children[0]);
    });

    it('returns null for a non-existent id', () => {
        expect(findNodeById(tree, 'does-not-exist')).toBeNull();
    });

    it('returns null when tree is null', () => {
        expect(findNodeById(null, 'any')).toBeNull();
    });

});

describe('saveTree normalization', () => {
    it('repairs malformed tree shape before persisting', () => {
        const malformedTree = {
            root: {
                label: 42,
                summary: null,
                entryUids: 'bad',
                children: [
                    {
                        id: '',
                        label: null,
                        summary: 7,
                        entryUids: null,
                        children: null,
                        _collapsed: 1,
                    },
                ],
            },
            version: 'bad',
            lastBuilt: null,
        };

        saveTree('Lorebook A', malformedTree);

        const saved = extension_settings.tunnelvision.trees['Lorebook A'];

        expect(saved.lorebookName).toBe('Lorebook A');
        expect(saved.version).toBe(1);
        expect(typeof saved.lastBuilt).toBe('number');
        expect(saved.root.label).toBe('Unnamed');
        expect(saved.root.summary).toBe('');
        expect(saved.root.entryUids).toEqual([]);
        expect(saved.root.children).toHaveLength(1);
        expect(saved.root.children[0].id).toMatch(/^tv_/);
        expect(saved.root.children[0].label).toBe('Unnamed');
        expect(saved.root.children[0].summary).toBe('');
        expect(saved.root.children[0].entryUids).toEqual([]);
        expect(saved.root.children[0].children).toEqual([]);
        expect(saved.root.children[0].collapsed).toBe(true);
        expect('_collapsed' in saved.root.children[0]).toBe(false);
    });
});

describe('tree mutation helpers', () => {
    it('addEntryToNode keeps entry uids unique', () => {
        const node = createTreeNode('Characters');

        addEntryToNode(node, 7);
        addEntryToNode(node, 7);
        addEntryToNode(node, 9);

        expect(node.entryUids).toEqual([7, 9]);
    });

    it('removeNode promotes orphaned entries and children to the parent', () => {
        const grandchild = createTreeNode('Grandchild');
        grandchild.id = 'grandchild';
        grandchild.entryUids = [30];

        const child = createTreeNode('Child');
        child.id = 'child';
        child.entryUids = [10, 20];
        child.children = [grandchild];

        const root = createTreeNode('Root');
        root.id = 'root';
        root.entryUids = [1];
        root.children = [child];

        const removed = removeNode(root, 'child');

        expect(removed).toBe(true);
        expect(root.entryUids).toEqual([1, 10, 20]);
        expect(root.children).toEqual([grandchild]);
    });
});

describe('tracker uid helpers', () => {
    it('setTrackerUid dedupes and sorts tracker ids', () => {
        expect(setTrackerUid('Lorebook A', 9, true, { save: false })).toBe(true);
        expect(setTrackerUid('Lorebook A', 3, true, { save: false })).toBe(true);
        expect(setTrackerUid('Lorebook A', 9, true, { save: false })).toBe(false);

        expect(getTrackerUids('Lorebook A')).toEqual([3, 9]);
    });

    it('syncTrackerUidsForLorebook keeps explicit trackers, adds title-based trackers, and drops disabled or stale entries', async () => {
        extension_settings.tunnelvision = {
            trackerUids: {
                Alpha: [9, 3, 999],
            },
        };

        const entries = {
            a: { uid: 3, comment: 'Ordinary Entry', disable: false },
            b: { uid: 5, comment: '[Tracker: Elena]', disable: false },
            c: { uid: 9, comment: '[Tracker: Old]', disable: true },
            d: { uid: 12, comment: '[tracker] Lowercase Works', disable: false },
        };

        const result = await syncTrackerUidsForLorebook('Alpha', { entries }, { save: false });

        expect(result).toEqual([3, 5, 12]);
        expect(getTrackerUids('Alpha')).toEqual([3, 5, 12]);
    });

    it('syncTrackerUidsForLorebook removes the book key when no trackers remain', async () => {
        extension_settings.tunnelvision = {
            trackerUids: {
                EmptyBook: [4],
            },
        };

        const result = await syncTrackerUidsForLorebook('EmptyBook', { entries: {} }, { save: false });

        expect(result).toEqual([]);
        expect(getTrackerUids('EmptyBook')).toEqual([]);
        expect(extension_settings.tunnelvision.trackerUids.EmptyBook).toBeUndefined();
    });
});

describe('createEmptyTree', () => {
    it('creates a normalized root node with lorebook metadata', () => {
        const tree = createEmptyTree('Lorebook X');

        expect(tree.lorebookName).toBe('Lorebook X');
        expect(tree.version).toBe(1);
        expect(typeof tree.lastBuilt).toBe('number');
        expect(tree.root.label).toBe('Root');
        expect(tree.root.summary).toContain('Lorebook X');
        expect(tree.root.entryUids).toEqual([]);
        expect(tree.root.children).toEqual([]);
        expect(tree.root.collapsed).toBe(false);
    });
});
