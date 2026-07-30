/**
 * TunnelVision — collapse summarized messages behind their summary.
 *
 * When a summary is created, the messages it covers are hidden with
 * hideChatMessageRange(), which sets `is_system = true`. That removes them from
 * the prompt (script.js builds `coreChat` by filtering `is_system` out) while
 * leaving them nearly unchanged on screen.
 *
 * The message BODY renders identically to a live one, and deliberately so:
 * script.js forces isSystem = false for anything whose ch_name is not the
 * system user, under the comment "Let hidden messages have markdown". The only
 * difference is driven off the .mes element's is_system="true" attribute — the
 * avatar picks up opacity 0.9 and grayscale(25%), and the hover buttons swap
 * .mes_hide for .mes_unhide plus .mes_ghost.
 *
 * A quarter-desaturated avatar and a changed hover button are easy to miss
 * across a long chat, so in practice the chat looks untouched while a large
 * part of it has silently left the model's context.
 *
 * That divergence is the whole problem: what you see stops matching what the
 * model sees. This module closes it by folding each summarized range into a
 * toggle attached to its summary marker, so the chat visibly pares down to the
 * essentials and the hidden text is still one click away.
 *
 * Only ranges owned by a summary marker are collapsed. Messages hidden by hand
 * (/hide) are left exactly as they are — this does not take over ST's own
 * hiding.
 */

import { eventSource, event_types, updateViewMessageIds } from '../../../../script.js';
import { getContext } from '../../../st-context.js';

const STYLE_ID = 'tv-summary-collapse-style';
const COLLAPSED_CLASS = 'tv-collapsed';
const TOGGLE_CLASS = 'tv-summary-toggle';

/** Marker message ids whose range the user has expanded. Reset per chat. */
let expanded = new Set();

let _initialized = false;

export function initSummaryCollapse() {
    if (_initialized) return;
    _initialized = true;

    injectStyle();

    const reapply = () => { try { applyCollapse(); } catch (e) { console.error('[TunnelVision] collapse failed:', e); } };

    if (event_types.CHAT_CHANGED) {
        eventSource.on(event_types.CHAT_CHANGED, () => { expanded = new Set(); reapply(); });
    }
    for (const evt of ['CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MESSAGE_DELETED', 'MESSAGE_UPDATED', 'MORE_MESSAGES_LOADED']) {
        if (event_types[evt]) eventSource.on(event_types[evt], reapply);
    }

    // Messages are re-rendered in ways that do not always emit an event
    // (scroll-back, swipe redraw). A cheap periodic reconcile keeps the view
    // honest without hooking ST's rendering internals.
    setInterval(reapply, 2000);
}

function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        .mes.${COLLAPSED_CLASS} { display: none !important; }
        .${TOGGLE_CLASS} {
            display: inline-block;
            margin-top: 6px;
            padding: 2px 8px;
            border: 1px solid var(--SmartThemeBorderColor, rgba(128,128,128,0.4));
            border-radius: 10px;
            font-size: 0.85em;
            opacity: 0.75;
            cursor: pointer;
            user-select: none;
        }
        .${TOGGLE_CLASS}:hover { opacity: 1; }
    `;
    document.head.appendChild(style);
}

/**
 * The range of messages a summary marker stands in for.
 *
 * Prefers the range recorded on the marker at creation. Summaries created
 * before that was recorded — and any created by the tool path, which does its
 * hiding separately — fall back to "the unbroken run of hidden messages
 * immediately above the marker", which is what a summary+hide always produces.
 *
 * @returns {{start:number,end:number}|null}
 */
function getRange(chat, markerId) {
    const message = chat[markerId];
    if (!message?.extra?.tunnelvision_summary) return null;

    const r = message.extra.tv_hidden_range;
    if (r) {
        const start = Number(r.start);
        const end = Number(r.end);
        if (Number.isFinite(start) && Number.isFinite(end) && start <= end) return { start, end };
    }

    // Fallback: walk back over the contiguous hidden run above the marker.
    let end = -1;
    let j = markerId - 1;
    while (j >= 1 && chat[j]?.is_system && !chat[j]?.extra?.tunnelvision_summary) {
        if (end < 0) end = j;
        j--;
    }
    if (end < 0) return null;
    return { start: j + 1, end };
}

/**
 * Reconcile the DOM with the collapse state implied by the chat array.
 */
export function applyCollapse() {
    const context = getContext();
    const chat = context?.chat;
    if (!Array.isArray(chat)) return;

    // Any message covered by a summary range that is not expanded gets collapsed.
    const shouldCollapse = new Set();

    for (let i = 0; i < chat.length; i++) {
        const range = getRange(chat, i);
        if (!range) continue;

        const isExpanded = expanded.has(i);
        if (!isExpanded) {
            for (let j = range.start; j <= range.end; j++) {
                // Only collapse what is actually hidden — if the user unhid a
                // message by hand, respect that and leave it visible.
                //
                // ...and never collapse ANOTHER summary's marker. A marker is
                // is_system, so it matches the test above, but its own toggle is
                // rendered on it: collapsing it hides the only control that could
                // expand that summary, leaving it unreachable.
                //
                // Every range after the first contains the previous marker, by
                // arithmetic rather than by chance: hideEnd is window.end - 1, so
                // one message is always left visible as a live tail and the marker
                // lands at hideEnd + 2, while the next window starts at
                // watermark + 1 = hideEnd + 1 — one index before it.
                if (chat[j]?.is_system && !chat[j]?.extra?.tunnelvision_summary) {
                    shouldCollapse.add(j);
                }
            }
        }
        renderToggle(i, range, isExpanded);
    }

    document.querySelectorAll('#chat .mes').forEach((el) => {
        const id = Number(el.getAttribute('mesid'));
        if (!Number.isFinite(id)) return;
        el.classList.toggle(COLLAPSED_CLASS, shouldCollapse.has(id));
    });
}

/**
 * Post a summary marker into the chat, standing in for the range it replaced.
 *
 * Lives here rather than in summary-runner so that BOTH summary paths can use
 * it without an import cycle — the interval/slash-command path and the tool
 * path used by the sidecar writer. A summary that hides messages without
 * posting a marker leaves orphaned hidden messages: gone from the model's
 * context, still on screen, with nothing explaining where they went.
 *
 * ⚠️ Posted as a SYSTEM message on purpose. SillyTavern excludes is_system
 * messages from the prompt (script.js builds coreChat by filtering them out),
 * and the summary already reaches context through its constant lorebook entry.
 * A normal message would put the same text in the prompt twice.
 *
 * @param {string} title
 * @param {string} summaryText
 * @param {{start:number,end:number}|null} [hiddenRange]
 */
export async function postSummaryMarker(title, summaryText, hiddenRange) {
    try {
        const context = getContext();
        if (typeof context.addOneMessage !== 'function') return;

        const message = {
            name: 'TunnelVision',
            is_user: false,
            is_system: true,
            send_date: Date.now(),
            mes: `📝 **${String(title).replace(/^\[Summary\]\s*/, '')}**\n\n${summaryText}`,
            extra: {
                isSmallSys: true,
                tunnelvision_summary: true,
                tv_hidden_range: hiddenRange || undefined,
            },
        };

        // Place the marker immediately after the range it stands in for, not at
        // the end of the chat.
        //
        // Summarising deliberately leaves the newest messages alone, and those
        // are correctly still visible — they are the live scene. But appending
        // the marker put it BELOW them, so the chat read
        // [collapsed range][live messages][summary]: a summary arriving after
        // messages it does not cover, which looks like the sweep missed them.
        // Inserting after the range gives [collapsed range][summary][live
        // messages] — the summary, then the scene continuing from it.
        //
        // Safe for the index-based ranges: everything already recorded (previous
        // ranges, the watermark) is <= hiddenRange.end, so only the kept-recent
        // tail shifts, and nothing refers to it by index.
        const insertAt = hiddenRange && Number.isFinite(hiddenRange.end)
            ? hiddenRange.end + 1
            : context.chat.length;

        if (insertAt < context.chat.length) {
            context.chat.splice(insertAt, 0, message);
            await context.addOneMessage(message, { insertAfter: hiddenRange.end });
            // ⚠️ REQUIRED after a mid-chat insert. addOneMessage puts the element
            // in the right place but does not renumber the ones after it, so
            // every following .mes keeps a mesid that is now one too low —
            // duplicates at the insertion point, gaps at the end. Anything that
            // maps DOM to chat by mesid (this module's collapse, ST's own edit,
            // swipe and delete) then acts on the wrong message.
            updateViewMessageIds();
        } else {
            context.chat.push(message);
            await context.addOneMessage(message);
        }
        await context.saveChat?.();
        applyCollapse();
    } catch (e) {
        console.error('[TunnelVision] Failed to post summary marker to chat:', e);
    }
}

/** Put (or refresh) the toggle control on a summary marker message. */
function renderToggle(markerId, range, isExpanded) {
    const block = document.querySelector(`#chat .mes[mesid="${markerId}"]`);
    if (!block) return;

    const host = block.querySelector('.mes_text') || block;
    let toggle = block.querySelector(`.${TOGGLE_CLASS}`);

    if (!toggle) {
        toggle = document.createElement('div');
        toggle.className = TOGGLE_CLASS;
        toggle.addEventListener('click', () => {
            if (expanded.has(markerId)) expanded.delete(markerId);
            else expanded.add(markerId);
            applyCollapse();
        });
        host.appendChild(toggle);
    }

    // Count what actually collapses, not the raw span: a previous summary's
    // marker can sit inside this range and is deliberately never collapsed, so
    // the span would overstate the number by one per marker it contains.
    const chat = getContext()?.chat;
    let count = 0;
    for (let j = range.start; j <= range.end; j++) {
        if (chat?.[j]?.is_system && !chat[j]?.extra?.tunnelvision_summary) count++;
    }

    toggle.textContent = isExpanded
        ? `▾ hide ${count} summarized messages`
        : `▸ show ${count} hidden messages`;
}
