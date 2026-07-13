/**
 * TunnelVision LLM Sidecar
 *
 * Direct API calls to user-configured LLM + embedding endpoints. Config lives in
 * extension_settings.TunnelVision.sidecarProfile / .embeddingProfile — each object
 * carries its OWN apiKey. No SillyTavern secrets are read, so allowKeysExposure is
 * not required (issue #29). Three call formats: openai-compatible, anthropic, google.
 *
 * Falls back to ST's generateRaw (handled by callers) when the sidecar is not enabled.
 */

import { getSettings } from './tree-store.js';
import { SIDECAR_DEFAULT_TIMEOUT_MS } from './constants.js';

const MODULE_NAME = 'TunnelVision';
const THINK_BLOCK_RE = /<think[\s\S]*?<\/think>/gi;

// ─── Circuit Breaker ────────────────────────────────────────────────
// Opens after BREAKER_THRESHOLD consecutive sidecarGenerate failures; a single
// success resets it. Prevents hammering a misconfigured endpoint.
const BREAKER_THRESHOLD = 3;
let _failureCount = 0;
let _breakerOpen = false;

export function resetCircuitBreaker() {
    _failureCount = 0;
    _breakerOpen = false;
}

function _recordFailure() {
    _failureCount += 1;
    if (_failureCount >= BREAKER_THRESHOLD) _breakerOpen = true;
}

function _recordSuccess() {
    _failureCount = 0;
    _breakerOpen = false;
}

// ─── Config Resolution ──────────────────────────────────────────────

/**
 * Resolve the sidecar generation config from settings.
 * @returns {{endpoint:string, apiKey:string, model:string, format:string, maxTokens:number, temperature:number}|null}
 */
export function getSidecarConfig() {
    const p = getSettings()?.sidecarProfile;
    if (!p || typeof p !== 'object') return null;
    if (!p.enabled) return null;
    const endpoint = String(p.endpoint || '').trim();
    const apiKey = String(p.apiKey || '').trim();
    if (!endpoint || !apiKey) return null;
    return {
        endpoint,
        apiKey,
        model: String(p.model || '').trim(),
        format: String(p.format || 'openai').trim().toLowerCase(),
        maxTokens: typeof p.maxTokens === 'number' ? p.maxTokens : 1000,
        temperature: typeof p.temperature === 'number' ? p.temperature : 0.3,
    };
}

/** True when sidecar is fully configured and the circuit breaker is closed. */
export function isSidecarConfigured() {
    return !_breakerOpen && getSidecarConfig() !== null;
}

/** Display label for the activity feed. */
export function getSidecarModelLabel() {
    const config = getSidecarConfig();
    if (!config) return null;
    return config.model || 'sidecar';
}

/**
 * Resolve the embedding config from settings. apiKey may be empty (local endpoints).
 * @returns {{endpoint:string, apiKey:string, model:string, format:string}|null}
 */
export function getEmbeddingConfig() {
    const p = getSettings()?.embeddingProfile;
    if (!p || typeof p !== 'object') return null;
    if (!p.enabled) return null;
    const endpoint = String(p.endpoint || '').trim();
    if (!endpoint) return null;
    return {
        endpoint,
        apiKey: String(p.apiKey || '').trim(),
        model: String(p.model || '').trim(),
        format: String(p.format || 'openai').trim().toLowerCase(),
    };
}

/** True when an embedding endpoint is configured with a supported format. */
export function isEmbeddingSupported() {
    const config = getEmbeddingConfig();
    if (!config) return false;
    return ['openai', 'google', 'gemini'].includes(config.format);
}

// ─── HTTP helper ────────────────────────────────────────────────────

async function _fetchJson(url, options, label) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SIDECAR_DEFAULT_TIMEOUT_MS);
    let response;
    try {
        response = await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
    if (!response.ok) {
        let detail = '';
        try { detail = await response.text(); } catch { /* body may be absent */ }
        if (detail && detail.length > 300) detail = detail.slice(0, 300) + '… (truncated)';
        throw new Error(`${label} HTTP ${response.status}${detail ? ` — ${detail}` : ''}`);
    }
    return response.json();
}

// ─── Endpoint normalization ─────────────────────────────────────────

function _normalizeChatEndpoint(endpoint) {
    if (/\/chat\/completions$/.test(endpoint)) return endpoint;
    if (/\/v\d+$/.test(endpoint)) return endpoint.replace(/\/+$/, '') + '/chat/completions';
    return endpoint; // custom proxy path — use as-is
}

function _modelsBase(endpoint) {
    const base = endpoint.replace(/\/+$/, '');
    return /\/models$/.test(base) ? base : base + '/models';
}

// ─── Generation ─────────────────────────────────────────────────────

/**
 * Generate text via a direct API call using the configured sidecar profile.
 * @param {{prompt:string, systemPrompt?:string}} opts
 * @returns {Promise<string>}
 */
export async function sidecarGenerate({ prompt, systemPrompt }) {
    if (_breakerOpen) {
        throw new Error('Sidecar circuit breaker open — too many consecutive failures. Check the Sidecar LLM configuration.');
    }
    const config = getSidecarConfig();
    if (!config) {
        throw new Error('Sidecar not configured: enable and fill in the Sidecar LLM profile in TunnelVision settings.');
    }
    const { endpoint, apiKey, model, format, maxTokens, temperature } = config;
    try {
        let result;
        if (format === 'anthropic') {
            result = await _callAnthropic({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens });
        } else if (format === 'google') {
            result = await _callGoogle({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens });
        } else {
            result = await _callOpenAI({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens });
        }
        _recordSuccess();
        return typeof result === 'string' ? result.replace(THINK_BLOCK_RE, '').trim() : result;
    } catch (error) {
        _recordFailure();
        throw error;
    }
}

async function _callOpenAI({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens }) {
    const url = _normalizeChatEndpoint(endpoint);
    const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
    if (/openrouter\.ai/i.test(url)) {
        headers['HTTP-Referer'] = (typeof window !== 'undefined' && window.location?.origin) || 'https://sillytavern.app';
        headers['X-Title'] = 'TunnelVision';
    }
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });
    const data = await _fetchJson(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens }),
    }, 'Sidecar');
    return data.choices?.[0]?.message?.content || '';
}

async function _callAnthropic({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens }) {
    const url = /\/messages$/.test(endpoint) ? endpoint : endpoint.replace(/\/+$/, '') + '/messages';
    const data = await _fetchJson(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            temperature,
            system: systemPrompt || '',
            messages: [{ role: 'user', content: prompt }],
        }),
    }, 'Sidecar');
    const block = Array.isArray(data.content)
        ? data.content.find(b => b.type === 'text' || typeof b.text === 'string')
        : null;
    return block?.text || '';
}

async function _callGoogle({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens }) {
    const url = `${_modelsBase(endpoint)}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;
    const data = await _fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
            generationConfig: { temperature, maxOutputTokens: maxTokens },
        }),
    }, 'Sidecar');
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// ─── Embeddings ─────────────────────────────────────────────────────

/**
 * Compute embeddings for a batch of texts using the configured embedding profile.
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
export async function computeEmbeddings(texts) {
    const config = getEmbeddingConfig();
    if (!config) {
        throw new Error('Embedding not configured: enable and fill in the Embedding profile in TunnelVision settings.');
    }
    const { endpoint, apiKey, model, format } = config;
    if (format === 'google' || format === 'gemini') {
        return _embedGoogle({ endpoint, apiKey, model, texts });
    }
    return _embedOpenAI({ endpoint, apiKey, model, texts });
}

async function _embedOpenAI({ endpoint, apiKey, model, texts }) {
    const url = /\/embeddings$/.test(endpoint) ? endpoint : endpoint.replace(/\/+$/, '') + '/embeddings';
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const data = await _fetchJson(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, input: texts }),
    }, 'Embedding');
    return (data.data || []).map(d => d.embedding);
}

async function _embedGoogle({ endpoint, apiKey, model, texts }) {
    const url = `${_modelsBase(endpoint)}/${model}:batchEmbedContents?key=${encodeURIComponent(apiKey)}`;
    const requests = texts.map(text => ({ model: `models/${model}`, content: { parts: [{ text }] } }));
    const data = await _fetchJson(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
    }, 'Embedding');
    return (data.embeddings || []).map(e => e.values);
}

// ─── Connectivity tests ─────────────────────────────────────────────

export async function testSidecarConnectivity() {
    const config = getSidecarConfig();
    if (!config) return { ok: false, message: 'No sidecar configuration to test.', latencyMs: 0 };
    const start = Date.now();
    try {
        const text = await sidecarGenerate({ prompt: 'Reply with the single word: OK' });
        const latencyMs = Date.now() - start;
        if (!text || !String(text).trim()) {
            return { ok: false, message: 'Empty response from sidecar endpoint.', latencyMs };
        }
        return { ok: true, message: `Connected (${latencyMs} ms).`, latencyMs };
    } catch (error) {
        return { ok: false, message: `Connection failed: ${error.message}`, latencyMs: Date.now() - start };
    }
}

export async function testEmbeddingConnectivity() {
    const config = getEmbeddingConfig();
    if (!config) return { ok: false, message: 'No embedding configuration to test.', latencyMs: 0 };
    const start = Date.now();
    try {
        const vectors = await computeEmbeddings(['TunnelVision connectivity test']);
        const latencyMs = Date.now() - start;
        const dims = Array.isArray(vectors?.[0]) ? vectors[0].length : 0;
        if (!dims) return { ok: false, message: 'Empty embedding response.', latencyMs };
        return { ok: true, message: `Connected — ${config.model || 'model'} (dimensions: ${dims}).`, latencyMs };
    } catch (error) {
        return { ok: false, message: `Connection failed: ${error.message}`, latencyMs: Date.now() - start };
    }
}
