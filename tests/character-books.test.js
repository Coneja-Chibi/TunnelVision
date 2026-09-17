import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nextFreeName } from '../shared-utils.js';

// Mutable host state, read through live getters by the mocked ST modules.
const st = vi.hoisted(() => ({
    characters: [],
    this_chid: undefined,
    selected_group: null,
    groups: [],
    charLore: [],
    selected_world_info: [],
    chat_metadata: {},
    enabled: new Set(),
}));

vi.mock('../../../../script.js', () => ({
    get characters() { return st.characters; },
    get this_chid() { return st.this_chid; },
    get chat_metadata() { return st.chat_metadata; },
}));
vi.mock('../../../group-chats.js', () => ({
    get selected_group() { return st.selected_group; },
    get groups() { return st.groups; },
}));
vi.mock('../../../world-info.js', () => ({
    get selected_world_info() { return st.selected_world_info; },
    get world_info() { return { charLore: st.charLore }; },
    loadWorldInfo: vi.fn(),
    METADATA_KEY: 'world_info',
}));
vi.mock('../../../utils.js', () => ({ getCharaFilename: (idx) => st.characters[idx]?.avatar.replace('.png', '') }));
vi.mock('../tree-store.js', () => ({
    isLorebookEnabled: (name) => st.enabled.has(name),
    getSettings: () => ({}),
    getTree: () => null,
    getBookDescription: () => '',
    syncTrackerUidsForLorebook: vi.fn(),
    getBookPermission: () => 'read_write',
    canReadBook: () => true,
    canWriteBook: () => true,
    isNativeInjectionBook: () => false,
}));
vi.mock('../activity-feed.js', () => ({ logToolCallStarted: vi.fn() }));
vi.mock('../entry-manager.js', () => ({ findEntry: vi.fn() }));
vi.mock('../tools/search.js', () => ({ getDefinition: () => null, getTreeOverview: () => '', TOOL_NAME: 'search', COMPACT_DESCRIPTION: '' }));
vi.mock('../tools/remember.js', () => ({ getDefinition: () => null, TOOL_NAME: 'remember', COMPACT_DESCRIPTION: '' }));
vi.mock('../tools/update.js', () => ({ getDefinition: () => null, TOOL_NAME: 'update', COMPACT_DESCRIPTION: '' }));
vi.mock('../tools/forget.js', () => ({ getDefinition: () => null, TOOL_NAME: 'forget', COMPACT_DESCRIPTION: '' }));
vi.mock('../tools/reorganize.js', () => ({ getDefinition: () => null, TOOL_NAME: 'reorganize', COMPACT_DESCRIPTION: '' }));
vi.mock('../tools/summarize.js', () => ({ getDefinition: () => null, TOOL_NAME: 'summarize', COMPACT_DESCRIPTION: '' }));
vi.mock('../tools/merge-split.js', () => ({ getDefinition: () => null, TOOL_NAME: 'merge-split', COMPACT_DESCRIPTION: '' }));
vi.mock('../tools/notebook.js', () => ({ getDefinition: () => null, TOOL_NAME: 'notebook', COMPACT_DESCRIPTION: '' }));

import { getCharacterBooks, getActiveTunnelVisionBooks } from '../tool-registry.js';

const ivy = { avatar: 'ivy.png', data: { extensions: { world: "Ivy's Lorebook" } } };
const sam = { avatar: 'sam.png', data: { extensions: { world: 'Sam Lore' } } };
const bob = { avatar: 'bob.png', data: { extensions: { world: 'Bob Lore' } } };

beforeEach(() => {
    st.characters = [ivy, sam, bob];
    st.this_chid = undefined;
    st.selected_group = null;
    st.groups = [];
    st.charLore = [];
    st.selected_world_info = [];
    st.chat_metadata = {};
    st.enabled = new Set();
});

describe('getCharacterBooks', () => {
    it('returns the primary and extra books of the current character, enabled or not', () => {
        st.this_chid = 0;
        st.charLore = [{ name: 'ivy', extraBooks: ['Ivy Extra'] }];
        expect(getCharacterBooks()).toEqual(["Ivy's Lorebook", 'Ivy Extra']);
    });

    it('returns nothing without a character', () => {
        expect(getCharacterBooks()).toEqual([]);
    });

    it('scans enabled group members only', () => {
        st.selected_group = 'g1';
        st.groups = [{ id: 'g1', members: ['ivy.png', 'sam.png', 'bob.png'], disabled_members: ['sam.png'] }];
        expect(getCharacterBooks()).toEqual(["Ivy's Lorebook", 'Bob Lore']);
    });
});

describe('getActiveTunnelVisionBooks', () => {
    it('still combines global, character and chat books, filtered to TV-enabled', () => {
        st.this_chid = 0;
        st.selected_world_info = ['Global'];
        st.chat_metadata = { world_info: 'TV - Ivy' };
        st.enabled = new Set(['Global', 'TV - Ivy']);
        expect(getActiveTunnelVisionBooks()).toEqual(['Global', 'TV - Ivy']);

        st.enabled.add("Ivy's Lorebook");
        expect(getActiveTunnelVisionBooks()).toEqual(['Global', "Ivy's Lorebook", 'TV - Ivy']);
    });
});

describe('nextFreeName', () => {
    it('returns the base name when free', () => {
        expect(nextFreeName('TV - Ivy', ['Other'])).toBe('TV - Ivy');
    });

    it('appends the first free number', () => {
        expect(nextFreeName('TV - Ivy', ['TV - Ivy'])).toBe('TV - Ivy 2');
        expect(nextFreeName('TV - Ivy', ['TV - Ivy', 'TV - Ivy 2', 'TV - Ivy 4'])).toBe('TV - Ivy 3');
    });
});
