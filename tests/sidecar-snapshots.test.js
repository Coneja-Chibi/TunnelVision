import { describe, it, expect, beforeEach, vi } from 'vitest';

// Host context + heavy local deps mocked so we can exercise snapshot
// persistence/hydration in isolation.
vi.mock('../../../st-context.js', () => ({ getContext: vi.fn() }));
vi.mock('../../../world-info.js', () => ({
    loadWorldInfo: vi.fn(),
    saveWorldInfo: vi.fn(),
    deleteWorldInfoEntry: vi.fn(),
    deleteWIOriginalDataValue: vi.fn(),
}));
vi.mock('../tree-store.js', () => ({
    getTree: vi.fn(() => null),
    saveTree: vi.fn(),
    removeEntryFromTree: vi.fn(),
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
    getActiveTunnelVisionBooks: vi.fn(() => ['Book']),
    checkToolConfirmation: vi.fn(),
    resolveTargetBook: vi.fn(() => ({ book: null })),
    REMEMBER_NAME: 'remember',
    UPDATE_NAME: 'update',
    FORGET_NAME: 'forget',
    SUMMARIZE_NAME: 'summarize',
    REORGANIZE_NAME: 'reorganize',
    MERGESPLIT_NAME: 'mergesplit',
}));
vi.mock('../llm-sidecar.js', () => ({
    isSidecarConfigured: vi.fn(() => false),
    isCircuitOpen: vi.fn(() => false),
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
import { deleteWorldInfoEntry, loadWorldInfo, saveWorldInfo } from '../../../world-info.js';
import { logSnapshotRevert } from '../activity-feed.js';
import { resolveTargetBook } from '../tool-registry.js';
import {
    cleanInvalidSidecarMemories,
    excludeStaticWriteOps,
    executeWriteOps,
    hydrateSnapshots,
    revertInvalidSnapshots,
    revertMessageSnapshots,
} from '../sidecar-writer.js';
import {
    CHAT_ID_METADATA_KEY,
    MESSAGE_ID_FIELD,
    getLegacyMessageFingerprint,
    getMessageFingerprint,
    makeSnapshotKey,
    makeTrackerKey,
} from '../message-identity.js';

const SNAP_KEY = 'tunnelvision_snapshots';

function makeContext(metadata, chat = []) {
    return {
        chatId: 'chat-1',
        chat,
        chatMetadata: metadata,
        saveMetadataDebounced: vi.fn(),
        saveChat: vi.fn(async () => {}),
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
        await hydrateSnapshots();

        const result = await revertMessageSnapshots('5', '42_Hello');

        expect(result).toBe(true);
        expect(logSnapshotRevert).toHaveBeenCalledTimes(1);
        // Snapshot consumed and persisted back out of metadata.
        expect(ctx.chatMetadata[SNAP_KEY][key]).toBeUndefined();
        expect(ctx.saveMetadataDebounced).toHaveBeenCalled();
    });

    it('returns false when no snapshot exists for the message', async () => {
        getContext.mockReturnValue(makeContext({}));

        await hydrateSnapshots(); // clears the in-memory map from empty metadata

        const result = await revertMessageSnapshots('99', 'missing');

        expect(result).toBe(false);
        expect(logSnapshotRevert).not.toHaveBeenCalled();
    });

    it('reverts only the deleted message snapshot after indexes shift', async () => {
        const first = { [MESSAGE_ID_FIELD]: 'tvmsg_first', mes: 'first message' };
        const deleted = { [MESSAGE_ID_FIELD]: 'tvmsg_deleted', mes: 'deleted message' };
        const later = { [MESSAGE_ID_FIELD]: 'tvmsg_later', mes: 'later message' };
        const firstKey = makeSnapshotKey(first[MESSAGE_ID_FIELD], getMessageFingerprint(first));
        const deletedKey = makeSnapshotKey(deleted[MESSAGE_ID_FIELD], getMessageFingerprint(deleted));
        const laterKey = makeSnapshotKey(later[MESSAGE_ID_FIELD], getMessageFingerprint(later));
        const metadata = {
            [SNAP_KEY]: {
                [firstKey]: { createdUids: [], modifiedEntries: {}, treeState: {} },
                [deletedKey]: { createdUids: [], modifiedEntries: {}, treeState: {} },
                [laterKey]: { createdUids: [], modifiedEntries: {}, treeState: {} },
            },
        };
        const ctx = makeContext(metadata, [first, later]);
        getContext.mockReturnValue(ctx);

        await hydrateSnapshots();
        await revertInvalidSnapshots();

        expect(ctx.chatMetadata[SNAP_KEY][firstKey]).toBeDefined();
        expect(ctx.chatMetadata[SNAP_KEY][laterKey]).toBeDefined();
        expect(ctx.chatMetadata[SNAP_KEY][deletedKey]).toBeUndefined();
        expect(logSnapshotRevert).toHaveBeenCalledTimes(1);
    });

    it('reverts a snapshot when its source message is swiped', async () => {
        const sourceId = 'tvmsg_swipe';
        const oldFingerprint = getMessageFingerprint('old response');
        const key = makeSnapshotKey(sourceId, oldFingerprint);
        const ctx = makeContext({
            [SNAP_KEY]: {
                [key]: { createdUids: [], modifiedEntries: {}, treeState: {} },
            },
        }, [{ [MESSAGE_ID_FIELD]: sourceId, mes: 'new response' }]);
        getContext.mockReturnValue(ctx);

        await hydrateSnapshots();
        await revertInvalidSnapshots();

        expect(ctx.chatMetadata[SNAP_KEY][key]).toBeUndefined();
        expect(logSnapshotRevert).toHaveBeenCalledTimes(1);
    });

    it('migrates shifted legacy snapshots instead of reverting unrelated ones', async () => {
        const first = { mes: 'first legacy message' };
        const deletedText = 'deleted legacy message';
        const later = { mes: 'later legacy message' };
        const firstLegacyKey = `0:${getLegacyMessageFingerprint(first)}`;
        const deletedLegacyKey = `1:${getLegacyMessageFingerprint(deletedText)}`;
        const laterLegacyKey = `2:${getLegacyMessageFingerprint(later)}`;
        const ctx = makeContext({
            [SNAP_KEY]: {
                [firstLegacyKey]: { createdUids: [], modifiedEntries: {}, treeState: {} },
                [deletedLegacyKey]: { createdUids: [], modifiedEntries: {}, treeState: {} },
                [laterLegacyKey]: { createdUids: [], modifiedEntries: {}, treeState: {} },
            },
        }, [first, later]);
        getContext.mockReturnValue(ctx);

        await hydrateSnapshots();
        await revertInvalidSnapshots();

        const remainingKeys = Object.keys(ctx.chatMetadata[SNAP_KEY]);
        expect(remainingKeys).toHaveLength(2);
        expect(remainingKeys.every(key => key.startsWith('v2:tvmsg_'))).toBe(true);
        expect(remainingKeys.some(key => key.endsWith(getMessageFingerprint(first)))).toBe(true);
        expect(remainingKeys.some(key => key.endsWith(getMessageFingerprint(later)))).toBe(true);
        expect(logSnapshotRevert).toHaveBeenCalledTimes(1);
        expect(ctx.saveChat).toHaveBeenCalled();
    });

    it('keeps ambiguous duplicate-content legacy snapshots rather than deleting data', async () => {
        const message = { mes: 'duplicate text' };
        const key = `99:${getLegacyMessageFingerprint(message)}`;
        const ctx = makeContext({
            [SNAP_KEY]: {
                [key]: { createdUids: [], modifiedEntries: {}, treeState: {} },
            },
        }, [message, { mes: message.mes }]);
        getContext.mockReturnValue(ctx);

        await hydrateSnapshots();
        await revertInvalidSnapshots();

        expect(ctx.chatMetadata[SNAP_KEY][key]).toBeDefined();
        expect(logSnapshotRevert).not.toHaveBeenCalled();
    });
});

describe('sidecar tracker cleanup', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('deletes only memories whose stable source message is gone', async () => {
        const chatId = 'tvchat_cleanup';
        const kept = { [MESSAGE_ID_FIELD]: 'tvmsg_kept', mes: 'kept source' };
        const bookData = {
            entries: {
                kept: {
                    uid: 1,
                    comment: 'Keep me',
                    key: [makeTrackerKey(chatId, kept[MESSAGE_ID_FIELD], getMessageFingerprint(kept))],
                },
                gone: {
                    uid: 2,
                    comment: 'Delete me',
                    key: [makeTrackerKey(chatId, 'tvmsg_gone', getMessageFingerprint('gone source'))],
                },
            },
        };
        loadWorldInfo.mockResolvedValue(bookData);
        getContext.mockReturnValue(makeContext({ [CHAT_ID_METADATA_KEY]: chatId }, [kept]));

        await cleanInvalidSidecarMemories();

        expect(deleteWorldInfoEntry).toHaveBeenCalledTimes(1);
        expect(deleteWorldInfoEntry).toHaveBeenCalledWith(bookData, 2, { silent: true });
        expect(saveWorldInfo).toHaveBeenCalledTimes(1);
    });

    it('migrates a shifted legacy tracker to a stable message identity', async () => {
        const chatId = 'tvchat_migration';
        const source = { mes: 'source after an earlier deletion' };
        const legacyTracker = `!tv_tracker:8:${getLegacyMessageFingerprint(source)}`;
        const entry = { uid: 3, comment: 'Migrated memory', key: [legacyTracker] };
        const bookData = { entries: { entry }, originalData: { entries: [{ ...entry, key: [...entry.key] }] } };
        const ctx = makeContext({ [CHAT_ID_METADATA_KEY]: chatId }, [{ mes: 'other' }, source]);
        loadWorldInfo.mockResolvedValue(bookData);
        getContext.mockReturnValue(ctx);

        await cleanInvalidSidecarMemories();

        expect(deleteWorldInfoEntry).not.toHaveBeenCalled();
        expect(entry.key[0]).toMatch(/^!tv_tracker:v2:tvchat_migration:tvmsg_/);
        expect(entry.key[0]).toContain(`:${getMessageFingerprint(source)}`);
        expect(source[MESSAGE_ID_FIELD]).toMatch(/^tvmsg_/);
        expect(ctx.saveChat).toHaveBeenCalled();
        expect(saveWorldInfo).toHaveBeenCalledTimes(1);
    });

    it('never deletes a scoped memory belonging to another chat', async () => {
        const entry = {
            uid: 4,
            comment: 'Other chat memory',
            key: [makeTrackerKey('tvchat_other', 'tvmsg_other', getMessageFingerprint('not in this chat'))],
        };
        loadWorldInfo.mockResolvedValue({ entries: { entry } });
        getContext.mockReturnValue(makeContext({ [CHAT_ID_METADATA_KEY]: 'tvchat_current' }, []));

        await cleanInvalidSidecarMemories();

        expect(deleteWorldInfoEntry).not.toHaveBeenCalled();
        expect(saveWorldInfo).not.toHaveBeenCalled();
    });

    it('keeps unmatched legacy trackers because they have no chat scope', async () => {
        const entry = {
            uid: 5,
            comment: 'Possibly from another chat',
            key: [`!tv_tracker:12:${getLegacyMessageFingerprint('missing here')}`],
        };
        loadWorldInfo.mockResolvedValue({ entries: { entry } });
        getContext.mockReturnValue(makeContext({ [CHAT_ID_METADATA_KEY]: 'tvchat_current' }, []));

        await cleanInvalidSidecarMemories();

        expect(deleteWorldInfoEntry).not.toHaveBeenCalled();
        expect(saveWorldInfo).not.toHaveBeenCalled();
    });
});

describe('sidecar static-entry protection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('filters every destructive operation targeting a static entry before tool actions run', async () => {
        loadWorldInfo.mockResolvedValue({
            entries: {
                static: { uid: 7, comment: 'Canon', constant: true, content: 'Do not rewrite.' },
                mutable: { uid: 8, comment: 'Notes', constant: false, content: 'Can evolve.' },
            },
        });

        const { allowed, skipped } = await excludeStaticWriteOps([
            { type: 'update', lorebook: 'Book', uid: 7 },
            { type: 'merge', lorebook: 'Book', keep_uid: 8, remove_uid: 7 },
            { type: 'split', lorebook: 'Book', uid: 7 },
            { type: 'forget', lorebook: 'Book', uid: 7 },
            { type: 'reorganize', lorebook: 'Book', action: 'move', uid: 7 },
            { type: 'update', lorebook: 'Book', uid: 8 },
            { type: 'remember', lorebook: 'Book', title: 'New', content: 'Allowed.' },
        ]);

        expect(allowed).toEqual([
            { type: 'update', lorebook: 'Book', uid: 8 },
            { type: 'remember', lorebook: 'Book', title: 'New', content: 'Allowed.' },
        ]);
        expect(skipped).toHaveLength(5);
        expect(skipped.every(message => message.includes('static entry "Canon"'))).toBe(true);
    });
});

describe('write ops guard against a mid-run swipe', () => {
    // The sidecar call between capturing `origin` and committing takes seconds.
    // A swipe in that window replaces the message text and runs its revert pass
    // before the writer returns, so committing afterwards would strand entries
    // keyed to a fingerprint nothing can revert.
    function originFor(message) {
        return {
            chatId: 'tvchat_1',
            messageId: message[MESSAGE_ID_FIELD],
            fingerprint: getMessageFingerprint(message),
        };
    }

    const OPS = [{ type: 'remember', lorebook: 'Book', title: 'T', content: 'C', keys: ['k'] }];

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('discards the writes when the source message changed mid-run', async () => {
        const message = { [MESSAGE_ID_FIELD]: 'tvmsg_swiped', mes: 'original response' };
        const origin = originFor(message);

        // The swipe: same message object and identity, new text.
        message.mes = 'the swiped-to response';
        getContext.mockReturnValue(makeContext({}, [message]));

        const result = await executeWriteOps(OPS, '', origin);

        expect(result.succeeded).toBe(0);
        expect(result.skipped).toBe(OPS.length);
        expect(loadWorldInfo).not.toHaveBeenCalled();
        expect(saveWorldInfo).not.toHaveBeenCalled();
    });

    it('proceeds past the guard when the source message is unchanged', async () => {
        const message = { [MESSAGE_ID_FIELD]: 'tvmsg_intact', mes: 'original response' };
        getContext.mockReturnValue(makeContext({}, [message]));
        resolveTargetBook.mockReturnValue({ book: 'Book' });

        // Downstream tool definitions are stubbed in this file, so the call throws
        // once it gets past snapshotting. Reaching loadWorldInfo is the assertion.
        await executeWriteOps(OPS, '', originFor(message)).catch(() => {});

        expect(loadWorldInfo).toHaveBeenCalled();
    });
});
