import { describe, it, expect, beforeEach, vi } from 'vitest';

// Host context + heavy local deps mocked so we can exercise snapshot
// persistence/hydration in isolation.
vi.mock('../../../st-context.js', () => ({ getContext: vi.fn() }));
vi.mock('../tree-store.js', () => ({
    getTree: vi.fn(() => null),
    saveTree: vi.fn(),
    findNodeById: vi.fn(),
    getAllEntryUids: vi.fn(() => []),
    getSettings: vi.fn(() => ({})),
}));
vi.mock('../activity-feed.js', () => ({
    logSidecarWrite: vi.fn(),
    logSnapshotRevert: vi.fn(),
}));
// Cut transitive import chains to ST-host modules not present in tests.
vi.mock('../tool-registry.js', () => ({
    getReadableBooks: vi.fn(() => []),
    getWritableBooks: vi.fn(() => []),
    getBookListWithDescriptions: vi.fn(() => ''),
    checkToolConfirmation: vi.fn(),
    REMEMBER_NAME: 'remember',
    UPDATE_NAME: 'update',
    FORGET_NAME: 'forget',
    SUMMARIZE_NAME: 'summarize',
    REORGANIZE_NAME: 'reorganize',
    MERGESPLIT_NAME: 'mergesplit',
}));
vi.mock('../llm-sidecar.js', () => ({
    isSidecarConfigured: vi.fn(() => false),
    sidecarGenerate: vi.fn(),
    getSidecarModelLabel: vi.fn(() => ''),
}));
vi.mock('../tools/remember.js', () => ({ getDefinition: vi.fn() }));
vi.mock('../tools/update.js', () => ({ getDefinition: vi.fn() }));
vi.mock('../tools/summarize.js', () => ({ getDefinition: vi.fn() }));
vi.mock('../tools/forget.js', () => ({ getDefinition: vi.fn() }));
vi.mock('../tools/reorganize.js', () => ({ getDefinition: vi.fn() }));
vi.mock('../tools/merge-split.js', () => ({ getDefinition: vi.fn() }));
vi.mock('../agent-utils.js', () => ({
    applyBackgroundPromptAddendum: vi.fn(),
    buildLanguageDirective: vi.fn(() => ''),
    trigramSimilarity: vi.fn(() => 0),
}));

import { getContext } from '../../../st-context.js';
import { logSnapshotRevert } from '../activity-feed.js';
import { hydrateSnapshots, revertMessageSnapshots } from '../sidecar-writer.js';

const SNAP_KEY = 'tunnelvision_snapshots';

function makeContext(metadata) {
    return {
        chatId: 'chat-1',
        chat: [],
        chatMetadata: metadata,
        saveMetadataDebounced: vi.fn(),
    };
}

describe('sidecar snapshot persistence', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('reverts a snapshot rehydrated from chat metadata (simulates reload)', async () => {
        const key = '5:42_Hello';
        const ctx = makeContext({
            [SNAP_KEY]: {
                [key]: { createdUids: [], modifiedEntries: {}, treeState: {} },
            },
        });
        getContext.mockReturnValue(ctx);

        // Reload: in-memory map is empty until hydrate pulls it from metadata.
        hydrateSnapshots();

        const result = await revertMessageSnapshots('5', '42_Hello');

        expect(result).toBe(true);
        expect(logSnapshotRevert).toHaveBeenCalledTimes(1);
        // Snapshot consumed and persisted back out of metadata.
        expect(ctx.chatMetadata[SNAP_KEY][key]).toBeUndefined();
        expect(ctx.saveMetadataDebounced).toHaveBeenCalled();
    });

    it('returns false when no snapshot exists for the message', async () => {
        getContext.mockReturnValue(makeContext({}));

        hydrateSnapshots(); // clears the in-memory map from empty metadata

        const result = await revertMessageSnapshots('99', 'missing');

        expect(result).toBe(false);
        expect(logSnapshotRevert).not.toHaveBeenCalled();
    });
});
