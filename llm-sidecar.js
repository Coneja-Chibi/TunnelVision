/**
 * TunnelVision LLM Sidecar
 * Direct API calls to LLM providers for tree building, summarization, and ingest.
 * Bypasses ST's generateRaw to give TV full control over its own samplers.
 *
 * Reads provider, model, and endpoint from a Connection Manager profile, then
 * fetches the API key from ST's secrets store. The user never has to configure
 * anything beyond picking a profile -- same UX as before, but now we make direct
 * fetch() calls instead of switching ST's active connection.
 *
 * Modeled on Lumiverse's summarization.js sidecar pattern:
 *   - fetchSecretKey() via ST's /api/secrets/find endpoint
 *   - PROVIDER_CONFIG with per-provider endpoint, auth, and response parsing
 *   - Three format branches: openai-compat, anthropic, google
 *
 * Falls back to ST's generateRaw when no connection profile is configured.
 */

import { getContext } from '../../../st-context.js';
import { getSettings, findConnectionProfile } from './tree-store.js';

const MODULE_NAME = 'TunnelVision';

// ─── Provider Mapping ───────────────────────────────────────────────
// Maps ST's chat_completion_source values (stored in profile.api) to
// the API format, default endpoint, and secret key needed for direct calls.

// ─── Circuit Breaker ────────────────────────────────────────────────
// Tripped on the first 403 from /api/secrets/find. Prevents repeated
// attempts when allowKeysExposure is not enabled in ST's config.yaml.
let _secretKeyFailed = false;
let _secretKeyWarningShown = false; // only show the toast once per session

const PROVIDER_MAP = {
    openai:       { format: 'openai',    endpoint: 'https://api.openai.com/v1/chat/completions',              secretKey: 'api_key_openai' },
    claude:       { format: 'anthropic', endpoint: 'https://api.anthropic.com/v1/messages',                   secretKey: 'api_key_claude' },
    openrouter:   { format: 'openai',    endpoint: 'https://openrouter.ai/api/v1/chat/completions',           secretKey: 'api_key_openrouter' },
    makersuite:   { format: 'google',    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',  secretKey: 'api_key_makersuite' },
    google:       { format: 'google',    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models',  secretKey: 'api_key_makersuite' },
    deepseek:     { format: 'openai',    endpoint: 'https://api.deepseek.com/v1/chat/completions',            secretKey: 'api_key_deepseek' },
    mistralai:    { format: 'openai',    endpoint: 'https://api.mistral.ai/v1/chat/completions',              secretKey: 'api_key_mistralai' },
    custom:       { format: 'openai',    endpoint: null,                                                       secretKey: 'api_key_custom' },
    nanogpt:      { format: 'openai',    endpoint: 'https://nano-gpt.com/api/v1/chat/completions',            secretKey: 'api_key_nanogpt' },
    groq:         { format: 'openai',    endpoint: 'https://api.groq.com/openai/v1/chat/completions',         secretKey: 'api_key_groq' },
    chutes:       { format: 'openai',    endpoint: 'https://llm.chutes.ai/v1/chat/completions',               secretKey: 'api_key_chutes' },
    electronhub:  { format: 'openai',    endpoint: 'https://api.electronhub.ai/v1/chat/completions',          secretKey: 'api_key_electronhub' },
    xai:          { format: 'openai',    endpoint: 'https://api.x.ai/v1/chat/completions',                    secretKey: 'api_key_xai' },
};

/**
 * Look up provider info from a profile's `api` field.
 * Falls back to OpenAI-compatible format for unknown providers.
 */
function getProviderInfo(apiSource) {
    return PROVIDER_MAP[apiSource] || { format: 'openai', endpoint: null, secretKey: null };
}

// ─── Secret Key Fetching ────────────────────────────────────────────

/**
 * Fetch an API key from SillyTavern's secrets system.
 * Requires allowKeysExposure: true in ST's config.yaml.
 * @param {string} secretKey - The secret key identifier (e.g. 'api_key_openai')
 * @param {string|null} [secretId] - Optional ST connection-profile secret id
 * @returns {Promise<string|null>} The API key or null if unavailable
 */
export async function fetchSecretKey(secretKey, secretId = null) {
    if (!secretKey) {
        console.warn(`[${MODULE_NAME}] fetchSecretKey called with no key identifier — provider may not be in PROVIDER_MAP`);
        return null;
    }
    if (_secretKeyFailed) {
        console.debug(`[${MODULE_NAME}] fetchSecretKey("${secretKey}"): skipped (circuit breaker tripped from prior 403)`);
        return null;
    }

    console.debug(`[${MODULE_NAME}] Fetching secret key: "${secretKey}" from /api/secrets/find${secretId ? ' with profile secret id' : ''}...`);

    try {
        const response = await fetch('/api/secrets/find', {
            method: 'POST',
            headers: getContext().getRequestHeaders(),
            body: JSON.stringify({ key: secretKey, ...(secretId ? { id: secretId } : {}) }),
        });

        if (!response.ok) {
            if (response.status === 403) {
                _secretKeyFailed = true;
                console.warn(`[${MODULE_NAME}] Secret key access DENIED (403). allowKeysExposure is NOT enabled in config.yaml. Sidecar disabled for this session.`);
                if (!_secretKeyWarningShown) {
                    _secretKeyWarningShown = true;
                    try {
                        toastr.warning(
                            'TunnelVision sidecar disabled: allowKeysExposure is not enabled in ST\'s config.yaml. ' +
                            'Set allowKeysExposure: true and restart ST to use a separate LLM for TV operations.',
                            'TunnelVision Sidecar',
                            { timeOut: 10000 },
                        );
                    } catch { /* toastr may not be loaded yet */ }
                }
            } else {
                console.warn(`[${MODULE_NAME}] Secret key fetch failed: HTTP ${response.status} for "${secretKey}"`);
            }
            return null;
        }

        const data = await response.json();
        const hasValue = !!(data.value);
        console.debug(`[${MODULE_NAME}] Secret key "${secretKey}": ${hasValue ? 'FOUND (key retrieved)' : 'EMPTY (key not set in ST)'}`);
        return data.value || null;
    } catch (error) {
        console.error(`[${MODULE_NAME}] Error fetching secret key "${secretKey}":`, error);
        return null;
    }
}

/**
 * Returns false when the circuit breaker has been tripped by a 403 from /api/secrets/find.
 * Callers can use this to skip sidecar entirely without attempting a fetch.
 * @returns {boolean}
 */
export function isSidecarKeyAvailable() {
    return !_secretKeyFailed;
}

// ─── Think Block Stripping ──────────────────────────────────────────

const THINK_BLOCK_RE = /<think[\s\S]*?<\/think>/gi;

// ─── Main Sidecar Generate ──────────────────────────────────────────

/**
 * Check whether the sidecar is configured (a connection profile is selected).
 * @returns {boolean}
 */
export function isSidecarConfigured() {
    if (_secretKeyFailed) {
        console.debug(`[${MODULE_NAME}] Sidecar check: DISABLED (secret key 403 circuit breaker tripped)`);
        return false;
    }
    const settings = getSettings();
    const profileId = settings.connectionProfile;
    if (!profileId) {
        console.debug(`[${MODULE_NAME}] Sidecar check: NO PROFILE selected in settings`);
        return false;
    }
    const profile = findConnectionProfile(profileId);
    if (!profile) {
        console.debug(`[${MODULE_NAME}] Sidecar check: profile ID "${profileId}" NOT FOUND in Connection Manager`);
        return false;
    }
    const configured = !!(profile.api && profile.model);
    console.debug(`[${MODULE_NAME}] Sidecar check: profile="${profile.name || profileId}" api="${profile.api || 'MISSING'}" model="${profile.model || 'MISSING'}" → ${configured ? 'CONFIGURED' : 'INCOMPLETE'}`);
    return configured;
}

/**
 * Get the resolved sidecar model display string (e.g. "nanogpt/deepseek-chat").
 * Returns null if sidecar is not configured.
 * @returns {string|null}
 */
export function getSidecarModelLabel() {
    const config = resolveProfileConfig();
    if (!config) return null;
    return `${config.provider}/${config.model}`;
}

/**
 * Resolve the connection profile into everything needed for a direct API call.
 * @returns {{ provider: string, format: string, model: string, endpoint: string, secretKey: string|null, secretId: string|null }|null}
 */
function resolveProfileConfig() {
    const settings = getSettings();
    const profileId = settings.connectionProfile;
    if (!profileId) return null;

    const profile = findConnectionProfile(profileId);
    if (!profile?.api || !profile?.model) return null;

    const info = getProviderInfo(profile.api);
    const isKnownProvider = !!PROVIDER_MAP[profile.api];

    // For known providers (those in PROVIDER_MAP with a default endpoint), always use
    // the PROVIDER_MAP endpoint for direct calls. ST stores session-based proxy URLs
    // in profile['api-url'] (e.g. NanoGPT's /api/subscription/v1) which don't work
    // for raw Bearer-token fetch() calls. Only fall back to the profile URL for
    // 'custom' or unknown providers where we have no built-in endpoint.
    let endpoint = info.endpoint || profile['api-url'] || null;
    // ST stores session-based proxy URLs (e.g. /api/subscription/v1) that don't
    // accept Bearer-token auth. Strip the /subscription segment for direct calls.
    if (endpoint && endpoint.includes('/subscription/')) {
        endpoint = endpoint.replace('/subscription/', '/');
        console.debug(`[${MODULE_NAME}] Stripped /subscription from proxy URL for direct API call`);
    }
    if (!info.endpoint && endpoint && info.format === 'openai' && !endpoint.endsWith('/chat/completions')) {
        endpoint = endpoint.replace(/\/+$/, '') + '/chat/completions';
    }

    console.debug(`[${MODULE_NAME}] Resolved sidecar config:`, {
        profileName: profile.name || profileId,
        provider: profile.api,
        knownProvider: isKnownProvider,
        format: info.format,
        model: profile.model,
        endpoint: endpoint || 'NONE',
        secretKeyId: info.secretKey || 'NONE',
        secretId: profile['secret-id'] ? 'set' : 'not set',
        profileUrl: profile['api-url'] || 'not set',
    });

    return {
        provider: profile.api,
        format: info.format,
        model: profile.model,
        endpoint,
        secretKey: info.secretKey,
        secretId: profile['secret-id'] || null,
    };
}

/**
 * Generate text via direct API call, bypassing ST's generateRaw.
 * Reads provider/model/endpoint from the selected Connection Manager profile.
 *
 * @param {Object} opts
 * @param {string} opts.prompt - The user/main prompt text
 * @param {string} [opts.systemPrompt] - Optional system prompt
 * @returns {Promise<string>} The generated text (think blocks stripped)
 * @throws {Error} On missing config, missing API key, or API errors
 */
export async function sidecarGenerate({ prompt, systemPrompt }) {
    console.debug(`[${MODULE_NAME}] sidecarGenerate called (prompt length: ${prompt?.length || 0})`);

    const config = resolveProfileConfig();
    if (!config) {
        throw new Error('Sidecar not configured: no valid connection profile selected.');
    }

    const settings = getSettings();
    const temperature = settings.sidecarTemperature ?? 0.2;
    const maxTokens = settings.sidecarMaxTokens || 2048;

    const { provider, format, model, endpoint, secretKey, secretId } = config;

    if (!endpoint) {
        throw new Error(`No endpoint found for provider "${provider}". Set a Server URL in the connection profile.`);
    }

    // Fetch API key from ST's secrets store
    const apiKey = await fetchSecretKey(secretKey, secretId);
    if (!apiKey) {
        throw new Error(
            `No API key found for "${provider}". Add your key in SillyTavern's API settings and ensure allowKeysExposure is enabled in config.yaml.`,
        );
    }

    console.debug(`[${MODULE_NAME}] Sidecar calling ${format} API: ${provider}/${model} → ${endpoint} (temp=${temperature}, maxTokens=${maxTokens})`);

    let result;

    if (format === 'anthropic') {
        result = await _callAnthropic({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens });
    } else if (format === 'google') {
        result = await _callGoogle({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens });
    } else {
        result = await _callOpenAI({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens, provider });
    }

    // Strip thinking/reasoning blocks
    const cleaned = typeof result === 'string' ? result.replace(THINK_BLOCK_RE, '').trim() : result;
    console.debug(`[${MODULE_NAME}] Sidecar response received: ${typeof cleaned === 'string' ? cleaned.length : 0} chars from ${provider}/${model}`);
    return cleaned;
}

// ─── Provider-Specific Callers ──────────────────────────────────────

/**
 * Anthropic Claude API
 */
async function _callAnthropic({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens }) {
    const requestBody = {
        model,
        max_tokens: maxTokens,
        system: systemPrompt || '',
        messages: [{ role: 'user', content: prompt }],
        temperature,
    };

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        let errorText = await response.text().catch(() => 'Unable to read error');
        if (errorText.length > 300) errorText = errorText.substring(0, 300) + '... (truncated)';
        throw new Error(`Anthropic API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    if (data.content && Array.isArray(data.content)) {
        const textBlock = data.content.find(block => block.type === 'text');
        return textBlock?.text || '';
    }
    return '';
}

/**
 * Google AI Studio (Gemini) API
 */
async function _callGoogle({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens }) {
    const googleEndpoint = `${endpoint}/${model}:generateContent`;

    const fullPrompt = systemPrompt
        ? `${systemPrompt}\n\n---\n\n${prompt}`
        : prompt;

    const requestBody = {
        safetySettings: [
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
        ],
        contents: [
            { role: 'user', parts: [{ text: fullPrompt }] },
        ],
        generationConfig: {
            temperature,
            maxOutputTokens: maxTokens,
        },
    };

    const response = await fetch(googleEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        let errorText = await response.text().catch(() => 'Unable to read error');
        if (errorText.length > 300) errorText = errorText.substring(0, 300) + '... (truncated)';
        throw new Error(`Google AI Studio API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
        return data.candidates[0].content.parts[0].text;
    }
    return '';
}

/**
 * OpenAI-compatible API (OpenAI, OpenRouter, DeepSeek, Groq, custom, etc.)
 */
async function _callOpenAI({ endpoint, apiKey, model, systemPrompt, prompt, temperature, maxTokens, provider }) {
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
    };

    // OpenRouter requires additional headers
    if (provider === 'openrouter') {
        headers['HTTP-Referer'] = window.location.origin;
        headers['X-Title'] = 'TunnelVision';
    }

    const messages = [];
    if (systemPrompt) {
        messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const requestBody = {
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
    };

    const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        let errorText = await response.text().catch(() => 'Unable to read error');
        // Truncate HTML error pages (e.g. 404 from wrong endpoint) to avoid flooding console
        if (errorText.length > 300) errorText = errorText.substring(0, 300) + '... (truncated)';
        throw new Error(`${provider} API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    if (data.choices?.[0]?.message?.content) {
        return data.choices[0].message.content;
    }
    return '';
}
