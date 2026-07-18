import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadWorldInfo, saveWorldInfo } from '../../../world-info.js';

const mockMetadata = {};
const mockSaveDebounced = vi.fn();
vi.mock('../../../st-context.js', () => ({
    getContext: () => ({
        chatMetadata: mockMetadata,
        saveMetadataDebounced: mockSaveDebounced,
    }),
}));

vi.mock('../../../world-info.js', () => ({
    loadWorldInfo: vi.fn(),
    createWorldInfoEntry: vi.fn(),
    saveWorldInfo: vi.fn(),
}));

vi.mock('./tree-store.js', () => ({
    getTree: vi.fn(),
    saveTree: vi.fn(),
    findNodeById: vi.fn(),
    findBestNodeForEntry: vi.fn(),
    addEntryToNode: vi.fn(),
    removeEntryFromTree: vi.fn(),
    createTreeNode: vi.fn(),
    isTrackerTitle: vi.fn(() => false),
    isTrackerUid: vi.fn(() => false),
    setTrackerUid: vi.fn(),
}));

import {
    parseJsonFromLLM,
    cleanupEntryMetadata,
    recordEntryTemporal,
    getEntryTemporal,
    setEntrySupersedes,
    getEntryTurnIndex,
    buildSummaryKeys,
    getCachedWorldInfo,
    getCachedWorldInfoSync,
    invalidateWorldInfoCache,
    invalidateDirtyWorldInfoCache,
    persistWorldInfo,
    buildUidMap,
    withEntryTransaction,
    updateEntry,
    mergeEntries,
} from '../entry-manager.js';

describe('entry manager cache and transaction invariants', () => {
    beforeEach(() => {
        for (const key of Object.keys(mockMetadata)) delete mockMetadata[key];
        mockSaveDebounced.mockClear();
        vi.clearAllMocks();
        invalidateWorldInfoCache();
    });

    it('caches loaded world info until explicitly invalidated', async () => {
        const bookData = { entries: { a: { uid: 1, comment: 'Alpha', content: 'One' } } };
        loadWorldInfo.mockResolvedValue(bookData);

        const first = await getCachedWorldInfo('Book A');
        const second = await getCachedWorldInfo('Book A');

        expect(first).toBe(bookData);
        expect(second).toBe(bookData);
        expect(loadWorldInfo).toHaveBeenCalledTimes(1);
        expect(getCachedWorldInfoSync('Book A')).toBe(bookData);

        invalidateWorldInfoCache('Book A');
        loadWorldInfo.mockResolvedValue({ entries: { b: { uid: 2, comment: 'Beta', content: 'Two' } } });

        const third = await getCachedWorldInfo('Book A');
        expect(loadWorldInfo).toHaveBeenCalledTimes(2);
        expect(third).not.toBe(bookData);
    });

    it('only invalidates dirty books during selective cache invalidation', async () => {
        const alpha = { entries: { a: { uid: 1, comment: 'Alpha', content: 'One' } } };
        const beta = { entries: { b: { uid: 2, comment: 'Beta', content: 'Two' } } };

        loadWorldInfo.mockImplementation(async (bookName) => {
            if (bookName === 'Alpha') return alpha;
            if (bookName === 'Beta') return beta;
            return null;
        });

        await getCachedWorldInfo('Alpha');
        await getCachedWorldInfo('Beta');

        invalidateWorldInfoCache('Alpha');
        invalidateDirtyWorldInfoCache();

        await getCachedWorldInfo('Alpha');
        await getCachedWorldInfo('Beta');

        expect(loadWorldInfo.mock.calls.filter(([name]) => name === 'Alpha')).toHaveLength(2);
        expect(loadWorldInfo.mock.calls.filter(([name]) => name === 'Beta')).toHaveLength(1);
    });

    it('persistWorldInfo saves and invalidates the targeted book cache', async () => {
        const bookData = { entries: { a: { uid: 1, comment: 'Alpha', content: 'One' } } };
        loadWorldInfo.mockResolvedValue(bookData);
        saveWorldInfo.mockResolvedValue(undefined);

        await getCachedWorldInfo('Book A');
        await persistWorldInfo('Book A', bookData);

        loadWorldInfo.mockResolvedValue({ entries: { a: { uid: 1, comment: 'Alpha', content: 'Two' } } });
        await getCachedWorldInfo('Book A');

        expect(saveWorldInfo).toHaveBeenCalledWith('Book A', bookData, true);
        expect(loadWorldInfo).toHaveBeenCalledTimes(2);
    });

    it('buildUidMap maps entries by uid', () => {
        const entries = {
            a: { uid: 10, comment: 'A' },
            b: { uid: 22, comment: 'B' },
        };

        const map = buildUidMap(entries);

        expect(map.get(10)).toBe(entries.a);
        expect(map.get(22)).toBe(entries.b);
        expect(map.size).toBe(2);
    });

    it('withEntryTransaction rolls back snapshotted entries after an operation failure', async () => {
        const originalA = { uid: 1, comment: 'Alpha', content: 'One', key: ['a'], disable: false };
        const originalB = { uid: 2, comment: 'Beta', content: 'Two', key: ['b'], disable: false };
        const bookData = { entries: { a: originalA, b: originalB } };

        loadWorldInfo.mockResolvedValue(bookData);
        saveWorldInfo.mockResolvedValue(undefined);

        await expect(withEntryTransaction('Book A', [1, 2], async (data) => {
            data.entries.a.content = 'Mutated one';
            data.entries.a.comment = 'Changed alpha';
            data.entries.a.key = ['changed'];
            data.entries.a.disable = true;
            data.entries.b.content = 'Mutated two';
            throw new Error('boom');
        })).rejects.toThrow('boom');

        expect(bookData.entries.a).toMatchObject({
            uid: 1,
            comment: 'Alpha',
            content: 'One',
            key: ['a'],
            disable: false,
        });
        expect(bookData.entries.b).toMatchObject({
            uid: 2,
            comment: 'Beta',
            content: 'Two',
            key: ['b'],
            disable: false,
        });
        expect(saveWorldInfo).toHaveBeenCalledWith('Book A', bookData, true);
    });

    it('withEntryTransaction does not persist rollback when no snapshotted entries exist', async () => {
        const bookData = { entries: { a: { uid: 1, comment: 'Alpha', content: 'One', key: [], disable: false } } };

        loadWorldInfo.mockResolvedValue(bookData);
        saveWorldInfo.mockResolvedValue(undefined);

        await expect(withEntryTransaction('Book A', [999], async () => {
            throw new Error('no snapshots');
        })).rejects.toThrow('no snapshots');

        expect(saveWorldInfo).not.toHaveBeenCalled();
    });
});

describe('background static-entry guard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        invalidateWorldInfoCache();
    });

    it('rejects background updates to static entries before saving', async () => {
        const bookData = {
            entries: { canon: { uid: 7, comment: 'Canon', content: 'Fixed fact', constant: true } },
        };
        loadWorldInfo.mockResolvedValue(bookData);

        await expect(updateEntry('Book A', 7, {
            content: 'Overwritten',
            _backgroundSource: 'sidecar',
        })).rejects.toThrow('static entry');

        expect(bookData.entries.canon.content).toBe('Fixed fact');
        expect(saveWorldInfo).not.toHaveBeenCalled();
    });

    it('rejects background merges when either target is static', async () => {
        const bookData = {
            entries: {
                canon: { uid: 7, comment: 'Canon', content: 'Fixed fact', constant: true, key: [] },
                notes: { uid: 8, comment: 'Notes', content: 'Mutable note', constant: false, key: [] },
            },
        };
        loadWorldInfo.mockResolvedValue(bookData);

        await expect(mergeEntries('Book A', 8, 7, {
            _backgroundSource: 'lifecycle',
        })).rejects.toThrow('static entry');

        expect(bookData.entries.canon.disable).toBeUndefined();
        expect(saveWorldInfo).not.toHaveBeenCalled();
    });
});

describe('parseJsonFromLLM', () => {
    // ── Clean inputs ─────────────────────────────────────────────

    it('parses a clean JSON object', () => {
        expect(parseJsonFromLLM('{"a": 1}')).toEqual({ a: 1 });
    });

    it('parses a clean JSON array', () => {
        expect(parseJsonFromLLM('[1, 2, 3]', { type: 'array' })).toEqual([1, 2, 3]);
    });

    // ── Empty / missing input ────────────────────────────────────

    it('returns empty object for null input', () => {
        expect(parseJsonFromLLM(null)).toEqual({});
    });

    it('returns empty object for undefined input', () => {
        expect(parseJsonFromLLM(undefined)).toEqual({});
    });

    it('returns empty object for empty string', () => {
        expect(parseJsonFromLLM('')).toEqual({});
    });

    it('returns empty array for empty input when type=array', () => {
        expect(parseJsonFromLLM('', { type: 'array' })).toEqual([]);
        expect(parseJsonFromLLM(null, { type: 'array' })).toEqual([]);
    });

    // ── Wrapper stripping ────────────────────────────────────────

    it('strips markdown code fences', () => {
        expect(parseJsonFromLLM('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    });

    it('strips markdown code fences without language tag', () => {
        expect(parseJsonFromLLM('```\n{"a": 1}\n```')).toEqual({ a: 1 });
    });

    it('strips <think> tags', () => {
        expect(parseJsonFromLLM('<think>reasoning here</think>{"a": 1}')).toEqual({ a: 1 });
    });

    it('strips <output> wrapper', () => {
        expect(parseJsonFromLLM('<output>{"a": 1}</output>')).toEqual({ a: 1 });
    });

    it('strips <response> wrapper', () => {
        expect(parseJsonFromLLM('<response>{"a": 1}</response>')).toEqual({ a: 1 });
    });

    it('strips <json> wrapper', () => {
        expect(parseJsonFromLLM('<json>{"a": 1}</json>')).toEqual({ a: 1 });
    });

    // ── Extraction from surrounding text ─────────────────────────

    it('extracts JSON object from surrounding prose', () => {
        expect(parseJsonFromLLM('Here is the result: {"a": 1} Hope that helps!')).toEqual({ a: 1 });
    });

    it('extracts JSON array from surrounding prose', () => {
        expect(parseJsonFromLLM('Result: [1, 2] Done.', { type: 'array' })).toEqual([1, 2]);
    });

    // ── Error recovery ───────────────────────────────────────────

    it('fixes trailing commas in objects', () => {
        expect(parseJsonFromLLM('{"a": 1, "b": 2,}')).toEqual({ a: 1, b: 2 });
    });

    it('fixes trailing commas in arrays', () => {
        expect(parseJsonFromLLM('[1, 2, 3,]', { type: 'array' })).toEqual([1, 2, 3]);
    });

    // ── Complex structures ───────────────────────────────────────

    it('handles nested objects', () => {
        const input = '{"outer": {"inner": [1, 2, 3]}}';
        expect(parseJsonFromLLM(input)).toEqual({ outer: { inner: [1, 2, 3] } });
    });

    it('handles objects with string values containing braces', () => {
        const input = '{"text": "a {b} c"}';
        expect(parseJsonFromLLM(input)).toEqual({ text: 'a {b} c' });
    });

    // ── No JSON found ────────────────────────────────────────────

    it('returns empty object when no JSON found', () => {
        expect(parseJsonFromLLM('Just plain text with no JSON.')).toEqual({});
    });

    it('returns empty array when no JSON array found', () => {
        expect(parseJsonFromLLM('Plain text', { type: 'array' })).toEqual([]);
    });
});

// ── cleanupEntryMetadata ─────────────────────────────────────────

describe('cleanupEntryMetadata', () => {
    beforeEach(() => {
        for (const key of Object.keys(mockMetadata)) delete mockMetadata[key];
        mockSaveDebounced.mockClear();
    });

    it('removes numeric uid key from tunnelvision_relevance', () => {
        mockMetadata.tunnelvision_relevance = { 42: Date.now(), 99: Date.now() };
        cleanupEntryMetadata('book', 42);
        expect(mockMetadata.tunnelvision_relevance[42]).toBeUndefined();
        expect(mockMetadata.tunnelvision_relevance[99]).toBeDefined();
    });

    it('removes string uid key from tunnelvision_relevance', () => {
        mockMetadata.tunnelvision_relevance = { '42': Date.now() };
        cleanupEntryMetadata('book', 42);
        expect(mockMetadata.tunnelvision_relevance['42']).toBeUndefined();
    });

    it('removes uid from tunnelvision_feedback', () => {
        mockMetadata.tunnelvision_feedback = {
            42: { injections: 3, references: 1 },
            99: { injections: 1, references: 0 },
        };
        cleanupEntryMetadata('book', 42);
        expect(mockMetadata.tunnelvision_feedback[42]).toBeUndefined();
        expect(mockMetadata.tunnelvision_feedback[99]).toBeDefined();
    });

    it('removes bookName:uid key from tunnelvision_entry_history', () => {
        mockMetadata.tunnelvision_entry_history = {
            'book:42': [{ timestamp: 1, source: 'test' }],
            'book:99': [{ timestamp: 2, source: 'test' }],
            'other:42': [{ timestamp: 3, source: 'test' }],
        };
        cleanupEntryMetadata('book', 42);
        expect(mockMetadata.tunnelvision_entry_history['book:42']).toBeUndefined();
        expect(mockMetadata.tunnelvision_entry_history['book:99']).toBeDefined();
        expect(mockMetadata.tunnelvision_entry_history['other:42']).toBeDefined();
    });

    it('calls saveMetadataDebounced after cleanup', () => {
        mockMetadata.tunnelvision_relevance = { 1: Date.now() };
        cleanupEntryMetadata('book', 1);
        expect(mockSaveDebounced).toHaveBeenCalled();
    });

    it('does not throw when metadata maps are absent', () => {
        expect(() => cleanupEntryMetadata('book', 42)).not.toThrow();
    });

    it('removes bookName:uid key from tunnelvision_entry_temporal', () => {
        mockMetadata.tunnelvision_entry_temporal = {
            'book:42': { turnIndex: 10, when: 'Day 1', arcId: null, supersedes: null, createdAt: 100 },
            'book:99': { turnIndex: 20, when: null, arcId: null, supersedes: null, createdAt: 200 },
        };
        cleanupEntryMetadata('book', 42);
        expect(mockMetadata.tunnelvision_entry_temporal['book:42']).toBeUndefined();
        expect(mockMetadata.tunnelvision_entry_temporal['book:99']).toBeDefined();
    });
});

// ── Temporal Fact Metadata ───────────────────────────────────────

describe('recordEntryTemporal', () => {
    beforeEach(() => {
        for (const key of Object.keys(mockMetadata)) delete mockMetadata[key];
        mockSaveDebounced.mockClear();
    });

    it('records temporal data for a new entry', () => {
        recordEntryTemporal('mybook', 42, { turnIndex: 15, when: 'Day 3, evening' });
        const data = mockMetadata.tunnelvision_entry_temporal?.['mybook:42'];
        expect(data).toBeTruthy();
        expect(data.turnIndex).toBe(15);
        expect(data.when).toBe('Day 3, evening');
        expect(data.arcId).toBeNull();
        expect(data.supersedes).toBeNull();
        expect(data.createdAt).toBeGreaterThan(0);
    });

    it('records arcId when provided', () => {
        recordEntryTemporal('mybook', 42, { turnIndex: 10, arcId: 'arc_123' });
        const data = mockMetadata.tunnelvision_entry_temporal['mybook:42'];
        expect(data.arcId).toBe('arc_123');
    });

    it('stores null when and arcId when not provided', () => {
        recordEntryTemporal('mybook', 42, { turnIndex: 5 });
        const data = mockMetadata.tunnelvision_entry_temporal['mybook:42'];
        expect(data.when).toBeNull();
        expect(data.arcId).toBeNull();
    });
});

describe('getEntryTemporal', () => {
    beforeEach(() => {
        for (const key of Object.keys(mockMetadata)) delete mockMetadata[key];
    });

    it('returns null when no temporal data exists', () => {
        expect(getEntryTemporal('mybook', 42)).toBeNull();
    });

    it('returns stored temporal data', () => {
        mockMetadata.tunnelvision_entry_temporal = {
            'mybook:42': { turnIndex: 10, when: 'Day 1', arcId: null, supersedes: null, createdAt: 100 },
        };
        const data = getEntryTemporal('mybook', 42);
        expect(data.turnIndex).toBe(10);
        expect(data.when).toBe('Day 1');
    });
});

describe('setEntrySupersedes', () => {
    beforeEach(() => {
        for (const key of Object.keys(mockMetadata)) delete mockMetadata[key];
    });

    it('sets supersedes on existing temporal entry', () => {
        mockMetadata.tunnelvision_entry_temporal = {
            'mybook:100': { turnIndex: 50, when: null, arcId: null, supersedes: null, createdAt: 100 },
        };
        setEntrySupersedes('mybook', 100, 42);
        expect(mockMetadata.tunnelvision_entry_temporal['mybook:100'].supersedes).toBe(42);
    });

    it('creates temporal entry with supersedes when none exists', () => {
        setEntrySupersedes('mybook', 100, 42);
        const data = mockMetadata.tunnelvision_entry_temporal['mybook:100'];
        expect(data).toBeTruthy();
        expect(data.supersedes).toBe(42);
    });
});

describe('getEntryTurnIndex', () => {
    beforeEach(() => {
        for (const key of Object.keys(mockMetadata)) delete mockMetadata[key];
    });

    it('returns 0 when no temporal data exists', () => {
        expect(getEntryTurnIndex('mybook', 42)).toBe(0);
    });

    it('returns the stored turnIndex', () => {
        mockMetadata.tunnelvision_entry_temporal = {
            'mybook:42': { turnIndex: 25, when: null, arcId: null, supersedes: null, createdAt: 100 },
        };
        expect(getEntryTurnIndex('mybook', 42)).toBe(25);
    });
});

describe('buildSummaryKeys', () => {
    it('includes LLM-generated keys', () => {
        const keys = buildSummaryKeys(
            { keys: ['forest', 'betrayal', 'night'], participants: [], significance: 'moderate' },
            ['Alice'],
            'moderate',
        );
        expect(keys).toContain('forest');
        expect(keys).toContain('betrayal');
        expect(keys).toContain('night');
    });

    it('includes participant names (lowercased)', () => {
        const keys = buildSummaryKeys({ keys: [] }, ['Alice', 'Bob'], 'moderate');
        expect(keys).toContain('alice');
        expect(keys).toContain('bob');
    });

    it('includes significance tag', () => {
        const keys = buildSummaryKeys({ keys: [] }, [], 'major');
        expect(keys).toContain('summary:major');
    });

    it('includes arc name as keyword', () => {
        const keys = buildSummaryKeys({ keys: [], arc: 'The Great War' }, [], 'moderate');
        expect(keys).toContain('the great war');
    });

    it('includes when field as keyword', () => {
        const keys = buildSummaryKeys({ keys: [], when: 'Evening, Day 3' }, [], 'moderate');
        expect(keys).toContain('evening, day 3');
    });

    it('deduplicates keys', () => {
        const keys = buildSummaryKeys(
            { keys: ['alice', 'Alice', 'ALICE'] },
            ['Alice'],
            'moderate',
        );
        const aliceCount = keys.filter(k => k === 'alice').length;
        expect(aliceCount).toBe(1);
    });

    it('filters out short keys (< 2 chars)', () => {
        const keys = buildSummaryKeys({ keys: ['a', 'ok', 'x'] }, [], 'moderate');
        expect(keys).not.toContain('a');
        expect(keys).not.toContain('x');
        expect(keys).toContain('ok');
    });

    it('handles missing/null keys gracefully', () => {
        const keys = buildSummaryKeys({ keys: null, arc: null, when: null }, [], 'moderate');
        expect(keys).toContain('summary:moderate');
        expect(keys.length).toBe(1);
    });

    it('skips unspecified when', () => {
        const keys = buildSummaryKeys({ keys: [], when: 'unspecified' }, [], 'moderate');
        expect(keys).not.toContain('unspecified');
    });
});
