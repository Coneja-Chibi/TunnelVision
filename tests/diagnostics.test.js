import { describe, it, expect, beforeEach, vi } from 'vitest';

const getMockState = () => globalThis.__tvDiagnosticsMockState;

vi.mock('../tree-store.js', () => ({
    getTree: vi.fn(() => null),
    createEmptyTree: vi.fn((lorebookName) => ({
        lorebookName,
        root: { id: 'root', children: [], entryUids: [] },
        version: 1,
        lastBuilt: 0,
    })),
    getAllEntryUids: vi.fn(root => {
        const result = [];
        (function walk(node) {
            if (!node) return;
            for (const uid of node.entryUids || []) result.push(uid);
            for (const child of node.children || []) walk(child);
        })(root);
        return result;
    }),
    findNodeById: vi.fn(() => null),
    getSettings: vi.fn(() => getMockState().settings),
    saveTree: vi.fn((bookName, tree) => {
        getMockState().savedTrees.push({ bookName, tree });
    }),
    getBookDescription: vi.fn(() => ''),
    isTrackerTitle: vi.fn(title => /^\[tracker[^\]]*\]/i.test(String(title || '').trim())),
}));

vi.mock('../tool-registry.js', () => ({
    getActiveTunnelVisionBooks: vi.fn(() => getMockState().activeBooks),
    ALL_TOOL_NAMES: [],
    CONFIRMABLE_TOOLS: new Set(),
    preflightToolRuntimeState: vi.fn(async () => ({
        ok: true,
        repairApplied: false,
        failureReasons: [],
        activeBooks: getMockState().activeBooks,
        disabledToolNames: [],
        expectedToolNames: [],
        registeredToolNames: [],
        missingToolNames: [],
        stealthToolNames: [],
        eligibleToolNames: [],
        eligibilityErrors: [],
    })),
}));

vi.mock('../entry-manager.js', () => ({
    buildUidMap: vi.fn(entries => {
        const map = new Map();
        for (const entry of Object.values(entries || {})) {
            if (entry && Number.isFinite(entry.uid)) {
                map.set(entry.uid, entry);
            }
        }
        return map;
    }),
    getCachedWorldInfo: vi.fn(async bookName => getMockState().lorebooks.get(bookName) || null),
}));

vi.mock('../../../st-context.js', () => ({
    getContext: vi.fn(() => ({
        chat: [],
        chatCompletionSettings: {},
        generateRaw: async () => '',
    })),
}));

vi.mock('../../../world-info.js', async () => {
    const actual = await vi.importActual('../../../world-info.js');
    return {
        ...actual,
        get world_names() {
            return getMockState().worldNames;
        },
    };
});

import { runDiagnostics } from '../diagnostics.js';

function resetMockState() {
    globalThis.__tvDiagnosticsMockState = {
        activeBooks: [],
        settings: { trackerUids: {} },
        worldNames: [],
        lorebooks: new Map(),
        savedTrees: [],
    };
}

function makeEntry(uid, comment, extra = {}) {
    return {
        uid,
        comment,
        disable: false,
        key: [],
        content: '',
        ...extra,
    };
}

describe('runDiagnostics tracker UID normalization', () => {
    beforeEach(() => {
        resetMockState();
        vi.clearAllMocks();
    });

    it('removes stale and disabled tracker UIDs while adding title-based trackers', async () => {
        const state = getMockState();
        state.settings = {
            trackerUids: {
                'Book A': [30, 20, 10, 20],
            },
        };
        state.worldNames = ['Book A'];
        state.lorebooks.set('Book A', {
            entries: {
                a: makeEntry(10, '[Tracker: Elena]'),
                b: makeEntry(20, 'Ordinary Fact', { disable: true }),
                c: makeEntry(40, '[tracker] Darius'),
                d: makeEntry(50, 'Unrelated note'),
            },
        });

        const results = await runDiagnostics();

        expect(state.settings.trackerUids).toEqual({
            'Book A': [10, 40],
        });

        const normalized = results.find(result =>
            result.message.includes('"Book A" tracker list was normalized:'),
        );
        expect(normalized).toBeTruthy();
        expect(normalized.message).toContain('stale removed');
        expect(normalized.message).toContain('title-based tracker(s) added');
    });

    it('removes tracker UID state for missing lorebooks', async () => {
        const state = getMockState();
        state.settings = {
            trackerUids: {
                MissingBook: [1, 2, 3],
            },
        };
        state.worldNames = [];

        const results = await runDiagnostics();

        expect(state.settings.trackerUids).toEqual({});
        expect(results.some(result =>
            result.message === 'Tracker entries for missing lorebook "MissingBook" were removed.',
        )).toBe(true);
        expect(results.some(result =>
            result.message === 'Tracker entries: none configured',
        )).toBe(true);
    });

    it('leaves already-valid tracker state unchanged', async () => {
        const state = getMockState();
        state.settings = {
            trackerUids: {
                'Book A': [5, 8],
            },
        };
        state.worldNames = ['Book A'];
        state.lorebooks.set('Book A', {
            entries: {
                a: makeEntry(5, '[Tracker: Alpha]'),
                b: makeEntry(8, '[Tracker: Beta]'),
                c: makeEntry(9, 'Regular entry'),
            },
        });

        const results = await runDiagnostics();

        expect(state.settings.trackerUids).toEqual({
            'Book A': [5, 8],
        });
        expect(results.some(result =>
            result.message === '"Book A" tracker entries validated (2)',
        )).toBe(true);
        expect(results.some(result =>
            result.message.includes('tracker list was normalized'),
        )).toBe(false);
    });

    it('reports aggregate tracker coverage across multiple lorebooks', async () => {
        const state = getMockState();
        state.settings = {
            trackerUids: {
                'Book A': [1],
                'Book B': [2, 3],
            },
        };
        state.worldNames = ['Book A', 'Book B'];
        state.lorebooks.set('Book A', {
            entries: {
                a: makeEntry(1, '[Tracker: Alpha]'),
            },
        });
        state.lorebooks.set('Book B', {
            entries: {
                a: makeEntry(2, '[Tracker: Beta]'),
                b: makeEntry(3, '[Tracker: Gamma]'),
            },
        });

        const results = await runDiagnostics();

        expect(results.some(result =>
            result.message === 'Tracker entries: 3 configured across 2 lorebook(s)',
        )).toBe(true);
    });

    it('keeps tracker state unchanged and warns when a lorebook cannot be loaded', async () => {
        const state = getMockState();
        state.settings = {
            trackerUids: {
                'Book A': [1, 2],
            },
        };
        state.worldNames = ['Book A'];
        state.lorebooks.set('Book A', null);

        const results = await runDiagnostics();

        expect(state.settings.trackerUids).toEqual({
            'Book A': [1, 2],
        });
        expect(results.some(result =>
            result.message === 'Tracker entries for "Book A" could not be validated because the lorebook failed to load.',
        )).toBe(true);
    });
});