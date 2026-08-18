/**
 * Whether a message explicitly starts an out-of-character turn.
 * Leading whitespace is ignored and the marker is case-insensitive, but it
 * must be the complete first word (so "OOCly" does not match).
 *
 * @param {*} text
 * @returns {boolean}
 */
export function isOocMessage(text) {
    return /^\s*OOC\b/i.test(String(text ?? ''));
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
 * Remove TunnelVision function definitions from one chat-completion request
 * while preserving tools registered by SillyTavern or other extensions.
 *
 * @param {Object} data
 * @returns {number} number of removed TunnelVision tools
 */
export function suppressTunnelVisionTools(data) {
    if (!data || typeof data !== 'object') return 0;

    const tools = Array.isArray(data.tools) ? data.tools : [];
    const remaining = tools.filter(tool => {
        const name = tool?.function?.name || tool?.name || '';
        return !String(name).startsWith('TunnelVision_');
    });
    const removed = tools.length - remaining.length;

    if (remaining.length > 0) data.tools = remaining;
    else delete data.tools;

    const chosenName = data.tool_choice?.function?.name || data.tool_choice?.name || '';
    if (String(chosenName).startsWith('TunnelVision_') || (!data.tools && data.tool_choice === 'required')) {
        data.tool_choice = data.tools ? 'auto' : 'none';
    }

    return removed;
}
