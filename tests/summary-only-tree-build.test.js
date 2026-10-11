import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../world-info.js', () => ({ loadWorldInfo: vi.fn() }));
vi.mock('../../../../script.js', () => ({ generateRaw: vi.fn(), saveSettingsDebounced: vi.fn() }));
vi.mock('../llm-sidecar.js', () => ({ isSidecarConfigured: () => true, sidecarGenerate: vi.fn() }));
vi.mock('../entry-manager.js', () => ({ createEntry: vi.fn(), findEntryByUid: vi.fn() }));
vi.mock('../agent-utils.js', () => ({ applyBackgroundPromptAddendum: text => text, trigramSimilarity: () => 0 }));

import { extension_settings } from '../../../extensions.js';
import { loadWorldInfo } from '../../../world-info.js';
import { generateRaw, saveSettingsDebounced } from '../../../../script.js';
import { sidecarGenerate } from '../llm-sidecar.js';
import { buildTreeWithLLM } from '../tree-builder.js';
import { getAllEntryUids, getTree } from '../tree-store.js';

beforeEach(() => {
    vi.clearAllMocks();
    extension_settings.tunnelvision = { trees: {} };
    vi.spyOn(Date, 'now').mockReturnValue(123456789);
    let nextId = 0;
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(array => array.fill(++nextId));
});

afterEach(() => vi.restoreAllMocks());

describe('summary-only lorebook builds', () => {
    it('builds an index retaining the sole active summary', async () => {
        loadWorldInfo.mockResolvedValue({ entries: { 1: { uid: 1, comment: '[Summary] Scene', key: ['scene'], content: 'They met.', disable: false } } });
        const tree = await buildTreeWithLLM('SummaryOnly');
        expect(getAllEntryUids(tree.root)).toContain(1);
    });

    it.each(['[Summary] Scene', '[Scene Summary] Meeting', '[Act Summary] Act 1', '[Story Summary] Story So Far'])(
        'persists %s in the Summaries node without calling a provider', async comment => {
            loadWorldInfo.mockResolvedValue({ entries: {
                1: { uid: 1, comment, content: 'They met.', disable: false },
                2: { uid: 2, comment: '[Scene Summary] Disabled', disable: true },
                3: { uid: 3, comment: 'Disabled lore', disable: true },
            } });

            const tree = await buildTreeWithLLM('SummaryOnly');

            expect(tree.root.entryUids).toEqual([]);
            expect(tree.root.children).toHaveLength(1);
            expect(tree.root.children[0].label).toBe('Summaries');
            expect(getAllEntryUids(tree.root)).toEqual([1]);
            expect(tree.lastBuilt).toBe(123456789);
            expect(getTree('SummaryOnly')).toBe(tree);
            expect(saveSettingsDebounced).toHaveBeenCalledTimes(1);
            expect(generateRaw).not.toHaveBeenCalled();
            expect(sidecarGenerate).not.toHaveBeenCalled();
        },
    );

    it.each([
        {},
        { 1: { uid: 1, comment: 'Disabled lore', disable: true } },
        { 1: { uid: 1, comment: '[Story Summary] Disabled', disable: true } },
    ])('rejects books with no enabled entries: %j', async entries => {
        loadWorldInfo.mockResolvedValue({ entries });

        await expect(buildTreeWithLLM('Empty')).rejects.toThrow('has no active entries to index');

        expect(getTree('Empty')).toBeNull();
        expect(saveSettingsDebounced).not.toHaveBeenCalled();
        expect(generateRaw).not.toHaveBeenCalled();
        expect(sidecarGenerate).not.toHaveBeenCalled();
    });
});
