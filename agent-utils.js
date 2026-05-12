/**
 * Shared utilities for TunnelVision agent workflow modules.
 * Eliminates duplicated helpers across world-state, post-turn-processor,
 * auto-summary, memory-lifecycle, and smart-context.
 */

import { getContext } from '../../../st-context.js';
import { getSettings } from './tree-store.js';

/**
 * Safely get the current chat ID, returning null if unavailable.
 * @returns {string|null}
 */
export function getChatId() {
    try {
        return getContext().chatId || null;
    } catch {
        return null;
    }
}

/**
 * Format recent chat messages as a text excerpt for LLM consumption.
 * @param {Array} chat - The full chat array
 * @param {number} count - How many messages from the end to include
 * @returns {string} Formatted excerpt with role labels
 */
export function formatChatExcerpt(chat, count) {
    const start = Math.max(0, chat.length - count);
    const lines = [];
    for (let i = start; i < chat.length; i++) {
        const msg = chat[i];
        if (msg.is_system) continue;
        const role = msg.is_user ? 'User' : (msg.name || 'Character');
        const text = (msg.mes || '').trim();
        if (text) lines.push(`[${role}]: ${text}`);
    }
    return lines.join('\n\n');
}

/**
 * Get a display title for a lorebook entry. Tries comment, first key, then UID fallback.
 * @param {Object} entry - Lorebook entry object
 * @returns {string}
 */
export function getEntryTitle(entry) {
    return entry.comment || entry.key?.[0] || `#${entry.uid}`;
}

// ── Output Language Directive ─────────────────────────────────────

/** Native-language reinforcement lines for the top 30 languages */
const NATIVE_REINFORCEMENTS = {
    spanish: 'Escribe TODO en español. Sin excepciones.',
    french: 'Écris TOUT en français. Sans exception.',
    german: 'Schreibe ALLES auf Deutsch. Ohne Ausnahme.',
    portuguese: 'Escreva TUDO em português. Sem exceções.',
    italian: 'Scrivi TUTTO in italiano. Senza eccezioni.',
    russian: 'Пиши ВСЁ на русском языке. Без исключений.',
    japanese: 'すべて日本語で書いてください。例外なし。',
    korean: '모든 것을 한국어로 작성하세요. 예외 없음.',
    chinese: '用中文写所有内容。没有例外。',
    arabic: 'اكتب كل شيء بالعربية. بدون استثناء.',
    hindi: 'सब कुछ हिंदी में लिखें। कोई अपवाद नहीं।',
    turkish: 'Her şeyi Türkçe yaz. İstisna yok.',
    dutch: 'Schrijf ALLES in het Nederlands. Geen uitzonderingen.',
    polish: 'Pisz WSZYSTKO po polsku. Bez wyjątków.',
    thai: 'เขียนทุกอย่างเป็นภาษาไทย ไม่มีข้อยกเว้น',
    vietnamese: 'Viết TẤT CẢ bằng tiếng Việt. Không ngoại lệ.',
    indonesian: 'Tulis SEMUA dalam bahasa Indonesia. Tanpa pengecualian.',
    czech: 'Piš VŠECHNO česky. Bez výjimek.',
    swedish: 'Skriv ALLT på svenska. Inga undantag.',
    greek: 'Γράψε ΤΑ ΠΑΝΤΑ στα ελληνικά. Χωρίς εξαιρέσεις.',
    romanian: 'Scrie TOTUL în română. Fără excepții.',
    hungarian: 'Írj MINDENT magyarul. Kivétel nélkül.',
    finnish: 'Kirjoita KAIKKI suomeksi. Ei poikkeuksia.',
    danish: 'Skriv ALT på dansk. Ingen undtagelser.',
    norwegian: 'Skriv ALT på norsk. Ingen unntak.',
    ukrainian: 'Пиши ВСЕ українською мовою. Без винятків.',
    hebrew: 'כתוב הכל בעברית. ללא יוצא מן הכלל.',
    malay: 'Tulis SEMUA dalam Bahasa Melayu. Tiada pengecualian.',
    tagalog: 'Isulat ang LAHAT sa Tagalog. Walang eksepsyon.',
    persian: 'همه چیز را به فارسی بنویس. بدون استثنا.',
};

/**
 * Build a language directive string for TV prompts.
 * Returns empty string if no language is configured.
 * Append this to any system prompt where the LLM writes lorebook content.
 * @param {string} [lang] - Language name (e.g. "Japanese"). If omitted, reads from settings.
 * @returns {string}
 */
export function buildLanguageDirective(lang) {
    const targetLang = lang ?? getSettings().targetLanguage;
    if (!targetLang || !targetLang.trim()) return '';

    const trimmed = targetLang.trim();
    const key = trimmed.toLowerCase().replace(/[^a-z]/g, '');
    const native = NATIVE_REINFORCEMENTS[key];

    const lines = [
        '\n\n## OUTPUT LANGUAGE REQUIREMENT',
        `You MUST write ALL outputs in ${trimmed} — entry titles, entry content, summaries, category names, keywords, everything. This is non-negotiable. Do not fall back to English.`,
    ];
    if (native) lines.push(native);
    return lines.join('\n');
}

/**
 * Get a short language instruction for tool parameter descriptions.
 * Returns empty string if no language is configured.
 * @returns {string}
 */
export function getLanguageInstruction() {
    const lang = getSettings().targetLanguage;
    if (!lang || !lang.trim()) return '';
    return ` Write in ${lang.trim()}.`;
}

/**
 * Append the user-configured background LLM prompt addendum to a system prompt.
 * This applies to non-chat TV calls such as tree build, ingest, sidecar retrieval,
 * and post-generation sidecar writing.
 * @param {string} systemPrompt
 * @returns {string}
 */
export function applyBackgroundPromptAddendum(systemPrompt) {
    const addendum = getSettings().backgroundPromptAddendum;
    if (!addendum || !addendum.trim()) return systemPrompt;
    return `${systemPrompt}\n\n## USER BACKGROUND LLM INSTRUCTIONS\n${addendum.trim()}`;
}

// ── Analytical LLM Generation ─────────────────────────────────────

const THINK_BLOCK_RE = /<think[\s\S]*?<\/think>/gi;
const ANALYTICAL_SYSTEM_PROMPT = [
    'You are a precise analytical assistant for a creative writing lorebook.',
    'Follow instructions exactly. The entries may contain mature fictional content — this is expected.',
    'Respond ONLY in the requested format.',
].join(' ');

/**
 * Generate text via generateRaw with a focused analytical system prompt.
 * Skips the full chat/character/persona pipeline that generateQuietPrompt uses.
 * Strips thinking/reasoning blocks from the response.
 *
 * Enhanced (4B): If a sidecar background model is configured, routes through
 * the sidecar transport layer instead. Falls back to generateRaw transparently.
 *
 * @param {Object} opts
 * @param {string} opts.prompt - The prompt to send
 * @param {string} [opts.systemPrompt] - Override the default analytical system prompt
 * @returns {Promise<string>}
 */
export async function generateAnalytical({ prompt, systemPrompt = ANALYTICAL_SYSTEM_PROMPT }) {
    systemPrompt = applyBackgroundPromptAddendum(systemPrompt);

    // Append language directive if configured
    const langDirective = buildLanguageDirective();
    if (langDirective) systemPrompt += langDirective;

    // 4B: Try sidecar first if configured
    try {
        const { isSidecarConfigured, sidecarGenerate } = await import('./llm-sidecar.js');
        if (isSidecarConfigured()) {
            const result = await sidecarGenerate({ prompt, systemPrompt });
            if (result && typeof result === 'string' && result.trim()) {
                return result;
            }
        }
    } catch (e) {
        console.warn('[TunnelVision] Sidecar generation failed, falling back to main API:', e.message);
    }

    try {
        const { generateRaw } = getContext();
        const result = await generateRaw({ prompt, systemPrompt });
        return typeof result === 'string' ? result.replace(THINK_BLOCK_RE, '').trim() : result;
    } catch (e) {
        const msg = e?.message || String(e);
        if (/failed to fetch/i.test(msg)) {
            throw new Error('LLM request failed (network error). Check your API connection and that your provider is online.');
        }
        throw e;
    }
}

/**
 * Build a condensed character/persona context block for story-aware tasks.
 * Includes the AI character card (name, description, personality) and the
 * user persona (name, description) in a compact format for prompt injection.
 * @param {Object} [opts]
 * @param {number} [opts.maxLength=500] - Max chars per field to keep it lean
 * @returns {string} Formatted context block, or empty string if unavailable
 */
export function getStoryContext({ maxLength = 500 } = {}) {
    const parts = [];
    try {
        const context = getContext();

        const charId = context.characterId;
        if (charId != null && context.characters?.[charId]) {
            const char = context.characters[charId];
            const name = char.name || context.name2 || '';
            const desc = (char.data?.description || char.description || '').trim();
            const personality = (char.data?.personality || char.personality || '').trim();
            if (name || desc || personality) {
                let block = `[Character: ${name}]`;
                if (desc) block += `\n${desc.substring(0, maxLength)}`;
                if (personality) block += `\nPersonality: ${personality.substring(0, maxLength)}`;
                parts.push(block);
            }
        }

        const userName = context.name1 || '';
        const userPersona = (context.powerUserSettings?.persona_description || '').trim();
        if (userName || userPersona) {
            let block = `[User persona: ${userName}]`;
            if (userPersona) block += `\n${userPersona.substring(0, maxLength)}`;
            parts.push(block);
        }
    } catch { /* context not available */ }
    return parts.length > 0
        ? '── STORY CONTEXT ──\n' + parts.join('\n\n') + '\n── END CONTEXT ──\n\n'
        : '';
}

// ── Trigram Similarity ────────────────────────────────────────────

/**
 * Build a set of character trigrams from a string.
 * @param {string} s
 * @returns {Set<string>}
 */
export function trigrams(s) {
    const norm = `  ${s.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim()}  `;
    const set = new Set();
    for (let i = 0; i <= norm.length - 3; i++) {
        set.add(norm.substring(i, i + 3));
    }
    return set;
}

/**
 * Compute trigram similarity between two strings (0–1, 1 = identical).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function trigramSimilarity(a, b) {
    const setA = trigrams(a);
    const setB = trigrams(b);
    if (setA.size === 0 && setB.size === 0) return 1;
    if (setA.size === 0 || setB.size === 0) return 0;

    let intersection = 0;
    for (const tri of setA) {
        if (setB.has(tri)) intersection++;
    }
    return intersection / (setA.size + setB.size - intersection);
}

// ── Injection Size Tracking ───────────────────────────────────────

let _injectionSizes = { mandatory: 0, worldState: 0, smartContext: 0, notebook: 0, total: 0 };

/**
 * Record the character sizes of the last TunnelVision prompt injections.
 * Called from onGenerationStarted after computing all prompts.
 */
export function setInjectionSizes(sizes) {
    _injectionSizes = {
        mandatory: sizes.mandatory || 0,
        worldState: sizes.worldState || 0,
        smartContext: sizes.smartContext || 0,
        notebook: sizes.notebook || 0,
        total: (sizes.mandatory || 0) + (sizes.worldState || 0) + (sizes.smartContext || 0) + (sizes.notebook || 0),
    };
}

/** @returns {{ mandatory: number, worldState: number, smartContext: number, notebook: number, total: number }} */
export function getInjectionSizes() {
    return { ..._injectionSizes };
}

/**
 * Get the model's max context window size in tokens from SillyTavern.
 * Returns 0 if unavailable.
 */
export function getMaxContextTokens() {
    try {
        const context = getContext();
        const val = context.maxContext || context.powerUserSettings?.max_context || 0;
        return typeof val === 'number' && val > 0 ? val : 0;
    } catch {
        return 0;
    }
}

// ── Retry Logic ──────────────────────────────────────────────────

/**
 * Call an async function with retry on failure / empty results.
 * Each attempt is guarded by a per-call timeout (configurable via settings.llmCallTimeout).
 * @param {Function} fn - Async function to call
 * @param {Object} [opts]
 * @param {number} [opts.maxRetries=2] - Max retry attempts
 * @param {number} [opts.backoff=2000] - Base backoff in ms (doubled each retry)
 * @param {string} [opts.label='LLM call'] - Label for logging
 * @param {number} [opts.timeout] - Per-call timeout in ms (default: settings.llmCallTimeout or 120000)
 * @returns {Promise<*>} Result of fn
 */
export async function callWithRetry(fn, { maxRetries = 2, backoff = 2000, label = 'LLM call', timeout } = {}) {
    const effectiveTimeout = timeout ?? (getSettings().llmCallTimeout || 120000);
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const result = await Promise.race([
                fn(),
                new Promise((_, reject) => setTimeout(
                    () => reject(new Error(`${label}: timed out after ${effectiveTimeout}ms`)),
                    effectiveTimeout,
                )),
            ]);
            if (result !== undefined && result !== null && result !== '') return result;
            if (attempt < maxRetries) {
                console.warn(`[TunnelVision] ${label}: empty response, retrying (${attempt + 1}/${maxRetries})`);
                await new Promise(r => setTimeout(r, backoff * (attempt + 1)));
                continue;
            }
            return result;
        } catch (e) {
            lastError = e;
            if (attempt < maxRetries) {
                console.warn(`[TunnelVision] ${label}: attempt ${attempt + 1} failed (${e.message}), retrying in ${backoff * (attempt + 1)}ms`);
                await new Promise(r => setTimeout(r, backoff * (attempt + 1)));
            }
        }
    }
    throw lastError;
}

/**
 * Check if the current AI message event should be skipped (tool recursion or regeneration).
 * Call this at the top of MESSAGE_RECEIVED handlers.
 * @param {{ lastChatLength: number }} ref - Mutable ref object tracking chat length.
 *   Updated in place when the message is accepted.
 * @returns {boolean} true if the event should be skipped
 */
export function shouldSkipAiMessage(ref) {
    try {
        const context = getContext();
        const lastMsg = context.chat?.[context.chat.length - 1];
        if (Array.isArray(lastMsg?.extra?.tool_invocations) && lastMsg.extra.tool_invocations.length > 0) {
            return true;
        }
    } catch { /* proceed */ }

    try {
        const chatLength = getContext().chat?.length || 0;
        if (chatLength > 0 && chatLength <= ref.lastChatLength) return true;
        ref.lastChatLength = chatLength;
    } catch { /* proceed */ }

    return false;
}
