import { describe, it, expect, vi } from 'vitest';

// Mock internal dependencies with complex transitive imports
vi.mock('../tool-registry.js', () => ({
    ALL_TOOL_NAMES: [],
    getActiveTunnelVisionBooks: vi.fn(() => []),
}));
vi.mock('../ui-controller.js', () => ({
    openTreeEditorForBook: vi.fn(),
}));
vi.mock('../world-state.js', () => ({
    getWorldStateText: vi.fn(() => ''),
    updateWorldState: vi.fn(),
    clearWorldState: vi.fn(),
    isWorldStateUpdating: vi.fn(() => false),
    hasPreviousWorldState: vi.fn(() => false),
    revertWorldState: vi.fn(),
}));
vi.mock('../post-turn-processor.js', () => ({
    createTrackerForCharacter: vi.fn(),
}));

import { parseRetrievedEntryHeader, buildToolSummary } from '../activity-feed.js';
import { parseTimestamp } from '../feed-views.js';
import { computeLineDiff } from '../feed-helpers.js';

// `resolveFeedItemCap` is not implemented anywhere in the source yet — the
// feed's item cap is still the hardcoded MAX_FEED_ITEMS constant, with no
// settings-driven override. Skipping rather than guessing at the intended
// clamp/default behavior; tracked as a follow-up.
describe.skip('resolveFeedItemCap', () => {
    it('returns the default cap when the setting is missing', () => {
        expect(resolveFeedItemCap({})).toBe(100);
    });

    it('clamps the cap to the supported minimum and maximum', () => {
        expect(resolveFeedItemCap({ activityFeedCap: 5 })).toBe(20);
        expect(resolveFeedItemCap({ activityFeedCap: 5000 })).toBe(1000);
    });

    it('rounds finite values to whole items', () => {
        expect(resolveFeedItemCap({ activityFeedCap: 128.7 })).toBe(129);
    });
});

// ── parseTimestamp ───────────────────────────────────────────────

describe('parseTimestamp', () => {
    it('parses [Day X, time] prefix', () => {
        const result = parseTimestamp('[Day 5, Morning] Elena woke up.');
        expect(result).toEqual({
            day: 5,
            dateKey: null,
            dateLabel: '',
            timeLabel: 'Day 5, Morning',
            groupKey: 'day:5',
            groupLabel: 'Day 5',
            rest: 'Elena woke up.',
        });
    });

    it('parses [Day X] prefix without time qualifier', () => {
        const result = parseTimestamp('[Day 3] Something happened.');
        expect(result).toEqual({
            day: 3,
            dateKey: null,
            dateLabel: '',
            timeLabel: 'Day 3',
            groupKey: 'day:3',
            groupLabel: 'Day 3',
            rest: 'Something happened.',
        });
    });

    it('parses date-aware tags and prefers date grouping with day in label', () => {
        const result = parseTimestamp('[Day 6, Sunday 16 March 2025, around 13:10-13:20] They reached the market.');
        expect(result).toEqual({
            day: 6,
            dateKey: '2025-03-16',
            dateLabel: 'Sunday 16 March 2025',
            timeLabel: 'Day 6, Sunday 16 March 2025, around 13:10-13:20',
            groupKey: 'date:2025-03-16',
            groupLabel: 'Sunday 16 March 2025 (Day 6)',
            rest: 'They reached the market.',
        });
    });

    it('parses date-only tags into date grouping', () => {
        const result = parseTimestamp('[Sunday, 16 March 2025, morning] Bells rang at dawn.');
        expect(result).toEqual({
            day: null,
            dateKey: '2025-03-16',
            dateLabel: 'Sunday, 16 March 2025',
            timeLabel: 'Sunday, 16 March 2025, morning',
            groupKey: 'date:2025-03-16',
            groupLabel: 'Sunday, 16 March 2025',
            rest: 'Bells rang at dawn.',
        });
    });

    it('returns undated group for bracket prefix without day/date', () => {
        const result = parseTimestamp('[Evening] The sun set.');
        expect(result).toEqual({
            day: null,
            dateKey: null,
            dateLabel: '',
            timeLabel: 'Evening',
            groupKey: 'undated',
            groupLabel: 'Undated',
            rest: 'The sun set.',
        });
    });

    it('returns defaults for content without timestamp', () => {
        const result = parseTimestamp('No timestamp here.');
        expect(result).toEqual({
            day: null,
            dateKey: null,
            dateLabel: '',
            timeLabel: '',
            groupKey: 'undated',
            groupLabel: 'Undated',
            rest: 'No timestamp here.',
        });
    });

    it('handles null input', () => {
        expect(parseTimestamp(null)).toEqual({
            day: null,
            dateKey: null,
            dateLabel: '',
            timeLabel: '',
            groupKey: 'undated',
            groupLabel: 'Undated',
            rest: '',
        });
    });

    it('handles empty string input', () => {
        expect(parseTimestamp('')).toEqual({
            day: null,
            dateKey: null,
            dateLabel: '',
            timeLabel: '',
            groupKey: 'undated',
            groupLabel: 'Undated',
            rest: '',
        });
    });

    it('handles large day numbers', () => {
        const result = parseTimestamp('[Day 142, Night] Battle raged.');
        expect(result.day).toBe(142);
        expect(result.groupKey).toBe('day:142');
        expect(result.groupLabel).toBe('Day 142');
    });
});

// ── parseRetrievedEntryHeader ────────────────────────────────────

describe('parseRetrievedEntryHeader', () => {
    it('parses a standard header line', () => {
        const result = parseRetrievedEntryHeader('[Lorebook: MyBook | UID: 42 | Title: Elena Hair Color]');
        expect(result).toEqual({
            lorebook: 'MyBook',
            uid: 42,
            title: 'Elena Hair Color',
        });
    });

    it('preserves pipe characters inside the title', () => {
        const result = parseRetrievedEntryHeader('[Lorebook: Book | UID: 10 | Title: A | B | C]');
        expect(result).toEqual({
            lorebook: 'Book',
            uid: 10,
            title: 'A | B | C',
        });
    });

    it('returns null for non-matching lines', () => {
        expect(parseRetrievedEntryHeader('Just some text')).toBeNull();
        expect(parseRetrievedEntryHeader('[Not a lorebook header]')).toBeNull();
    });

    it('returns null for incomplete header (fewer than 3 parts)', () => {
        expect(parseRetrievedEntryHeader('[Lorebook: MyBook | UID: 42]')).toBeNull();
    });

    it('returns null uid for non-numeric UID', () => {
        const result = parseRetrievedEntryHeader('[Lorebook: Book | UID: abc | Title: Test]');
        expect(result).toEqual({
            lorebook: 'Book',
            uid: null,
            title: 'Test',
        });
    });

    it('returns null for line not ending with ]', () => {
        expect(parseRetrievedEntryHeader('[Lorebook: Book | UID: 1 | Title: T')).toBeNull();
    });
});

// ── buildToolSummary ─────────────────────────────────────────────

describe('buildToolSummary', () => {
    // Remember
    it('summarizes Remember with title', () => {
        expect(buildToolSummary('TunnelVision_Remember', { title: 'Elena Hair' }, ''))
            .toBe('"Elena Hair"');
    });

    it('summarizes Remember without title', () => {
        expect(buildToolSummary('TunnelVision_Remember', {}, '')).toBe('new entry');
    });

    // Update
    it('summarizes Update with UID and title', () => {
        expect(buildToolSummary('TunnelVision_Update', { uid: 42, title: 'New Title' }, ''))
            .toBe('UID 42 -> "New Title"');
    });

    it('summarizes Update with only UID', () => {
        expect(buildToolSummary('TunnelVision_Update', { uid: 42 }, ''))
            .toBe('UID 42');
    });

    // Forget
    it('summarizes Forget with UID and reason', () => {
        expect(buildToolSummary('TunnelVision_Forget', { uid: 7, reason: 'outdated' }, ''))
            .toBe('UID 7 (outdated)');
    });

    it('summarizes Forget with only UID', () => {
        expect(buildToolSummary('TunnelVision_Forget', { uid: 7 }, ''))
            .toBe('UID 7');
    });

    // Search — navigate
    it('summarizes Search navigate', () => {
        expect(buildToolSummary('TunnelVision_Search', { action: 'navigate', node_ids: ['n1'] }, ''))
            .toBe('navigate n1');
    });

    it('summarizes Search navigate without node_ids', () => {
        expect(buildToolSummary('TunnelVision_Search', { action: 'navigate' }, ''))
            .toBe('navigate tree');
    });

    // Search — retrieve with entries
    it('summarizes Search with a single retrieved entry', () => {
        const entries = [{ lorebook: 'Book1', uid: 1, title: 'Entry One' }];
        expect(buildToolSummary('TunnelVision_Search', {}, '', entries))
            .toBe('retrieved "Entry One"');
    });

    it('summarizes Search with multiple entries from one lorebook', () => {
        const entries = [
            { lorebook: 'Book1', uid: 1, title: 'A' },
            { lorebook: 'Book1', uid: 2, title: 'B' },
        ];
        expect(buildToolSummary('TunnelVision_Search', {}, '', entries))
            .toBe('retrieved 2 entries from Book1');
    });

    it('summarizes Search with entries from multiple lorebooks', () => {
        const entries = [
            { lorebook: 'Book1', uid: 1, title: 'A' },
            { lorebook: 'Book2', uid: 2, title: 'B' },
        ];
        expect(buildToolSummary('TunnelVision_Search', {}, '', entries))
            .toBe('retrieved 2 entries from 2 lorebooks');
    });

    // MergeSplit
    it('summarizes merge action', () => {
        expect(buildToolSummary('TunnelVision_MergeSplit', { action: 'merge', keep_uid: 1, remove_uid: 2 }, ''))
            .toBe('merge 1 + 2');
    });

    it('summarizes split action', () => {
        expect(buildToolSummary('TunnelVision_MergeSplit', { action: 'split', uid: 5 }, ''))
            .toBe('split 5');
    });

    // Summarize
    it('summarizes Summarize tool', () => {
        expect(buildToolSummary('TunnelVision_Summarize', { title: 'The Battle' }, ''))
            .toBe('"The Battle"');
    });

    // Notebook
    it('summarizes Notebook tool', () => {
        expect(buildToolSummary('TunnelVision_Notebook', { action: 'read', title: 'Notes' }, ''))
            .toBe('read: "Notes"');
    });

    // Reorganize
    it('summarizes Reorganize move', () => {
        expect(buildToolSummary('TunnelVision_Reorganize', { action: 'move', uid: 3, target_node_id: 'n2' }, ''))
            .toBe('UID 3 -> n2');
    });

    it('summarizes Reorganize create_category', () => {
        expect(buildToolSummary('TunnelVision_Reorganize', { action: 'create_category', label: 'New' }, ''))
            .toBe('create "New"');
    });

    // Unknown
    it('returns empty string for unknown tool', () => {
        expect(buildToolSummary('Unknown_Tool', {}, '')).toBe('');
    });

    // Truncation
    it('truncates long titles', () => {
        const longTitle = 'A'.repeat(100);
        const result = buildToolSummary('TunnelVision_Remember', { title: longTitle }, '');
        expect(result.length).toBeLessThan(60);
        expect(result).toContain('...');
    });
});

// ── computeLineDiff ─────────────────────────────────────────────

describe('computeLineDiff', () => {
    it('returns all "same" for identical texts', () => {
        const diff = computeLineDiff('A\nB\nC', 'A\nB\nC');
        expect(diff).toEqual([
            { type: 'same', text: 'A' },
            { type: 'same', text: 'B' },
            { type: 'same', text: 'C' },
        ]);
    });

    it('detects added lines', () => {
        const diff = computeLineDiff('A\nB', 'A\nX\nB');
        const types = diff.map(d => d.type);
        expect(types).toContain('add');
        expect(diff.find(d => d.type === 'add').text).toBe('X');
    });

    it('detects removed lines', () => {
        const diff = computeLineDiff('A\nB\nC', 'A\nC');
        const removed = diff.filter(d => d.type === 'remove');
        expect(removed.length).toBeGreaterThanOrEqual(1);
        expect(removed[0].text).toBe('B');
    });

    it('shows changed lines as remove + add pairs', () => {
        const diff = computeLineDiff('Mood: happy', 'Mood: sad');
        expect(diff).toEqual([
            { type: 'remove', text: 'Mood: happy' },
            { type: 'add', text: 'Mood: sad' },
        ]);
    });

    it('handles empty old text', () => {
        const diff = computeLineDiff('', 'new\ncontent');
        expect(diff.length).toBe(3); // empty string splits to [''], plus 'new' and 'content'
        const adds = diff.filter(d => d.type === 'add');
        expect(adds.length).toBeGreaterThan(0);
    });

    it('handles empty new text', () => {
        const diff = computeLineDiff('old\ncontent', '');
        const removes = diff.filter(d => d.type === 'remove');
        expect(removes.length).toBeGreaterThan(0);
    });

    it('handles both empty', () => {
        const diff = computeLineDiff('', '');
        expect(diff).toEqual([{ type: 'same', text: '' }]);
    });

    it('handles multi-line tracker with one field change', () => {
        const old = 'Name: Elena\nMood: happy\nLocation: forest\nHealth: good';
        const now = 'Name: Elena\nMood: sad\nLocation: forest\nHealth: good';
        const diff = computeLineDiff(old, now);

        const same = diff.filter(d => d.type === 'same');
        const changed = diff.filter(d => d.type !== 'same');
        expect(same.length).toBe(3); // Name, Location, Health
        expect(changed.length).toBe(2); // remove old Mood + add new Mood
    });

    it('preserves line order', () => {
        const diff = computeLineDiff('A\nB\nC', 'A\nB\nC\nD');
        expect(diff[0]).toEqual({ type: 'same', text: 'A' });
        expect(diff[1]).toEqual({ type: 'same', text: 'B' });
        expect(diff[2]).toEqual({ type: 'same', text: 'C' });
        expect(diff[3]).toEqual({ type: 'add', text: 'D' });
    });

    it('handles null inputs gracefully', () => {
        const diff = computeLineDiff(null, 'text');
        expect(diff.length).toBeGreaterThan(0);
    });
});
