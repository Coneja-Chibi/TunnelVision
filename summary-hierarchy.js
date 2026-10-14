/**
 * TunnelVision Summary Hierarchy (5A)
 *
 * Implements multi-level summary rollups:
 *   Scene Summaries → Act Summaries → Story Summary
 *
 * The hierarchy reduces context budget pressure at scale:
 *   - Story Summary: always injected, gives the LLM a narrative anchor
 *   - Act Summaries: injected when relevant (warm tier)
 *   - Scene Summaries: demoted to cold once rolled up, retrievable via Search
 *
 * Rollup triggers are checked after each scene archive.
 */

import { getContext } from '../../../st-context.js';
import { SCENES_PER_ACT, ACTS_PER_STORY_UPDATE } from './constants.js';
import { generateAnalytical } from './agent-utils.js';
import { createEntry, getCachedWorldInfo, parseJsonFromLLM, buildSummaryKeys, findEntryByUid, KEYWORD_RULES, SUMMARY_STYLE_RULES } from './entry-manager.js';
import {
    getTree, saveTree, createTreeNode, addEntryToNode, findNodeById,
} from './tree-store.js';
import { ensureSummariesNode } from './tools/summarize.js';
import { addBackgroundEvent } from './background-events.js';

// ── Constants ────────────────────────────────────────────────────

const HIERARCHY_META_KEY = 'tunnelvision_summary_hierarchy';



const ACT_TITLE_PREFIX = '[Act Summary]';
const STORY_TITLE_PREFIX = '[Story Summary]';

// ── Metadata helpers ─────────────────────────────────────────────

/**
 * @typedef {Object} HierarchyState
 * @property {number} currentActNumber - Current act number (1-based)
 * @property {number[]} currentActSceneUids - UIDs of scene summaries in the current (open) act
 * @property {number[]} rolledUpSceneUids - UIDs of scene summaries already rolled into act summaries
 * @property {number[]} actSummaryUids - UIDs of act summary entries
 * @property {number|null} storySummaryUid - UID of the story summary entry
 * @property {number} lastRollupAt - Timestamp of last rollup
 */

/** @returns {HierarchyState} */
export function getHierarchyState() {
    try {
        const context = getContext();
        const stored = context.chatMetadata?.[HIERARCHY_META_KEY];
        if (stored) {
            if (!stored.rolledUpSceneUids) stored.rolledUpSceneUids = [];
            return stored;
        }
    } catch { /* metadata not available */ }
    return {
        currentActNumber: 1,
        currentActSceneUids: [],
        rolledUpSceneUids: [],
        actSummaryUids: [],
        storySummaryUid: null,
        lastRollupAt: 0,
    };
}

function saveHierarchyState(state) {
    try {
        const context = getContext();
        if (!context.chatMetadata) return;
        context.chatMetadata[HIERARCHY_META_KEY] = state;
        context.saveMetadataDebounced?.();
    } catch { /* metadata not available */ }
}

// ── Title / detection helpers ────────────────────────────────────

export function isActSummaryTitle(title) {
    return String(title || '').trim().startsWith(ACT_TITLE_PREFIX);
}

export function isStorySummaryTitle(title) {
    return String(title || '').trim().startsWith(STORY_TITLE_PREFIX);
}

export function isRolledUpSummary(title) {
    return isActSummaryTitle(title) || isStorySummaryTitle(title);
}

// ── Scene registration ───────────────────────────────────────────

/**
 * Register a newly archived scene summary. Called after archiveScene succeeds.
 * Returns true if an act rollup should be triggered.
 */
export function registerSceneSummary(uid) {
    const state = getHierarchyState();
    if (!state.currentActSceneUids.includes(uid)) {
        state.currentActSceneUids.push(uid);
    }
    saveHierarchyState(state);
    return state.currentActSceneUids.length >= SCENES_PER_ACT;
}

// ── Act Rollup ───────────────────────────────────────────────────

/**
 * Roll up the current act's scene summaries into a single act summary.
 * @param {string} bookName - Target lorebook
 * @returns {Promise<{uid: number, title: string}|null>}
 */
export async function rollupActSummary(bookName) {
    const state = getHierarchyState();
    const sceneUids = state.currentActSceneUids;
    if (sceneUids.length < 3) return null;

    const bookData = await getCachedWorldInfo(bookName);
    if (!bookData?.entries) return null;

    const sceneSummaries = [];
    for (const uid of sceneUids) {
        const entry = findEntryByUid(bookData.entries, uid);
        if (entry && !entry.disable) {
            sceneSummaries.push(entry);
        }
    }

    if (sceneSummaries.length < 3) return null;

    const actNumber = state.currentActNumber;
    const sceneTexts = sceneSummaries.map((e, i) => {
        const title = (e.comment || '').replace(/^\[(?:scene\s+)?summary\]\s*/i, '');
        return `Scene ${i + 1}: ${title}\n${e.content}`;
    }).join('\n\n---\n\n');

    const prompt = [
        `You are a narrative archivist. Below are ${sceneSummaries.length} scene summaries from Act ${actNumber} of an ongoing roleplay.`,
        'Synthesize them into a single ACT SUMMARY — a condensed narrative that replaces reading all individual scenes.',
        '',
        SUMMARY_STYLE_RULES,
        '',
        KEYWORD_RULES,
        '',
        'Respond with ONLY a JSON object (no markdown, no code fences):',
        '{',
        '  "title": "Act N: short descriptive title",',
        '  "summary": "the act summary text",',
        '  "participants": ["name1", "name2"],',
        '  "keys": ["keyword1", "location", "theme", "event"],',
        '  "significance": "moderate|major|critical",',
        '  "when_start": "in-world time of first scene",',
        '  "when_end": "in-world time of last scene"',
        '}',
        '',
        `── SCENE SUMMARIES (Act ${actNumber}) ──`,
        sceneTexts,
    ].join('\n');

    let response;
    try {
        response = await generateAnalytical({ prompt });
    } catch (e) {
        console.warn('[TunnelVision] Act rollup LLM call failed:', e);
        return null;
    }

    const parsed = parseJsonFromLLM(response);
    if (!parsed?.title || !parsed?.summary) {
        console.warn('[TunnelVision] Act rollup: LLM returned invalid JSON');
        return null;
    }

    const participants = Array.isArray(parsed.participants) ? parsed.participants : [];
    const significance = ['moderate', 'major', 'critical'].includes(parsed.significance)
        ? parsed.significance : 'major';

    const whenStart = parsed.when_start || '';
    const whenEnd = parsed.when_end || '';
    const whenLine = whenStart
        ? (whenEnd && whenEnd !== whenStart ? `When: ${whenStart} → ${whenEnd}\n` : `When: ${whenStart}\n`)
        : '';

    const content = [
        `[Act Summary — ${significance}]`,
        whenLine ? whenLine.trim() : null,
        `Participants: ${participants.join(', ') || '(unspecified)'}`,
        `Scenes: ${sceneSummaries.length}`,
        '',
        parsed.summary.trim(),
    ].filter(Boolean).join('\n');

    const keys = buildSummaryKeys(
        { ...parsed, arc: null, when: whenStart || whenEnd },
        participants,
        significance,
    );
    keys.push(`act:${actNumber}`);

    const tree = getTree(bookName);
    const summariesNodeId = ensureSummariesNode(bookName);

    // Create an "Act N" sub-node under Summaries
    const actNodeLabel = `Act ${actNumber}`;
    let actNodeId = null;
    if (tree?.root && summariesNodeId) {
        const summNode = findNodeById(tree.root, summariesNodeId);
        if (summNode) {
            const existing = (summNode.children || []).find(c => c.label === actNodeLabel);
            if (existing) {
                actNodeId = existing.id;
            } else {
                const actNode = createTreeNode(actNodeLabel, parsed.title);
                summNode.children = summNode.children || [];
                summNode.children.push(actNode);
                actNodeId = actNode.id;
            }

            // Move scene summaries into the act node
            if (actNodeId) {
                const actNode = findNodeById(tree.root, actNodeId);
                if (actNode) {
                    for (const uid of sceneUids) {
                        addEntryToNode(actNode, uid);
                    }
                }
            }

            saveTree(bookName, tree);
        }
    }

    const result = await createEntry(bookName, {
        content,
        comment: `${ACT_TITLE_PREFIX} ${parsed.title}`,
        keys,
        nodeId: actNodeId || summariesNodeId,
        background: true,
    });

    // Update hierarchy state: advance to next act
    state.rolledUpSceneUids.push(...sceneUids);
    state.actSummaryUids.push(result.uid);
    state.currentActNumber = actNumber + 1;
    state.currentActSceneUids = [];
    state.lastRollupAt = Date.now();
    saveHierarchyState(state);

    addBackgroundEvent({
        type: 'system',
        icon: 'fa-layer-group',
        color: '#6c5ce7',
        title: `Act ${actNumber} rolled up`,
        detail: `${sceneSummaries.length} scenes → "${parsed.title}"`,
    });

    console.log(`[TunnelVision] Act ${actNumber} rolled up: "${parsed.title}" (UID ${result.uid})`);
    return { uid: result.uid, title: parsed.title };
}

// ── Story Rollup ─────────────────────────────────────────────────

/**
 * Check whether a story summary update is needed and perform it.
 * Called after an act rollup. Updates (or creates) the single story summary entry.
 * @param {string} bookName
 * @returns {Promise<{uid: number, title: string}|null>}
 */
export async function rollupStorySummary(bookName) {
    const state = getHierarchyState();

    // Only update story summary every N acts (or on first act)
    if (state.actSummaryUids.length > 1 && state.actSummaryUids.length % ACTS_PER_STORY_UPDATE !== 0) {
        return null;
    }

    const bookData = await getCachedWorldInfo(bookName);
    if (!bookData?.entries) return null;

    const actSummaries = [];
    for (const uid of state.actSummaryUids) {
        const entry = findEntryByUid(bookData.entries, uid);
        if (entry && !entry.disable) actSummaries.push(entry);
    }

    if (actSummaries.length === 0) return null;

    const existingStory = state.storySummaryUid
        ? findEntryByUid(bookData.entries, state.storySummaryUid)
        : null;
    const existingStoryText = existingStory?.content || '';

    const actTexts = actSummaries.map((e, i) => {
        const title = (e.comment || '').replace(/^\[act summary\]\s*/i, '');
        return `Act ${i + 1}: ${title}\n${e.content}`;
    }).join('\n\n---\n\n');

    const updateOrCreate = existingStoryText
        ? `Below is the CURRENT story summary. Update it to incorporate the latest act(s).\n\nCURRENT STORY SUMMARY:\n${existingStoryText}\n\n`
        : '';

    const prompt = [
        'You are a narrative archivist. You maintain a running STORY SUMMARY for an ongoing roleplay.',
        'This summary is always visible to the AI — it serves as the persistent narrative anchor.',
        '',
        updateOrCreate,
        `Below are all act summaries so far (${actSummaries.length} acts):`,
        actTexts,
        '',
        'Write (or update) a comprehensive STORY SUMMARY covering the overall narrative arc, major character introductions and relationship evolution, key turning points, and current unresolved threads.',
        'Be thorough — this is the only guaranteed narrative context the AI always sees.',
        '',
        SUMMARY_STYLE_RULES,
        '',
        KEYWORD_RULES,
        '',
        'Respond with ONLY a JSON object (no markdown, no code fences):',
        '{',
        '  "title": "Story So Far: short phrase",',
        '  "summary": "the full story summary",',
        '  "participants": ["name1", "name2"],',
        '  "keys": ["keyword1", "location", "theme"],',
        '  "significance": "critical"',
        '}',
    ].join('\n');

    let response;
    try {
        response = await generateAnalytical({ prompt });
    } catch (e) {
        console.warn('[TunnelVision] Story rollup LLM call failed:', e);
        return null;
    }

    const parsed = parseJsonFromLLM(response);
    if (!parsed?.title || !parsed?.summary) {
        console.warn('[TunnelVision] Story rollup: LLM returned invalid JSON');
        return null;
    }

    const participants = Array.isArray(parsed.participants) ? parsed.participants : [];
    const content = `[Story Summary]\nParticipants: ${participants.join(', ') || '(unspecified)'}\nActs covered: ${actSummaries.length}\n\n${parsed.summary.trim()}`;

    const keys = buildSummaryKeys(
        { ...parsed, arc: null, when: null },
        participants,
        'critical',
    );
    keys.push('story-summary');

    const summariesNodeId = ensureSummariesNode(bookName);

    if (existingStory) {
        // Update existing story summary in place
        const prevContent = existingStory.content;
        const prevComment = existingStory.comment;
        const prevKey = existingStory.key;
        existingStory.content = content;
        existingStory.comment = `${STORY_TITLE_PREFIX} ${parsed.title}`;
        if (Array.isArray(keys) && keys.length > 0) {
            existingStory.key = keys;
        }
        try {
            const { saveWorldInfo } = await import('../../../world-info.js');
            await saveWorldInfo(bookName, bookData);
        } catch (e) {
            // Revert in-memory changes — the save failed so the entry object is stale
            existingStory.content = prevContent;
            existingStory.comment = prevComment;
            existingStory.key = prevKey;
            console.warn('[TunnelVision] Failed to save updated story summary:', e);
            return null;
        }

        state.lastRollupAt = Date.now();
        saveHierarchyState(state);

        addBackgroundEvent({
            type: 'system',
            icon: 'fa-book',
            color: 'var(--tv-color-primary)',
            title: 'Story summary updated',
            detail: `Covers ${actSummaries.length} act(s)`,
        });

        console.log(`[TunnelVision] Story summary updated (UID ${existingStory.uid})`);
        return { uid: existingStory.uid, title: parsed.title };
    }

    // Create new story summary
    const result = await createEntry(bookName, {
        content,
        comment: `${STORY_TITLE_PREFIX} ${parsed.title}`,
        keys,
        nodeId: summariesNodeId,
        background: true,
    });

    state.storySummaryUid = result.uid;
    state.lastRollupAt = Date.now();
    saveHierarchyState(state);

    addBackgroundEvent({
        type: 'system',
        icon: 'fa-book',
        color: 'var(--tv-color-primary)',
        title: 'Story summary created',
        detail: `"${parsed.title}" — covers ${actSummaries.length} act(s)`,
    });

    console.log(`[TunnelVision] Story summary created: "${parsed.title}" (UID ${result.uid})`);
    return { uid: result.uid, title: parsed.title };
}

// ── Orchestrator ─────────────────────────────────────────────────

let _rollupRunning = false;

/**
 * Check and perform any needed rollups after a scene archive.
 * Call this after a scene summary is successfully created.
 * Serialized via lock to prevent concurrent rollups from creating duplicates.
 * @param {string} bookName
 * @param {number} sceneSummaryUid - UID of the newly created scene summary
 */
export async function checkAndRollup(bookName, sceneSummaryUid) {
    const needsActRollup = registerSceneSummary(sceneSummaryUid);

    if (!needsActRollup) return;
    if (_rollupRunning) {
        console.log('[TunnelVision] Rollup already in progress, skipping');
        return;
    }

    _rollupRunning = true;
    try {
        const actResult = await rollupActSummary(bookName);
        if (!actResult) return;

        await rollupStorySummary(bookName);
    } finally {
        _rollupRunning = false;
    }
}

// ── Query helpers for smart-context ──────────────────────────────

/** Returns the UID of the story summary entry, or null. */
export function getStorySummaryUid() {
    return getHierarchyState().storySummaryUid;
}

/** Returns UIDs of all act summary entries. */
export function getActSummaryUids() {
    return getHierarchyState().actSummaryUids;
}

/** Returns a Set of UIDs of scene summaries already rolled into act summaries. */
export function getRolledUpSceneUids() {
    return new Set(getHierarchyState().rolledUpSceneUids);
}
