/**
 * TunnelVision Embedding Cache
 *
 * Caches entry-level text embeddings and provides cosine similarity scoring
 * for the smart context pipeline. Embeddings are computed lazily via the
 * sidecar transport and invalidated when entry content changes.
 *
 * Storage: two-tier — fast in-memory Map + persistent localforage store
 * (IndexedDB with automatic fallback) keyed by "bookName:uid:contentHash".
 * On load, the in-memory cache is hydrated from the persistent store so
 * only entries whose content changed need recomputation.
 * Entries older than EMBEDDING_CACHE_TTL_DAYS are evicted on hydration.
 */

import { isEmbeddingSupported, computeEmbeddings } from "./llm-sidecar.js";
import { hashString } from "./shared-utils.js";
import {
  EMBEDDING_MAX_BATCH_SIZE,
  EMBEDDING_MAX_TEXT_LENGTH,
  EMBEDDING_CACHE_TTL_DAYS,
  EMBEDDING_SIMILARITY_BOOSTS,
} from "./constants.js";

/** @type {Map<string, {embedding: number[], contentHash: number}>} */
const _cache = new Map();

const STORE_NAME = "TunnelVisionEmbeddings";
const TTL_MS = EMBEDDING_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;

// ── Availability ─────────────────────────────────────────────────

/**
 * Check if embedding-based similarity is available (sidecar configured + supports embeddings).
 * @returns {boolean}
 */
export function isEmbeddingAvailable() {
  return isEmbeddingSupported();
}

// ── Cosine Similarity ────────────────────────────────────────────

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

// ── Persistent Store (localforage) ───────────────────────────────

/** @type {import('localforage')|null} */
let _store = null;

function getStore() {
  if (_store) return _store;
  try {
    const lf = globalThis.SillyTavern?.libs?.localforage;
    if (!lf) return null;
    _store = lf.createInstance({ name: STORE_NAME });
    return _store;
  } catch (e) {
    console.warn(
      "[TunnelVision] localforage unavailable, embeddings will be memory-only:",
      e.message,
    );
    return null;
  }
}

function persistKey(bookName, uid, contentHash) {
  return `${bookName}:${uid}:${contentHash}`;
}

// ── Hydration ────────────────────────────────────────────────────

let _hydrated = false;

/**
 * Hydrate the in-memory cache from the persistent store. Evicts entries older than TTL.
 * Called once on first use.
 */
async function hydrateFromStore() {
  if (_hydrated) return;
  _hydrated = true;

  const store = getStore();
  if (!store) return;

  const now = Date.now();
  const staleKeys = [];
  let loaded = 0;

  try {
    await store.iterate((record, key) => {
      if (!record?.embedding) return;

      if (record.storedAt && now - record.storedAt > TTL_MS) {
        staleKeys.push(key);
        return;
      }

      const parts = key.split(":");
      if (parts.length < 3) return;
      const contentHash = Number(parts[parts.length - 1]);
      const memKey = parts.slice(0, parts.length - 1).join(":");
      _cache.set(memKey, { embedding: record.embedding, contentHash });
      loaded++;
    });
  } catch (e) {
    console.debug(
      "[TunnelVision] Embedding hydration failed (non-critical):",
      e.message,
    );
    return;
  }

  if (staleKeys.length > 0) {
    Promise.all(
      staleKeys.map((k) => store.removeItem(k).catch(() => {})),
    ).catch(() => {});
    console.debug(
      `[TunnelVision] Evicted ${staleKeys.length} stale embedding(s)`,
    );
  }

  if (loaded > 0) {
    console.debug(
      `[TunnelVision] Hydrated ${loaded} embedding(s) from persistent store`,
    );
  }
}

// ── Cache Operations ─────────────────────────────────────────────

function getMemCacheKey(bookName, uid) {
  return `${bookName}:${uid}`;
}

function getCachedEmbedding(bookName, uid, contentHash) {
  const key = getMemCacheKey(bookName, uid);
  const cached = _cache.get(key);
  if (cached && cached.contentHash === contentHash) return cached.embedding;
  return null;
}

function setCachedEmbedding(bookName, uid, contentHash, embedding) {
  const key = getMemCacheKey(bookName, uid);
  _cache.set(key, { embedding, contentHash });

  const store = getStore();
  if (store) {
    store
      .setItem(persistKey(bookName, uid, contentHash), {
        embedding,
        contentHash,
        storedAt: Date.now(),
      })
      .catch(() => {});
  }
}

/** Clear all cached embeddings (both in-memory and persistent store). */
export function clearEmbeddingCache() {
  _cache.clear();
  const store = getStore();
  if (store) store.clear().catch(() => {});
}

// ── Batch Embedding ──────────────────────────────────────────────

/**
 * Ensure embeddings are cached for a set of entries, computing any missing ones.
 * On first call, hydrates from persistent store so saved embeddings are reused.
 * @param {Array<{entry: Object, bookName: string}>} candidates
 * @returns {Promise<void>}
 */
async function ensureEmbeddings(candidates) {
  await hydrateFromStore();

  const missing = [];

  for (const c of candidates) {
    const content = (c.entry.content || "").trim();
    const text = ((c.entry.comment || "") + " " + content).substring(
      0, EMBEDDING_MAX_TEXT_LENGTH,
    );
    const hash = hashString(text);
    const existing = getCachedEmbedding(c.bookName, c.entry.uid, hash);
    if (!existing) {
      missing.push({ candidate: c, text, hash });
    }
  }

  if (missing.length === 0) return;

  for (let i = 0; i < missing.length; i += EMBEDDING_MAX_BATCH_SIZE) {
    const batch = missing.slice(i, i + EMBEDDING_MAX_BATCH_SIZE);
    try {
      const texts = batch.map((m) => m.text);
      const embeddings = await computeEmbeddings(texts);
      for (let j = 0; j < batch.length; j++) {
        if (embeddings[j]) {
          setCachedEmbedding(
            batch[j].candidate.bookName,
            batch[j].candidate.entry.uid,
            batch[j].hash,
            embeddings[j],
          );
        }
      }
    } catch (e) {
      console.debug("[TunnelVision] Embedding batch failed:", e.message);
      break;
    }
  }
}

// ── Similarity Scoring ───────────────────────────────────────────

/**
 * Compute embedding similarity boosts for candidates against recent chat text.
 * Returns a Map of UID → bonus score (0–8 range).
 * @param {Array<{entry: Object, bookName: string, score: number}>} candidates
 * @param {string} recentText - Lowercased recent chat text
 * @returns {Promise<Map<number, number>>}
 */
export async function getEmbeddingSimilarityBoosts(candidates, recentText) {
  const boosts = new Map();

  if (candidates.length === 0 || !recentText) return boosts;

  await ensureEmbeddings(candidates);

  let chatEmbedding;
  try {
    const chatSnippet = recentText.substring(0, EMBEDDING_MAX_TEXT_LENGTH);
    const embeddings = await computeEmbeddings([chatSnippet]);
    chatEmbedding = embeddings?.[0];
  } catch {
    return boosts;
  }
  if (!chatEmbedding) return boosts;

  for (const c of candidates) {
    const content = (c.entry.content || "").trim();
    const text = ((c.entry.comment || "") + " " + content).substring(
      0,
      EMBEDDING_MAX_TEXT_LENGTH,
    );
    const hash = hashString(text);
    const entryEmbedding = getCachedEmbedding(c.bookName, c.entry.uid, hash);
    if (!entryEmbedding) continue;

    const similarity = cosineSimilarity(chatEmbedding, entryEmbedding);

    let boost = 0;
    for (const tier of EMBEDDING_SIMILARITY_BOOSTS) {
      if (similarity >= tier.minSimilarity) { boost = tier.boost; break; }
    }
    if (boost > 0) boosts.set(c.entry.uid, boost);
  }

  return boosts;
}
