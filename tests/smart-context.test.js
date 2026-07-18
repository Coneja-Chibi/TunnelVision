import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockMetadata = {};
const mockChat = [];
const mockState = {
    activeBooks: [],
    cachedWorldInfoCalls: [],
    cachedWorldInfoSyncByBook: new Map(),
    settings: {
        smartContextEnabled: true,
        globalEnabled: true,
        smartContextLookback: 6,
    },
    maxContextTokens: 0,
};

function makeEntry(overrides = {}) {
    return {
        uid: 1,
        comment: 'Elena',
        key: ['elena'],
        content: 'Elena trained at the Grand Cathedral.',
        disable: false,
        ...overrides,
    };
}

// Mock internal dependencies with complex transitive imports
vi.mock('../tool-registry.js', () => ({
    getActiveTunnelVisionBooks: vi.fn(() => mockState.activeBooks),
}));
vi.mock('../entry-manager.js', () => ({
    getCachedWorldInfoSync: vi.fn((book) => mockState.cachedWorldInfoSyncByBook.get(book) || null),
    getCachedWorldInfo: vi.fn(async (book) => {
        mockState.cachedWorldInfoCalls.push(book);
        return mockState.cachedWorldInfoSyncByBook.get(book) || null;
    }),
}));
vi.mock('../world-state.js', () => ({
    getWorldStateSections: vi.fn(() => ({})),
}));
vi.mock('../arc-tracker.js', () => ({
    getActiveArcs: vi.fn(() => []),
}));
vi.mock('../background-events.js', () => ({
    addBackgroundEvent: vi.fn(),
    addEntryActivationEvents: vi.fn(),
}));
vi.mock('../tree-store.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        getSettings: vi.fn(() => mockState.settings),
    };
});
// Override the st-context mock for this file so we can control chatMetadata
vi.mock('../../../st-context.js', () => ({
    getContext: () => ({
        chatId: 'test-chat',
        chat: mockChat,
        chatMetadata: mockMetadata,
        saveMetadataDebounced: vi.fn(),
    }),
}));

import { scoreEntry, getFeedbackMap, processRelevanceFeedback, invalidatePreWarmCache, computeEntryTier, TIER_HOT, TIER_WARM, TIER_COLD, buildSmartContextPrompt, preWarmSmartContext } from '../smart-context.js';
import { addBackgroundEvent, addEntryActivationEvents } from '../background-events.js';

beforeEach(() => {
    // Reset state between tests
    for (const key of Object.keys(mockMetadata)) delete mockMetadata[key];
    invalidatePreWarmCache();
    mockChat.length = 0;
    mockState.activeBooks = [];
    mockState.cachedWorldInfoCalls = [];
    mockState.cachedWorldInfoSyncByBook = new Map();
    mockState.settings = {
        smartContextEnabled: true,
        globalEnabled: true,
        smartContextLookback: 6,
    };
    vi.mocked(addBackgroundEvent).mockClear();
    vi.mocked(addEntryActivationEvents).mockClear();
});

// ── scoreEntry ───────────────────────────────────────────────────

describe('scoreEntry', () => {
    it('returns 0 for empty recentText', () => {
        const entry = { comment: 'Elena', key: ['elena', 'hair'] };
        expect(scoreEntry(entry, '')).toBe(0);
    });

    it('returns 0 for null recentText', () => {
        const entry = { comment: 'Elena', key: ['elena'] };
        expect(scoreEntry(entry, null)).toBe(0);
    });

    it('scores +10 when entry title appears in recentText', () => {
        const entry = { comment: 'Elena', key: [] };
        expect(scoreEntry(entry, 'elena went to the market')).toBe(10);
    });

    it('scores +3 per matching key', () => {
        const entry = { comment: '', key: ['sword', 'shield'] };
        expect(scoreEntry(entry, 'she drew her sword and shield')).toBe(6);
    });

    it('combines title and key scores', () => {
        const entry = { comment: 'Elena', key: ['elena', 'magic'] };
        expect(scoreEntry(entry, 'elena used magic')).toBe(16);
    });

    it('ignores keys shorter than 2 characters', () => {
        const entry = { comment: '', key: ['a', 'x', 'bow'] };
        expect(scoreEntry(entry, 'a x bow and arrow')).toBe(3);
    });

    it('returns 0 when nothing matches', () => {
        const entry = { comment: 'Elena', key: ['sword'] };
        expect(scoreEntry(entry, 'the weather was nice')).toBe(0);
    });

    it('handles entry with no comment and no keys', () => {
        const entry = { comment: '', key: [] };
        expect(scoreEntry(entry, 'anything at all')).toBe(0);
    });

    it('handles entry with missing key array', () => {
        const entry = { comment: 'test' };
        expect(scoreEntry(entry, 'test entry')).toBe(10);
    });

    // ── 1A: Semantic key expansion (derived alias keys) ──

    it('gives +2 for a proper noun phrase derived from content first sentence', () => {
        const entry = {
            comment: 'Elena',
            key: [],
            uid: 1,
            content: 'Elena trained at the Grand Cathedral under Master Aldric.',
        };
        // "grand cathedral" is a proper noun phrase derived from the first sentence
        expect(scoreEntry(entry, 'they arrived at the grand cathedral')).toBeGreaterThanOrEqual(2);
    });

    it('gives +2 for a role descriptor derived from content first sentence', () => {
        const entry = {
            comment: 'Kael',
            key: [],
            uid: 2,
            content: 'Kael is a wandering merchant who travels between villages.',
        };
        // "wandering merchant" is a role descriptor ("a wandering merchant who...")
        expect(scoreEntry(entry, 'a wandering merchant appeared at the gate')).toBeGreaterThanOrEqual(2);
    });

    it('gives +2 for a capitalized word derived from content (not first word)', () => {
        const entry = {
            comment: '',
            key: [],
            uid: 3,
            content: 'The artifact was forged by Aldric in the old forge.',
        };
        // "aldric" is a capitalized word in the first sentence (not the first word)
        expect(scoreEntry(entry, 'aldric appeared from nowhere')).toBeGreaterThanOrEqual(2);
    });

    it('stacks derived alias score with title and key scores', () => {
        const entry = {
            comment: 'Elena',
            key: ['magic'],
            uid: 4,
            content: 'Elena is a powerful sorceress who commands fire.',
        };
        // title "elena" => +10, key "magic" => +3, derived "powerful sorceress" => +2
        const score = scoreEntry(entry, 'elena used magic, the powerful sorceress');
        expect(score).toBeGreaterThanOrEqual(15);
    });

    it('does not derive keys from entries with empty content', () => {
        const entry = { comment: '', key: [], uid: 5, content: '' };
        expect(scoreEntry(entry, 'anything at all')).toBe(0);
    });

    it('derives multiple alias keys from a rich first sentence', () => {
        const entry = {
            comment: '',
            key: [],
            uid: 6,
            content: 'Lord Varen is a reclusive nobleman who rules over Stonereach Keep.',
        };
        // Should derive "lord varen" (proper noun phrase), "varen" (capitalized), "stonereach keep" (proper noun phrase)
        // and "reclusive nobleman" (role descriptor)
        const score1 = scoreEntry(entry, 'lord varen was displeased');
        const score2 = scoreEntry(entry, 'the reclusive nobleman retreated');
        expect(score1).toBeGreaterThanOrEqual(2);
        expect(score2).toBeGreaterThanOrEqual(2);
    });

    it('does not give alias bonus for short derived keys under 3 chars', () => {
        const entry = {
            comment: '',
            key: [],
            uid: 7,
            content: 'A. B. Smith is an old man who lives nearby.',
        };
        // Single-letter words should not be derived as alias keys
        expect(scoreEntry(entry, 'a b')).toBe(0);
    });

    it('caches derived keys across calls (second call uses cache)', () => {
        const entry = {
            comment: '',
            key: [],
            uid: 8,
            content: 'Captain Thorne patrols the northern border.',
        };
        const score1 = scoreEntry(entry, 'thorne was spotted');
        const score2 = scoreEntry(entry, 'thorne returned');
        expect(score1).toBe(score2);
        expect(score1).toBeGreaterThanOrEqual(2);
    });

    // ── presentKeySet fast path (2D perf optimization) ──

    it('produces same score with presentKeySet as without for title match', () => {
        const entry = { comment: 'Elena', key: [], uid: 20 };
        const text = 'elena went to the market';
        const keySet = new Set(['elena']);
        expect(scoreEntry(entry, text, keySet)).toBe(scoreEntry(entry, text));
    });

    it('produces same score with presentKeySet as without for key matches', () => {
        const entry = { comment: '', key: ['sword', 'shield'], uid: 21 };
        const text = 'she drew her sword and shield';
        const keySet = new Set(['sword', 'shield']);
        expect(scoreEntry(entry, text, keySet)).toBe(scoreEntry(entry, text));
    });

    it('produces same combined score with presentKeySet as without', () => {
        const entry = { comment: 'Elena', key: ['elena', 'magic'], uid: 22 };
        const text = 'elena used magic';
        const keySet = new Set(['elena', 'magic']);
        expect(scoreEntry(entry, text, keySet)).toBe(scoreEntry(entry, text));
    });

    it('returns 0 via presentKeySet when keys are absent from the set', () => {
        const entry = { comment: 'Elena', key: ['sword'], uid: 23 };
        const emptySet = new Set();
        expect(scoreEntry(entry, 'elena used a sword', emptySet)).toBe(0);
    });

    it('scores partial matches correctly via presentKeySet', () => {
        const entry = { comment: 'Elena', key: ['sword', 'shield'], uid: 24 };
        const keySet = new Set(['elena', 'sword']);
        // title match (+10) + sword (+3) but not shield
        expect(scoreEntry(entry, 'elena sword shield', keySet)).toBe(13);
    });

    it('handles presentKeySet with derived alias keys', () => {
        const entry = {
            comment: '',
            key: [],
            uid: 25,
            content: 'Lord Varen is a reclusive nobleman who rules over Stonereach.',
        };
        const text = 'lord varen sent a message';
        const withoutSet = scoreEntry(entry, text);
        // Build a set that includes the derived key
        const keySet = new Set(['lord varen']);
        const withSet = scoreEntry(entry, text, keySet);
        // Both should detect "lord varen" as a derived proper noun phrase
        expect(withoutSet).toBeGreaterThanOrEqual(2);
        expect(withSet).toBeGreaterThanOrEqual(2);
    });
});

// ── getFeedbackMap ───────────────────────────────────────────────

describe('getFeedbackMap', () => {
    it('returns empty object when no feedback exists', () => {
        expect(getFeedbackMap()).toEqual({});
    });

    it('returns stored feedback data', () => {
        mockMetadata.tunnelvision_feedback = { '42': { injections: 3, references: 1, missStreak: 0, lastReferenced: 100 } };
        const map = getFeedbackMap();
        expect(map['42'].injections).toBe(3);
        expect(map['42'].references).toBe(1);
    });
});

// ── processRelevanceFeedback ─────────────────────────────────────

describe('processRelevanceFeedback', () => {
    it('does nothing when _lastInjectedEntries is empty (no prior injection)', () => {
        mockChat.push({ is_user: true, mes: 'Hello' });
        mockChat.push({ is_user: false, mes: 'Hi there' });

        processRelevanceFeedback();
        expect(getFeedbackMap()).toEqual({});
    });
});

// ── computeEntryTier ─────────────────────────────────────────────

describe('computeEntryTier', () => {
    const baseOpts = {
        isTracker: false,
        isSummary: false,
        feedbackMap: {},
        relevanceMap: {},
        chatLength: 200,
        maxUid: 1000,
        arcOverlap: 0,
    };

    it('classifies trackers as hot', () => {
        const entry = { uid: 500 };
        expect(computeEntryTier(entry, { ...baseOpts, isTracker: true })).toBe(TIER_HOT);
    });

    it('classifies recently referenced entries as hot', () => {
        const entry = { uid: 500 };
        const opts = {
            ...baseOpts,
            feedbackMap: { 500: { lastReferenced: Date.now() - 30 * 60 * 1000, injections: 1, references: 1 } },
        };
        expect(computeEntryTier(entry, opts)).toBe(TIER_HOT);
    });

    it('classifies arc-overlapping recently seen entries as hot', () => {
        const entry = { uid: 500 };
        const opts = {
            ...baseOpts,
            relevanceMap: { 500: Date.now() - 3 * 60 * 60 * 1000 },
            arcOverlap: 4,
        };
        expect(computeEntryTier(entry, opts)).toBe(TIER_HOT);
    });

    it('classifies recently created entries as warm', () => {
        const entry = { uid: 950 };
        expect(computeEntryTier(entry, baseOpts)).toBe(TIER_WARM);
    });

    it('classifies entries with recent feedback as warm', () => {
        const entry = { uid: 100 };
        const opts = {
            ...baseOpts,
            feedbackMap: { 100: { lastReferenced: Date.now() - 6 * 60 * 60 * 1000, injections: 5, references: 3 } },
        };
        expect(computeEntryTier(entry, opts)).toBe(TIER_WARM);
    });

    it('classifies old entries with no engagement as cold', () => {
        const entry = { uid: 50 };
        expect(computeEntryTier(entry, baseOpts)).toBe(TIER_COLD);
    });

    it('classifies old entries with poor reference rate as cold', () => {
        const entry = { uid: 50 };
        const opts = {
            ...baseOpts,
            feedbackMap: { 50: { lastReferenced: Date.now() - 48 * 60 * 60 * 1000, injections: 10, references: 1 } },
        };
        expect(computeEntryTier(entry, opts)).toBe(TIER_COLD);
    });
});

// ── invalidatePreWarmCache ───────────────────────────────────────

describe('invalidatePreWarmCache', () => {
    it('is callable and does not throw', () => {
        expect(() => invalidatePreWarmCache()).not.toThrow();
    });

    it('can be called multiple times without error', () => {
        invalidatePreWarmCache();
        expect(() => invalidatePreWarmCache()).not.toThrow();
    });
});

describe('dynamic budget behavior', () => {
    it('builds a smart-context prompt when no context window is available and candidates exist', () => {
        mockState.maxContextTokens = 0;
        mockState.settings.smartContextMaxChars = 4321;
        mockState.activeBooks = ['Lorebook A'];
        mockState.cachedWorldInfoSyncByBook.set('Lorebook A', {
            entries: {
                1: makeEntry({
                    uid: 10,
                    comment: 'Harbor',
                    key: ['harbor'],
                    content: 'Harbor notes.',
                }),
            },
        });
        mockChat.push(
            { is_user: true, mes: 'Tell me about the harbor.' },
            { is_user: false, mes: 'The harbor is quiet tonight.' },
        );

        const prompt = buildSmartContextPrompt();

        expect(prompt).toContain('[TunnelVision Smart Context');
        expect(prompt).toContain('Harbor');
        expect(prompt).toContain('Lorebook A');
    });

    it('returns a prompt that favors stronger matches when there are only a few high-confidence candidates', () => {
        mockState.maxContextTokens = 10000;
        mockState.settings.smartContextMaxChars = 4000;
        mockState.settings.smartContextMaxEntries = 10;
        mockState.activeBooks = ['Lorebook A'];
        mockState.cachedWorldInfoSyncByBook.set('Lorebook A', {
            entries: {
                1: makeEntry({
                    uid: 10,
                    comment: 'Harbor',
                    key: ['harbor'],
                    content: 'H'.repeat(2000),
                }),
                2: makeEntry({
                    uid: 11,
                    comment: 'Garden',
                    key: ['garden'],
                    content: 'G'.repeat(2000),
                }),
                3: makeEntry({
                    uid: 12,
                    comment: 'Archive',
                    key: ['archive'],
                    content: 'A'.repeat(2000),
                }),
            },
        });
        mockChat.push(
            { is_user: true, mes: 'The harbor is calm tonight.' },
            { is_user: false, mes: 'We should remain quiet.' },
        );

        const prompt = buildSmartContextPrompt();

        expect(prompt).toContain('[TunnelVision Smart Context');
        expect(prompt).toContain('Harbor');
    });

    it('returns multiple relevant entries when many candidates strongly match the chat', () => {
        mockState.maxContextTokens = 10000;
        mockState.settings.smartContextMaxChars = 4000;
        mockState.settings.smartContextMaxEntries = 10;
        mockState.activeBooks = ['Lorebook A'];
        mockState.cachedWorldInfoSyncByBook.set('Lorebook A', {
            entries: {
                1: makeEntry({
                    uid: 10,
                    comment: 'Harbor',
                    key: ['harbor'],
                    content: 'H'.repeat(1200),
                }),
                2: makeEntry({
                    uid: 11,
                    comment: 'Garden',
                    key: ['garden'],
                    content: 'G'.repeat(1200),
                }),
                3: makeEntry({
                    uid: 12,
                    comment: 'Archive',
                    key: ['archive'],
                    content: 'A'.repeat(1200),
                }),
                4: makeEntry({
                    uid: 13,
                    comment: 'Tower',
                    key: ['tower'],
                    content: 'T'.repeat(1200),
                }),
                5: makeEntry({
                    uid: 14,
                    comment: 'Forge',
                    key: ['forge'],
                    content: 'F'.repeat(1200),
                }),
            },
        });
        mockChat.push(
            { is_user: true, mes: 'We moved from the harbor to the garden, archive, tower, and forge.' },
            { is_user: false, mes: 'All five locations matter right now.' },
        );

        const prompt = buildSmartContextPrompt();

        expect(prompt).toContain('[TunnelVision Smart Context');
        expect(prompt).toContain('Lorebook A');
        expect(prompt).toMatch(/UID \d+/);
    });

    it('produces a prompt for both downtime and combat scenes, with combat not shorter than downtime for the same candidates', () => {
        mockState.maxContextTokens = 10000;
        mockState.settings.smartContextMaxChars = 4000;
        mockState.settings.smartContextMaxEntries = 10;
        mockState.activeBooks = ['Lorebook A'];
        mockState.cachedWorldInfoSyncByBook.set('Lorebook A', {
            entries: {
                1: makeEntry({
                    uid: 10,
                    comment: 'Harbor',
                    key: ['harbor'],
                    content: 'H'.repeat(1400),
                }),
                2: makeEntry({
                    uid: 11,
                    comment: 'Garden',
                    key: ['garden'],
                    content: 'G'.repeat(1400),
                }),
                3: makeEntry({
                    uid: 12,
                    comment: 'Archive',
                    key: ['archive'],
                    content: 'A'.repeat(1400),
                }),
                4: makeEntry({
                    uid: 13,
                    comment: 'Tower',
                    key: ['tower'],
                    content: 'T'.repeat(1400),
                }),
                5: makeEntry({
                    uid: 14,
                    comment: 'Forge',
                    key: ['forge'],
                    content: 'F'.repeat(1400),
                }),
            },
        });

        mockChat.push(
            { is_user: true, mes: 'We rest quietly at the harbor and speak softly in the garden, archive, tower, and forge.' },
            { is_user: false, mes: 'This is a calm rest scene with conversation and reflection.' },
        );
        const downtimePrompt = buildSmartContextPrompt();

        mockChat.length = 0;
        mockChat.push(
            { is_user: true, mes: 'We fight at the harbor and battle through the garden, archive, tower, and forge.' },
            { is_user: false, mes: 'The combat is fierce and violent in every location.' },
        );
        const combatPrompt = buildSmartContextPrompt();

        expect(downtimePrompt).toContain('[TunnelVision Smart Context');
        expect(combatPrompt).toContain('[TunnelVision Smart Context');
        expect(combatPrompt.length).toBeGreaterThanOrEqual(downtimePrompt.length);
    });
});

describe('preWarmSmartContext', () => {
    it('loads world info asynchronously so current-turn prompt can use cached data', async () => {
        mockState.activeBooks = ['Book A'];
        mockChat.push(
            { is_user: true, mes: 'Tell me about Elena and the cathedral.' },
            { is_user: false, mes: 'Elena heads toward the Grand Cathedral.' },
        );

        mockState.cachedWorldInfoSyncByBook.set('Book A', {
            entries: {
                1: makeEntry(),
            },
        });

        await preWarmSmartContext();

        expect(mockState.cachedWorldInfoCalls).toEqual(['Book A']);
        expect(addBackgroundEvent).toHaveBeenCalledTimes(1);
        expect(addBackgroundEvent).toHaveBeenCalledWith(expect.objectContaining({
            verb: 'Pre-warmed',
            preWarmSource: 'smart-context',
            relatedEntries: expect.arrayContaining([
                expect.objectContaining({ title: 'Elena' }),
            ]),
        }));

        const prompt = buildSmartContextPrompt();
        expect(prompt).toContain('Elena');
        expect(prompt).toContain('Grand Cathedral');
    });

    it('invalidates a prewarmed cache when the last message content changes', async () => {
        mockState.activeBooks = ['Book A'];
        mockState.cachedWorldInfoSyncByBook.set('Book A', {
            entries: {
                1: makeEntry(),
            },
        });

        mockChat.push(
            { is_user: true, mes: 'Tell me about Elena.' },
            { is_user: false, mes: 'Elena heads toward the Grand Cathedral.' },
        );

        await preWarmSmartContext();
        expect(mockState.cachedWorldInfoCalls).toEqual(['Book A']);

        mockState.cachedWorldInfoCalls = [];
        mockChat[mockChat.length - 1] = {
            is_user: false,
            mes: 'Completely unrelated reply about the weather.',
        };

        await preWarmSmartContext();

        expect(mockState.cachedWorldInfoCalls).toEqual(['Book A']);
    });

    it('reuses a prewarmed cache when the last message is unchanged', async () => {
        mockState.activeBooks = ['Book A'];
        mockState.cachedWorldInfoSyncByBook.set('Book A', {
            entries: {
                1: makeEntry(),
            },
        });

        mockChat.push(
            { is_user: true, mes: 'Tell me about Elena.' },
            { is_user: false, mes: 'Elena heads toward the Grand Cathedral.' },
        );

        await preWarmSmartContext();
        expect(mockState.cachedWorldInfoCalls).toEqual(['Book A']);
        expect(addBackgroundEvent).toHaveBeenCalledTimes(1);

        mockState.cachedWorldInfoCalls = [];
        vi.mocked(addBackgroundEvent).mockClear();

        await preWarmSmartContext();

        expect(mockState.cachedWorldInfoCalls).toEqual([]);
        expect(addBackgroundEvent).not.toHaveBeenCalled();
    });

    it('keeps a prewarmed cache after prompt build when chat is unchanged', async () => {
        mockState.activeBooks = ['Book A'];
        mockState.cachedWorldInfoSyncByBook.set('Book A', {
            entries: {
                1: makeEntry(),
            },
        });

        mockChat.push(
            { is_user: true, mes: 'Tell me about Elena.' },
            { is_user: false, mes: 'Elena heads toward the Grand Cathedral.' },
        );

        await preWarmSmartContext();
        expect(mockState.cachedWorldInfoCalls).toEqual(['Book A']);

        const prompt = buildSmartContextPrompt();
        expect(prompt).toContain('Elena');

        mockState.cachedWorldInfoCalls = [];
        vi.mocked(addBackgroundEvent).mockClear();

        await preWarmSmartContext();

        expect(mockState.cachedWorldInfoCalls).toEqual([]);
        expect(addBackgroundEvent).not.toHaveBeenCalled();
    });

    it('refreshes prewarm when lookback settings change', async () => {
        mockState.activeBooks = ['Book A'];
        mockState.cachedWorldInfoSyncByBook.set('Book A', {
            entries: {
                1: makeEntry(),
            },
        });

        mockChat.push(
            { is_user: true, mes: 'Tell me about Elena.' },
            { is_user: false, mes: 'Elena heads toward the Grand Cathedral.' },
        );

        await preWarmSmartContext();
        expect(mockState.cachedWorldInfoCalls).toEqual(['Book A']);

        mockState.cachedWorldInfoCalls = [];
        mockState.settings.smartContextLookback = 10;

        await preWarmSmartContext();

        expect(mockState.cachedWorldInfoCalls).toEqual(['Book A']);
    });

    it('refreshes prewarm after cache age expires', async () => {
        vi.useFakeTimers();
        try {
            mockState.activeBooks = ['Book A'];
            mockState.cachedWorldInfoSyncByBook.set('Book A', {
                entries: {
                    1: makeEntry(),
                },
            });

            mockChat.push(
                { is_user: true, mes: 'Tell me about Elena.' },
                { is_user: false, mes: 'Elena heads toward the Grand Cathedral.' },
            );

            await preWarmSmartContext();
            expect(mockState.cachedWorldInfoCalls).toEqual(['Book A']);

            mockState.cachedWorldInfoCalls = [];
            vi.advanceTimersByTime(5 * 60 * 1000 + 1);

            await preWarmSmartContext();

            expect(mockState.cachedWorldInfoCalls).toEqual(['Book A']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('marks explicitly fact-driven prewarms with distinct event metadata', async () => {
        mockState.activeBooks = ['Book A'];
        mockChat.push(
            { is_user: true, mes: 'Tell me about Elena.' },
            { is_user: false, mes: 'Elena heads toward the Grand Cathedral.' },
        );

        mockState.cachedWorldInfoSyncByBook.set('Book A', {
            entries: {
                1: makeEntry(),
            },
        });

        await preWarmSmartContext({ source: 'fact-driven' });

        expect(addBackgroundEvent).toHaveBeenCalledWith(expect.objectContaining({
            icon: 'fa-brain',
            color: '#e84393',
            preWarmSource: 'fact-driven',
        }));

        vi.mocked(addEntryActivationEvents).mockClear();

        const prompt = buildSmartContextPrompt();

        expect(prompt).toContain('Elena');
        expect(addEntryActivationEvents).toHaveBeenCalledWith(expect.arrayContaining([
            expect.objectContaining({
                source: 'fact-driven',
                title: 'Elena',
            }),
        ]));
    });

    it('skips prewarm when smart context is disabled', async () => {
        mockState.settings = {
            ...mockState.settings,
            smartContextEnabled: false,
        };
        mockState.activeBooks = ['Book A'];
        mockChat.push(
            { is_user: true, mes: 'Tell me about Elena.' },
            { is_user: false, mes: 'Elena remembers the cathedral.' },
        );

        await preWarmSmartContext();

        expect(mockState.cachedWorldInfoCalls).toEqual([]);
    });
});

describe('secret guard', () => {
    it('prepends the guard when an injected entry is tagged [SECRET]', () => {
        mockState.maxContextTokens = 0;
        mockState.activeBooks = ['Lorebook A'];
        mockState.cachedWorldInfoSyncByBook.set('Lorebook A', {
            entries: {
                1: makeEntry({
                    uid: 10,
                    comment: 'Elena heritage',
                    key: ['elena'],
                    content: '[SECRET — Elena is unaware] Elena is the lost heir.',
                }),
            },
        });
        mockChat.push(
            { is_user: true, mes: 'Tell me about Elena.' },
            { is_user: false, mes: 'Elena trains hard.' },
        );

        const prompt = buildSmartContextPrompt();

        expect(prompt).toContain('narrator-only dramatic irony');
        expect(prompt).toContain('[TunnelVision Smart Context');
    });

    it('omits the guard when no injected entry is tagged', () => {
        mockState.maxContextTokens = 0;
        mockState.activeBooks = ['Lorebook A'];
        mockState.cachedWorldInfoSyncByBook.set('Lorebook A', {
            entries: {
                1: makeEntry({
                    uid: 11,
                    comment: 'Elena heritage',
                    key: ['elena'],
                    content: 'Elena is the lost heir.',
                }),
            },
        });
        mockChat.push(
            { is_user: true, mes: 'Tell me about Elena.' },
            { is_user: false, mes: 'Elena trains hard.' },
        );

        const prompt = buildSmartContextPrompt();

        expect(prompt).toContain('[TunnelVision Smart Context');
        expect(prompt).not.toContain('narrator-only dramatic irony');
    });
});
