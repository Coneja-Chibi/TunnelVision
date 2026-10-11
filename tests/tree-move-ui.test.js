/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import $ from 'jquery';

const state = vi.hoisted(() => ({ metadata: {}, editor: null, picker: null, closeEditor: null }));
vi.mock('../../../st-context.js', () => ({
    getContext: () => ({ chatMetadata: state.metadata, chat: [], saveMetadataDebounced: vi.fn() }),
}));
vi.mock('../../../world-info.js', () => ({
    world_names: ['Book'],
    loadWorldInfo: vi.fn(async () => ({ entries: {
        7: { uid: 7, comment: 'Memory', key: ['memory'], content: 'Keep this.', disable: false },
        8: { uid: 8, comment: 'Other memory', key: ['other'], content: 'Keep this too.', disable: false },
    } })),
    saveWorldInfo: vi.fn(),
}));
vi.mock('../auto-summary.js', () => ({ getAutoSummaryCount: () => 0, resetAutoSummaryCount: vi.fn() }));
vi.mock('../tree-builder.js', () => ({
    buildTreeFromMetadata: vi.fn(), buildTreeWithLLM: vi.fn(), generateSummariesForTree: vi.fn(), ingestChatMessages: vi.fn(),
}));
vi.mock('../llm-sidecar.js', () => ({ testSidecarConnectivity: vi.fn(), testEmbeddingConnectivity: vi.fn() }));
vi.mock('../embedding-cache.js', () => ({ isEmbeddingAvailable: () => false }));
vi.mock('../tool-registry.js', () => ({
    getActiveTunnelVisionBooks: () => ['Book'], registerTools: vi.fn(), unregisterTools: vi.fn(),
    getDefaultToolDescriptions: () => ({}), stripDynamicContent: text => text, applyRecurseLimit: vi.fn(),
}));
vi.mock('../diagnostics.js', () => ({ runDiagnostics: vi.fn() }));
vi.mock('../sidecar-retrieval.js', () => ({ clearRetrievalPrompt: vi.fn() }));
vi.mock('../index.js', () => ({ applyRecurseLimit: vi.fn() }));
vi.mock('../activity-feed.js', () => ({ refreshHiddenToolCallMessages: vi.fn() }));
vi.mock('../../../popup.js', () => ({
    POPUP_TYPE: { TEXT: 'text', DISPLAY: 'display' }, POPUP_RESULT: { CANCELLED: 0 },
    callGenericPopup: vi.fn(content => {
        state.editor = content;
        document.body.append(content[0]);
        return new Promise(resolve => { state.closeEditor = resolve; });
    }),
    Popup: class {
        constructor(content) { this.content = content; }
        show() {
            state.picker = this.content;
            document.body.append(this.content[0]);
            return new Promise(resolve => { this.close = resolve; });
        }
        async complete() { this.content.remove(); this.close(); }
    },
}));

import { extension_settings } from '../../../extensions.js';
import { openTreeEditorForBook, refreshUI } from '../ui-controller.js';
import { createEmptyTree, createTreeNode, deleteTree, getAllEntryUids, getTree, saveTree } from '../tree-store.js';

let opening;
let original;

beforeEach(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(123456789);
    let nextId = 0;
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(array => array.fill(++nextId));
    vi.stubGlobal('$', $);
    vi.stubGlobal('toastr', { warning: vi.fn(), error: vi.fn(), success: vi.fn() });
    extension_settings.tunnelvision = {};
    state.metadata = {};
    state.editor = state.picker = state.closeEditor = null;
    document.body.replaceChildren();
    original = createEmptyTree('Book');
    original.root.entryUids = [7];
    original.root.children = [createTreeNode('Destination')];
    saveTree('Book', original);
    opening = openTreeEditorForBook('Book');
    await vi.waitFor(() => expect(state.editor).not.toBeNull());
    state.editor.find('.tv-entry-move').first().trigger('click');
    await vi.waitFor(() => expect(state.picker).not.toBeNull());
});

afterEach(async () => {
    state.closeEditor?.();
    await opening;
    await new Promise(resolve => setTimeout(resolve, 0));
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('tree editor move picker', () => {
    it('moves an entry when the tree has not changed', async () => {
        state.picker.find('.tv-move-picker-row').last().trigger('click');
        await vi.waitFor(() => expect(document.querySelector('.tv-move-picker')).toBeNull());
        expect(getTree('Book').root.children[0].entryUids).toEqual([7]);
        expect(getTree('Book').root.entryUids).toEqual([]);
    });

    it.each([false, true])('moves into the saved replacement and preserves other assignments (refresh=%s)', async refresh => {
        const detachedDestination = original.root.children[0];
        const replacement = JSON.parse(JSON.stringify(original));
        replacement.root.entryUids.push(8);
        saveTree('Book', replacement);
        if (refresh) {
            refreshUI();
            await Promise.resolve();
        }
        state.picker.find('.tv-move-picker-row').last().trigger('click');
        await vi.waitFor(() => expect(document.querySelector('.tv-move-picker')).toBeNull());
        const saved = getTree('Book');
        expect(saved.root.children[0].entryUids).toEqual([7]);
        expect(saved.root.entryUids).toEqual([8]);
        expect(getAllEntryUids(saved.root)).toEqual([8, 7]);
        expect(detachedDestination.entryUids).toEqual([]);
    });

    it('preserves the assignment when the destination was removed', async () => {
        const replacement = JSON.parse(JSON.stringify(original));
        replacement.root.children = [];
        saveTree('Book', replacement);
        state.picker.find('.tv-move-picker-row').last().trigger('click');
        await Promise.resolve();
        expect(getTree('Book')).toBe(replacement);
        expect(getTree('Book').root.entryUids).toEqual([7]);
        expect(toastr.warning).toHaveBeenCalled();
    });

    it('does not recreate a deleted tree from the stale picker', async () => {
        deleteTree('Book');
        state.picker.find('.tv-move-picker-row').last().trigger('click');
        await Promise.resolve();
        expect(getTree('Book')).toBeNull();
        expect(toastr.warning).toHaveBeenCalled();
    });
});
