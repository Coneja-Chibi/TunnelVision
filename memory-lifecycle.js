/**
 * TunnelVision Memory Lifecycle Manager
 *
 * A periodic background process that maintains lorebook health over long
 * conversations. Runs every N turns (configurable) and performs:
 *
 *   1. Consolidation — Find entries about the same entity and merge them
 *   2. Compression — Condense verbose entries while preserving key facts
 *   3. Reorganization — Categorize orphaned entries into the tree index
 *
 * Unlike the Post-Turn Processor (which runs after every exchange), the Lifecycle
 * Manager runs less frequently and makes bigger structural changes. Think of it
 * as a periodic "memory defragmentation."
 *
 * Trigger: every N post-turn processor runs (or manually via /tv-maintain).
 * Data: lifecycle state in chat_metadata.tunnelvision_lifecycle
 */

import { eventSource, event_types } from "../../../../script.js";
import { getContext } from "../../../st-context.js";
import {
  getSettings,
  getTree,
  saveTree,
  createTreeNode,
  addEntryToNode,
  removeEntryFromTree,
  getAllEntryUids,
  isSummaryTitle,
  isTrackerTitle,
  getTrackerUids,
} from "./tree-store.js";
import {
  normalizeCategoryLabel,
  findCategoryByLabel,
  findOrCreateChildCategory,
} from "./tree-categories.js";
import { getActiveTunnelVisionBooks } from "./tool-registry.js";
import {
  getCachedWorldInfo,
  buildUidMap,
  parseJsonFromLLM,
  invalidateWorldInfoCache,
  mergeEntries,
  findEntryByUid,
  updateEntry,
  forgetEntry,
  recordEntryVersion,
  getEntryTurnIndex,
  setEntrySupersedes,
  getEntryTemporal,
} from "./entry-manager.js";
import { loadWorldInfo, saveWorldInfo } from "../../../world-info.js";
import {
  getChatId,
  shouldSkipAiMessage,
  callWithRetry,
  generateAnalytical,
} from "./agent-utils.js";
import {
  addBackgroundEvent,
  registerBackgroundTask,
} from "./background-events.js";
import { getWorldStateText } from "./world-state.js";
import { shuffleArray, isSystemEntry } from "./shared-utils.js";
import {
  LIFECYCLE_BATCH_LIMIT,
  COMPRESSION_THRESHOLD,
  REORGANIZE_BATCH_LIMIT,
  CROSS_VALIDATION_INTERVAL,
  MAX_TRACKER_CHARS,
  MAX_FACTS_FOR_AUDIT,
  MAX_WS_CHARS_FOR_AUDIT as MAX_WS_CHARS,
  ADAPTIVE_MIN_INTERVAL,
  ADAPTIVE_MAX_INTERVAL,
  ADAPTIVE_MULTIPLIERS,
  LIFECYCLE_SIMILARITY_BUDGET_RATIO,
} from "./constants.js";

const METADATA_KEY = "tunnelvision_lifecycle";

let _initialized = false;
let _lifecycleRunning = false;

// ── Persistence ──────────────────────────────────────────────────

function getLifecycleState() {
  try {
    return getContext().chatMetadata?.[METADATA_KEY] || null;
  } catch {
    return null;
  }
}

function setLifecycleState(state) {
  try {
    const context = getContext();
    if (!context.chatMetadata) return;
    context.chatMetadata[METADATA_KEY] = state;
    context.saveMetadataDebounced?.();
  } catch {
    /* metadata not available */
  }
}

// (getChatId imported from agent-utils.js)

// ── Decision Logic ───────────────────────────────────────────────



/**
 * Compute a dynamic lifecycle interval based on recent lorebook activity.
 * Factors: growth rate, duplicate density from last run, and contradiction recency.
 * Falls back to the user-configured static interval when adaptive signals are absent.
 */
export function computeAdaptiveInterval(settings, state) {
  const baseInterval = settings.lifecycleInterval || 30;

  if (!state?.lastResult) return baseInterval;

  let factor = 1.0;
  const last = state.lastResult;

  // Growth pressure: estimate entries added since last run via merged/compressed counts
  // High lifecycle activity implies rapid lorebook growth
  const workDone =
    (last.duplicatesMerged || 0) +
    (last.entriesCompressed || 0) +
    (last.entriesReorganized || 0);
  for (const { threshold, multiplier } of ADAPTIVE_MULTIPLIERS.workDone) {
    if (workDone >= threshold) { factor *= multiplier; break; }
  }

  // Duplicate pressure: high duplicate findings → run sooner
  const dupsFound = last.duplicatesFound || 0;
  for (const { threshold, multiplier } of ADAPTIVE_MULTIPLIERS.duplicatesFound) {
    if (dupsFound >= threshold) { factor *= multiplier; break; }
  }

  // Contradiction pressure
  const contradictions =
    (last.contradictionsFound || 0) + (last.crossValidationContradictions || 0);
  for (const { threshold, multiplier } of ADAPTIVE_MULTIPLIERS.contradictions) {
    if (contradictions >= threshold) { factor *= multiplier; break; }
  }

  // Quiet period bonus: no activity → relax interval
  const totalWork = workDone + dupsFound + contradictions;
  if (totalWork === 0) factor *= ADAPTIVE_MULTIPLIERS.quiet;

  const adaptive = Math.round(baseInterval * factor);
  return Math.max(
    ADAPTIVE_MIN_INTERVAL,
    Math.min(ADAPTIVE_MAX_INTERVAL, adaptive),
  );
}

function shouldRunLifecycle() {
  const settings = getSettings();
  if (!settings.lifecycleEnabled || settings.globalEnabled === false)
    return false;
  if (getActiveTunnelVisionBooks().length === 0) return false;

  const context = getContext();
  const chatLength = context.chat?.length || 0;
  if (chatLength < 20) return false;

  const state = getLifecycleState();
  const lastRunMsgIdx = state?.lastRunMsgIdx ?? -1;
  const interval = computeAdaptiveInterval(settings, state);

  return chatLength - 1 - lastRunMsgIdx >= interval;
}

/**
 * Get the current effective lifecycle interval (for display purposes).
 * @returns {number}
 */
export function getEffectiveLifecycleInterval() {
  const settings = getSettings();
  const state = getLifecycleState();
  return computeAdaptiveInterval(settings, state);
}

// ── Core Lifecycle Pipeline ──────────────────────────────────────

/**
 * Run the memory lifecycle maintenance pipeline.
 * @param {boolean} [force=false] - Skip interval check
 * @returns {Promise<Object|null>} Results summary, or null
 */
export async function runLifecycleMaintenance(force = false) {
  if (_lifecycleRunning) return null;
  if (!force && !shouldRunLifecycle()) return null;

  const settings = getSettings();
  if (!settings.lifecycleEnabled || settings.globalEnabled === false)
    return null;

  const activeBooks = getActiveTunnelVisionBooks();
  if (activeBooks.length === 0) return null;

  const chatId = getChatId();
  _lifecycleRunning = true;
  const task = registerBackgroundTask({
    label: "Lifecycle",
    icon: "fa-recycle",
    color: "#00cec9",
  });

  const result = {
    entriesCompressed: 0,
    duplicatesFound: 0,
    duplicatesMerged: 0,
    contradictionsFound: 0,
    contradictionsResolved: 0,
    entriesReorganized: 0,
    crossValidationContradictions: 0,
    errors: 0,
  };

  console.log("[TunnelVision] Memory lifecycle maintenance starting");

  try {
    for (const bookName of activeBooks) {
      if (getChatId() !== chatId || task.cancelled) break;

      const bookData = await getCachedWorldInfo(bookName);
      if (!bookData?.entries) continue;

      // Steps run sequentially: dedup and compress both do read-modify-write
      // on bookData via saveWorldInfo, and dedup also modifies the tree.
      // Parallelizing would cause lost-update races on shared mutable state.
      if (settings.lifecycleConsolidate !== false) {
        const dupeResult = await findAndMergeDuplicates(
          bookName,
          bookData,
          chatId,
        );
        result.duplicatesFound += dupeResult.found;
        result.duplicatesMerged += dupeResult.merged;
        result.contradictionsFound += dupeResult.contradictionsFound;
        result.contradictionsResolved += dupeResult.contradictionsResolved;
        result.errors += dupeResult.errors;
      }

      if (getChatId() !== chatId || task.cancelled) break;

      if (settings.lifecycleCompress !== false) {
        const compressResult = await compressVerboseEntries(
          bookName,
          bookData,
          chatId,
        );
        result.entriesCompressed += compressResult.compressed;
        result.errors += compressResult.errors;
      }

      if (getChatId() !== chatId || task.cancelled) break;

      if (settings.lifecycleReorganize !== false) {
        const reorgResult = await reorganizeTree(bookName, bookData, chatId);
        result.entriesReorganized += reorgResult.reorganized;
        result.errors += reorgResult.errors;
      }
    }

    if (!task.cancelled) {
      let maxOrderValue = 0;
      for (const bookName of activeBooks) {
        const bd = await getCachedWorldInfo(bookName);
        if (!bd?.entries) continue;
        for (const key of Object.keys(bd.entries)) {
          const entry = bd.entries[key];
          if (entry.disable) continue;
          maxOrderValue = Math.max(maxOrderValue, getEntryOrderValue(bookName, entry.uid));
        }
      }

      const prevState = getLifecycleState();
      const runCount = (prevState?.runCount || 0) + 1;

      // Cross-validation audit: run every Nth lifecycle cycle
      if (
        runCount % CROSS_VALIDATION_INTERVAL === 0 &&
        getChatId() === chatId
      ) {
        const auditResult = await runConsistencyAudit(activeBooks, chatId);
        result.crossValidationContradictions = auditResult.contradictions;
        result.errors += auditResult.errors;
      }

      // Count total entries for adaptive lifecycle tracking
      let totalEntries = 0;
      for (const bookName of activeBooks) {
        const bd = await getCachedWorldInfo(bookName);
        if (!bd?.entries) continue;
        for (const key of Object.keys(bd.entries)) {
          if (!bd.entries[key].disable) totalEntries++;
        }
      }

      setLifecycleState({
        lastRunMsgIdx: (getContext().chat?.length || 1) - 1,
        lastRunAt: Date.now(),
        lastResult: result,
        lastMaxUid: maxOrderValue,
        runCount,
        lastEntryCount: totalEntries,
      });
    }

    const details = [];
    if (result.entriesCompressed > 0)
      details.push(`${result.entriesCompressed} compressed`);
    if (result.duplicatesMerged > 0)
      details.push(`${result.duplicatesMerged} merged`);
    else if (result.duplicatesFound > 0)
      details.push(`${result.duplicatesFound} duplicate pairs`);
    if (result.contradictionsResolved > 0)
      details.push(
        `${result.contradictionsResolved} contradiction(s) resolved`,
      );
    else if (result.contradictionsFound > 0)
      details.push(`${result.contradictionsFound} contradiction(s) found`);
    if (result.entriesReorganized > 0)
      details.push(`${result.entriesReorganized} reorganized`);
    if (result.crossValidationContradictions > 0)
      details.push(
        `${result.crossValidationContradictions} cross-validation issue(s)`,
      );
    console.log(
      `[TunnelVision] Lifecycle maintenance complete: ${details.length > 0 ? details.join(", ") : "no changes needed"}`,
    );

    const updatedState = getLifecycleState();
    const nextInterval = computeAdaptiveInterval(settings, updatedState);
    const baseInterval = settings.lifecycleInterval || 30;
    if (nextInterval !== baseInterval) {
      details.push(`next run in ~${nextInterval} turns (adaptive)`);
    }

    if (details.length > 0) {
      addBackgroundEvent({
        icon: "fa-recycle",
        verb: "Lifecycle",
        color: "#00cec9",
        summary: details.join(", "),
        details,
      });
    }

    return result;
  } catch (e) {
    console.error("[TunnelVision] Lifecycle maintenance failed:", e);
    toastr.error(
      `Memory lifecycle maintenance failed: ${e.message || "Unknown error"}`,
      "TunnelVision",
    );
    addBackgroundEvent({
      icon: "fa-triangle-exclamation",
      verb: "Lifecycle failed",
      color: "#d63031",
      summary: e.message || "Unknown error",
    });
    _lifecycleRunning = false;
    task.fail(e, () => runLifecycleMaintenance(true));
    return null;
  } finally {
    if (!task._ended) {
      _lifecycleRunning = false;
      task.end();
    }
  }
}

// ── Tiered Batch Strategy (2A) ───────────────────────────────────



/**
 * Build a tiered batch of entries for lifecycle consolidation.
 * Instead of a flat cap, prioritizes:
 *   1. Entries created since the last lifecycle run (always checked)
 *   2. Entries with high trigram similarity to new entries (pre-filtered locally)
 *   3. Random sample from remaining entries (rotating coverage)
 * @param {Array<{uid: number, title: string, content: string}>} allEntries
 * @param {string} bookName
 * @returns {Array<{uid: number, title: string, content: string}>}
 */
function getEntryOrderValue(bookName, uid) {
  const turn = getEntryTurnIndex(bookName, uid);
  if (turn >= 0) return turn;
  const temporal = getEntryTemporal(bookName, uid);
  if (Number.isFinite(temporal?.created)) return Number(temporal.created);
  return Number(uid) || 0;
}

function buildLifecycleBatch(allEntries, bookName) {
  if (allEntries.length <= LIFECYCLE_BATCH_LIMIT) return allEntries;

  const state = getLifecycleState();
  const lastRunUidThreshold = state?.lastMaxUid ?? 0;

  const newEntries = allEntries.filter((e) => getEntryOrderValue(bookName, e.uid) > lastRunUidThreshold);
  const oldEntries = allEntries.filter((e) => getEntryOrderValue(bookName, e.uid) <= lastRunUidThreshold);

  const selected = new Set(newEntries.map((e) => e.uid));
  let budget = LIFECYCLE_BATCH_LIMIT - selected.size;

  if (budget > 0 && newEntries.length > 0 && oldEntries.length > 0) {
    const newTexts = newEntries.map((e) => `${e.title} ${e.content}`);
    const newTrigrams = newTexts.map((t) => trigrams(t));

    const scored = oldEntries.map((old) => {
      const oldTri = trigrams(`${old.title} ${old.content}`);
      let maxSim = 0;
      for (const nt of newTrigrams) {
        const sim = trigramSetSimilarity(oldTri, nt);
        if (sim > maxSim) maxSim = sim;
      }
      return { entry: old, similarity: maxSim };
    });
    scored.sort((a, b) => b.similarity - a.similarity);

    const similarCount = Math.min(Math.ceil(budget * LIFECYCLE_SIMILARITY_BUDGET_RATIO), scored.length);
    for (let i = 0; i < similarCount; i++) {
      selected.add(scored[i].entry.uid);
    }
    budget = LIFECYCLE_BATCH_LIMIT - selected.size;

    if (budget > 0) {
      const remaining = oldEntries.filter((e) => !selected.has(e.uid));
      shuffleArray(remaining);
      for (let i = 0; i < Math.min(budget, remaining.length); i++) {
        selected.add(remaining[i].uid);
      }
    }
  }

  return allEntries.filter((e) => selected.has(e.uid));
}

function trigrams(s) {
  const norm = `  ${s
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ")
    .trim()}  `;
  const set = new Set();
  for (let i = 0; i <= norm.length - 3; i++) {
    set.add(norm.substring(i, i + 3));
  }
  return set;
}

function trigramSetSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const tri of setA) {
    if (setB.has(tri)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

// ── Step 1: Duplicate Detection ──────────────────────────────────

async function findAndMergeDuplicates(bookName, bookData, chatId) {
  const result = {
    found: 0,
    merged: 0,
    contradictionsFound: 0,
    contradictionsResolved: 0,
    errors: 0,
  };

  const entries = [];
  for (const key of Object.keys(bookData.entries)) {
    const entry = bookData.entries[key];
    if (entry.disable) continue;
    const title = (entry.comment || "").trim();
    if (!title) continue;
    if (isSystemEntry(entry)) continue;
    entries.push({
      uid: entry.uid,
      title,
      content: (entry.content || "").substring(0, 200),
    });
  }

  if (entries.length < 2) return result;

  const batch = buildLifecycleBatch(entries, bookName);
  const entryList = batch
    .map(
      (e) =>
        `- UID ${e.uid}: "${e.title}" — ${e.content.replace(/\n/g, " ").substring(0, 100)}...`,
    )
    .join("\n");

  const quietPrompt = [
    "You are a lorebook maintenance assistant. Analyze these lorebook entry titles and previews.",
    "Perform TWO checks:",
    "",
    "1. DUPLICATES: Identify pairs that are genuinely about the SAME topic/entity and contain overlapping information that should be consolidated.",
    '2. CONTRADICTIONS: Identify pairs where one fact directly contradicts another about the same subject (e.g. "Elena lives in Port Alara" vs "Elena moved to the capital").',
    "",
    `[Entries in "${bookName}"]`,
    entryList,
    "",
    "For DUPLICATES: decide which entry to KEEP (more complete) and provide merged content combining the best of both.",
    "For CONTRADICTIONS: provide resolved content that reflects the current truth. If recency is unclear from content, make the best supported choice and explain it briefly.",
    "",
    "Respond with a JSON array. If nothing found, respond with [].",
    'Format: [{"type": "duplicate"|"contradiction", "keep_uid": 123, "remove_uid": 456, "merged_title": "best title", "merged_content": "resolved content", "reason": "brief reason"}]',
    "",
    "For contradictions: keep_uid = the entry that should remain current, remove_uid = the outdated entry.",
    "Only flag genuine duplicates or direct contradictions — not entries that merely reference the same character in different contexts.",
    'Different facts about the same character (e.g. "Elena is brave" and "Elena lives in Port Alara") are NOT contradictions.',
    "Limit to at most 3 duplicate pairs + 3 contradiction pairs per run.",
    "Respond with ONLY the JSON array.",
  ].join("\n");

  try {
    const response = await callWithRetry(
      () => generateAnalytical({ prompt: quietPrompt }),
      { label: "Lifecycle consolidation" },
    );
    if (getChatId() !== chatId) return result;

    const pairs = parseJsonFromLLM(response, { type: "array" });
    if (!Array.isArray(pairs) || pairs.length === 0) return result;

    const duplicates = pairs
      .filter((p) => p?.type !== "contradiction")
      .slice(0, 3);
    const contradictions = pairs
      .filter((p) => p?.type === "contradiction")
      .slice(0, 3);

    result.found = duplicates.length;
    result.contradictionsFound = contradictions.length;

    // Process duplicates — merge as before
    for (const pair of duplicates) {
      if (!pair?.keep_uid || !pair?.remove_uid) continue;
      if (getChatId() !== chatId) break;

      try {
        await mergeEntries(
          bookName,
          Number(pair.keep_uid),
          Number(pair.remove_uid),
          {
            mergedContent: pair.merged_content || undefined,
            mergedTitle: pair.merged_title || undefined,
          },
        );
        result.merged++;
        console.log(
          `[TunnelVision] Lifecycle: merged UID ${pair.remove_uid} → ${pair.keep_uid} in "${bookName}" (${pair.reason || "duplicate"})`,
        );
      } catch (e) {
        console.warn(
          `[TunnelVision] Lifecycle: merge failed for ${pair.keep_uid} ↔ ${pair.remove_uid}:`,
          e,
        );
        result.errors++;
      }
    }

    // Process contradictions — use temporal turn index to determine precedence,
    // update the newer entry with resolved content, disable the older, and record causal link
    for (const pair of contradictions) {
      if (!pair?.keep_uid || !pair?.remove_uid) continue;
      if (getChatId() !== chatId) break;

      try {
        let keepUid = Number(pair.keep_uid);
        let removeUid = Number(pair.remove_uid);

        // Use temporal turnIndex when available for more accurate
        // ordering than raw UID (which only reflects creation order)
        const keepTurn = getEntryTurnIndex(bookName, keepUid);
        const removeTurn = getEntryTurnIndex(bookName, removeUid);
        if (keepTurn > 0 && removeTurn > 0 && removeTurn > keepTurn) {
          [keepUid, removeUid] = [removeUid, keepUid];
        }

        if (pair.merged_content) {
          await updateEntry(bookName, keepUid, {
            content: pair.merged_content,
            ...(pair.merged_title ? { comment: pair.merged_title } : {}),
            _source: "lifecycle",
          });
        }

        await forgetEntry(bookName, removeUid, false);

        // Record causal chain: the kept entry supersedes the removed one
        setEntrySupersedes(bookName, keepUid, removeUid);

        result.contradictionsResolved++;
        console.log(
          `[TunnelVision] Lifecycle: resolved contradiction — UID ${removeUid} (turn ${removeTurn}) superseded by UID ${keepUid} (turn ${keepTurn}) in "${bookName}" (${pair.reason || "contradiction"})`,
        );
      } catch (e) {
        console.warn(
          `[TunnelVision] Lifecycle: contradiction resolution failed for ${pair.keep_uid} ↔ ${pair.remove_uid}:`,
          e,
        );
        result.errors++;
      }
    }
  } catch (e) {
    console.warn("[TunnelVision] Lifecycle consolidation failed:", e);
    result.errors++;
  }

  return result;
}

// ── Character Entry Detection ────────────────────────────────────

/**
 * Build a set of UIDs that belong to character-related tree subtrees.
 * A subtree is character-related if it contains at least one tracker entry
 * (trackers are per-character by definition). Also includes entries whose
 * keywords contain "character". This works regardless of category naming.
 */
function buildCharacterUidSet(bookName, bookData) {
  const characterUids = new Set();
  const trackerSet = new Set(getTrackerUids(bookName));

  const tree = getTree(bookName);
  if (tree?.root) {
    for (const child of tree.root.children || []) {
      const subtreeUids = getAllEntryUids(child);
      if (subtreeUids.some((uid) => trackerSet.has(uid))) {
        for (const uid of subtreeUids) characterUids.add(uid);
      }
    }
  }

  if (bookData?.entries) {
    for (const key of Object.keys(bookData.entries)) {
      const entry = bookData.entries[key];
      if (entry.disable) continue;
      const keys = entry.key || [];
      if (keys.some((k) => String(k).toLowerCase().includes("character"))) {
        characterUids.add(entry.uid);
      }
    }
  }

  return characterUids;
}

// ── Step 2: Entry Compression ────────────────────────────────────



async function compressVerboseEntries(bookName, bookData, chatId) {
  const result = { compressed: 0, errors: 0 };

  const characterUids = buildCharacterUidSet(bookName, bookData);

  // Find entries that are excessively long
  const verbose = [];
  for (const key of Object.keys(bookData.entries)) {
    const entry = bookData.entries[key];
    if (entry.disable) continue;
    if ((entry.content || "").length > COMPRESSION_THRESHOLD) {
      // Skip tracker entries and summaries — they have intentional structure
      if (isSystemEntry(entry)) continue;

      // Skip character entries — their detail is intentional
      if (characterUids.has(entry.uid)) continue;

      verbose.push({
        uid: entry.uid,
        title: entry.comment || `#${entry.uid}`,
        content: entry.content,
      });
    }
  }

  if (verbose.length === 0) return result;

  // Process up to 3 entries per cycle to limit API usage
  const batch = verbose.slice(0, 3);

  for (const entry of batch) {
    if (getChatId() !== chatId) break;

    const quietPrompt = [
      "You are a lorebook editor. This entry is too verbose and needs to be condensed.",
      "Preserve ALL key facts, names, relationships, and important details.",
      "Remove redundancy, filler, and excessive description. Aim for 40-60% of the original length.",
      "",
      `[Entry: "${entry.title}" (UID ${entry.uid})]`,
      entry.content,
      "",
      "Rewrite this entry in a more concise form. Preserve the same format/structure if it has one.",
      "Respond with ONLY the compressed content. No commentary, no code fences.",
    ].join("\n");

    try {
      const response = await callWithRetry(
        () => generateAnalytical({ prompt: quietPrompt }),
        { label: "Lifecycle compress", maxRetries: 1 },
      );
      if (getChatId() !== chatId) return result;

      const compressed = response?.trim();
      if (!compressed || compressed.length >= entry.content.length) continue;

      // Safety check: don't compress if the result is too short (model might have hallucinated)
      if (compressed.length < entry.content.length * 0.2) {
        console.warn(
          `[TunnelVision] Lifecycle: compression result suspiciously short for "${entry.title}", skipping`,
        );
        continue;
      }

      // Apply the compression by loading fresh book data
      const freshBookData = await loadWorldInfo(bookName);
      if (!freshBookData?.entries) continue;

      const uidMap = buildUidMap(freshBookData.entries);
      const freshEntry = uidMap.get(entry.uid);
      if (!freshEntry) continue;

      recordEntryVersion(bookName, entry.uid, {
        source: "lifecycle",
        previousContent: freshEntry.content || "",
        previousTitle: freshEntry.comment || "",
      });

      freshEntry.content = compressed;
      await saveWorldInfo(bookName, freshBookData, true);
      invalidateWorldInfoCache(bookName);
      result.compressed++;

      console.log(
        `[TunnelVision] Lifecycle: compressed "${entry.title}" (${entry.content.length} → ${compressed.length} chars)`,
      );
    } catch (e) {
      console.warn(
        `[TunnelVision] Lifecycle: compression failed for "${entry.title}":`,
        e,
      );
      result.errors++;
    }
  }

  return result;
}

// ── Step 3: Tree Reorganization ──────────────────────────────────



/**
 * Find entries that are orphaned (on root node or missing from the tree entirely)
 * and use an LLM call to assign them to existing tree categories.
 */
async function reorganizeTree(bookName, bookData, chatId) {
  const result = { reorganized: 0, errors: 0 };

  const tree = getTree(bookName);
  if (!tree?.root || tree.root.children.length === 0) return result;

  const assignedUids = new Set(getAllEntryUids(tree.root));
  const rootUidSet = new Set(tree.root.entryUids || []);

  // Collect orphaned entries: on root or not in tree at all
  const orphaned = [];
  for (const key of Object.keys(bookData.entries)) {
    const entry = bookData.entries[key];
    if (!entry || entry.disable) continue;
    if (isSummaryTitle(entry.comment) || isTrackerTitle(entry.comment))
      continue;

    const onRoot = rootUidSet.has(entry.uid);
    const missing = !assignedUids.has(entry.uid);
    if (onRoot || missing) {
      orphaned.push(entry);
    }
  }

  if (orphaned.length === 0) return result;

  const batch = orphaned.slice(0, REORGANIZE_BATCH_LIMIT);

  // Collect existing category paths (excluding Summaries)
  const categories = [];
  function collectCategories(node, prefix) {
    for (const child of node.children || []) {
      if (child.label === "Summaries") continue;
      const path = prefix ? `${prefix} > ${child.label}` : child.label;
      const desc = child.summary ? ` — ${child.summary}` : "";
      categories.push({ path, label: child.label, id: child.id, desc });
      collectCategories(child, path);
    }
  }
  collectCategories(tree.root, "");

  if (categories.length === 0) return result;

  const entryList = batch
    .map((e) => {
      const label = e.comment || e.key?.[0] || `Entry #${e.uid}`;
      const preview = (e.content || "").substring(0, 150).replace(/\n/g, " ");
      return `  UID ${e.uid}: "${label}" — ${preview}`;
    })
    .join("\n");

  const catList = categories.map((c) => `  - "${c.path}"${c.desc}`).join("\n");

  const quietPrompt = [
    "You are a lorebook organization assistant. Assign each entry to the most appropriate existing category.",
    "",
    "[Existing Categories]",
    catList,
    "",
    "[Entries to Categorize]",
    entryList,
    "",
    "Assign each entry UID to the best matching existing category whenever possible.",
    "Prefer an exact category path from the Existing Categories list.",
    'If an entry genuinely doesn\'t fit any category, use "new: Suggested Name" as the category.',
    'Respond with ONLY a JSON array: [{"uid": 123, "category": "Category Path"}]',
    "No commentary, no code fences.",
  ].join("\n");

  try {
    const response = await callWithRetry(
      () => generateAnalytical({ prompt: quietPrompt }),
      { label: "Lifecycle reorganize", maxRetries: 1 },
    );
    if (getChatId() !== chatId) return result;

    const assignments = parseJsonFromLLM(response, { type: "array" });
    if (!Array.isArray(assignments) || assignments.length === 0) return result;

    // Build lookup maps for exact path and label-based reuse.
    const pathMap = new Map();
    const labelMap = new Map();

    function indexNodes(node, prefix = "") {
      for (const child of node.children || []) {
        const path = prefix ? `${prefix} > ${child.label}` : child.label;
        pathMap.set(normalizeCategoryLabel(path), child);

        const normalizedLabel = normalizeCategoryLabel(child.label);
        if (!labelMap.has(normalizedLabel)) {
          labelMap.set(normalizedLabel, child);
        }

        indexNodes(child, path);
      }
    }
    indexNodes(tree.root);

    const batchUids = new Set(batch.map((e) => e.uid));

    for (const assignment of assignments) {
      if (!assignment?.uid || !assignment?.category) continue;
      const uid = Number(assignment.uid);
      if (!batchUids.has(uid)) continue;

      let targetNode = null;
      const catStr = String(assignment.category).trim();
      const normalizedCategory = normalizeCategoryLabel(catStr);

      if (catStr.toLowerCase().startsWith("new:")) {
        const newLabel = catStr.substring(4).trim();
        const normalizedNewLabel = normalizeCategoryLabel(newLabel);
        if (normalizedNewLabel) {
          targetNode =
            findCategoryByLabel(tree.root, newLabel) || labelMap.get(normalizedNewLabel) || null;

          if (!targetNode) {
            const created = findOrCreateChildCategory(tree.root, newLabel, "");
            targetNode = created.node;
            pathMap.set(normalizeCategoryLabel(targetNode.label), targetNode);
            labelMap.set(normalizedNewLabel, targetNode);
          }
        }
      } else {
        const segments = catStr.split(">").map((s) => s.trim()).filter(Boolean);
        const lastSegment = segments[segments.length - 1] || catStr;

        targetNode =
          pathMap.get(normalizedCategory) ||
          findCategoryByLabel(tree.root, catStr) ||
          labelMap.get(normalizeCategoryLabel(lastSegment)) ||
          findCategoryByLabel(tree.root, lastSegment);
      }

      if (targetNode) {
        removeEntryFromTree(tree.root, uid);
        addEntryToNode(targetNode, uid);
        result.reorganized++;
      }
    }

    if (result.reorganized > 0) {
      saveTree(bookName, tree);
      console.log(
        `[TunnelVision] Lifecycle: reorganized ${result.reorganized} entries into tree categories in "${bookName}"`,
      );
    }
  } catch (e) {
    console.warn("[TunnelVision] Lifecycle tree reorganization failed:", e);
    result.errors++;
  }

  return result;
}

// ── Step 4: Cross-Validation Audit (3B) ──────────────────────────



/**
 * Run a consistency audit comparing tracker claims against recent facts
 * and the current world state. Flags contradictions as "Review needed"
 * background events. Runs every Nth lifecycle cycle.
 *
 * @param {string[]} activeBooks
 * @param {string} chatId
 * @returns {Promise<{contradictions: number, errors: number}>}
 */
async function runConsistencyAudit(activeBooks, chatId) {
  const result = { contradictions: 0, errors: 0 };

  // Gather tracker content
  const trackerTexts = [];
  for (const bookName of activeBooks) {
    const bookData = await getCachedWorldInfo(bookName);
    if (!bookData?.entries) continue;
    const trackerUidSet = new Set(getTrackerUids(bookName));
    for (const key of Object.keys(bookData.entries)) {
      const entry = bookData.entries[key];
      if (entry.disable || !trackerUidSet.has(entry.uid)) continue;
      const title = (entry.comment || "").trim();
      const content = (entry.content || "").trim();
      if (content) {
        trackerTexts.push(
          `[${title} — UID ${entry.uid}]\n${content.substring(0, 800)}`,
        );
      }
    }
  }

  if (trackerTexts.length === 0) return result;

  // Gather recent facts (sorted newest-first by UID, cap to MAX_FACTS_FOR_AUDIT)
  const allFacts = [];
  for (const bookName of activeBooks) {
    const bookData = await getCachedWorldInfo(bookName);
    if (!bookData?.entries) continue;
    for (const key of Object.keys(bookData.entries)) {
      const entry = bookData.entries[key];
      if (entry.disable) continue;
      if (isSystemEntry(entry)) continue;
      const orderValue = getEntryOrderValue(bookName, entry.uid);
      allFacts.push({
        uid: entry.uid,
        orderValue,
        title: entry.comment || "",
        content: (entry.content || "").substring(0, 200),
      });
    }
  }
  allFacts.sort((a, b) => b.orderValue - a.orderValue);
  const recentFacts = allFacts.slice(0, MAX_FACTS_FOR_AUDIT);

  // Gather world state
  let worldStateSnippet = "";
  try {
    const wsText = getWorldStateText();
    if (wsText) {
      worldStateSnippet = wsText.substring(0, MAX_WS_CHARS);
    }
  } catch {
    /* proceed without world state */
  }

  const trackerSection = trackerTexts
    .join("\n\n---\n\n")
    .substring(0, MAX_TRACKER_CHARS);
  const factSection = recentFacts
    .map(
      (f) => `- UID ${f.uid}: "${f.title}" — ${f.content.replace(/\n/g, " ")}`,
    )
    .join("\n");

  const auditPrompt = [
    "You are a consistency auditor for a roleplay lorebook. Compare three sources of truth and find DIRECT CONTRADICTIONS where one source says X and another says NOT-X about the same subject.",
    "",
    'Only flag genuine contradictions — not differences in detail level or phrasing. A tracker saying "Location: Forest" while a fact says "Elena entered the deep forest" is NOT a contradiction.',
    "",
    "[TRACKER ENTRIES — structured character state documents]",
    trackerSection,
    "",
    "[RECENT FACTS — individual story events, newest first]",
    factSection,
    "",
    worldStateSnippet
      ? `[WORLD STATE — current scene snapshot]\n${worldStateSnippet}\n`
      : "",
    "Find contradictions between these three sources. For each:",
    "- Describe the contradiction clearly",
    "- Identify which sources conflict",
    "- Suggest which is likely correct (prefer the most recently created source)",
    "",
    "Respond with a JSON array. If no contradictions, return [].",
    'Format: [{"subject": "who/what is contradicted", "claim_a": "what source A says", "source_a": "tracker|fact|world_state", "claim_b": "what source B says", "source_b": "tracker|fact|world_state", "likely_correct": "a|b", "reason": "brief explanation"}]',
    "",
    "Limit to at most 5 contradictions. Respond with ONLY the JSON array.",
  ].join("\n");

  try {
    const response = await callWithRetry(
      () => generateAnalytical({ prompt: auditPrompt }),
      { label: "Cross-validation audit", maxRetries: 1 },
    );
    if (getChatId() !== chatId) return result;

    const contradictions = parseJsonFromLLM(response, { type: "array" });
    if (!Array.isArray(contradictions) || contradictions.length === 0)
      return result;

    for (const item of contradictions.slice(0, 5)) {
      if (!item?.subject || !item?.claim_a || !item?.claim_b) continue;
      result.contradictions++;

      addBackgroundEvent({
        icon: "fa-triangle-exclamation",
        verb: "Review needed",
        color: "#fdcb6e",
        summary: `Contradiction: ${item.subject}`,
        details: [
          `${item.source_a || "source"}: "${item.claim_a}"`,
          `${item.source_b || "source"}: "${item.claim_b}"`,
          item.reason
            ? `Likely correct: ${item.likely_correct === "a" ? item.claim_a : item.claim_b} — ${item.reason}`
            : "",
        ].filter(Boolean),
      });
    }

    if (result.contradictions > 0) {
      console.log(
        `[TunnelVision] Cross-validation audit found ${result.contradictions} contradiction(s)`,
      );
    }
  } catch (e) {
    console.warn("[TunnelVision] Cross-validation audit failed:", e);
    result.errors++;
  }

  return result;
}

// ── Event Handlers ───────────────────────────────────────────────

const _chatRef = { lastChatLength: 0 };

function onAiMessageReceived() {
  const settings = getSettings();
  if (!settings.lifecycleEnabled || settings.globalEnabled === false) return;
  if (shouldSkipAiMessage(_chatRef)) return;

  if (shouldRunLifecycle()) {
    runLifecycleMaintenance().catch((e) => {
      console.error(
        "[TunnelVision] Background lifecycle maintenance failed:",
        e,
      );
    });
  }
}

function onChatChanged() {
  try {
    _chatRef.lastChatLength = getContext().chat?.length || 0;
  } catch {
    _chatRef.lastChatLength = 0;
  }
}

// ── Init ─────────────────────────────────────────────────────────

export function initMemoryLifecycle() {
  if (_initialized) return;
  _initialized = true;

  if (event_types.MESSAGE_RECEIVED) {
    eventSource.on(event_types.MESSAGE_RECEIVED, onAiMessageReceived);
  }
  if (event_types.CHAT_CHANGED) {
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
  }

  console.log("[TunnelVision] Memory lifecycle manager initialized");
}

// ── Public API ───────────────────────────────────────────────────

export function getLastLifecycleResult() {
  return getLifecycleState()?.lastResult || null;
}

export function getLastLifecycleRunIndex() {
  return getLifecycleState()?.lastRunMsgIdx ?? -1;
}

/** @internal — not currently used externally but kept for future coordination */
function isLifecycleRunning() {
  return _lifecycleRunning;
}
