import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let mockSidecarProfile = null;
let mockEmbeddingProfile = null;

vi.mock('../tree-store.js', () => ({
    getSettings: () => ({ sidecarProfile: mockSidecarProfile, embeddingProfile: mockEmbeddingProfile }),
    getTree: vi.fn(() => null),
    getTrackerUids: vi.fn(() => []),
}));

import {
    isSidecarConfigured,
    getSidecarConfig,
    resetCircuitBreaker,
    isCircuitOpen,
    sidecarGenerate,
    getEmbeddingConfig,
    isEmbeddingSupported,
    computeEmbeddings,
    testSidecarConnectivity,
    testEmbeddingConnectivity,
} from '../llm-sidecar.js';

const validProfile = {
    enabled: true,
    endpoint: 'https://api.example.com/v1',
    apiKey: 'sk-test-key-123',
    model: 'gpt-4o-mini',
    format: 'openai',
    maxTokens: 500,
};

const validEmbeddingProfile = {
    enabled: true,
    endpoint: 'https://embed.example.com/v1',
    apiKey: 'emb-key-123',
    model: 'nomic-embed-text',
    format: 'openai',
};

beforeEach(() => {
    mockSidecarProfile = null;
    mockEmbeddingProfile = null;
    resetCircuitBreaker();
    vi.restoreAllMocks();
});

// ── getSidecarConfig ─────────────────────────────────────────────

describe('getSidecarConfig', () => {
    it('returns null when sidecarProfile is null', () => {
        expect(getSidecarConfig()).toBeNull();
    });

    it('returns null when sidecarProfile is not an object', () => {
        mockSidecarProfile = 'string';
        expect(getSidecarConfig()).toBeNull();
    });

    it('returns null when not enabled', () => {
        mockSidecarProfile = { ...validProfile, enabled: false };
        expect(getSidecarConfig()).toBeNull();
    });

    it('returns null when enabled flag is missing', () => {
        mockSidecarProfile = { endpoint: 'https://example.com', apiKey: 'key' };
        expect(getSidecarConfig()).toBeNull();
    });

    it('returns null when endpoint is empty', () => {
        mockSidecarProfile = { enabled: true, endpoint: '', apiKey: 'key', model: '', format: 'openai' };
        expect(getSidecarConfig()).toBeNull();
    });

    it('returns null when apiKey is empty', () => {
        mockSidecarProfile = { enabled: true, endpoint: 'https://example.com', apiKey: '', model: '', format: 'openai' };
        expect(getSidecarConfig()).toBeNull();
    });

    it('returns structured config for valid profile', () => {
        mockSidecarProfile = { ...validProfile };
        const config = getSidecarConfig();
        expect(config).toEqual({
            endpoint: 'https://api.example.com/v1',
            apiKey: 'sk-test-key-123',
            model: 'gpt-4o-mini',
            format: 'openai',
            maxTokens: 500,
            temperature: 0.3,
        });
    });

    it('trims whitespace from config values', () => {
        mockSidecarProfile = { enabled: true, endpoint: '  https://api.example.com  ', apiKey: ' key ', model: ' model ', format: ' OpenAI ' };
        const config = getSidecarConfig();
        expect(config.endpoint).toBe('https://api.example.com');
        expect(config.apiKey).toBe('key');
        expect(config.model).toBe('model');
        expect(config.format).toBe('openai');
    });

    it('defaults format to openai when missing', () => {
        mockSidecarProfile = { enabled: true, endpoint: 'https://api.example.com', apiKey: 'key' };
        const config = getSidecarConfig();
        expect(config.format).toBe('openai');
    });

    it('defaults maxTokens to 1000 when missing', () => {
        mockSidecarProfile = { enabled: true, endpoint: 'https://api.example.com', apiKey: 'key' };
        const config = getSidecarConfig();
        expect(config.maxTokens).toBe(1000);
    });

    it('defaults temperature to 0.3 when missing', () => {
        mockSidecarProfile = { enabled: true, endpoint: 'https://api.example.com', apiKey: 'key' };
        const config = getSidecarConfig();
        expect(config.temperature).toBe(0.3);
    });

    it('uses custom temperature when provided', () => {
        mockSidecarProfile = { ...validProfile, temperature: 0.7 };
        const config = getSidecarConfig();
        expect(config.temperature).toBe(0.7);
    });

    it('allows temperature of 0', () => {
        mockSidecarProfile = { ...validProfile, temperature: 0 };
        const config = getSidecarConfig();
        expect(config.temperature).toBe(0);
    });
});

// ── isSidecarConfigured ──────────────────────────────────────────

describe('isSidecarConfigured', () => {
    it('returns false when no profile exists', () => {
        expect(isSidecarConfigured()).toBe(false);
    });

    it('returns true with valid profile', () => {
        mockSidecarProfile = { ...validProfile };
        expect(isSidecarConfigured()).toBe(true);
    });

    it('returns false when endpoint is missing', () => {
        mockSidecarProfile = { enabled: true, apiKey: 'key' };
        expect(isSidecarConfigured()).toBe(false);
    });

    it('returns false when apiKey is missing', () => {
        mockSidecarProfile = { enabled: true, endpoint: 'https://example.com' };
        expect(isSidecarConfigured()).toBe(false);
    });

    it('returns false when not enabled', () => {
        mockSidecarProfile = { ...validProfile, enabled: false };
        expect(isSidecarConfigured()).toBe(false);
    });
});

// ── resetCircuitBreaker ──────────────────────────────────────────

describe('resetCircuitBreaker', () => {
    it('does not throw', () => {
        expect(() => resetCircuitBreaker()).not.toThrow();
    });

    it('restores isSidecarConfigured after circuit was tripped', async () => {
        mockSidecarProfile = { ...validProfile };

        const mockFetch = vi.fn().mockRejectedValue(new Error('network error'));
        vi.stubGlobal('fetch', mockFetch);

        // Trip the circuit breaker (threshold is 3)
        for (let i = 0; i < 3; i++) {
            try { await sidecarGenerate({ prompt: 'test' }); } catch { /* expected */ }
        }

        expect(isSidecarConfigured()).toBe(false);

        resetCircuitBreaker();
        expect(isSidecarConfigured()).toBe(true);

        vi.unstubAllGlobals();
    });

    it('re-closes on its own once the cooldown elapses', async () => {
        mockSidecarProfile = { ...validProfile };
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

        for (let i = 0; i < 3; i++) {
            try { await sidecarGenerate({ prompt: 'test' }); } catch { /* expected */ }
        }
        expect(isCircuitOpen()).toBe(true);

        // Jump past the 5-minute cooldown — the breaker should allow a probe.
        vi.useFakeTimers();
        vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
        expect(isCircuitOpen()).toBe(false);

        // One further failure re-opens it immediately (no free second run).
        try { await sidecarGenerate({ prompt: 'test' }); } catch { /* expected */ }
        expect(isCircuitOpen()).toBe(true);

        vi.useRealTimers();
        vi.unstubAllGlobals();
    });
});

// ── sidecarGenerate ──────────────────────────────────────────────

describe('sidecarGenerate', () => {
    it('throws when sidecar is not configured', async () => {
        await expect(sidecarGenerate({ prompt: 'hello' })).rejects.toThrow('Sidecar not configured');
    });

    it('makes a fetch call to OpenAI-compatible endpoint', async () => {
        mockSidecarProfile = { ...validProfile };
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ choices: [{ message: { content: 'response text' } }] }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const result = await sidecarGenerate({ prompt: 'hello' });
        expect(result).toBe('response text');
        expect(mockFetch).toHaveBeenCalledOnce();

        const [url, opts] = mockFetch.mock.calls[0];
        expect(url).toContain('/chat/completions');
        expect(opts.method).toBe('POST');
        expect(opts.headers['Authorization']).toBe('Bearer sk-test-key-123');

        const body = JSON.parse(opts.body);
        expect(body.model).toBe('gpt-4o-mini');
        expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);

        vi.unstubAllGlobals();
    });

    it('uses custom proxy URL as-is without appending /chat/completions', async () => {
        mockSidecarProfile = { ...validProfile, endpoint: 'https://myproxy.org/abc123' };
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
        });
        vi.stubGlobal('fetch', mockFetch);

        await sidecarGenerate({ prompt: 'test' });
        const [url] = mockFetch.mock.calls[0];
        expect(url).toBe('https://myproxy.org/abc123');
        expect(url).not.toContain('/chat/completions');

        vi.unstubAllGlobals();
    });

    it('appends /chat/completions to standard /v1 endpoint', async () => {
        mockSidecarProfile = { ...validProfile, endpoint: 'https://api.openai.com/v1' };
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
        });
        vi.stubGlobal('fetch', mockFetch);

        await sidecarGenerate({ prompt: 'test' });
        const [url] = mockFetch.mock.calls[0];
        expect(url).toBe('https://api.openai.com/v1/chat/completions');

        vi.unstubAllGlobals();
    });

    it('includes system prompt when provided (OpenAI format)', async () => {
        mockSidecarProfile = { ...validProfile };
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
        });
        vi.stubGlobal('fetch', mockFetch);

        await sidecarGenerate({ prompt: 'hello', systemPrompt: 'You are helpful.' });

        const body = JSON.parse(mockFetch.mock.calls[0][1].body);
        expect(body.messages[0]).toEqual({ role: 'system', content: 'You are helpful.' });
        expect(body.messages[1]).toEqual({ role: 'user', content: 'hello' });

        vi.unstubAllGlobals();
    });

    it('makes a fetch call to Anthropic endpoint', async () => {
        mockSidecarProfile = { ...validProfile, format: 'anthropic', model: 'claude-3-haiku-20240307' };
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ content: [{ text: 'anthropic response' }] }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const result = await sidecarGenerate({ prompt: 'test' });
        expect(result).toBe('anthropic response');

        const [url, opts] = mockFetch.mock.calls[0];
        expect(url).toContain('/messages');
        expect(opts.headers['x-api-key']).toBe('sk-test-key-123');
        expect(opts.headers['anthropic-version']).toBe('2023-06-01');

        const body = JSON.parse(opts.body);
        expect(body.model).toBe('claude-3-haiku-20240307');
        expect(body.messages).toEqual([{ role: 'user', content: 'test' }]);

        vi.unstubAllGlobals();
    });

    it('makes a fetch call to Google/Gemini endpoint', async () => {
        mockSidecarProfile = { ...validProfile, format: 'google', model: 'gemini-1.5-flash' };
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ candidates: [{ content: { parts: [{ text: 'gemini response' }] } }] }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const result = await sidecarGenerate({ prompt: 'test' });
        expect(result).toBe('gemini response');

        const [url] = mockFetch.mock.calls[0];
        expect(url).toContain(':generateContent');
        expect(url).toContain('key=sk-test-key-123');

        vi.unstubAllGlobals();
    });

    it('strips <think> blocks from response', async () => {
        mockSidecarProfile = { ...validProfile };
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: '<think>internal reasoning</think>actual answer' } }],
            }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const result = await sidecarGenerate({ prompt: 'test' });
        expect(result).toBe('actual answer');
        expect(result).not.toContain('<think>');

        vi.unstubAllGlobals();
    });

    it('throws on HTTP error and records failure', async () => {
        mockSidecarProfile = { ...validProfile };
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 403,
            text: async () => 'Forbidden',
        });
        vi.stubGlobal('fetch', mockFetch);

        await expect(sidecarGenerate({ prompt: 'test' })).rejects.toThrow(/Sidecar HTTP 403/);

        vi.unstubAllGlobals();
    });

    it('opens circuit breaker after 3 consecutive failures', async () => {
        mockSidecarProfile = { ...validProfile };
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 500,
            text: async () => 'Server Error',
        });
        vi.stubGlobal('fetch', mockFetch);

        for (let i = 0; i < 3; i++) {
            try { await sidecarGenerate({ prompt: 'test' }); } catch { /* expected */ }
        }

        expect(isSidecarConfigured()).toBe(false);

        vi.unstubAllGlobals();
    });

    it('resets failure count on success', async () => {
        mockSidecarProfile = { ...validProfile };
        let callCount = 0;
        const mockFetch = vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount <= 2) {
                return Promise.resolve({ ok: false, status: 500, text: async () => 'err' });
            }
            return Promise.resolve({
                ok: true,
                json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
            });
        });
        vi.stubGlobal('fetch', mockFetch);

        try { await sidecarGenerate({ prompt: 'a' }); } catch { /* fail 1 */ }
        try { await sidecarGenerate({ prompt: 'b' }); } catch { /* fail 2 */ }
        await sidecarGenerate({ prompt: 'c' }); // success resets count

        // 2 more failures should not trip the breaker (count was reset)
        callCount = 0;
        try { await sidecarGenerate({ prompt: 'd' }); } catch { /* fail 1 */ }
        try { await sidecarGenerate({ prompt: 'e' }); } catch { /* fail 2 */ }
        expect(isSidecarConfigured()).toBe(true);

        vi.unstubAllGlobals();
    });

    it('throws when circuit breaker is open', async () => {
        mockSidecarProfile = { ...validProfile };
        const mockFetch = vi.fn().mockRejectedValue(new Error('network'));
        vi.stubGlobal('fetch', mockFetch);

        for (let i = 0; i < 3; i++) {
            try { await sidecarGenerate({ prompt: 'test' }); } catch { /* trip */ }
        }

        await expect(sidecarGenerate({ prompt: 'test' })).rejects.toThrow('Sidecar circuit breaker open');

        vi.unstubAllGlobals();
    });
});

// ── getEmbeddingConfig ───────────────────────────────────────────

describe('getEmbeddingConfig', () => {
    it('returns null when embeddingProfile is null', () => {
        expect(getEmbeddingConfig()).toBeNull();
    });

    it('returns null when embeddingProfile is not an object', () => {
        mockEmbeddingProfile = 'string';
        expect(getEmbeddingConfig()).toBeNull();
    });

    it('returns null when not enabled', () => {
        mockEmbeddingProfile = { ...validEmbeddingProfile, enabled: false };
        expect(getEmbeddingConfig()).toBeNull();
    });

    it('returns null when enabled flag is missing', () => {
        mockEmbeddingProfile = { endpoint: 'https://example.com', apiKey: 'key' };
        expect(getEmbeddingConfig()).toBeNull();
    });

    it('returns null when endpoint is empty', () => {
        mockEmbeddingProfile = { enabled: true, endpoint: '', apiKey: 'key' };
        expect(getEmbeddingConfig()).toBeNull();
    });

    it('returns config with valid endpoint', () => {
        mockEmbeddingProfile = { ...validEmbeddingProfile };
        const config = getEmbeddingConfig();
        expect(config).toEqual({
            endpoint: 'https://embed.example.com/v1',
            apiKey: 'emb-key-123',
            model: 'nomic-embed-text',
            format: 'openai',
        });
    });

    it('allows empty apiKey (some local endpoints need no key)', () => {
        mockEmbeddingProfile = { enabled: true, endpoint: 'http://localhost:11434/v1', apiKey: '' };
        const config = getEmbeddingConfig();
        expect(config).not.toBeNull();
        expect(config.apiKey).toBe('');
    });

    it('defaults format to openai', () => {
        mockEmbeddingProfile = { enabled: true, endpoint: 'http://localhost:11434/v1' };
        const config = getEmbeddingConfig();
        expect(config.format).toBe('openai');
    });
});

// ── isEmbeddingSupported ─────────────────────────────────────────

describe('isEmbeddingSupported', () => {
    it('returns false when embedding is not configured', () => {
        expect(isEmbeddingSupported()).toBe(false);
    });

    it('returns true for openai format', () => {
        mockEmbeddingProfile = { ...validEmbeddingProfile, format: 'openai' };
        expect(isEmbeddingSupported()).toBe(true);
    });

    it('returns true for google format', () => {
        mockEmbeddingProfile = { ...validEmbeddingProfile, format: 'google' };
        expect(isEmbeddingSupported()).toBe(true);
    });

    it('returns true for gemini format alias', () => {
        mockEmbeddingProfile = { ...validEmbeddingProfile, format: 'gemini' };
        expect(isEmbeddingSupported()).toBe(true);
    });

    it('is independent of sidecar configuration', () => {
        mockSidecarProfile = { ...validProfile };
        mockEmbeddingProfile = null;
        expect(isEmbeddingSupported()).toBe(false);

        mockSidecarProfile = null;
        mockEmbeddingProfile = { ...validEmbeddingProfile };
        expect(isEmbeddingSupported()).toBe(true);
    });
});

// ── computeEmbeddings ────────────────────────────────────────────

describe('computeEmbeddings', () => {
    it('throws when embedding is not configured', async () => {
        await expect(computeEmbeddings(['hello'])).rejects.toThrow('Embedding not configured');
    });

    it('calls OpenAI embeddings endpoint with configured model', async () => {
        mockEmbeddingProfile = { ...validEmbeddingProfile };
        const mockEmbedding = [0.1, 0.2, 0.3];
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ data: [{ embedding: mockEmbedding }] }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const result = await computeEmbeddings(['test text']);
        expect(result).toEqual([mockEmbedding]);

        const [url, opts] = mockFetch.mock.calls[0];
        expect(url).toContain('/embeddings');
        const body = JSON.parse(opts.body);
        expect(body.model).toBe('nomic-embed-text');

        vi.unstubAllGlobals();
    });

    it('includes Authorization header when apiKey is provided', async () => {
        mockEmbeddingProfile = { ...validEmbeddingProfile };
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ data: [{ embedding: [0.1] }] }),
        });
        vi.stubGlobal('fetch', mockFetch);

        await computeEmbeddings(['test']);
        const headers = mockFetch.mock.calls[0][1].headers;
        expect(headers['Authorization']).toBe('Bearer emb-key-123');

        vi.unstubAllGlobals();
    });

    it('omits Authorization header when apiKey is empty', async () => {
        mockEmbeddingProfile = { ...validEmbeddingProfile, apiKey: '' };
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ data: [{ embedding: [0.1] }] }),
        });
        vi.stubGlobal('fetch', mockFetch);

        await computeEmbeddings(['test']);
        const headers = mockFetch.mock.calls[0][1].headers;
        expect(headers['Authorization']).toBeUndefined();

        vi.unstubAllGlobals();
    });

    it('calls Google embeddings endpoint for google format', async () => {
        mockEmbeddingProfile = { ...validEmbeddingProfile, format: 'google', model: 'text-embedding-004' };
        const mockEmbedding = [0.4, 0.5, 0.6];
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ embeddings: [{ values: mockEmbedding }] }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const result = await computeEmbeddings(['test text']);
        expect(result).toEqual([mockEmbedding]);

        const [url] = mockFetch.mock.calls[0];
        expect(url).toContain(':batchEmbedContents');

        vi.unstubAllGlobals();
    });

    it('handles multiple texts in a single batch', async () => {
        mockEmbeddingProfile = { ...validEmbeddingProfile };
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                data: [
                    { embedding: [0.1, 0.2] },
                    { embedding: [0.3, 0.4] },
                ],
            }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const result = await computeEmbeddings(['text a', 'text b']);
        expect(result).toHaveLength(2);

        vi.unstubAllGlobals();
    });

    it('throws on embedding API error', async () => {
        mockEmbeddingProfile = { ...validEmbeddingProfile };
        const mockFetch = vi.fn().mockResolvedValue({
            ok: false,
            status: 429,
        });
        vi.stubGlobal('fetch', mockFetch);

        await expect(computeEmbeddings(['test'])).rejects.toThrow(/Embedding HTTP 429/);

        vi.unstubAllGlobals();
    });

    it('works independently of sidecar configuration', async () => {
        mockSidecarProfile = null;
        mockEmbeddingProfile = { ...validEmbeddingProfile };
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ data: [{ embedding: [0.5] }] }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const result = await computeEmbeddings(['test']);
        expect(result).toEqual([[0.5]]);

        vi.unstubAllGlobals();
    });
});

// ── testSidecarConnectivity ──────────────────────────────────────

describe('testSidecarConnectivity', () => {
    it('returns error when not configured', async () => {
        const result = await testSidecarConnectivity();
        expect(result.ok).toBe(false);
        expect(result.message).toContain('No sidecar configuration');
    });

    it('returns success on valid response', async () => {
        mockSidecarProfile = { ...validProfile };
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ choices: [{ message: { content: 'OK' } }] }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const result = await testSidecarConnectivity();
        expect(result.ok).toBe(true);
        expect(result.message).toContain('Connected');
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);

        vi.unstubAllGlobals();
    });

    it('returns failure on network error', async () => {
        mockSidecarProfile = { ...validProfile };
        const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
        vi.stubGlobal('fetch', mockFetch);

        resetCircuitBreaker();
        const result = await testSidecarConnectivity();
        expect(result.ok).toBe(false);
        expect(result.message).toContain('Connection failed');

        vi.unstubAllGlobals();
    });

    it('returns failure on empty response', async () => {
        mockSidecarProfile = { ...validProfile };
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ choices: [{ message: { content: '' } }] }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const result = await testSidecarConnectivity();
        expect(result.ok).toBe(false);
        expect(result.message).toContain('Empty response');

        vi.unstubAllGlobals();
    });
});

// ── testEmbeddingConnectivity ────────────────────────────────────

describe('testEmbeddingConnectivity', () => {
    it('returns error when embedding is not configured', async () => {
        const result = await testEmbeddingConnectivity();
        expect(result.ok).toBe(false);
        expect(result.message).toContain('No embedding configuration');
    });

    it('returns success with dimension info on valid response', async () => {
        mockEmbeddingProfile = { ...validEmbeddingProfile };
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }] }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const result = await testEmbeddingConnectivity();
        expect(result.ok).toBe(true);
        expect(result.message).toContain('Connected');
        expect(result.message).toContain('dimensions: 4');
        expect(result.message).toContain('nomic-embed-text');
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);

        vi.unstubAllGlobals();
    });

    it('returns failure on network error', async () => {
        mockEmbeddingProfile = { ...validEmbeddingProfile };
        const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
        vi.stubGlobal('fetch', mockFetch);

        const result = await testEmbeddingConnectivity();
        expect(result.ok).toBe(false);
        expect(result.message).toContain('Connection failed');

        vi.unstubAllGlobals();
    });
});
