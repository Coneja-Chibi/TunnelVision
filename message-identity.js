/**
 * Stable message identities for sidecar snapshots and lorebook trackers.
 *
 * SillyTavern's MESSAGE_RECEIVED argument and DOM `mesid` are chat-array
 * indexes. They change when an earlier message is deleted. ChatMessage does
 * not expose a persistent `id`, so TunnelVision stores its own ID directly on
 * the message object; unknown top-level fields are preserved in chat files and
 * survive swipe data being copied into/out of `message.extra`.
 */

export const MESSAGE_ID_FIELD = 'tunnelvision_message_id';
export const CHAT_ID_METADATA_KEY = 'tunnelvision_chat_identity';
const ORIGIN_VERSION = 'v2';
const SNAPSHOT_PREFIX = `${ORIGIN_VERSION}:`;
const TRACKER_PREFIX = '!tv_tracker:';
const STABLE_ID_PREFIX = 'tvmsg_';
const CHAT_ID_PREFIX = 'tvchat_';

function createScopedId(prefix) {
    try {
        if (typeof globalThis.crypto?.randomUUID === 'function') {
            return `${prefix}${globalThis.crypto.randomUUID()}`;
        }
        if (typeof globalThis.crypto?.getRandomValues === 'function') {
            const bytes = new Uint32Array(4);
            globalThis.crypto.getRandomValues(bytes);
            return `${prefix}${Array.from(bytes, value => value.toString(16).padStart(8, '0')).join('')}`;
        }
    } catch { /* fall through to the compatibility fallback */ }

    return `${prefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

function createMessageId() {
    return createScopedId(STABLE_ID_PREFIX);
}

/** @param {unknown} value */
export function isStableMessageId(value) {
    return typeof value === 'string' && value.startsWith(STABLE_ID_PREFIX) && value.length > STABLE_ID_PREFIX.length;
}

/** @param {Object|null|undefined} message */
export function getMessageIdentity(message) {
    const value = message?.[MESSAGE_ID_FIELD];
    return isStableMessageId(value) ? value : null;
}

/** @param {Object|null|undefined} context */
export function getChatIdentity(context) {
    const value = context?.chatMetadata?.[CHAT_ID_METADATA_KEY];
    return typeof value === 'string' && value.startsWith(CHAT_ID_PREFIX) ? value : null;
}

/** Ensure tracker keys can never collide across chats sharing a lorebook. */
export function ensureChatIdentity(context) {
    if (!context?.chatMetadata || typeof context.chatMetadata !== 'object') {
        return { id: null, created: false };
    }
    const existing = getChatIdentity(context);
    if (existing) return { id: existing, created: false };

    const id = createScopedId(CHAT_ID_PREFIX);
    context.chatMetadata[CHAT_ID_METADATA_KEY] = id;
    return { id, created: true };
}

/**
 * Ensure a message carries a persistent TunnelVision identity.
 * @param {Object|null|undefined} message
 * @returns {{id: string|null, created: boolean}}
 */
export function ensureMessageIdentity(message) {
    if (!message || typeof message !== 'object') return { id: null, created: false };
    const existing = getMessageIdentity(message);
    if (existing) return { id: existing, created: false };

    const id = createMessageId();
    message[MESSAGE_ID_FIELD] = id;
    return { id, created: true };
}

/** Existing index-based tracker hash, retained only for migration. */
export function getLegacyMessageFingerprint(message) {
    const text = typeof message === 'string' ? message : message?.mes;
    return text ? `${text.length}_${text.substring(0, 100).replace(/[^\w]/g, '')}` : '0';
}

/**
 * Unicode-safe full-content fingerprint for v2 records. FNV-1a is not used as
 * a security primitive here; it is a compact change detector paired with a
 * stable random message identity.
 */
export function getMessageFingerprint(message) {
    const text = String(typeof message === 'string' ? message : message?.mes || '');
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return `f1_${text.length}_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function fingerprintForOrigin(message, origin) {
    return origin.version === 2
        ? getMessageFingerprint(message)
        : getLegacyMessageFingerprint(message);
}

/**
 * Resolve the source message identified by MESSAGE_RECEIVED. Null is used by
 * the debounced group writer and intentionally resolves to the current tail.
 */
export function resolveSourceMessage(chat, messageIndexOrId = null) {
    if (!Array.isArray(chat) || chat.length === 0) return null;

    if (typeof messageIndexOrId === 'number' && Number.isInteger(messageIndexOrId)) {
        return chat[messageIndexOrId] || null;
    }
    if (typeof messageIndexOrId === 'string') {
        const byStableId = chat.find(message => getMessageIdentity(message) === messageIndexOrId);
        if (byStableId) return byStableId;
        if (/^\d+$/.test(messageIndexOrId)) {
            return chat[Number(messageIndexOrId)] || null;
        }
    }

    return chat[chat.length - 1] || null;
}

export function makeSnapshotKey(messageId, fingerprint) {
    return `${SNAPSHOT_PREFIX}${messageId}:${fingerprint}`;
}

export function makeTrackerKey(chatId, messageId, fingerprint) {
    return `${TRACKER_PREFIX}${ORIGIN_VERSION}:${chatId}:${messageId}:${fingerprint}`;
}

function parseOriginPayload(payload) {
    const parts = String(payload || '').split(':');
    if (parts[0] === ORIGIN_VERSION && parts.length >= 3 && isStableMessageId(parts[1])) {
        return {
            version: 2,
            messageId: parts[1],
            fingerprint: parts.slice(2).join(':'),
        };
    }
    if (parts.length >= 2 && parts[0]) {
        return {
            version: 1,
            messageId: parts[0],
            fingerprint: parts.slice(1).join(':'),
        };
    }
    return null;
}

export function parseSnapshotKey(key) {
    return parseOriginPayload(key);
}

export function parseTrackerKey(key) {
    const value = String(key || '');
    if (!value.startsWith(TRACKER_PREFIX)) return null;

    const payload = value.slice(TRACKER_PREFIX.length);
    const parts = payload.split(':');
    if (parts[0] === ORIGIN_VERSION && parts.length >= 4 && parts[1].startsWith(CHAT_ID_PREFIX) && isStableMessageId(parts[2])) {
        return {
            version: 2,
            chatId: parts[1],
            messageId: parts[2],
            fingerprint: parts.slice(3).join(':'),
        };
    }
    return parseOriginPayload(payload);
}

export function parseLegacyCommentTracker(comment) {
    const match = String(comment || '').match(/\[TV_SIDECAR:([^:]+):([^\]]+)\]/);
    return match ? { version: 1, messageId: match[1], fingerprint: match[2] } : null;
}

/**
 * Match a stored origin to the current chat without risking unrelated data.
 * Legacy index records may be recovered by a unique content fingerprint after
 * indexes shift. Duplicate-content matches are deliberately "ambiguous" and
 * retained rather than guessed at or deleted.
 *
 * @returns {{status:'valid'|'invalid'|'ambiguous', message?:Object}}
 */
export function locateOriginMessage(chat, origin) {
    if (!Array.isArray(chat) || !origin?.fingerprint) return { status: 'ambiguous' };

    if (origin.version === 2) {
        const byId = chat.filter(message => getMessageIdentity(message) === origin.messageId);
        if (byId.length === 1) {
            return fingerprintForOrigin(byId[0], origin) === origin.fingerprint
                ? { status: 'valid', message: byId[0] }
                : { status: 'invalid' };
        }
        if (byId.length > 1) return { status: 'ambiguous' };

        // A fingerprint alone is not enough to transfer a stable identity to a
        // different object. If matching untagged content exists, retain the
        // record as ambiguous rather than risking a false association.
        const untaggedMatches = chat.filter(message => (
            !getMessageIdentity(message) && fingerprintForOrigin(message, origin) === origin.fingerprint
        ));
        return untaggedMatches.length > 0 ? { status: 'ambiguous' } : { status: 'invalid' };
    }

    const legacyIndex = /^\d+$/.test(origin.messageId) ? Number(origin.messageId) : null;
    if (legacyIndex !== null) {
        const direct = chat[legacyIndex];
        if (direct && fingerprintForOrigin(direct, origin) === origin.fingerprint) {
            return { status: 'valid', message: direct };
        }
    }

    const fingerprintMatches = chat.filter(message => fingerprintForOrigin(message, origin) === origin.fingerprint);
    if (fingerprintMatches.length === 1) return { status: 'valid', message: fingerprintMatches[0] };
    if (fingerprintMatches.length === 0) return { status: 'invalid' };
    return { status: 'ambiguous' };
}
