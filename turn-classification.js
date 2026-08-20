/**
 * Whether a message explicitly starts an out-of-character turn.
 *
 * The marker is case-insensitive and may be wrapped in the usual chat
 * decorations — `(OOC: ...)`, `((OOC: ...))`, `[OOC: ...]`, `<OOC> ...`,
 * `**OOC** ...` — so leading brackets and emphasis are skipped.
 *
 * It must still be the complete first word: "OOCly" does not match, and
 * neither does a bare `[ ... ]` or `(( ... ))` with no OOC marker inside.
 * Those brackets are widely used for action beats and sound effects mid-scene,
 * so treating them as OOC would suppress memory writes on ordinary roleplay.
 *
 * @param {*} text
 * @returns {boolean}
 */
export function isOocMessage(text) {
    return /^[\s(\[<*]*OOC\b/i.test(String(text ?? ''));
}

/**
 * Whether the latest user-authored message in a chat starts with OOC.
 * Searching backwards keeps the result stable after the assistant response is
 * appended and during regenerate/swipe generation paths.
 *
 * @param {Array<Object>} chat
 * @returns {boolean}
 */
export function isOocUserTurn(chat) {
    if (!Array.isArray(chat)) return false;

    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (message?.is_user === true) {
            return isOocMessage(message.mes);
        }
    }

    return false;
}

/**
 * Whether the current generation belongs to an OOC user turn. SillyTavern
 * emits GENERATION_STARTED before moving normal user input from the textarea
 * into the chat array, so both sources must be checked.
 *
 * @param {Array<Object>} chat
 * @param {*} pendingUserInput
 * @returns {boolean}
 */
export function isOocTurn(chat, pendingUserInput = '') {
    return isOocMessage(pendingUserInput) || isOocUserTurn(chat);
}

/**
 * TunnelVision_Search only reads the lorebook, so it stays available on an OOC
 * turn — answering "how old is she again?" is exactly what it is for. Every
 * other TunnelVision tool mutates stored memory.
 */
const OOC_SAFE_TOOLS = new Set(['TunnelVision_Search']);

/**
 * Remove TunnelVision's *writing* function definitions from one chat-completion
 * request, leaving the read-only ones plus any tool registered by SillyTavern or
 * another extension.
 *
 * @param {Object} data
 * @returns {number} number of removed TunnelVision tools
 */
export function suppressTunnelVisionWriteTools(data) {
    if (!data || typeof data !== 'object') return 0;

    const tools = Array.isArray(data.tools) ? data.tools : [];
    const remaining = tools.filter(tool => {
        const name = String(tool?.function?.name || tool?.name || '');
        return !name.startsWith('TunnelVision_') || OOC_SAFE_TOOLS.has(name);
    });
    const removed = tools.length - remaining.length;

    if (remaining.length > 0) data.tools = remaining;
    else delete data.tools;

    const chosenName = String(data.tool_choice?.function?.name || data.tool_choice?.name || '');
    const chosenRemoved = chosenName.startsWith('TunnelVision_') && !OOC_SAFE_TOOLS.has(chosenName);
    if (chosenRemoved || (!data.tools && data.tool_choice === 'required')) {
        data.tool_choice = data.tools ? 'auto' : 'none';
    }

    return removed;
}

/**
 * Generation types that must never trigger the post-generation sidecar writer.
 *
 * `swipe` is deliberately NOT here. MESSAGE_RECEIVED reverts the previous
 * response's lorebook writes on a swipe (revertInvalidSnapshots), so skipping
 * the writer too left that turn with no memory at all — swiping to a response
 * you like is exactly when you want the *new* response memorized.
 *
 * `regenerate` stays skipped: unlike swipe it gets no revert pass, so running
 * the writer there would stack new memories on top of the old response's.
 */
const NON_WRITER_GENERATION_TYPES = new Set([
    'continue',
    'appendFinal',
    'first_message',
    'command',
    'extension',
    'regenerate',
]);

/**
 * Whether a MESSAGE_RECEIVED generation type should run the sidecar writer.
 *
 * @param {*} type
 * @returns {boolean}
 */
export function shouldRunSidecarWriter(type) {
    return !NON_WRITER_GENERATION_TYPES.has(String(type ?? ''));
}
