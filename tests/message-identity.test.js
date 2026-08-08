import { describe, expect, it } from 'vitest';
import {
    CHAT_ID_METADATA_KEY,
    MESSAGE_ID_FIELD,
    ensureChatIdentity,
    ensureMessageIdentity,
    getLegacyMessageFingerprint,
    getMessageFingerprint,
    locateOriginMessage,
    makeSnapshotKey,
    makeTrackerKey,
    parseSnapshotKey,
    parseTrackerKey,
    resolveSourceMessage,
} from '../message-identity.js';

describe('stable sidecar message identities', () => {
    it('stores an identity on the message instead of relying on its array index', () => {
        const message = { mes: 'Persistent source message' };
        const { id, created } = ensureMessageIdentity(message);

        expect(created).toBe(true);
        expect(message[MESSAGE_ID_FIELD]).toBe(id);
        expect(resolveSourceMessage([{ mes: 'earlier' }, message], id)).toBe(message);
    });

    it('parses versioned snapshot and tracker keys without confusing legacy indexes', () => {
        const id = 'tvmsg_1234';
        const chatId = 'tvchat_1234';
        const fingerprint = '12_HelloWorld';

        expect(parseSnapshotKey(makeSnapshotKey(id, fingerprint))).toEqual({
            version: 2,
            messageId: id,
            fingerprint,
        });
        expect(parseTrackerKey(makeTrackerKey(chatId, id, fingerprint))).toEqual({
            version: 2,
            chatId,
            messageId: id,
            fingerprint,
        });
        expect(parseSnapshotKey(`7:${fingerprint}`)).toEqual({
            version: 1,
            messageId: '7',
            fingerprint,
        });
    });

    it('recovers a shifted legacy index by a unique content fingerprint', () => {
        const source = { mes: 'The source survives an earlier deletion' };
        const origin = {
            version: 1,
            messageId: '9',
            fingerprint: getLegacyMessageFingerprint(source),
        };

        expect(locateOriginMessage([{ mes: 'other' }, source], origin)).toEqual({
            status: 'valid',
            message: source,
        });
    });

    it('does not guess when duplicate content makes a legacy record ambiguous', () => {
        const first = { mes: 'same content' };
        const second = { mes: 'same content' };
        const origin = {
            version: 1,
            messageId: '99',
            fingerprint: getLegacyMessageFingerprint(first),
        };

        expect(locateOriginMessage([first, second], origin)).toEqual({ status: 'ambiguous' });
    });

    it('invalidates a stable origin when that message is swiped', () => {
        const message = {
            [MESSAGE_ID_FIELD]: 'tvmsg_swiped',
            mes: 'replacement swipe',
        };
        const origin = {
            version: 2,
            messageId: 'tvmsg_swiped',
            fingerprint: getMessageFingerprint('original swipe'),
        };

        expect(locateOriginMessage([message], origin)).toEqual({ status: 'invalid' });
    });

    it('does not transfer a missing stable ID based on matching content alone', () => {
        const text = 'same text, but no persistent identity';
        const origin = {
            version: 2,
            messageId: 'tvmsg_missing',
            fingerprint: getMessageFingerprint(text),
        };

        expect(locateOriginMessage([{ mes: text }], origin)).toEqual({ status: 'ambiguous' });
    });

    it('detects same-length Unicode swipe changes that the legacy hash missed', () => {
        expect(getMessageFingerprint('你好世界')).not.toBe(getMessageFingerprint('再见朋友'));
        expect(getLegacyMessageFingerprint('你好世界')).toBe(getLegacyMessageFingerprint('再见朋友'));
    });

    it('persists a separate identity in chat metadata for shared-lorebook scoping', () => {
        const context = { chatMetadata: {} };
        const first = ensureChatIdentity(context);
        const second = ensureChatIdentity(context);

        expect(first.created).toBe(true);
        expect(second).toEqual({ id: first.id, created: false });
        expect(context.chatMetadata[CHAT_ID_METADATA_KEY]).toBe(first.id);
    });
});
