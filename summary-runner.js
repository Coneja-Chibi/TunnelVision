/**
 * TunnelVision — shared summarization runner.
 *
 * ONE implementation of "summarize the recent scene", used by BOTH the
 * /tv-summarize slash command and interval auto-summary, so the two cannot
 * drift apart. Previously they were separate code paths with different bugs:
 * the slash command created entries with `keys: []` and no tree node (dead,
 * unfiled entries), and auto-summary did not summarize at all — it injected an
 * instruction telling the CHAT model to call TunnelVision_Summarize.
 *
 * ⚠️ Deliberate design point: this module NEVER depends on the host's function
 * calling. It generates the summary itself through generateAnalytical() (the
 * analytical/sidecar connection). With SillyTavern's function calling switched
 * off — a supported and commonly recommended configuration — the old
 * instruction-injection approach could never work, and the model would type
 * `TunnelVision_Summarize: "..."` into the scene as narrative text.
 */

import { getContext } from '../../../st-context.js';
import { getSettings } from './tree-store.js';
import { createEntry } from './entry-manager.js';
import { resolveTargetBook } from './tool-registry.js';
import { generateAnalytical, getStoryContext, getLanguageInstruction } from './agent-utils.js';
import {
    ensureSummariesNode,
    hideSummarizedMessages,
    getWatermark,
} from './tools/summarize.js';
import { applyCollapse } from './summary-collapse.js';

/** Hard ceiling on how many messages one summary will look at. */
const MAX_WINDOW = 200;

/**
 * Collect the messages this summary should cover.
 *
 * Unlike the old getRecentChat(), this returns the *index range* as well as the
 * text, so hiding uses a range we computed rather than a `messages_back` number
 * the model may omit (the cause of auto-hide silently no-opping).
 *
 * The window starts after the last summary watermark so consecutive summaries
 * do not re-cover the same messages.
 *
 * @param {number} fallbackCount How far back to look when no watermark is set.
 * @returns {{ text: string, start: number, end: number, visibleCount: number }|null}
 */
function collectChatWindow(fallbackCount) {
    const context = getContext();
    const chat = context?.chat;
    if (!chat || chat.length === 0) return null;

    const lastIndex = chat.length - 1;
    const watermark = getWatermark();

    let start = watermark >= 0
        ? watermark + 1
        : Math.max(0, chat.length - fallbackCount);

    // Never swallow the opening message/greeting.
    if (start < 1) start = chat.length > 1 ? 1 : 0;

    const end = Math.min(lastIndex, start + MAX_WINDOW - 1);
    if (start > end) return null;

    const lines = [];
    let visibleCount = 0;
    for (let i = start; i <= end; i++) {
        const msg = chat[i];
        if (!msg || msg.is_system) continue;
        visibleCount++;
        const name = msg.is_user ? (context.name1 || 'User') : (msg.name || context.name2 || 'AI');
        lines.push(`${name}: ${(msg.mes || '').substring(0, 600)}`);
    }

    if (visibleCount === 0) return null;
    return { text: lines.join('\n'), start, end, visibleCount };
}

/** Lenient JSON parse — the analytical model sometimes fences or prefaces its output. */
function parseJSON(text) {
    if (!text) return null;
    const stripped = String(text).replace(/```(?:json)?\s*/gi, '').replace(/```\s*/g, '').trim();
    try {
        return JSON.parse(stripped);
    } catch {
        const first = stripped.search(/[{[]/);
        if (first >= 0) {
            try { return JSON.parse(stripped.substring(first)); } catch { /* fall through */ }
        }
        return null;
    }
}

/**
 * Build the keyword set for a summary entry.
 *
 * TunnelVision's own retrieval is tree-based, so its entries do not rely on
 * SillyTavern's keyword matcher — but keys are still what makes an entry
 * findable by cross-book search, and what keeps the lorebook useful if the
 * extension is ever disabled. The slash command used to pass `keys: []`.
 * This guarantees at least one usable key.
 *
 * @param {string[]|undefined} participants
 * @param {string} title
 * @param {string} significance
 * @returns {string[]}
 */
export function buildSummaryKeys(participants, title, significance) {
    const keys = [];

    if (Array.isArray(participants)) {
        for (const p of participants) {
            const clean = String(p || '').trim();
            if (clean) keys.push(clean);
        }
    }

    // Fall back to distinctive words from the title so the entry can still fire.
    if (keys.length === 0) {
        const stop = new Set(['the', 'and', 'for', 'with', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'summary', 'scene']);
        const words = String(title || '')
            .replace(/^\[[^\]]*\]\s*/, '')
            .split(/[^A-Za-z0-9']+/)
            .map(w => w.trim())
            .filter(w => w.length > 3 && !stop.has(w.toLowerCase()));
        keys.push(...words.slice(0, 5));
    }

    keys.push(`summary:${significance}`);
    return [...new Set(keys)];
}

/**
 * Run one summarization pass.
 *
 * @param {Object} opts
 * @param {string} [opts.titleHint] Optional steer for the title.
 * @param {string} [opts.source] 'command' | 'auto' — for logging only.
 * @param {boolean} [opts.hide] Hide the summarized range afterwards. Default: follow autoHideSummarized.
 * @param {boolean} [opts.postToChat] Insert a marker message in the chat. Default: follow settings.
 * @returns {Promise<{ ok: boolean, reason?: string, title?: string, uid?: number, hidden?: string|null }>}
 */
export async function runSummary({ titleHint = '', source = 'command', hide, postToChat } = {}) {
    const settings = getSettings();

    const { book: lorebook, error } = resolveTargetBook(undefined, { checkWrite: true });
    if (error) return { ok: false, reason: error };

    const fallbackCount = Number(settings.commandContextMessages) || 50;
    const window = collectChatWindow(fallbackCount);
    if (!window) return { ok: false, reason: 'No new messages to summarize.' };

    const storyCtx = getStoryContext();
    const prompt = `${storyCtx ? storyCtx + '\n\n' : ''}Summarize the following conversation for a creative writing lorebook.
Write in third person, past tense, capturing key actions, decisions, emotional beats, and plot developments.

${titleHint ? `Topic/title hint: "${titleHint}"\n\n` : ''}RECENT CONVERSATION:
${window.text}

Return JSON:
{
  "title": "<concise descriptive title, no bracket prefix>",
  "summary": "<thorough third-person past-tense summary>${getLanguageInstruction()}",
  "participants": ["<character names involved>"],
  "significance": "minor|moderate|major|critical"
}`;

    const response = await generateAnalytical({ prompt });
    const parsed = parseJSON(response);
    if (!parsed?.title || !parsed?.summary) {
        return { ok: false, reason: 'Could not parse the summarizer response.' };
    }

    const significance = ['minor', 'moderate', 'major', 'critical'].includes(parsed.significance)
        ? parsed.significance
        : 'moderate';

    const participants = Array.isArray(parsed.participants) ? parsed.participants : [];
    const participantList = participants.length ? participants.join(', ') : '(unspecified)';
    const content = `[Scene Summary — ${significance}]\nParticipants: ${participantList}\n\n${String(parsed.summary).trim()}`;
    const title = `[Summary] ${String(parsed.title).replace(/^\[[^\]]*\]\s*/, '').trim()}`;

    // File it under the Summaries node — this also creates a minimal tree when
    // the book has none, which keeps the book visible to the sidecar writer.
    const nodeId = ensureSummariesNode(lorebook);

    let result;
    try {
        result = await createEntry(lorebook, {
            content,
            comment: title,
            keys: buildSummaryKeys(participants, parsed.title, significance),
            nodeId,
            // ⚠️ Summaries are ALWAYS-ON by design. This entry stands in for chat
            // messages that have just been hidden, so it has to be present every
            // turn — a keyword-triggered summary that fails to fire would mean the
            // scene is gone from context with nothing in its place. Being constant
            // also brings it inside isStaticEntry()'s protection, so background
            // automation will not rewrite the record of what happened.
            constant: true,
        });
    } catch (e) {
        return { ok: false, reason: `Failed to save summary: ${e.message}` };
    }

    console.log(`[TunnelVision] Summary (${source}) saved as UID ${result.uid} covering messages ${window.start}-${window.end}`);

    // Hide the summarized range FIRST, so the marker we post afterwards can
    // carry that range and collapse it in the UI. Keep the most recent message
    // visible so the scene still has a live tail to continue from.
    let hidden = null;
    let hiddenRange = null;
    const shouldHide = hide !== undefined ? hide : settings.autoHideSummarized !== false;
    if (shouldHide) {
        const hideEnd = Math.min(window.end, (getContext().chat?.length ?? 1) - 2);
        if (hideEnd >= window.start) {
            hidden = await hideSummarizedMessages(undefined, window.start, hideEnd);
            if (hidden) hiddenRange = { start: window.start, end: hideEnd };
        }
    }

    // Put a marker in the chat standing in for the scene it replaced.
    const shouldPost = postToChat !== undefined ? postToChat : settings.summaryPostToChat !== false;
    if (shouldPost) {
        await postSummaryMarker(title, String(parsed.summary).trim(), hiddenRange);
    }

    return { ok: true, title, uid: result.uid, hidden, book: lorebook };
}

/**
 * Insert the summary into the chat in place of what it covers.
 *
 * ⚠️ Posted as a SYSTEM message (is_system: true) on purpose: SillyTavern
 * excludes system messages from the prompt, and the summary already reaches
 * context through its lorebook entry. Posting it as a normal message would put
 * the same text in twice.
 */
async function postSummaryMarker(title, summaryText, hiddenRange) {
    try {
        const context = getContext();
        if (typeof context.addOneMessage !== 'function') return;

        const message = {
            name: 'TunnelVision',
            is_user: false,
            is_system: true,
            send_date: Date.now(),
            mes: `📝 **${title.replace(/^\[Summary\]\s*/, '')}**\n\n${summaryText}`,
            extra: {
                isSmallSys: true,
                tunnelvision_summary: true,
                // The range this summary stands in for. summary-collapse.js reads
                // this to fold those messages away behind a toggle, so the chat
                // visibly matches what the model actually receives.
                tv_hidden_range: hiddenRange || undefined,
            },
        };

        context.chat.push(message);
        await context.addOneMessage(message);
        await context.saveChat?.();
        applyCollapse();
    } catch (e) {
        console.error('[TunnelVision] Failed to post summary marker to chat:', e);
    }
}
