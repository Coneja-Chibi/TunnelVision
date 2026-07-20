/**
 * TunnelVision Constants
 *
 * Centralized named constants extracted from across the codebase.
 * Each constant was previously either an inline magic number or a module-local
 * `const` duplicated/scattered across multiple files.
 *
 * Organized by domain so related tuning knobs are easy to find and adjust.
 *
 * When adding new constants:
 *   1. Choose the appropriate domain section (or create a new one).
 *   2. Document *why* the value was chosen, not just *what* it is.
 *   3. Keep the JSDoc `@see` tag pointing at the primary consumer(s).
 */

// ── Token / Character Estimation ─────────────────────────────────

/**
 * Approximate characters per token for budget calculations.
 * This is a rough average across English text with GPT-style tokenizers.
 * Used wherever token counts need to be converted to character budgets.
 *
 * @see activity-feed.js — context usage bar
 * @see smart-context.js — dynamic budget computation
 * @see ui-controller.js — budget recommendation display
 */
export const CHARS_PER_TOKEN = 4;

// ── Prompt Budget ────────────────────────────────────────────────

/**
 * Minimum remaining budget (in chars) below which an injection slot is
 * dropped entirely rather than emitting a truncated fragment.
 * A fragment shorter than this is unlikely to provide useful context.
 *
 * @see index.js — onGenerationStarted budget allocation loop
 */
export const MIN_INJECTION_BUDGET_CHARS = 200;

/**
 * When trimming an injection to fit the remaining budget, prefer to cut
 * at a newline boundary if one exists in the last portion of the text.
 * This ratio controls how far back from the end we look for a newline:
 * 0.5 means "if a newline exists in the last 50% of the remaining budget,
 * cut there instead of at the hard char limit."
 *
 * @see index.js — onGenerationStarted budget trim logic
 */
export const BUDGET_TRIM_NEWLINE_RATIO = 0.5;

/**
 * Maximum characters for a chat excerpt used in world state updates.
 * Keeps the LLM prompt reasonably sized while providing enough recent
 * conversation for accurate state tracking.
 *
 * @see world-state.js — buildUpdatePrompt
 */
export const MAX_EXCERPT_CHARS = 20_000;

/**
 * Default maximum characters for chat excerpt formatting in slash commands.
 * Balances detail against token cost for /tv-summarize and similar commands.
 *
 * @see commands.js — formatChatExcerpt call
 */
export const DEFAULT_CHAT_EXCERPT_MAX_CHARS = 15_000;

// ── Concurrency ──────────────────────────────────────────────────

/**
 * Maximum concurrent LLM calls during tree build phases (categorization,
 * subdivision, summary generation). Kept low to avoid rate limits on most
 * providers while still enabling meaningful parallelism.
 *
 * @see tree-builder.js — _buildTreeWithLLM, subdivideOversizedNodes
 */
export const BUILD_CONCURRENCY = 3;

/**
 * Maximum concurrent LLM calls during chat message ingestion.
 * Same rationale as BUILD_CONCURRENCY; a separate constant in case
 * ingestion endpoints have different rate limits.
 *
 * @see tree-builder.js — _ingestChatMessages
 */
export const INGEST_CONCURRENCY = 3;

// ── Similarity Thresholds ────────────────────────────────────────

/**
 * Minimum trigram similarity (0–1) to auto-assign a new entry to an
 * existing tree node. Below this, entries are left uncategorized rather
 * than placed in a poor-fit node. Chosen empirically — values below 0.3
 * produce frequent false positives on short labels.
 *
 * @see tree-store.js — findBestNodeForEntry
 */
export const AUTO_CLASSIFY_THRESHOLD = 0.35;

/**
 * Trigram similarity threshold for considering two entries as duplicates
 * during post-turn fact extraction. A fact with similarity≥ this value
 * to an existing entry is treated as redundant and skipped.
 *
 * @see post-turn-processor.js — analyzeExchange dedup logic
 */
export const DEDUP_SIMILARITY_THRESHOLD = 0.62;

/**
 * Minimum trigram overlap to even consider two entries as duplicate
 * candidates. Acts as a cheap pre-filter before the full similarity
 * computation, avoiding O(n²) pairwise comparisons on large lorebooks.
 *
 * @see post-turn-processor.js — trigram candidate pre-filter
 */
export const TRIGRAM_CANDIDATE_MIN_OVERLAP = 0.3;

/**
 * Trigram similarity at which two entries are flagged as potential
 * duplicates in the health report. Slightly lower than DEDUP_SIMILARITY_THRESHOLD
 * because the health report is advisory, not automatic.
 *
 * @see entry-scoring.js — buildHealthReport duplicate scan
 */
export const HEALTH_DUPLICATE_CANDIDATE_THRESHOLD = 0.6;

/**
 * Trigram similarity at which entries count toward the "duplicate density"
 * metric in the health report. Higher than the candidate threshold to
 * avoid inflating the metric with borderline matches.
 *
 * @see entry-scoring.js — buildHealthReport duplicate density
 */
export const HEALTH_DUPLICATE_DENSITY_THRESHOLD = 0.7;

// ── Entry Limits ─────────────────────────────────────────────────

/**
 * Maximum character length for a single lorebook entry's content.
 * Entries longer than this are truncated on creation/update to prevent
 * context window blow-up from a single oversized entry.
 *
 * @see entry-manager.js — createEntry, updateEntry
 */
export const MAX_ENTRY_CONTENT_LENGTH = 15_000;

/**
 * Rate limit on the number of new entries created per turn.
 * Prevents runaway fact extraction from overwhelming the lorebook.
 * Reset at the start of each turn.
 *
 * @see entry-manager.js — createEntry guard
 */
export const MAX_ENTRIES_PER_TURN = 15;

/**
 * FIFO cap on version history entries stored per lorebook entry.
 * Keeps metadata size bounded while preserving recent edit history
 * for diff display and rollback.
 *
 * @see entry-manager.js — recordEntryVersion
 */
export const MAX_VERSIONS_PER_ENTRY = 5;

// ── Scoring / Quality ────────────────────────────────────────────

/**
 * Entry content length thresholds for the specificity quality dimension.
 * Longer entries are assumed to be more specific and detailed.
 * Each threshold maps to a score: [500→20, 150→15, 50→10, default→5].
 *
 * @see entry-scoring.js — computeEntryQuality specificity axis
 */
export const SPECIFICITY_THRESHOLDS = Object.freeze([{ minChars: 500, score: 20 },
    { minChars: 150, score: 15 },
    { minChars: 50,  score: 10 },
]);
export const SPECIFICITY_DEFAULT_SCORE = 5;

/**
 * Quality rating label boundaries (total score out of 100).
 * -≥ 70: "good" (healthy entry)
 * - ≥ 50: "fair" (room for improvement)
 * - ≥ 30: "stale" (needs attention)
 * - < 30: "poor" (likely needs rewrite or deletion)
 *
 * @see entry-scoring.js — getQualityRating
 */
export const QUALITY_RATING_GOOD = 70;
export const QUALITY_RATING_FAIR = 50;
export const QUALITY_RATING_STALE = 30;

/**
 * Maximum entries checked in the O(n²) pairwise duplicate scan
 * during health report generation. Caps computation time for large lorebooks.
 *
 * @see entry-scoring.js — buildHealthReport duplicate loop
 */
export const HEALTH_MAX_DUPLICATE_SCAN_ENTRIES = 200;

/**
 * Content length outlier floor. Entries longer than
 * max(avgLength × 3, this value) are flagged as outliers.
 *
 * @see entry-scoring.js — buildHealthReport outlier detection
 */
export const HEALTH_OUTLIER_LENGTH_FLOOR = 2000;

// ── Embedding Cache ──────────────────────────────────────────────

/**
 * Maximum texts sent in a single embedding API batch request.
 * Keeps request payloads manageable and avoids provider-side timeouts.
 *
 * @see embedding-cache.js — ensureEmbeddings batching
 */
export const EMBEDDING_MAX_BATCH_SIZE = 20;

/**
 * Maximum characters of entry text sent to the embedding API per entry.
 * Longer entries are truncated to this length before embedding.
 * Most embedding models have their own input limits (typically 512–8192 tokens),
 * so500 chars keeps us well within the smallest common window.
 *
 * @see embedding-cache.js — text preparation
 */
export const EMBEDDING_MAX_TEXT_LENGTH = 500;

/**
 * Time-to-live for persistent embedding cache entries, in days.
 * After this period, cached embeddings are evicted and recomputed
 * on next access. Balances storage growth against recomputation cost.
 *
 * @see embedding-cache.js — hydrateFromStore eviction
 */
export const EMBEDDING_CACHE_TTL_DAYS = 7;

/**
 * Embedding cosine similarity → score boost mapping.
 * Higher similarity to recent chat text earns a larger boost
 * in the smart context candidate scoring pipeline.
 * Evaluated top-down; first match wins.
 *
 * @see embedding-cache.js — getEmbeddingSimilarityBoosts
 */
export const EMBEDDING_SIMILARITY_BOOSTS = Object.freeze([
    { minSimilarity: 0.8, boost: 8 },
    { minSimilarity: 0.6, boost: 5 },
    { minSimilarity: 0.4, boost: 3 },
    { minSimilarity: 0.3, boost: 1 },
]);

// ── Smart Context ────────────────────────────────────────────────

/**
 * Recency thresholds for tiered entry classification.
 * Entries accessed/referenced within HOT_RECENCY_MS are "hot" (always injected),
 * within WARM_RECENCY_MS are "warm" (boosted), else "cold" (standard scoring).
 *
 * @see smart-context.js — computeEntryTier
 */
export const HOT_RECENCY_MS = 2* 60 * 60 * 1000;   // 2 hours
export const WARM_RECENCY_MS = 12 * 60 * 60 * 1000;  // 12 hours

/**
 * Injection cooldown window size (number of recent turns tracked).
 * If an entry was injected in any of the last N turns, it receives
 * a score penalty to avoid repetitive context injection.
 *
 * @see smart-context.js — cooldownPenalty
 */
export const COOLDOWN_WINDOW_TURNS = 3;

/**
 * Score penalty applied per turn that an entry was recently injected.
 * Applied for each turn within COOLDOWN_WINDOW_TURNS.
 * Negative to reduce the entry's injection score.
 *
 * @see smart-context.js — cooldownPenalty
 */
export const COOLDOWN_PENALTY_PER_TURN = -5;

/**
 * Number of injections without any AI reference (references === 0)
 * before an entry is considered "stale" for negative signal purposes.
 *
 * @see smart-context.js — negativeSignalPenalty
 */
export const STALE_INJECTION_THRESHOLD = 3;

/**
 * Score penalty applied to entries that are stale (injected multiple
 * times without the AI ever referencing them).
 *
 * @see smart-context.js — negativeSignalPenalty
 */
export const STALE_INJECTION_PENALTY = -3;

/**
 * Dynamic context budget bounds, as fractions of the total context window.
 * The actual budget is computed based on candidate scores and phase,
 * but is always clamped within these bounds.
 *
 * @see smart-context.js — computeDynamicBudget
 */
export const DYNAMIC_BUDGET_MAX_RATIO = 0.10;  // 10% of context window
export const DYNAMIC_BUDGET_MIN_RATIO = 0.03;  // 3% of context window

/**
 * Candidate score threshold above which an entry is considered
 * "high-confidence" for dynamic budget expansion.
 *
 * @see smart-context.js — computeDynamicBudget
 */
export const HIGH_CONFIDENCE_SCORE_THRESHOLD = 15;

/**
 * Max count of high-confidence candidates used when computing
 * the confidence ratio for budget scaling. Prevents a lorebook
 * with many high-scoring entries from inflating the budget unboundedly.
 *
 * @see smart-context.js — computeDynamicBudget
 */
export const HIGH_CONFIDENCE_CAP = 5;

/**
 * Budget multiplier when no high-confidence candidates exist.
 * Reduces the budget to avoid injecting low-relevance entries.
 *
 * @see smart-context.js — computeDynamicBudget
 */
export const LOW_CONFIDENCE_BUDGET_MULTIPLIER = 0.6;

/**
 * Phase-specific budget multipliers. Combat scenes get more context
 * (more entities/abilities in play), downtime gets less.
 *
 * @see smart-context.js — computeDynamicBudget
 */
export const PHASE_BUDGET_MULTIPLIERS = Object.freeze({
    combat: 1.2,
    downtime: 0.8,
});

// ── Lifecycle / Maintenance ──────────────────────────────────────

/**
 * Maximum entries included in a single lifecycle consolidation batch.
 * Larger batches find more duplicates but cost more LLM tokens.
 *
 * @see memory-lifecycle.js — buildLifecycleBatch
 */
export const LIFECYCLE_BATCH_LIMIT = 80;

/**
 * Entry content length above which compression is triggered.
 * Entries longer than this are candidates for LLM-driven summarization
 * during lifecycle maintenance.
 *
 * @see memory-lifecycle.js — compressVerboseEntries
 */
export const COMPRESSION_THRESHOLD = 1500;

/**
 * Maximum orphaned entries reorganized (assigned to tree nodes)
 * per lifecycle run. Limits LLM cost per maintenance cycle.
 *
 * @see memory-lifecycle.js — reorganizeTree
 */
export const REORGANIZE_BATCH_LIMIT = 30;

/**
 * Run cross-validation consistency audit every N lifecycle runs.
 * The audit is expensive (checks trackers vs facts vs world state),
 * so it doesn't run on every maintenance cycle.
 *
 * @see memory-lifecycle.js — runLifecycleMaintenance
 */
export const CROSS_VALIDATION_INTERVAL = 3;

/**
 * Maximum tracker text characters included in the cross-validation
 * audit prompt. Truncates long trackers to keep prompt size bounded.
 *
 * @see memory-lifecycle.js — runConsistencyAudit
 */
export const MAX_TRACKER_CHARS = 3000;

/**
 * Maximum recent fact entries included in the consistency audit prompt.
 * Only the most recent facts are checked — older ones are assumed stable.
 *
 * @see memory-lifecycle.js — runConsistencyAudit
 */
export const MAX_FACTS_FOR_AUDIT = 40;

/**
 * Maximum world state characters included in the audit prompt.
 *
 * @see memory-lifecycle.js — runConsistencyAudit
 */
export const MAX_WS_CHARS_FOR_AUDIT = 2000;

/**
 * Minimum and maximum bounds for the adaptive lifecycle interval (in turns).
 * The interval self-adjusts based on how much work was done in recent runs,
 * but is always clamped within these bounds.
 *
 * @see memory-lifecycle.js — computeAdaptiveInterval
 */
export const ADAPTIVE_MIN_INTERVAL = 10;
export const ADAPTIVE_MAX_INTERVAL = 60;

/**
 * Adaptive interval multipliers.
 * Applied multiplicatively based on signals from the previous lifecycle run.
 *
 * WORK_DONE: Number of merges/compressions/reorgs performed.
 *- ≥ 8items → multiply interval by 0.5 (run sooner, lots of churn)
 *   - ≥ 4 items →0.7
 *   - ≥ 2 items → 0.85
 *
 * DUPLICATES_FOUND: Duplicate pairs detected (even if merge was skipped).
 *   - ≥ 5 → 0.5(many dupes, run sooner to catch more)
 *   - ≥ 2 → 0.7
 *
 * CONTRADICTIONS: Inconsistencies found in cross-validation audit.
 *   - ≥ 3 → 0.6 (significant data quality issues)
 *   - ≥ 1 → 0.8
 *
 * QUIET: No activity at all → 1.5(relax, check less often).
 *
 * @see memory-lifecycle.js — computeAdaptiveInterval
 */
export const ADAPTIVE_MULTIPLIERS = Object.freeze({
    workDone: [
        { threshold: 8, multiplier: 0.5 },
        { threshold: 4, multiplier: 0.7 },
        { threshold: 2, multiplier: 0.85 },
    ],
    duplicatesFound: [
        { threshold: 5, multiplier: 0.5 },
        { threshold: 2, multiplier: 0.7 },
    ],
    contradictions: [
        { threshold: 3, multiplier: 0.6 },
        { threshold: 1, multiplier: 0.8 },
    ],
    quiet: 1.5,
});

/**
 * Fraction of the lifecycle batch budget allocated to similarity-ranked
 * (high-priority) entries vs random sampling. 0.6 means 60% of the batch
 * slots go to entries most similar to recently created ones.
 *
 * @see memory-lifecycle.js — buildLifecycleBatch
 */
export const LIFECYCLE_SIMILARITY_BUDGET_RATIO = 0.6;

// ── Post-Turn Processor ──────────────────────────────────────────

/**
 * Maximum existing fact titles sent to the LLM as dedup context
 * during fact extraction. More titles improve dedup accuracy but
 * increase prompt size and cost.
 *
 * @see post-turn-processor.js — analyzeExchange
 */
export const MAX_EXISTING_FACTS = 150;

/**
 * Minimum character mention count across extracted facts before
 * suggesting tracker creation for that character. Avoids premature
 * tracker suggestions for briefly-mentioned characters.
 *
 * @see post-turn-processor.js — checkTrackerSuggestions
 */
export const TRACKER_SUGGESTION_THRESHOLD = 5;

/**
 * Change fraction (0–1) above which a tracker update is flagged
 * as a "large update" and logged with a warning in the activity feed.
 * Helps catch LLM hallucinations that would overwrite tracker content.
 *
 * @see post-turn-processor.js — updateTrackers
 */
export const LARGE_UPDATE_THRESHOLD = 0.6;

/**
 * Cooldown period (ms) after a scene archive before another can be
 * created. Prevents rapid-fire archiving when multiple events fire
 * in quick succession.
 *
 * @see post-turn-processor.js — hasRecentArchive
 */
export const SCENE_ARCHIVE_COOLDOWN_MS = 30_000;

// ── Summary Hierarchy ────────────────────────────────────────────

/**
 * Number of scene summaries accumulated before triggering an
 * act rollup. Higher values produce more detailed act summaries
 * but consume more tokens during rollup.
 *
 * @see summary-hierarchy.js — registerSceneSummary
 */
export const SCENES_PER_ACT = 10;

/**
 * Number of act summaries accumulated before triggering a
 * story summary update. The story summary is the highest-level
 * narrative anchor, always injected into context.
 *
 * @see summary-hierarchy.js — rollupActSummary
 */
export const ACTS_PER_STORY_UPDATE = 3;

// ── Arc Tracker ──────────────────────────────────────────────────

/**
 * Maximum status history entries retained per narrative arc.
 * Older status changes are dropped FIFO to keep metadata bounded.
 *
 * @see arc-tracker.js — processArcUpdates
 */
export const ARC_MAX_HISTORY = 10;

/**
 * Number of turns after an arc is resolved/abandoned during which
 * it is still included in the prompt injection. Gives the AI a
 * few turns to wrap up references before the arc fades out.
 *
 * @see arc-tracker.js — buildArcsSummary / buildArcsContextBlock
 */
export const RECENT_RESOLVED_ARC_TURNS = 5;

// ── UI / Display ─────────────────────────────────────────────────

/**
 * Budget recommendation heuristic: suggest15% of the model's
 * context window as the TunnelVision injection budget, rounded
 * to the nearest 500 chars for clean display.
 *
 * @see ui-controller.js — updateBudgetRecommendation
 */
export const BUDGET_RECOMMENDATION_RATIO = 0.15;
export const BUDGET_RECOMMENDATION_MAX = 8000;
export const BUDGET_RECOMMENDATION_ROUND_TO = 500;

// ── LLM Sidecar / Circuit Breaker ────────────────────────────────

/**
 * Number of consecutive sidecar failures before the circuit breaker
 * opens and stops sending requests (avoiding repeated timeouts).
 *
 * @see llm-sidecar.js — recordFailure
 */
export const CIRCUIT_BREAKER_THRESHOLD = 3;

/**
 * Cooldown duration (ms) after the circuit breaker opens before
 * it allows a new probe request. 5 minutes is long enough for
 * most transient API issues to resolve.
 *
 * @see llm-sidecar.js — isCircuitOpen
 */
export const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Default timeout (ms) for a single sidecar LLM generation request.
 * Prevents indefinite hangs when the endpoint is unresponsive.
 *
 * Sized for slow providers: retrieval and writer prompts are large, and a
 * backend running at a few tokens/sec can legitimately take over a minute.
 * Too tight a value shows up as AbortError, which trips the circuit breaker
 * and silently disables the sidecar.
 *
 * @see llm-sidecar.js — sidecarGenerate
 */
export const SIDECAR_DEFAULT_TIMEOUT_MS = 90_000;

/**
 * Timeout (ms) for sidecar connectivity tests. Shorter than the
 * generation timeout since connectivity checks use minimal prompts.
 *
 * @see llm-sidecar.js — testSidecarConnectivity
 */
export const SIDECAR_CONNECTIVITY_TIMEOUT_MS = 15_000;