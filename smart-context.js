/**
 * TunnelVision Smart Context (Proactive Pre-fetch)
 *
 * Automatically injects the most relevant lorebook entries into context
 * BEFORE the AI generates, based on who/what was mentioned in recent messages.
 * This supplements (or replaces) the need for the AI to call TunnelVision_Search
 * every turn — the most obvious context is already provided.
 *
 * Strategy:
 *   1. Scan recent messages for entity names matching entry titles/keys
 *   2. Include tracker entries for mentioned characters
 *   3. Respect a configurable token budget
 *   4. Format and inject via setExtensionPrompt at GENERATION_STARTED
 *
 * This runs synchronously at GENERATION_STARTED (before prompt is built),
 * so it does NOT make LLM calls — only fast local matching.
 *
 * Enhanced with:
 *   - Semantic key expansion (1A): derive alias keys from entry content
 *   - Sliding window dedup cooldown (1B): penalize recently-injected entries
 *   - Score-density budget allocation (1C): density metric for selection
 *   - Conversation phase detection (2A): adjust weights by narrative phase
 *   - Tree proximity scoring (2B): boost siblings/cousins of matched entries
 *   - Negative signal integration (2C): penalize stale/contradicted entries
 *   - Arc-aware boosting (2D): boost entries aligned with active arcs
 *   - Per-entry injection value tracking (3A): correlate with response quality
 *   - Predictive pre-warming (3B): bigram model of entity mention patterns
 *   - Dynamic budget allocation (3C): compute budget from context window
 *   - Hybrid sidecar reranking (5A): LLM reranks keyword candidates
 *   - Embedding similarity (5B): cached embeddings with cosine matching
 */

import { eventSource, event_types } from "../../../../script.js";
import { getContext } from "../../../st-context.js";
import { getSettings, getTrackerUids, getTree } from "./tree-store.js";
import { getActiveTunnelVisionBooks, getInjectionManagedBooks } from "./tool-registry.js";
import { getSelectivelyRetrievedUids } from "./tools/search.js";
import { getCachedWorldInfoSync, getCachedWorldInfo, getEntryTurnIndex } from "./entry-manager.js";
import { getEntryTitle, getMaxContextTokens } from "./agent-utils.js";
import { getWorldStateSections } from "./world-state.js";
import { getActiveArcs } from "./arc-tracker.js";
import { addBackgroundEvent, addEntryActivationEvents } from "./background-events.js";
import {
  shuffleArray,
  isActSummaryEntry,
  isStorySummaryEntry,
  isSummaryEntry,
  isTrackerEntry,
  hashString,
  SECRET_TAG_RE,
  SECRET_GUARD_LINE,
} from "./shared-utils.js";
import {
  HOT_RECENCY_MS,
  WARM_RECENCY_MS,
  COOLDOWN_WINDOW_TURNS as COOLDOWN_WINDOW,
  COOLDOWN_PENALTY_PER_TURN,
  STALE_INJECTION_THRESHOLD,
  STALE_INJECTION_PENALTY,
  DYNAMIC_BUDGET_MAX_RATIO,
  DYNAMIC_BUDGET_MIN_RATIO,
  HIGH_CONFIDENCE_SCORE_THRESHOLD,
  HIGH_CONFIDENCE_CAP,
  LOW_CONFIDENCE_BUDGET_MULTIPLIER,
  PHASE_BUDGET_MULTIPLIERS,
} from "./constants.js";

// ── Summary Hierarchy (5A) lazy accessor ─────────────────────────

let _getRolledUpSceneUids = () => new Set();
const SMART_CONTEXT_LOG_PREFIX = "[TunnelVision][SmartContext]";

/**
 * Initialize hierarchy references. Called once after module load to avoid circular imports.
 */
export function initHierarchyRefs(refs) {
  if (refs.getRolledUpSceneUids)
    _getRolledUpSceneUids = refs.getRolledUpSceneUids;
}

// ── Pre-Warming Cache ────────────────────────────────────────────

/** @type {Array|null} Pre-computed scored candidates from background pre-warm. */
let _preWarmedCandidates = null;
/** @type {string|null} Cache key for validating pre-warmed data freshness. */
let _preWarmCacheKey = null;
let _preWarmSource = "smart-context";
let _lastReportedPreWarmKey = null;
let _preWarmCachedAt = 0;
const PREWARM_CACHE_MAX_AGE_MS = 5 * 60 * 1000;

function buildPreWarmCacheKey() {
  try {
    const context = getContext();
    const settings = getSettings();
    const chat = context.chat || [];
    const chatLen = chat.length;
    const books = getActiveTunnelVisionBooks().sort().join(",");
    const settingsFingerprint = JSON.stringify({
      smartContextLookback: settings.smartContextLookback || 6,
    });

    const lastMsg = chat[chatLen - 1] || null;
    const lastMsgFingerprint = lastMsg
      ? hashString(
          JSON.stringify({
            is_user: !!lastMsg.is_user,
            name: lastMsg.name || "",
            mes: lastMsg.mes || "",
            tool_invocations:
              Array.isArray(lastMsg?.extra?.tool_invocations) &&
              lastMsg.extra.tool_invocations.length > 0,
          }),
        )
      : 0;

    return `${chatLen}:${books}:${settingsFingerprint}:${lastMsgFingerprint}`;
  } catch {
    return null;
  }
}

function isPreWarmCacheFresh(cacheKey) {
  if (!_preWarmedCandidates || _preWarmCacheKey !== cacheKey) return false;
  if (!_preWarmCachedAt) return false;
  return Date.now() - _preWarmCachedAt <= PREWARM_CACHE_MAX_AGE_MS;
}

/** Invalidate the pre-warming cache when entries change or books are modified. */
export function invalidatePreWarmCache() {
  _preWarmedCandidates = null;
  _preWarmCacheKey = null;
  _preWarmSource = "smart-context";
  _preWarmCachedAt = 0;
  _lastReportedPreWarmKey = null;
  _lastReportedInjectionKey = null;
  _derivedKeyCache.clear();
}

const RELEVANCE_KEY = "tunnelvision_relevance";
const FEEDBACK_KEY = "tunnelvision_feedback";

/** Entries injected during the most recent GENERATION_STARTED. */
let _lastInjectedEntries = [];
let _lastReportedInjectionKey = null;
let _scInitialized = false;

// ── Semantic Key Expansion (1A) ──────────────────────────────────

/** Transient cache: entry UID → derived alias keys. Cleared on invalidatePreWarmCache. */
const _derivedKeyCache = new Map();

const ROLE_DESCRIPTOR_RE =
  /\b(?:a|an|the)\s+([\w\s-]{3,30}?)(?:\s+(?:who|that|of|from|in|at|with|,|\.|\)|$))/gi;
const PROPER_NOUN_PHRASE_RE = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/g;

/**
 * Derive alias keys from an entry's content first sentence.
 * Extracts role descriptors, proper noun phrases, and standalone capitalized words.
 * @param {Object} entry - Lorebook entry
 * @returns {string[]} Lowercase alias keys
 */
function deriveAliasKeys(entry) {
  const cached = _derivedKeyCache.get(entry.uid);
  if (cached !== undefined) return cached;

  const content = (entry.content || "").trim();
  if (!content) {
    _derivedKeyCache.set(entry.uid, []);
    return [];
  }

  const firstSentenceMatch = content.match(/^[^.!?\n]+[.!?]?/);
  if (!firstSentenceMatch) {
    _derivedKeyCache.set(entry.uid, []);
    return [];
  }

  const origFirstSentence = firstSentenceMatch[0];
  const lowerFirstSentence = origFirstSentence.toLowerCase();
  const aliases = [];

  ROLE_DESCRIPTOR_RE.lastIndex = 0;
  let m;
  while ((m = ROLE_DESCRIPTOR_RE.exec(lowerFirstSentence)) !== null) {
    const role = m[1].trim();
    if (role.length >= 3 && role.split(/\s+/).length <= 4) {
      aliases.push(role);
    }
  }

  PROPER_NOUN_PHRASE_RE.lastIndex = 0;
  while ((m = PROPER_NOUN_PHRASE_RE.exec(origFirstSentence)) !== null) {
    const name = m[1].trim().toLowerCase();
    if (name.length >= 3) aliases.push(name);
  }

  const words = origFirstSentence.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const word = words[i].replace(/[^a-zA-Z]/g, "");
    if (word.length >= 3 && /^[A-Z][a-z]+$/.test(word)) {
      aliases.push(word.toLowerCase());
    }
  }

  const uniqueAliases = [...new Set(aliases)];
  _derivedKeyCache.set(entry.uid, uniqueAliases);
  return uniqueAliases;
}

// ── Tiered Memory Architecture (3A) ──────────────────────────────

export const TIER_HOT = "hot";
export const TIER_WARM = "warm";
export const TIER_COLD = "cold";


/**
 * Classify an entry into a memory tier based on its role, recency, and engagement.
 *
 * - Hot: trackers, entries referenced/injected within ~10 turns, entries linked to active arcs
 * - Warm: recently created facts (within last ~100 turns by UID), entries with recent feedback
 * - Cold: everything else (older facts, scene summaries)
 *
 * @param {Object} entry
 * @param {Object} opts
 * @param {boolean} opts.isTracker
 * @param {boolean} opts.isSummary
 * @param {Record<string, Object>} opts.feedbackMap
 * @param {Record<string, number>} opts.relevanceMap
 * @param {number} opts.chatLength
 * @param {number} opts.maxUid
 * @param {number} [opts.turnIndex]
 * @param {number} [opts.arcOverlap] - Non-zero if entry overlaps an active arc
 * @returns {'hot'|'warm'|'cold'}
 */
export function computeEntryTier(
  entry,
  {
    isTracker,
    isSummary,
    feedbackMap,
    relevanceMap,
    chatLength,
    maxUid,
    turnIndex = -1,
    arcOverlap = 0,
  },
) {
  if (isTracker) return TIER_HOT;

  // 5A: Story summary is always hot; act summaries are warm
  if (isStorySummaryEntry(entry)) return TIER_HOT;
  if (isActSummaryEntry(entry)) return TIER_WARM;

  const fb = feedbackMap?.[entry.uid];
  const lastRef = fb?.lastReferenced || 0;
  const lastSeen = relevanceMap?.[entry.uid] || 0;
  const mostRecent = Math.max(lastRef, lastSeen);
  const elapsed = mostRecent > 0 ? Date.now() - mostRecent : Infinity;

  if (elapsed < HOT_RECENCY_MS) return TIER_HOT;
  if (arcOverlap > 0 && elapsed < WARM_RECENCY_MS) return TIER_HOT;

  if (chatLength > 0 && turnIndex >= 0 && chatLength - turnIndex <= 100) {
    return TIER_WARM;
  }

  if (turnIndex < 0) {
    const uidRatio = maxUid > 0 ? entry.uid / maxUid : 1;
    const warmUidThreshold =
      chatLength > 0 ? Math.max(1 - 100 / chatLength, 0.5) : 0.8;

    if (uidRatio > warmUidThreshold) return TIER_WARM;
  }
  if (elapsed < WARM_RECENCY_MS) return TIER_WARM;
  if (
    fb &&
    fb.references > 0 &&
    fb.injections > 0 &&
    fb.references / fb.injections > 0.3
  )
    return TIER_WARM;

  return TIER_COLD;
}

const TIER_SCORE_ADJUST = {
  [TIER_HOT]: { thresholdOverride: 1, bonus: 3 },
  [TIER_WARM]: { thresholdOverride: null, bonus: 0 },
  [TIER_COLD]: { thresholdOverride: null, bonus: -5 },
};

// ── Injection Cooldown (1B) ──────────────────────────────────────

/** @type {Set<number>[]} Ring buffer of UID sets from last N turns' injections. */
const _recentInjections = [];

function cooldownPenalty(uid) {
  let penalty = 0;
  for (const turnSet of _recentInjections) {
    if (turnSet.has(uid)) penalty += COOLDOWN_PENALTY_PER_TURN;
  }
  return penalty;
}

function recordInjections(uids) {
  _recentInjections.push(new Set(uids));
  while (_recentInjections.length > COOLDOWN_WINDOW) {
    _recentInjections.shift();
  }
}

// ── Conversation Phase Detection (2A) ────────────────────────────

const PHASE_PATTERNS = {
  combat:
    /\b(attack|strike|slash|defend|dodge|block|wound|bleed|fight|battle|sword|spell|cast|charge|arrow|shield|kill|weapon|dagger|punch|kick)\b/gi,
  dialogue:
    /\b(said|asked|replied|whispered|shouted|explained|told|spoke|talked|murmured|stammered|declared|suggested|argued|agreed)\b/gi,
  exploration:
    /\b(explore|discover|travel|journey|arrive|enter|examine|inspect|investigate|search|find|open|door|cave|forest|mountain|path|road|village|city)\b/gi,
  downtime:
    /\b(rest|sleep|eat|drink|cook|read|study|practice|train|meditate|relax|bathe|dress|prepare|morning|evening|bed|home|routine)\b/gi,
  emotional:
    /\b(cry|tears|sob|laugh|embrace|hug|kiss|love|hate|grieve|mourn|comfort|console|confess|fear|angry|rage|despair|joy|happy)\b/gi,
};

/**
 * Detect the current conversation phase from recent chat text.
 * @param {string} recentText - Lowercased recent chat text
 * @returns {'combat'|'dialogue'|'exploration'|'downtime'|'emotional'}
 */
function detectConversationPhase(recentText) {
  let best = "dialogue";
  let bestCount = 0;
  for (const [phase, pattern] of Object.entries(PHASE_PATTERNS)) {
    pattern.lastIndex = 0;
    const matches = (recentText.match(pattern) || []).length;
    if (matches > bestCount) {
      bestCount = matches;
      best = phase;
    }
  }
  return best;
}

/**
 * Phase-specific boost for an entry based on its heuristic content type.
 * @param {Object} entry
 * @param {string} phase
 * @returns {number}
 */
function phaseBoost(entry, phase) {
  const weights = {
    combat: { location: 3, ability: 4, relationship: 0, lore: 1 },
    dialogue: { location: 0, ability: 0, relationship: 4, lore: 2 },
    exploration: { location: 5, ability: 1, relationship: 0, lore: 3 },
    downtime: { location: 1, ability: 0, relationship: 3, lore: 1 },
    emotional: { location: 0, ability: 0, relationship: 5, lore: 1 },
  };
  const w = weights[phase];
  if (!w) return 0;

  const text = (
    (entry.comment || "") +
    " " +
    (entry.content || "").substring(0, 300)
  ).toLowerCase();
  let boost = 0;

  if (
    /\b(location|place|city|town|forest|building|room|castle|tavern|map|region|territory)\b/.test(
      text,
    )
  )
    boost += w.location;
  if (
    /\b(ability|spell|skill|power|weapon|technique|magic|combat|strength|attack)\b/.test(
      text,
    )
  )
    boost += w.ability;
  if (
    /\b(relationship|friend|enemy|ally|lover|family|marriage|trust|bond|companion)\b/.test(
      text,
    )
  )
    boost += w.relationship;
  if (
    /\b(history|legend|prophecy|tradition|custom|law|rule|origin|ancient|lore)\b/.test(
      text,
    )
  )
    boost += w.lore;

  return boost;
}

// ── Tree Proximity Scoring (2B) ──────────────────────────────────

const TREE_PROXIMITY_TOP_K = 10;
const TREE_PROXIMITY_SAMPLE_SIZE = 50;

/**
 * Compute proximity boosts for candidates based on tree structure.
 * Entries sharing a tree node with a high-scoring entry get +4,
 * sibling nodes get +2, cousin nodes get +1.
 * Capped to top-K high scorers and a sampled subset of candidates to avoid O(H*C).
 * @param {Array} candidates - Scored candidate array
 * @param {string[]} activeBooks
 * @returns {Map<number, number>} UID → bonus score
 */
function computeTreeProximityBoosts(candidates, activeBooks) {
  const boostMap = new Map();

  for (const bookName of activeBooks) {
    const tree = getTree(bookName);
    if (!tree?.root) continue;

    const uidNodeMap = new Map();
    const nodeParentMap = new Map();
    (function walk(node, parent) {
      for (const uid of node.entryUids || []) {
        uidNodeMap.set(uid, node.id);
      }
      if (parent) nodeParentMap.set(node.id, parent.id);
      for (const child of node.children || []) walk(child, node);
    })(tree.root, null);

    const bookCandidates = candidates.filter((c) => c.bookName === bookName);

    // Cap high scorers to top-K by score
    const highScorers = bookCandidates
      .filter((c) => c.score >= 10)
      .sort((a, b) => b.score - a.score)
      .slice(0, TREE_PROXIMITY_TOP_K);

    if (highScorers.length === 0) continue;

    // Sample candidates if too many, to keep cost bounded
    let targetCandidates = bookCandidates;
    if (bookCandidates.length > TREE_PROXIMITY_SAMPLE_SIZE) {
      const highScorerUids = new Set(highScorers.map((h) => h.entry.uid));
      const rest = bookCandidates.filter(
        (c) => !highScorerUids.has(c.entry.uid),
      );
      shuffleArray(rest);
      targetCandidates = [
        ...highScorers,
        ...rest.slice(0, TREE_PROXIMITY_SAMPLE_SIZE - highScorers.length),
      ];
    }

    for (const hs of highScorers) {
      const nodeId = uidNodeMap.get(hs.entry.uid);
      if (!nodeId) continue;
      const parentId = nodeParentMap.get(nodeId);

      for (const c of targetCandidates) {
        if (c.entry.uid === hs.entry.uid) continue;
        const cNodeId = uidNodeMap.get(c.entry.uid);
        if (!cNodeId) continue;

        if (cNodeId === nodeId) {
          boostMap.set(
            c.entry.uid,
            Math.max(boostMap.get(c.entry.uid) || 0, 4),
          );
        } else if (parentId && nodeParentMap.get(cNodeId) === parentId) {
          boostMap.set(
            c.entry.uid,
            Math.max(boostMap.get(c.entry.uid) || 0, 2),
          );
        } else if (parentId) {
          const grandParentId = nodeParentMap.get(parentId);
          const cParentId = nodeParentMap.get(cNodeId);
          if (
            grandParentId &&
            cParentId &&
            nodeParentMap.get(cParentId) === grandParentId
          ) {
            boostMap.set(
              c.entry.uid,
              Math.max(boostMap.get(c.entry.uid) || 0, 1),
            );
          }
        }
      }
    }
  }

  return boostMap;
}

// ── Negative Signal Integration (2C) ─────────────────────────────

/**
 * Penalize entries flagged as stale (high injection count, zero references).
 * @param {Object} entry
 * @param {Record<string, Object>} feedbackMap
 * @returns {number} Negative penalty (0 or less)
 */
function negativeSignalPenalty(entry, feedbackMap) {
  let penalty = 0;
  const fb = feedbackMap[entry.uid];
  if (fb && fb.injections >= STALE_INJECTION_THRESHOLD && fb.references === 0) {
    penalty += STALE_INJECTION_PENALTY;
  }
  return penalty;
}

// ── Arc-Aware Boosting (2D) ──────────────────────────────────────

/** @type {Array|null} Cached active arcs for the current scoring pass. */
let _cachedActiveArcs = null;

/**
 * Boost entries whose keys/titles overlap with active narrative arcs.
 * @param {Object} entry
 * @returns {number} Bonus score
 */
function arcBoost(entry) {
  if (!_cachedActiveArcs) _cachedActiveArcs = getActiveArcs();
  const arcs = _cachedActiveArcs;
  if (arcs.length === 0) return 0;

  const title = (entry.comment || "").toLowerCase();
  const keys = (entry.key || []).map((k) => String(k).trim().toLowerCase());
  const searchable = [title, ...keys];

  let boost = 0;
  for (const arc of arcs) {
    const arcWords = (arc.title || "")
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 3);
    const arcProgression = (arc.progression || "").toLowerCase();

    for (const term of searchable) {
      if (term.length < 3) continue;
      if (arcProgression.includes(term)) {
        boost += 4;
        break;
      }
      if (arcWords.some((w) => term.includes(w) || w.includes(term))) {
        boost += 2;
        break;
      }
    }
  }

  return Math.min(boost, 10);
}

// ── Predictive Pre-Warming (3B) ──────────────────────────────────

const MENTION_HISTORY_KEY = "tunnelvision_mention_history";
/** @type {Map<string, Map<string, number>>} entityA → (entityB → co-occurrence count) */
const _bigramModel = new Map();

function buildBigramModel() {
  try {
    const history = getContext().chatMetadata?.[MENTION_HISTORY_KEY] || [];
    _bigramModel.clear();
    for (let i = 0; i < history.length - 1; i++) {
      const current = history[i];
      const next = history[i + 1];
      for (const a of current) {
        if (!_bigramModel.has(a)) _bigramModel.set(a, new Map());
        const followers = _bigramModel.get(a);
        for (const b of next) {
          followers.set(b, (followers.get(b) || 0) + 1);
        }
      }
    }
  } catch {
    /* ignore */
  }
}

/**
 * Predict which entities are likely to appear next based on current mentions.
 * @param {string[]} currentMentions
 * @returns {Map<string, number>} entity → confidence score
 */
function predictNextEntities(currentMentions) {
  const predicted = new Map();
  const mentionSet = new Set(currentMentions);
  for (const mention of currentMentions) {
    const followers = _bigramModel.get(mention);
    if (!followers) continue;
    for (const [entity, count] of followers) {
      if (!mentionSet.has(entity)) {
        predicted.set(entity, (predicted.get(entity) || 0) + count);
      }
    }
  }
  return predicted;
}

function recordMentions(mentionedKeys) {
  try {
    const context = getContext();
    if (!context.chatMetadata) return;
    const history = context.chatMetadata[MENTION_HISTORY_KEY] || [];
    history.push(mentionedKeys);
    if (history.length > 50) history.splice(0, history.length - 50);
    context.chatMetadata[MENTION_HISTORY_KEY] = history;
    context.saveMetadataDebounced?.();
  } catch {
    /* metadata not available */
  }
}

// ── Dynamic Budget Allocation (3C) ───────────────────────────────

/**
 * Compute the smart context character budget dynamically.
 * Uses available context window, candidate confidence, and conversation phase.
 * @param {Array} candidates
 * @param {Object} settings
 * @param {string} phase
 * @returns {number}
 */
function computeDynamicBudget(candidates, settings, phase) {
  const maxContextTokens = getMaxContextTokens();
  const baseBudget = settings.smartContextMaxChars || 4000;

  if (maxContextTokens <= 0) return baseBudget;

  const maxContextChars = maxContextTokens * 4;
  const dynamicMax = Math.floor(maxContextChars * DYNAMIC_BUDGET_MAX_RATIO);
  const dynamicMin = Math.floor(maxContextChars * DYNAMIC_BUDGET_MIN_RATIO);

  const highConfidence = candidates.filter((c) => c.score >= HIGH_CONFIDENCE_SCORE_THRESHOLD).length;
  if (highConfidence <= 2)
    return Math.max(dynamicMin, Math.floor(baseBudget * LOW_CONFIDENCE_BUDGET_MULTIPLIER));

  const confidenceRatio = Math.min(highConfidence / HIGH_CONFIDENCE_CAP, 1);
  let budget = dynamicMin + (dynamicMax - dynamicMin) * confidenceRatio;

  if (phase === "combat") budget *= PHASE_BUDGET_MULTIPLIERS.combat;
  else if (phase === "downtime") budget *= PHASE_BUDGET_MULTIPLIERS.downtime;

  return Math.min(Math.round(budget), baseBudget * 2, dynamicMax);
}

// ── Entity Extraction ────────────────────────────────────────────

/**
 * Extract candidate entity names from recent chat messages.
 * Uses entry titles and keys as the vocabulary to match against.
 * @param {Array} chat - Chat messages array
 * @param {number} lookback - How many messages to scan
 * @returns {string} Lowercased combined text from recent messages
 */
function extractMentionsFromChat(chat, lookback) {
  const start = Math.max(0, chat.length - lookback);
  const combinedText = [];

  for (let i = start; i < chat.length; i++) {
    const msg = chat[i];
    if (msg.is_system) continue;
    const text = (msg.mes || "").trim();
    if (text) combinedText.push(text);
  }

  return combinedText.join(" ").toLowerCase();
}

/**
 * Pre-build a Set of all known entry keys/derived-keys that appear in recentText.
 * Single O(keys * L) pass, then each scoreEntry call is O(keys) with Set.has().
 * @param {string[]} activeBooks
 * @param {string} recentText - Lowercased recent chat text
 * @returns {Set<string>} All keys present in recentText
 */
function buildPresentKeySet(activeBooks, recentText) {
  const presentKeys = new Set();
  for (const bookName of activeBooks) {
    const bookData = getCachedWorldInfoSync(bookName);
    if (!bookData?.entries) continue;
    for (const key of Object.keys(bookData.entries)) {
      const entry = bookData.entries[key];
      if (entry.disable) continue;
      const title = (entry.comment || "").trim().toLowerCase();
      if (title && title.length >= 2 && recentText.includes(title)) {
        presentKeys.add(title);
      }
      for (const k of entry.key || []) {
        const kl = String(k).trim().toLowerCase();
        if (kl.length >= 2 && recentText.includes(kl)) {
          presentKeys.add(kl);
        }
      }
      for (const dk of deriveAliasKeys(entry)) {
        if (dk.length >= 3 && recentText.includes(dk)) {
          presentKeys.add(dk);
        }
      }
    }
  }
  return presentKeys;
}

/**
 * Score an entry's relevance based on how well it matches the recent chat text.
 * Includes derived alias key matching (1A).
 * @param {Object} entry - Lorebook entry
 * @param {string} recentText - Lowercased concatenated recent chat text
 * @param {Set<string>} [presentKeySet] - Pre-built set of keys found in recentText (O(1) lookup)
 * @returns {number} Relevance score (0 = no match, higher = more relevant)
 */
export function scoreEntry(entry, recentText, presentKeySet) {
  if (!recentText) return 0;

  const useFastPath = presentKeySet instanceof Set;
  let score = 0;

  const title = (entry.comment || "").trim();
  const titleLower = title.toLowerCase();
  if (title) {
    if (
      useFastPath
        ? presentKeySet.has(titleLower)
        : recentText.includes(titleLower)
    ) {
      score += 10;
    }
  }

  const keys = entry.key || [];
  for (const key of keys) {
    const k = String(key).trim().toLowerCase();
    if (
      k.length >= 2 &&
      (useFastPath ? presentKeySet.has(k) : recentText.includes(k))
    ) {
      score += 3;
    }
  }

  const derivedKeys = deriveAliasKeys(entry);
  for (const dk of derivedKeys) {
    if (
      dk.length >= 3 &&
      (useFastPath ? presentKeySet.has(dk) : recentText.includes(dk))
    ) {
      score += 2;
    }
  }

  return score;
}

// ── Relevance Tracking ───────────────────────────────────────────

function getRelevanceMap() {
  try {
    return getContext().chatMetadata?.[RELEVANCE_KEY] || {};
  } catch {
    return {};
  }
}

function touchRelevance(uids) {
  try {
    const context = getContext();
    if (!context.chatMetadata) return;
    const map = context.chatMetadata[RELEVANCE_KEY] || {};
    const now = Date.now();
    for (const uid of uids) map[uid] = now;
    context.chatMetadata[RELEVANCE_KEY] = map;
    context.saveMetadataDebounced?.();
  } catch {
    /* metadata not available */
  }
}

function relevanceDecay(uid, relevanceMap) {
  const lastSeen = relevanceMap[uid];
  if (!lastSeen) return 0;
  const hoursAgo = (Date.now() - lastSeen) / (1000 * 60 * 60);
  if (hoursAgo < 0.5) return 5;
  if (hoursAgo < 2) return 3;
  if (hoursAgo < 8) return 1;
  return 0;
}

// ── Relevance Feedback ───────────────────────────────────────────

/**
 * Retrieve the per-entry feedback map from chat_metadata.
 * Each key is a stringified UID, value is { injections, references, missStreak, lastReferenced, valueSamples }.
 * @returns {Record<string, {injections:number, references:number, missStreak:number, lastReferenced:number, valueSamples?:Array}>}
 */
export function getFeedbackMap() {
  try {
    return getContext().chatMetadata?.[FEEDBACK_KEY] || {};
  } catch {
    return {};
  }
}

function saveFeedbackMap(map) {
  try {
    const context = getContext();
    if (!context.chatMetadata) return;
    context.chatMetadata[FEEDBACK_KEY] = map;
    context.saveMetadataDebounced?.();
  } catch {
    /* metadata not available */
  }
}

/**
 * Score modifier based on whether an entry's past injections led to AI usage.
 * Positive for entries the AI actually references; negative for repeatedly-ignored entries.
 * Enhanced (3A): includes rolling value score from injection samples.
 */
function feedbackBoost(uid) {
  const map = getFeedbackMap();
  const data = map[uid];
  if (!data) return 0;

  let boost = 0;

  if (data.lastReferenced) {
    const hoursAgo = (Date.now() - data.lastReferenced) / (1000 * 60 * 60);
    if (hoursAgo < 1) boost += 5;
    else if (hoursAgo < 4) boost += 3;
    else if (hoursAgo < 12) boost += 1;
  }

  if (data.injections >= 3 && data.references / data.injections > 0.5) {
    boost += 3;
  }

  if (data.missStreak >= 5) boost -= 4;
  else if (data.missStreak >= 3) boost -= 2;

  // 3A: Rolling value score from injection samples
  if (Array.isArray(data.valueSamples) && data.valueSamples.length >= 3) {
    const refRate =
      data.valueSamples.filter((s) => s.ref).length / data.valueSamples.length;
    if (refRate > 0.6) boost += 3;
    else if (refRate > 0.3) boost += 1;
    else if (refRate < 0.1) boost -= 2;
  }

  return boost;
}

/**
 * Check if the AI's response text references an injected entry.
 * Matches on title or on 2+ keys (or 1 substantial key of 4+ chars).
 */
function isEntryReferenced(entry, responseText) {
  const title = entry.title.toLowerCase();
  if (title.length >= 3 && responseText.includes(title)) return true;

  let keyHits = 0;
  let hasSubstantialHit = false;
  for (const key of entry.keys) {
    const k = key.toLowerCase();
    if (k.length >= 2 && responseText.includes(k)) {
      keyHits++;
      if (k.length >= 4) hasSubstantialHit = true;
      if (keyHits >= 2) return true;
    }
  }

  return keyHits >= 1 && hasSubstantialHit;
}

/**
 * After an AI response, scan it for references to entries that were injected
 * via smart context. Updates the per-entry feedback map in chat_metadata.
 * Enhanced (3A): tracks value samples for rolling quality correlation.
 */
export function processRelevanceFeedback() {
  if (_lastInjectedEntries.length === 0) return;

  const context = getContext();
  const chat = context.chat;
  if (!chat || chat.length < 2) return;

  const lastMsg = chat[chat.length - 1];
  if (!lastMsg || lastMsg.is_user) return;
  const responseText = (lastMsg.mes || "").toLowerCase();
  if (!responseText) return;

  const responseLen = responseText.length;
  const feedbackMap = getFeedbackMap();

  for (const entry of _lastInjectedEntries) {
    const uid = String(entry.uid);
    if (!feedbackMap[uid]) {
      feedbackMap[uid] = {
        injections: 0,
        references: 0,
        missStreak: 0,
        lastReferenced: 0,
        valueSamples: [],
      };
    }

    const data = feedbackMap[uid];
    data.injections++;

    const referenced = isEntryReferenced(entry, responseText);

    // 3A: Track value sample
    if (!data.valueSamples) data.valueSamples = [];
    data.valueSamples.push({ len: responseLen, ref: referenced });
    if (data.valueSamples.length > 10)
      data.valueSamples = data.valueSamples.slice(-10);

    if (referenced) {
      data.references++;
      data.missStreak = 0;
      data.lastReferenced = Date.now();
    } else {
      data.missStreak++;
    }
  }

  saveFeedbackMap(feedbackMap);
  _lastInjectedEntries = [];
}

// ── World State Boost ────────────────────────────────────────────

const WS_BOLD_NAME_RE = /\*\*([^*]+)\*\*/g;

/**
 * Extract boost signals from the world state's parsed sections.
 * Returns lowercased sets of present character names and active thread keywords.
 * @returns {{ presentCharacters: Set<string>, threadKeywords: Set<string> } | null}
 */
function extractWorldStateBoostSignals() {
  const sections = getWorldStateSections();
  if (!sections) return null;

  const presentCharacters = new Set();
  const threadKeywords = new Set();

  const sceneBody = sections["Current Scene"] || "";
  const presentMatch = sceneBody.match(/Present:\s*(.+)/i);
  if (presentMatch) {
    for (const name of presentMatch[1].split(/[,;&]+/)) {
      const trimmed = name.replace(/\*\*/g, "").trim().toLowerCase();
      if (trimmed.length >= 2) presentCharacters.add(trimmed);
    }
  }

  const threadsBody = sections["Active Threads"] || "";
  let m;
  WS_BOLD_NAME_RE.lastIndex = 0;
  while ((m = WS_BOLD_NAME_RE.exec(threadsBody)) !== null) {
    const keyword = m[1].trim().toLowerCase();
    if (keyword.length >= 2) threadKeywords.add(keyword);
  }

  if (presentCharacters.size === 0 && threadKeywords.size === 0) return null;
  return { presentCharacters, threadKeywords };
}

/**
 * Score an entry against world state signals (present characters, active threads).
 * @param {Object} entry - Lorebook entry
 * @param {{ presentCharacters: Set<string>, threadKeywords: Set<string> }} signals
 * @returns {number} Bonus score
 */
function worldStateBoost(entry, signals) {
  if (!signals) return 0;

  let boost = 0;
  const title = (entry.comment || "").toLowerCase();
  const keys = (entry.key || []).map((k) => String(k).trim().toLowerCase());
  const searchable = [title, ...keys];

  for (const charName of signals.presentCharacters) {
    if (searchable.some((s) => s.includes(charName))) {
      boost += 8;
      break;
    }
  }

  for (const keyword of signals.threadKeywords) {
    if (searchable.some((s) => s.includes(keyword))) {
      boost += 5;
      break;
    }
  }

  return boost;
}

// ── Scoring Pipeline ─────────────────────────────────────────────

function computeScoringContext(activeBooks, recentText) {
  const relevanceMap = getRelevanceMap();
  const wsSignals = extractWorldStateBoostSignals();
  const feedbackMap = getFeedbackMap();
  const phase = detectConversationPhase(recentText);

  let maxUid = 0;
  for (const bookName of activeBooks) {
    const bd = getCachedWorldInfoSync(bookName);
    if (!bd?.entries) continue;
    for (const key of Object.keys(bd.entries)) {
      if (bd.entries[key].uid > maxUid) maxUid = bd.entries[key].uid;
    }
  }

  const maxDecayBonus = 5;
  const maxRecencyBonus = 3;
  const maxWsBonus = wsSignals ? 13 : 0;
  const maxFbBonus = 11;
  const maxPhaseBonus = 9;
  const maxArcBonus = 10;
  const maxAllBonus =
    maxDecayBonus +
    maxRecencyBonus +
    maxWsBonus +
    maxFbBonus +
    maxPhaseBonus +
    maxArcBonus;

  const chatLength = getContext().chat?.length || 0;

  let rolledUpSceneUids;
  try {
    rolledUpSceneUids = _getRolledUpSceneUids();
  } catch {
    rolledUpSceneUids = new Set();
  }

  return {
    relevanceMap,
    wsSignals,
    feedbackMap,
    phase,
    maxUid,
    maxAllBonus,
    chatLength,
    rolledUpSceneUids,
  };
}

function entryBaseThreshold(isTracker, isSummary, isActSummary) {
  return isTracker ? 1 : isSummary || isActSummary ? 3 : 5;
}

function applySummaryHierarchyAdjustments(relevance, entry, isActSummary, isSummary, rolledUpSceneUids) {
  if (isActSummary) {
    return relevance + 5;
  }
  if (isSummary && rolledUpSceneUids.has(entry.uid)) {
    return relevance - 10;
  }
  return relevance;
}

function collectMentionedEntryKeys(entry, presentKeySet, currentMentionKeys) {
  const entryKeys = (entry.key || [])
    .map((k) => String(k).trim().toLowerCase())
    .filter((k) => k.length >= 2);
  for (const k of entryKeys) {
    if (presentKeySet.has(k)) currentMentionKeys.add(k);
  }
}

function applyPrimaryScoringStages(relevance, entry, ctx, bookName) {
  let score = relevance;
  score += relevanceDecay(entry.uid, ctx.relevanceMap);
  const turnIndex = getEntryTurnIndex(bookName, entry.uid);
  if (turnIndex >= 0 && ctx.chatLength > 0) {
    if (ctx.chatLength - turnIndex <= 100) score += 3;
  } else if (ctx.maxUid > 0 && entry.uid > ctx.maxUid * 0.9) {
    score += 3;
  }
  score += worldStateBoost(entry, ctx.wsSignals);
  score += feedbackBoost(entry.uid);
  score += cooldownPenalty(entry.uid);
  score += phaseBoost(entry, ctx.phase);
  score += negativeSignalPenalty(entry, ctx.feedbackMap);
  return score;
}

function computeTierAdjustedScore(relevance, entry, opts) {
  const tier = computeEntryTier(entry, {
    isTracker: opts.isTracker,
    isSummary: opts.isSummary,
    feedbackMap: opts.feedbackMap,
    relevanceMap: opts.relevanceMap,
    chatLength: opts.chatLength,
    maxUid: opts.maxUid,
    arcOverlap: opts.arcOverlap,
  });
  const tierAdj = TIER_SCORE_ADJUST[tier];
  const score = relevance + tierAdj.bonus;
  const effectiveThreshold =
    tierAdj.thresholdOverride != null
      ? tierAdj.thresholdOverride
      : opts.threshold;
  return { score, tier, effectiveThreshold };
}

function pushCandidateIfEligible(candidates, candidate, effectiveThreshold) {
  const { entry, bookName, score, isTracker, isSummary, tier } = candidate;

  if (isTracker && score > 0) {
    candidates.push({
      entry,
      bookName,
      score: score + 20,
      isTracker: true,
      isSummary: false,
      tier,
    });
    return;
  }

  if (isSummary && score >= Math.min(effectiveThreshold, 3)) {
    candidates.push({
      entry,
      bookName,
      score: score + 2,
      isTracker: false,
      isSummary: true,
      tier,
    });
    return;
  }

  if (score >= effectiveThreshold) {
    candidates.push({
      entry,
      bookName,
      score,
      isTracker,
      isSummary,
      tier,
    });
  }
}

function applyTreeProximityBoosts(candidates, activeBooks) {
  const proximityBoosts = computeTreeProximityBoosts(candidates, activeBooks);
  for (const c of candidates) {
    const bonus = proximityBoosts.get(c.entry.uid);
    if (bonus) c.score += bonus;
  }
}

function applyPredictiveBoosts(candidates, currentMentionKeys) {
  const mentionKeysArray = [...currentMentionKeys];
  const predicted = predictNextEntities(mentionKeysArray);
  if (predicted.size > 0) {
    for (const c of candidates) {
      const entryKeys = (c.entry.key || []).map((k) =>
        String(k).trim().toLowerCase(),
      );
      const entryTitle = (c.entry.comment || "").toLowerCase();
      for (const [entity, confidence] of predicted) {
        if (
          entryTitle.includes(entity) ||
          entryKeys.some((k) => k.includes(entity))
        ) {
          c.score += Math.min(confidence, 5);
          break;
        }
      }
    }
  }

  if (currentMentionKeys.size > 0) {
    recordMentions(mentionKeysArray);
  }
}

/**
 * Score all active entries against recent chat text and sort by relevance.
 * Integrates all scoring signals: keyword, decay, world state, feedback,
 * phase (2A), cooldown (1B), negative signals (2C), and arc boost (2D).
 * Tree proximity (2B) and predictive boost (3B) are applied as a second pass.
 * @param {string[]} activeBooks - Active TV-managed lorebook names
 * @param {string} recentText - Lowercased recent chat text
 * @returns {Array<{entry: Object, bookName: string, score: number, isTracker: boolean, isSummary: boolean, tier: string}>}
 */
function scoreCandidates(activeBooks, recentText) {
  const candidates = [];
  const currentMentionKeys = new Set();

  _cachedActiveArcs = null;
  buildBigramModel();

  const presentKeySet = buildPresentKeySet(activeBooks, recentText);
  const ctx = computeScoringContext(activeBooks, recentText);

  for (const bookName of activeBooks) {
    const bookData = getCachedWorldInfoSync(bookName);
    if (!bookData?.entries) continue;

    const trackerSet = new Set(getTrackerUids(bookName));

    for (const key of Object.keys(bookData.entries)) {
      const entry = bookData.entries[key];
      if (entry.disable) continue;
      if (!entry.content || !entry.content.trim()) continue;

      const isTracker = trackerSet.has(entry.uid);
      const isActSummary = isActSummaryEntry(entry);
      const isStorySummary = isStorySummaryEntry(entry);
      const isSummary = isSummaryEntry(entry);

      if (isStorySummary) {
        candidates.push({
          entry,
          bookName,
          score: 50,
          isTracker: false,
          isSummary: true,
          tier: TIER_HOT,
        });
        continue;
      }

      let relevance = scoreEntry(entry, recentText, presentKeySet);
      relevance = applySummaryHierarchyAdjustments(
        relevance,
        entry,
        isActSummary,
        isSummary,
        ctx.rolledUpSceneUids,
      );

      const threshold = entryBaseThreshold(isTracker, isSummary, isActSummary);
      if (relevance + ctx.maxAllBonus < threshold) continue;

      if (relevance > 0) {
        collectMentionedEntryKeys(entry, presentKeySet, currentMentionKeys);
      }

      const turnIndex = getEntryTurnIndex(bookName, entry.uid);
      relevance = applyPrimaryScoringStages(relevance, entry, ctx, bookName);
      const entryArcBoost = arcBoost(entry);
      relevance += entryArcBoost;

      const tierResult = computeTierAdjustedScore(relevance, entry, {
        isTracker,
        isSummary,
        feedbackMap: ctx.feedbackMap,
        relevanceMap: ctx.relevanceMap,
        chatLength: ctx.chatLength,
        maxUid: ctx.maxUid,
        turnIndex,
        arcOverlap: entryArcBoost,
        threshold,
      });

      pushCandidateIfEligible(
        candidates,
        {
          entry,
          bookName,
          score: tierResult.score,
          isTracker,
          isSummary,
          tier: tierResult.tier,
        },
        tierResult.effectiveThreshold,
      );
    }
  }

  applyTreeProximityBoosts(candidates, activeBooks);
  applyPredictiveBoosts(candidates, currentMentionKeys);

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

// ── Core Logic ───────────────────────────────────────────────────

/**
 * Build proactive context from lorebook entries matching recent chat mentions.
 * Called synchronously at GENERATION_STARTED — must be fast (no LLM calls, no awaits).
 * Uses pre-warmed candidates if available; otherwise falls back to synchronous scoring.
 *
 * Enhanced with:
 *   - Score-density budget allocation (1C): density metric for selection
 *   - Dynamic budget allocation (3C): context-window-aware budget
 *   - Cooldown recording (1B): tracks which entries were injected
 *
 * @returns {string} Formatted context string for injection, or empty string
 */
function reportSmartContextSelections(selectedEntryInfo, source = "smart-context") {
  if (!Array.isArray(selectedEntryInfo) || selectedEntryInfo.length === 0) return;

  const injectionKey = selectedEntryInfo
    .map((entry) => `${entry.uid}:${entry.title}`)
    .join("|");

  if (injectionKey === _lastReportedInjectionKey) return;
  _lastReportedInjectionKey = injectionKey;

  addEntryActivationEvents(
    selectedEntryInfo.map((entry) => ({
      source,
      lorebook: entry.bookName || "",
      uid: entry.uid ?? null,
      title: entry.title || `UID ${entry.uid ?? "?"}`,
      keys: Array.isArray(entry.keys) ? entry.keys : [],
    })),
  );
}

function reportPreWarmCandidates(candidates, cacheKey, source = "smart-context") {
  if (!Array.isArray(candidates) || candidates.length === 0) return;
  if (!cacheKey || cacheKey === _lastReportedPreWarmKey) return;
  _lastReportedPreWarmKey = cacheKey;

  const relatedEntries = candidates.map((candidate) => ({
    lorebook: candidate.bookName || "",
    uid: candidate.entry?.uid ?? null,
    title: candidate.entry?.comment || `UID ${candidate.entry?.uid ?? "?"}`,
    keys: Array.isArray(candidate.entry?.key) ? candidate.entry.key : [],
    score: Number(candidate.score) || 0,
    tier: candidate.tier || "",
    summary: candidate.isTracker
      ? "Tracker candidate"
      : candidate.isSummary
        ? "Summary candidate"
        : "Lorebook candidate",
  }));

  const isFactDriven = source === 'fact-driven';

  addBackgroundEvent({
    icon: isFactDriven ? 'fa-brain' : 'fa-forward',
    verb: 'Pre-warmed',
    color: isFactDriven ? '#e84393' : '#fdcb6e',
    summary: `${candidates.length} smart-context entr${candidates.length === 1 ? 'y' : 'ies'} cached for the next prompt`,
    details: [isFactDriven ? 'Refreshed after post-turn fact updates' : 'Ready for next turn'],
    relatedEntries,
    preWarmSource: source,
  });
}

export function buildSmartContextPrompt() {
  const settings = getSettings();
  if (!settings.smartContextEnabled || settings.globalEnabled === false)
    return "";

  const activeBooks = getInjectionManagedBooks();
  if (activeBooks.length === 0) return "";

  const context = getContext();
  const chat = context.chat;
  if (!chat || chat.length < 2) return "";

  const lookback = settings.smartContextLookback || 6;
  const maxEntries = settings.smartContextMaxEntries || 8;

  const recentText = extractMentionsFromChat(chat, lookback);
  if (!recentText) return "";

  // Use pre-warmed candidates if cache is fresh, otherwise score synchronously
  let candidates;
  const cacheKey = buildPreWarmCacheKey();
  let selectionSource = "smart-context";
  if (isPreWarmCacheFresh(cacheKey)) {
    candidates = _preWarmedCandidates;
    selectionSource = _preWarmSource || "smart-context";
  } else {
    candidates = scoreCandidates(activeBooks, recentText);
  }

  if (candidates.length === 0) return "";

  // Selective retrieval filter: if the model has explicitly selected UIDs
  // via TunnelVision_Search this turn, only inject those entries (plus
  // trackers/story summaries which are always-inject).
  if (settings.selectiveRetrieval) {
    const selectedUids = getSelectivelyRetrievedUids();
    if (selectedUids.size > 0) {
      candidates = candidates.filter(
        (c) => selectedUids.has(c.entry.uid) || c.isTracker || (c.isSummary && isStorySummaryEntry(c.entry)),
      );
      if (candidates.length === 0) return "";
    }
  }

  // 3C: Dynamic budget allocation
  const phase = detectConversationPhase(recentText);
  const maxChars = computeDynamicBudget(candidates, settings, phase);

  // 1C: Score-density budget allocation
  // Reserve slots for story summary + trackers, then fill by density
  const storySummaryCand = candidates.find(
    (c) => c.isSummary && isStorySummaryEntry(c.entry),
  );
  const trackerCandidates = candidates.filter((c) => c.isTracker);
  const nonTrackerCandidates = candidates.filter(
    (c) => !c.isTracker && c !== storySummaryCand,
  );

  // Compute density (score per character) for non-tracker entries
  const withDensity = nonTrackerCandidates.map((c) => ({
    ...c,
    density: c.score / Math.max((c.entry.content || "").trim().length, 1),
  }));
  withDensity.sort((a, b) => b.density - a.density);

  const selected = [];
  const selectedUids = [];
  const selectedEntryInfo = [];
  let totalChars = 0;
  let trackerSlots = 0;

  // 5A: Story summary always gets first slot (guaranteed injection)
  if (storySummaryCand) {
    const entryText = formatEntryForInjection(
      storySummaryCand.entry,
      storySummaryCand.bookName,
      false,
      true,
    );
    selected.push(entryText);
    selectedUids.push(storySummaryCand.entry.uid);
    selectedEntryInfo.push({
      uid: storySummaryCand.entry.uid,
      title: (storySummaryCand.entry.comment || "").trim(),
      keys: (storySummaryCand.entry.key || []).map((k) => String(k).trim()),
      bookName: storySummaryCand.bookName,
    });
    totalChars += entryText.length;
  }

  // Then: include up to 2 tracker entries (reserved slots)
  for (const c of trackerCandidates) {
    if (trackerSlots >= 2 || selected.length >= maxEntries) break;
    const entryText = formatEntryForInjection(
      c.entry,
      c.bookName,
      c.isTracker,
      c.isSummary,
    );
    if (totalChars + entryText.length > maxChars) continue;

    selected.push(entryText);
    selectedUids.push(c.entry.uid);
    selectedEntryInfo.push({
      uid: c.entry.uid,
      title: (c.entry.comment || "").trim(),
      keys: (c.entry.key || []).map((k) => String(k).trim()),
      bookName: c.bookName,
    });
    totalChars += entryText.length;
    trackerSlots++;
  }

  // Then: fill remaining slots by density
  for (const c of withDensity) {
    if (selected.length >= maxEntries) break;
    const entryText = formatEntryForInjection(
      c.entry,
      c.bookName,
      c.isTracker,
      c.isSummary,
    );
    if (totalChars + entryText.length > maxChars) continue;

    selected.push(entryText);
    selectedUids.push(c.entry.uid);
    selectedEntryInfo.push({
      uid: c.entry.uid,
      title: (c.entry.comment || "").trim(),
      keys: (c.entry.key || []).map((k) => String(k).trim()),
      bookName: c.bookName,
    });
    totalChars += entryText.length;
  }

  if (selected.length === 0) return "";

  console.log(
    `${SMART_CONTEXT_LOG_PREFIX} Injecting ${selected.length} entr${selected.length === 1 ? "y" : "ies"}`,
  );

  _lastInjectedEntries = selectedEntryInfo;
  reportSmartContextSelections(selectedEntryInfo, selectionSource);
  if (selectedUids.length > 0) touchRelevance(selectedUids);

  // 1B: Record injections for cooldown
  recordInjections(selectedUids);

  const header = `[TunnelVision Smart Context — ${selected.length} relevant entries auto-retrieved based on current scene. This is supplemental memory; the AI can search for more with TunnelVision_Search if needed.]`;
  const hasSecret = selected.some((t) => SECRET_TAG_RE.test(t));
  const parts = hasSecret ? [SECRET_GUARD_LINE, ""] : [];
  parts.push(header, "", selected.join("\n\n---\n\n"));
  return parts.join("\n");
}

/**
 * Async background pre-computation of smart context scores.
 * Called after MESSAGE_RECEIVED or post-turn completion so scoring is ready for the next generation.
 * Ensures world info data is loaded (async) then runs the full scoring pipeline.
 *
 * Enhanced with:
 *   - Predictive pre-warming (3B): bigram model built here
 *   - Hybrid sidecar reranking (5A): if sidecar available, reranks top candidates
 *   - Embedding similarity (5B): if embeddings available, adds similarity scores
 */
export async function preWarmSmartContext({ source = 'smart-context' } = {}) {
  const settings = getSettings();
  if (!settings.smartContextEnabled || settings.globalEnabled === false) return;

  const activeBooks = getInjectionManagedBooks();
  if (activeBooks.length === 0) return;

  const context = getContext();
  const chat = context.chat;
  if (!chat || chat.length < 2) return;

  const cacheKey = buildPreWarmCacheKey();
  if (!cacheKey) return;
  if (isPreWarmCacheFresh(cacheKey)) return;

  const lookback = settings.smartContextLookback || 6;
  const recentText = extractMentionsFromChat(chat, lookback);
  if (!recentText) return;

  // Ensure world info data is in cache (the async part that saves time later)
  await Promise.all(activeBooks.map((book) => getCachedWorldInfo(book)));

  const candidates = scoreCandidates(activeBooks, recentText);

  // 5A: Hybrid sidecar reranking — if sidecar is configured, rerank top-15
  try {
    const { isSidecarConfigured, sidecarGenerate } =
      await import("./llm-sidecar.js");
    if (isSidecarConfigured() && candidates.length > 3) {
      const topN = candidates.slice(0, 15);
      const rerankPrompt = buildRerankPrompt(topN, recentText);
      const response = await sidecarGenerate({
        prompt: rerankPrompt,
        maxTokens: 200,
      });
      applyRerankResults(candidates, topN, response);
    }
  } catch (e) {
    console.debug("[TunnelVision] Sidecar reranking skipped:", e.message);
  }

  // 5B: Embedding similarity — if embedding API available, add cosine similarity scores
  try {
    const { isEmbeddingAvailable, getEmbeddingSimilarityBoosts } =
      await import("./embedding-cache.js");
    if (isEmbeddingAvailable()) {
      const boosts = await getEmbeddingSimilarityBoosts(candidates, recentText);
      for (const c of candidates) {
        const bonus = boosts.get(c.entry.uid);
        if (bonus) {
          c.score += bonus;
        }
      }
      candidates.sort((a, b) => b.score - a.score);
    }
  } catch (e) {
    console.debug("[TunnelVision] Embedding similarity skipped:", e.message);
  }

  _preWarmedCandidates = candidates;
  _preWarmCacheKey = cacheKey;
  _preWarmSource = source;
  _preWarmCachedAt = Date.now();
  reportPreWarmCandidates(candidates, cacheKey, source);
}

// ── Hybrid Reranking Helpers (5A) ────────────────────────────────

function buildRerankPrompt(topCandidates, recentText) {
  const snippet = recentText.length > 500 ? recentText.slice(-500) : recentText;
  const entryList = topCandidates
    .map(
      (c, i) =>
        `${i + 1}. [${(c.entry.comment || "").trim() || `UID ${c.entry.uid}`}] — ${(c.entry.content || "").trim().substring(0, 80)}`,
    )
    .join("\n");

  return [
    "Rank these lorebook entries by relevance to the recent conversation.",
    "Return ONLY a comma-separated list of entry numbers in order of relevance (most relevant first).",
    "",
    "[Recent conversation]",
    snippet,
    "",
    "[Entries]",
    entryList,
  ].join("\n");
}

function applyRerankResults(allCandidates, topN, response) {
  if (!response || typeof response !== "string") return;
  const nums = response.match(/\d+/g);
  if (!nums || nums.length < 2) return;

  const maxBoost = topN.length;
  for (let rank = 0; rank < nums.length; rank++) {
    const idx = parseInt(nums[rank], 10) - 1;
    if (idx >= 0 && idx < topN.length) {
      const uid = topN[idx].entry.uid;
      const candidate = allCandidates.find((c) => c.entry.uid === uid);
      if (candidate) {
        candidate.score += Math.max(maxBoost - rank, 1);
      }
    }
  }
  allCandidates.sort((a, b) => b.score - a.score);
}

// ── Formatting ───────────────────────────────────────────────────

function formatEntryForInjection(
  entry,
  bookName,
  isTracker,
  isSummary = false,
  tier = TIER_WARM,
) {
  const tag = isTracker ? " [Tracker]" : isSummary ? " [Summary]" : "";
  return `[${getEntryTitle(entry)}${tag} — ${bookName}, UID ${entry.uid}]\n${(entry.content || "").trim()}`;
}

// ── Init ─────────────────────────────────────────────────────────

function onMessageReceived() {
  try {
    const context = getContext();
    const lastMsg = context.chat?.[context.chat.length - 1];
    if (
      Array.isArray(lastMsg?.extra?.tool_invocations) &&
      lastMsg.extra.tool_invocations.length > 0
    ) return;
  } catch {
    return;
  }

  processRelevanceFeedback();

  preWarmSmartContext({ source: 'smart-context' }).catch((err) => {
    console.debug(
      "[TunnelVision] Pre-warm failed (non-critical):",
      err.message,
    );
  });
}

/**
 * Register the MESSAGE_RECEIVED handler for relevance feedback + pre-warming.
 * Called once from index.js init.
 */
export function initSmartContext() {
  if (_scInitialized) return;
  _scInitialized = true;

  if (event_types.MESSAGE_RECEIVED) {
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
  }

  if (event_types.WORLDINFO_UPDATED) {
    eventSource.on(event_types.WORLDINFO_UPDATED, invalidatePreWarmCache);
  }

  console.log(
    "[TunnelVision] Smart context feedback loop + pre-warming initialized",
  );
}
