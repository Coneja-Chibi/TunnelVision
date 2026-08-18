/* @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Host context + heavy local deps mocked so we can exercise the retrieval
// prompt in isolation and assert what the sidecar actually gets told.
vi.mock('../../../st-context.js', () => ({ getContext: vi.fn() }));
vi.mock('../../../../script.js', () => ({
    setExtensionPrompt: vi.fn(),
    extension_prompt_types: { IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 },
    extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
}));
vi.mock('../../../world-info.js', () => ({ loadWorldInfo: vi.fn(async () => ({ entries: {} })) }));
vi.mock('../tree-store.js', () => ({
    getTree: vi.fn(() => ({ root: { id: 'root', label: 'Root', children: [] } })),
    findNodeById: vi.fn(() => null),
    getAllEntryUids: vi.fn(() => []),
    getSettings: vi.fn(() => ({ sidecarAutoRetrieval: true, sidecarContextMessages: 10, conditionalTriggersEnabled: false })),
    isNativeInjectionBook: vi.fn(() => false),
}));
vi.mock('../tool-registry.js', () => ({ getReadableBooks: vi.fn(() => ['Book']) }));
vi.mock('../conditions.js', () => ({
    hasEvaluableConditions: vi.fn(() => false),
    separateConditions: vi.fn(() => ({ conditions: [], keywords: [] })),
    mapSelectiveLogic: vi.fn(() => 'AND_ANY'),
    describeSelectiveLogic: vi.fn(() => ''),
    rollKeywordProbability: vi.fn(() => true),
    formatCondition: vi.fn(() => ''),
    CONDITION_DESCRIPTIONS: {},
    CONDITION_LABELS: {},
}));
vi.mock('../llm-sidecar.js', () => ({
    isSidecarConfigured: vi.fn(() => true),
    isCircuitOpen: vi.fn(() => false),
    sidecarGenerate: vi.fn(async () => 'NODES: none'),
    getSidecarModelLabel: vi.fn(() => 'test-model'),
    beginRetrievalScope: vi.fn(),
    endRetrievalScope: vi.fn(),
}));
vi.mock('../activity-feed.js', () => ({
    logSidecarRetrieval: vi.fn(),
    logConditionalEvaluations: vi.fn(),
    setSidecarActive: vi.fn(),
}));
vi.mock('../index.js', () => ({ getKeywordTriggeredUids: vi.fn(() => []) }));
vi.mock('../agent-utils.js', () => ({
    applyBackgroundPromptAddendum: vi.fn(s => s),
    buildLanguageDirective: vi.fn(() => ''),
}));

const { getContext } = await import('../../../st-context.js');
const { sidecarGenerate } = await import('../llm-sidecar.js');
const { runSidecarRetrieval } = await import('../sidecar-retrieval.js');

/** Chat where the tail is an assistant reply the user is about to swipe away. */
const CHAT = [
    { is_user: true, is_system: false, mes: 'user question here' },
    { is_user: false, is_system: false, mes: 'REJECTED SWIPE TEXT' },
];

/** @returns {string} the prompt handed to the sidecar LLM */
function promptSentToSidecar() {
    return sidecarGenerate.mock.calls.at(-1)[0].prompt;
}

describe('sidecar retrieval — swipe tail handling', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getContext.mockReturnValue({ chat: CHAT });
    });

    it('excludes the rejected response from the prompt on a swipe', async () => {
        await runSidecarRetrieval('swipe');

        const prompt = promptSentToSidecar();
        expect(prompt).not.toContain('REJECTED SWIPE TEXT');
        expect(prompt).toContain('user question here');
    });

    it('includes the tail message on a normal generation', async () => {
        await runSidecarRetrieval('normal');

        expect(promptSentToSidecar()).toContain('REJECTED SWIPE TEXT');
    });

    it('does not run at all when a swipe leaves no usable context', async () => {
        getContext.mockReturnValue({ chat: [{ is_user: false, is_system: false, mes: 'only message' }] });

        await runSidecarRetrieval('swipe');

        expect(sidecarGenerate).not.toHaveBeenCalled();
    });
});
