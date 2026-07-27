import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../st-context.js', () => ({
    getContext: vi.fn(),
}));

// Mock transitive dependencies
vi.mock('../tree-store.js', () => ({
    getSettings: vi.fn(() => ({})),
    getTrackerUids: vi.fn(() => new Map()),
    isTrackerTitle: vi.fn((t) => t?.startsWith('[Tracker]')),
    isSummaryTitle: vi.fn((t) => t?.includes('[Summary]') || t?.includes('[Scene Summary]')),
}));
vi.mock('../tool-registry.js', () => ({
    getActiveTunnelVisionBooks: vi.fn(() => []),
    resolveTargetBook: vi.fn(() => 'test'),
}));
vi.mock('../entry-manager.js', () => ({
    createEntry: vi.fn(),
    updateEntry: vi.fn(),
    forgetEntry: vi.fn(),
    getCachedWorldInfo: vi.fn(),
    buildUidMap: vi.fn(() => new Map()),
    parseJsonFromLLM: vi.fn(() => []),
    recordEntryTemporal: vi.fn(),
    KEYWORD_RULES: 'KEYWORD RULES (test stub)',
    FACT_EXTRACTION_PROMPT: [
        'FACT EXTRACTION PROMPT (test stub)',
        '{existingFactsSection}',
        '{temporalContext}',
        '{inputSection}',
        'Respond with ONLY a JSON array',
    ].join('\n'),
}));
vi.mock('../auto-summary.js', () => ({
    markAutoSummaryComplete: vi.fn(),
}));
vi.mock('../tools/summarize.js', () => ({
    getWatermark: vi.fn(() => 0),
    setWatermark: vi.fn(),
    hideSummarizedMessages: vi.fn(),
}));
vi.mock('../agent-utils.js', () => ({
    getChatId: vi.fn(() => 'test-chat'),
    formatChatExcerpt: vi.fn(() => ''),
    trigramSimilarity: vi.fn(() => 0),
    trigrams: vi.fn(() => new Set()),
    callWithRetry: vi.fn(),
    generateAnalytical: vi.fn(),
    getStoryContext: vi.fn(() => ''),
}));
vi.mock('../background-events.js', () => ({
    addBackgroundEvent: vi.fn(),
    registerBackgroundTask: vi.fn(() => ({ cancelled: false, end: vi.fn(), fail: vi.fn() })),
    getTrackerSuggestionNames: vi.fn(() => []),
}));
vi.mock('../world-state.js', () => ({
    requestPriorityUpdate: vi.fn(),
    getWorldStateTemporalSnapshot: vi.fn(() => null),
}));
vi.mock('../arc-tracker.js', () => ({
    processArcUpdates: vi.fn(() => ({ created: 0, updated: 0, resolved: 0 })),
    buildArcsContextBlock: vi.fn(() => ''),
}));
vi.mock('../smart-context.js', () => ({
    getFeedbackMap: vi.fn(() => ({})),
    preWarmSmartContext: vi.fn(() => Promise.resolve()),
    invalidatePreWarmCache: vi.fn(),
}));

import { getContext } from '../../../st-context.js';
import { updateEntry, parseJsonFromLLM } from '../entry-manager.js';
import { callWithRetry, generateAnalytical } from '../agent-utils.js';
import {
    contentHash,
    computeChangeFraction,
    updateTrackers,
    runPostTurnProcessor,
    shouldInvalidateSmartContextPreWarm,
    refreshSmartContextAfterPostTurn,
} from '../post-turn-processor.js';
import { getSettings } from '../tree-store.js';
import { getActiveTunnelVisionBooks, resolveTargetBook } from '../tool-registry.js';
import { formatChatExcerpt } from '../agent-utils.js';
import { registerBackgroundTask } from '../background-events.js';
import { invalidatePreWarmCache, preWarmSmartContext } from '../smart-context.js';
import { getWorldStateTemporalSnapshot } from '../world-state.js';

beforeEach(() => {
    vi.clearAllMocks();
    getContext.mockReturnValue({
        chatMetadata: {},
        saveMetadataDebounced: vi.fn(),
    });
    callWithRetry.mockImplementation(async (fn) => await fn());
    generateAnalytical.mockResolvedValue('[]');
    parseJsonFromLLM.mockReturnValue([]);
    getSettings.mockReturnValue({
        postTurnEnabled: true,
        globalEnabled: true,
        postTurnExtractFacts: false,
        postTurnUpdateTrackers: false,
        postTurnSceneArchive: false,
    });
    getActiveTunnelVisionBooks.mockReturnValue(['test-book']);
    resolveTargetBook.mockReturnValue({ book: 'test-book', error: null });
    formatChatExcerpt.mockReturnValue('User: hello\n\nCharacter: hi');
    registerBackgroundTask.mockReturnValue({
        cancelled: false,
        _ended: false,
        end: vi.fn(function () { this._ended = true; }),
        fail: vi.fn(),
    });
});

// ── contentHash ─────────────────────────────────────────────────

describe('contentHash', () => {
    it('returns a number', () => {
        expect(typeof contentHash('hello world')).toBe('number');
    });

    it('returns the same hash for identical strings', () => {
        expect(contentHash('test string')).toBe(contentHash('test string'));
    });

    it('returns different hashes for different strings', () => {
        expect(contentHash('hello')).not.toBe(contentHash('world'));
    });

    it('handles empty string', () => {
        expect(contentHash('')).toBe(0);
    });

    it('handles long strings', () => {
        const long = 'a'.repeat(10000);
        expect(typeof contentHash(long)).toBe('number');
    });

    it('is sensitive to small changes', () => {
        expect(contentHash('Location: forest')).not.toBe(contentHash('Location: camp'));
    });
});

// ── computeChangeFraction ───────────────────────────────────────

describe('computeChangeFraction', () => {
    it('returns 0 for identical texts', () => {
        const text = 'Mood: happy\nLocation: camp\nHealth: good';
        expect(computeChangeFraction(text, text)).toBe(0);
    });

    it('returns 1 for completely different texts', () => {
        const old = 'Line A\nLine B\nLine C';
        const now = 'Line X\nLine Y\nLine Z';
        expect(computeChangeFraction(old, now)).toBe(1);
    });

    it('returns 0 for both empty', () => {
        expect(computeChangeFraction('', '')).toBe(0);
    });

    it('returns 1 when old is empty and new has content', () => {
        expect(computeChangeFraction('', 'some\ncontent')).toBe(1);
    });

    it('returns 1 when new is empty and old has content', () => {
        expect(computeChangeFraction('some\ncontent', '')).toBe(1);
    });

    it('returns a low fraction for a single-line change in a multi-line tracker', () => {
        const old = 'Name: Elena\nMood: happy\nLocation: forest\nHealth: good\nInventory: sword, shield';
        const now = 'Name: Elena\nMood: sad\nLocation: forest\nHealth: good\nInventory: sword, shield';
        const fraction = computeChangeFraction(old, now);
        expect(fraction).toBeGreaterThan(0);
        expect(fraction).toBeLessThan(0.3);
    });

    it('returns a high fraction when most lines change', () => {
        const old = 'Name: Elena\nMood: happy\nLocation: forest\nHealth: good';
        const now = 'Name: John\nMood: angry\nLocation: cave\nHealth: injured';
        const fraction = computeChangeFraction(old, now);
        expect(fraction).toBeGreaterThan(0.6);
    });

    it('handles added lines', () => {
        const old = 'Line A\nLine B';
        const now = 'Line A\nLine B\nLine C\nLine D';
        const fraction = computeChangeFraction(old, now);
        expect(fraction).toBeGreaterThan(0);
        expect(fraction).toBeLessThan(1);
    });

    it('handles removed lines', () => {
        const old = 'Line A\nLine B\nLine C\nLine D';
        const now = 'Line A\nLine B';
        const fraction = computeChangeFraction(old, now);
        expect(fraction).toBeGreaterThan(0);
        expect(fraction).toBeLessThan(1);
    });

    it('ignores leading/trailing whitespace on lines', () => {
        const old = '  Mood: happy  \n  Location: camp  ';
        const now = 'Mood: happy\nLocation: camp';
        expect(computeChangeFraction(old, now)).toBe(0);
    });

    it('result is between 0 and 1 inclusive', () => {
        const cases = [
            ['a', 'b'],
            ['a\nb', 'a\nc'],
            ['x\ny\nz', 'x'],
            ['', 'new'],
        ];
        for (const [a, b] of cases) {
            const f = computeChangeFraction(a, b);
            expect(f).toBeGreaterThanOrEqual(0);
            expect(f).toBeLessThanOrEqual(1);
        }
    });
});

describe('updateTrackers', () => {
    it('rebases externally modified tracker content and still applies the update', async () => {
        const saveMetadataDebounced = vi.fn();
        getContext.mockReturnValue({
            chatMetadata: {
                tunnelvision_tracker_hashes: {
                    'test-book:7': {
                        hash: contentHash('## Current Status\nMood: calm'),
                        timestamp: 1,
                    },
                },
            },
            saveMetadataDebounced,
        });

        generateAnalytical.mockResolvedValue('[{"uid":7,"book":"test-book","content":"## Current Status\nMood: alert"}]');
        parseJsonFromLLM.mockReturnValue([
            {
                uid: 7,
                book: 'test-book',
                content: '## Current Status\nMood: alert',
            },
        ]);

        const trackers = [
            {
                uid: 7,
                book: 'test-book',
                title: '[Tracker: Sophia Fuchs]',
                content: '## Current Status\nMood: uneasy',
            },
        ];

        const result = await updateTrackers(trackers, 'Sophia steadies herself.', 'test-chat');

        expect(result.updated).toBe(1);
        expect(result.staleSkips).toEqual([
            { uid: 7, book: 'test-book', title: '[Tracker: Sophia Fuchs]' },
        ]);
        expect(updateEntry).toHaveBeenCalledWith('test-book', 7, {
            content: '## Current Status\nMood: alert',
            _source: 'post-turn',
        });
        expect(getContext().chatMetadata.tunnelvision_tracker_hashes['test-book:7'].hash)
            .toBe(contentHash('## Current Status\nMood: alert'));
        expect(saveMetadataDebounced).toHaveBeenCalled();
    });

    it('updates trackers normally when no prior hash exists', async () => {
        getContext.mockReturnValue({
            chatMetadata: {},
            saveMetadataDebounced: vi.fn(),
        });

        generateAnalytical.mockResolvedValue('[{"uid":9,"book":"test-book","content":"## Current Status\nLocation: safehouse"}]');
        parseJsonFromLLM.mockReturnValue([
            {
                uid: 9,
                book: 'test-book',
                content: '## Current Status\nLocation: safehouse',
            },
        ]);

        const trackers = [
            {
                uid: 9,
                book: 'test-book',
                title: '[Tracker: Sophia Fuchs]',
                content: '## Current Status\nLocation: street',
            },
        ];

        const result = await updateTrackers(trackers, 'Sophia arrives at the safehouse.', 'test-chat');

        expect(result.updated).toBe(1);
        expect(updateEntry).toHaveBeenCalledWith('test-book', 9, {
            content: '## Current Status\nLocation: safehouse',
            _source: 'post-turn',
        });
    });
});

describe('runPostTurnProcessor smart-context refresh', () => {
    it('rewarms smart-context without invalidation when post-turn makes no memory changes', async () => {
        getContext.mockReturnValue({
            chat: [
                { is_user: true, mes: 'Hello' },
                { is_user: false, mes: 'Hi there' },
                { is_user: true, mes: 'Remember Elena' },
                { is_user: false, mes: 'Elena is important' },
            ],
            chatMetadata: {},
            saveMetadataDebounced: vi.fn(),
        });

        const result = await runPostTurnProcessor(true);

        expect(result).toEqual({
            factsCreated: 0,
            trackersUpdated: 0,
            sceneArchived: false,
            sceneTitle: null,
            arcsCreated: 0,
            arcsUpdated: 0,
            arcsResolved: 0,
            errors: 0,
        });
        expect(invalidatePreWarmCache).not.toHaveBeenCalled();
        expect(preWarmSmartContext).toHaveBeenCalledTimes(1);
    });

    it('invalidates prewarm cache before refreshing when post-turn creates facts', async () => {
        getSettings.mockReturnValue({
            postTurnEnabled: true,
            globalEnabled: true,
            postTurnExtractFacts: true,
            postTurnUpdateTrackers: false,
            postTurnSceneArchive: false,
        });

        getContext.mockReturnValue({
            chat: [
                { is_user: true, mes: 'Hello' },
                { is_user: false, mes: 'Hi there' },
                { is_user: true, mes: 'Remember Elena' },
                { is_user: false, mes: 'Elena is important' },
            ],
            chatMetadata: {},
            saveMetadataDebounced: vi.fn(),
        });

        callWithRetry.mockResolvedValue('[]');
        parseJsonFromLLM.mockReturnValue({
            facts: [
                {
                    content: 'Elena trained at the Grand Cathedral.',
                    title: 'Elena',
                    keys: ['elena'],
                },
            ],
            scene_change: null,
            arcs: [],
        });

        const createEntry = (await import('../entry-manager.js')).createEntry;
        createEntry.mockResolvedValue({ uid: 123 });

        await runPostTurnProcessor(true);

        expect(invalidatePreWarmCache).toHaveBeenCalledTimes(1);
        expect(preWarmSmartContext).toHaveBeenCalledTimes(1);

        const invalidateOrder = invalidatePreWarmCache.mock.invocationCallOrder[0];
        const prewarmOrder = preWarmSmartContext.mock.invocationCallOrder[0];
        expect(invalidateOrder).toBeLessThan(prewarmOrder);
    });

    it('injects structured world-state day/date/time into the analysis prompt', async () => {
        getSettings.mockReturnValue({
            postTurnEnabled: true,
            globalEnabled: true,
            postTurnExtractFacts: true,
            postTurnUpdateTrackers: false,
            postTurnSceneArchive: false,
        });

        getContext.mockReturnValue({
            chat: [
                { is_user: true, mes: 'Hello' },
                { is_user: false, mes: 'Hi there' },
                { is_user: true, mes: 'What day is it?' },
                { is_user: false, mes: 'It is getting late.' },
            ],
            chatMetadata: {},
            saveMetadataDebounced: vi.fn(),
        });

        getWorldStateTemporalSnapshot.mockReturnValue({
            day: 'Day 6',
            date: 'Sunday 16 March 2025',
            time: 'around 13:10-13:20',
            location: 'Germany > Berlin > Cafe',
        });
        parseJsonFromLLM.mockReturnValue({ facts: [], sceneChange: { detected: false }, arcs: [] });

        await runPostTurnProcessor(true);

        expect(generateAnalytical).toHaveBeenCalledWith(expect.objectContaining({
            prompt: expect.stringContaining('[Current In-World Time — use this to timestamp facts]'),
        }));

        const analysisPrompt = generateAnalytical.mock.calls[0][0].prompt;
        expect(analysisPrompt).toContain('- Day: Day 6');
        expect(analysisPrompt).toContain('- Date: Sunday 16 March 2025');
        expect(analysisPrompt).toContain('- Time: around 13:10-13:20');
        expect(analysisPrompt).toContain('- Location: Germany > Berlin > Cafe');
    });
});

describe('shouldInvalidateSmartContextPreWarm', () => {
    it('returns false when there are no memory changes', () => {
        expect(shouldInvalidateSmartContextPreWarm({
            factsCreated: 0,
            trackersUpdated: 0,
            sceneArchived: false,
            arcsCreated: 0,
            arcsUpdated: 0,
            arcsResolved: 0,
        })).toBe(false);
    });

    it('returns true when facts were created', () => {
        expect(shouldInvalidateSmartContextPreWarm({
            factsCreated: 1,
            trackersUpdated: 0,
            sceneArchived: false,
            arcsCreated: 0,
            arcsUpdated: 0,
            arcsResolved: 0,
        })).toBe(true);
    });

    it('returns true when trackers were updated', () => {
        expect(shouldInvalidateSmartContextPreWarm({
            factsCreated: 0,
            trackersUpdated: 1,
            sceneArchived: false,
            arcsCreated: 0,
            arcsUpdated: 0,
            arcsResolved: 0,
        })).toBe(true);
    });

    it('returns true when a scene was archived', () => {
        expect(shouldInvalidateSmartContextPreWarm({
            factsCreated: 0,
            trackersUpdated: 0,
            sceneArchived: true,
            arcsCreated: 0,
            arcsUpdated: 0,
            arcsResolved: 0,
        })).toBe(true);
    });

    it('returns true when arc state changed', () => {
        expect(shouldInvalidateSmartContextPreWarm({
            factsCreated: 0,
            trackersUpdated: 0,
            sceneArchived: false,
            arcsCreated: 0,
            arcsUpdated: 1,
            arcsResolved: 0,
        })).toBe(true);
    });
});

describe('refreshSmartContextAfterPostTurn', () => {
    it('rewarms without invalidation when no memory changed', async () => {
        refreshSmartContextAfterPostTurn({
            factsCreated: 0,
            trackersUpdated: 0,
            sceneArchived: false,
            arcsCreated: 0,
            arcsUpdated: 0,
            arcsResolved: 0,
        });

        await Promise.resolve();

        expect(invalidatePreWarmCache).not.toHaveBeenCalled();
        expect(preWarmSmartContext).toHaveBeenCalledTimes(1);
    });

    it('invalidates before rewarming when memory changed', async () => {
        refreshSmartContextAfterPostTurn({
            factsCreated: 0,
            trackersUpdated: 1,
            sceneArchived: false,
            arcsCreated: 0,
            arcsUpdated: 0,
            arcsResolved: 0,
        });

        await Promise.resolve();

        expect(invalidatePreWarmCache).toHaveBeenCalledTimes(1);
        expect(preWarmSmartContext).toHaveBeenCalledTimes(1);

        const invalidateOrder = invalidatePreWarmCache.mock.invocationCallOrder[0];
        const prewarmOrder = preWarmSmartContext.mock.invocationCallOrder[0];
        expect(invalidateOrder).toBeLessThan(prewarmOrder);
    });
});
