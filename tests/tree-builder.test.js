import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks -------------------------------------------------------------

const mockSettings = {
  llmBuildDetail: 'full',
  llmChunkTokens: 30000,
  treeGranularity: 2,
};

const mockGenerateRaw = vi.fn();
const mockLoadWorldInfo = vi.fn();

// script.js mock (generateRaw passthrough used by tree-builder wrapper)
vi.mock('../../../../script.js', () => ({
  generateRaw: (...args) => mockGenerateRaw(...args),
  saveSettingsDebounced: vi.fn(),
}));

vi.mock('../../../st-context.js', () => ({
  getContext: () => ({
    chat: [],
    characters: [],
    characterId: null,
    name1: 'User',
    name2: 'Assistant',
  }),
}));

vi.mock('../../../world-info.js', () => ({
  loadWorldInfo: (...args) => mockLoadWorldInfo(...args),
}));

vi.mock('../../../slash-commands/SlashCommandParser.js', () => ({
  SlashCommandParser: {
    addCommandObject: vi.fn(),
  },
}));

vi.mock('./entry-manager.js', () => ({
  createEntry: vi.fn(),
  findEntryByUid: vi.fn(),
  parseJsonFromLLM: vi.fn((txt) => {
    try {
      return JSON.parse(txt);
    } catch {
      return null;
    }
  }),
  KEYWORD_RULES: 'keyword rules',
}));

vi.mock('./shared-utils.js', () => ({
  chunkBySize(items, sizeFn, charLimit) {
    if (!items.length) return [];
    const chunks = [];
    let cur = [];
    let curSize = 0;
    for (const item of items) {
      const size = sizeFn(item);
      if (cur.length > 0 && curSize + size > charLimit) {
        cur.push(item); // overfill behavior to match production utility
        chunks.push(cur);
        cur = [];
        curSize = 0;
      } else {
        cur.push(item);
        curSize += size;
      }
    }
    if (cur.length) chunks.push(cur);
    return chunks;
  },
}));

vi.mock('./tree-store.js', () => ({
  createEmptyTree: vi.fn((name) => ({
    lorebookName: name,
    root: { id: 'root', label: 'Root', summary: '', entryUids: [], children: [] },
    version: 1,
    lastBuilt: Date.now(),
  })),
  createTreeNode: vi.fn((label = 'New Category', summary = '') => ({
    id: `node_${Math.random().toString(36).slice(2, 8)}`,
    label,
    summary,
    entryUids: [],
    children: [],
    collapsed: false,
  })),
  addEntryToNode: vi.fn((node, uid) => {
    if (!node.entryUids) node.entryUids = [];
    if (!node.entryUids.includes(uid)) node.entryUids.push(uid);
  }),
  removeEntryFromTree: vi.fn((node, uid) => {
    if (!node) return;
    node.entryUids = (node.entryUids || []).filter((x) => x !== uid);
    for (const c of node.children || []) {
      c.entryUids = (c.entryUids || []).filter((x) => x !== uid);
      for (const sc of c.children || []) {
        sc.entryUids = (sc.entryUids || []).filter((x) => x !== uid);
      }
    }
  }),
  saveTree: vi.fn(),
  getAllEntryUids: vi.fn((node) => {
    const out = [];
    const walk = (n) => {
      out.push(...(n.entryUids || []));
      for (const c of n.children || []) walk(c);
    };
    if (node) walk(node);
    return out;
  }),
  getSettings: vi.fn(() => mockSettings),
  isSummaryTitle: vi.fn((title) =>
    /^\[(?:scene\s+|act\s+|story\s+)?summary/i.test(String(title || '').trim()),
  ),
}));

// --- Import under test -------------------------------------------------

import {
  splitEntriesForTree,
  getTreeBuildSettings,
  assignUnassignedEntries,
  pinSummaryEntries,
  extractCategoryLabels,
  buildContinuationPrompt,
  chunkEntries,
  getIngestText,
} from '../tree-builder.js';

// --- Helpers -----------------------------------------------------------

function makeEntry(uid, { comment, content = 'content', disable = false, key = ['k'] } = {}) {
  return {
    uid,
    comment: comment ?? `Entry ${uid}`,
    content,
    disable,
    key,
  };
}

// --- Tests -------------------------------------------------------------

describe('tree-builder helper functions (refactor coverage)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettings.llmBuildDetail = 'full';
    mockSettings.llmChunkTokens = 30000;
    mockSettings.treeGranularity = 2;
  });

  describe('splitEntriesForTree', () => {
    it('splits active non-summary entries and summary entries', () => {
      const bookData = {
        entries: {
          a: makeEntry(1, { comment: 'Normal A' }),
          b: makeEntry(2, { comment: '[Summary] Scene A' }),
          c: makeEntry(3, { comment: '[Act Summary] Act 1' }),
          d: makeEntry(4, { comment: 'Normal B' }),
        },
      };

      const { activeEntries, summaryEntries } = splitEntriesForTree(bookData);

      expect(activeEntries.map((e) => e.uid)).toEqual([1, 4]);
      expect(summaryEntries.map((e) => e.uid)).toEqual([2, 3]);
    });

    it('skips disabled entries', () => {
      const bookData = {
        entries: {
          a: makeEntry(1, { disable: true }),
          b: makeEntry(2, { comment: '[Summary] S', disable: true }),
          c: makeEntry(3, {}),
        },
      };

      const { activeEntries, summaryEntries } = splitEntriesForTree(bookData);

      expect(activeEntries.map((e) => e.uid)).toEqual([3]);
      expect(summaryEntries).toEqual([]);
    });

    it('handles empty entries map', () => {
      const { activeEntries, summaryEntries } = splitEntriesForTree({ entries: {} });
      expect(activeEntries).toEqual([]);
      expect(summaryEntries).toEqual([]);
    });
  });

  describe('getTreeBuildSettings', () => {
    it('returns explicit settings values', () => {
      const out = getTreeBuildSettings({ llmBuildDetail: 'lite', llmChunkTokens: 12345 });
      expect(out).toEqual({ detail: 'lite', chunkLimit: 12345 });
    });

    it('applies defaults when settings missing', () => {
      const out = getTreeBuildSettings({});
      expect(out).toEqual({ detail: 'full', chunkLimit: 30000 });
    });
  });

  describe('extractCategoryLabels', () => {
    it('collects top-level and second-level labels', () => {
      const root = {
        children: [
          { label: 'People', children: [{ label: 'Allies' }, { label: 'Rivals' }] },
          { label: 'Places', children: [{ label: 'Cities' }] },
        ],
      };

      const labels = extractCategoryLabels(root);
      expect(labels).toEqual([
        'People',
        'People > Allies',
        'People > Rivals',
        'Places',
        'Places > Cities',
      ]);
    });

    it('handles missing children arrays', () => {
      const root = { children: [{ label: 'Solo' }] };
      expect(extractCategoryLabels(root)).toEqual(['Solo']);
    });
  });

  describe('buildContinuationPrompt', () => {
    it('includes existing categories and formatted new entries', () => {
      mockSettings.llmBuildDetail = 'titles';
      mockSettings.treeGranularity = 1;

      const entries = [
        makeEntry(10, { comment: 'Alice Profile', content: '...' }),
        makeEntry(11, { comment: 'Magic Sword', content: '...' }),
      ];
      const categories = ['People', 'Items > Weapons'];

      const prompt = buildContinuationPrompt('MyBook', entries, categories, 50);

      expect(prompt).toContain('organize a lorebook called "MyBook"');
      expect(prompt).toContain('Existing categories:');
      expect(prompt).toContain('- People');
      expect(prompt).toContain('- Items > Weapons');
      expect(prompt).toContain('Here are the NEW entries to categorize:');
      expect(prompt).toContain('Alice Profile');
      expect(prompt).toContain('Magic Sword');
    });

    it('adds detailed subcategory hint at high granularity', () => {
      mockSettings.treeGranularity = 4;
      const prompt = buildContinuationPrompt('Book', [makeEntry(1)], ['A'], 4000);
      expect(prompt.toLowerCase()).toContain('prefer creating new sub-categories');
    });
  });

  describe('chunkEntries', () => {
    it('delegates chunking with overfill semantics', () => {
      const entries = [
        makeEntry(1, { comment: 'A', content: 'x'.repeat(20) }),
        makeEntry(2, { comment: 'B', content: 'x'.repeat(20) }),
        makeEntry(3, { comment: 'C', content: 'x'.repeat(20) }),
      ];

      const chunks = chunkEntries(entries, 'full', 50);

      // With overfill strategy, second item causes overfill of first chunk.
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks.flat().map((e) => e.uid)).toEqual([1, 2, 3]);
    });

    it('returns empty for empty input', () => {
      expect(chunkEntries([], 'full', 100)).toEqual([]);
    });
  });

  describe('assignUnassignedEntries', () => {
    it('adds only missing UIDs to root', () => {
      const tree = {
        root: {
          entryUids: [1, 2],
          children: [
            { entryUids: [3], children: [] },
          ],
        },
      };

      assignUnassignedEntries(tree, [1, 2, 3, 4, 5]);

      const all = [tree.root.entryUids, tree.root.children[0].entryUids].flat();
      expect(all).toContain(4);
      expect(all).toContain(5);
      expect(all.filter((x) => x === 1).length).toBe(1);
    });

    it('does nothing when all are already assigned', () => {
      const tree = { root: { entryUids: [1, 2], children: [] } };
      assignUnassignedEntries(tree, [1, 2]);
      expect(tree.root.entryUids).toEqual([1, 2]);
    });
  });

  describe('pinSummaryEntries', () => {
    it('creates Summaries node when missing and pins entries', () => {
      const tree = {
        root: {
          children: [
            { label: 'People', entryUids: [1], children: [] },
          ],
        },
      };

      const summaryEntries = [
        makeEntry(100, { comment: '[Summary] S1' }),
        makeEntry(101, { comment: '[Act Summary] A1' }),
      ];

      pinSummaryEntries(tree, summaryEntries);

      const summariesNode = tree.root.children.find((c) => c.label === 'Summaries');
      expect(summariesNode).toBeTruthy();
      expect(summariesNode.entryUids).toEqual(expect.arrayContaining([100, 101]));

      // ensure not duplicated in other node after remove/add
      const people = tree.root.children.find((c) => c.label === 'People');
      expect(people.entryUids).not.toContain(100);
      expect(people.entryUids).not.toContain(101);
    });

    it('reuses existing Summaries node', () => {
      const tree = {
        root: {
          children: [
            { label: 'Summaries', entryUids: [42], children: [] },
          ],
        },
      };

      const summaryEntries = [makeEntry(43, { comment: '[Summary] New' })];
      pinSummaryEntries(tree, summaryEntries);

      const summariesNode = tree.root.children.find((c) => c.label === 'Summaries');
      expect(summariesNode.entryUids).toEqual(expect.arrayContaining([42, 43]));
      expect(tree.root.children.filter((c) => c.label === 'Summaries')).toHaveLength(1);
    });

    it('no-ops with empty summary list', () => {
      const tree = { root: { children: [] } };
      pinSummaryEntries(tree, []);
      expect(tree.root.children).toEqual([]);
    });
  });
});
describe('getIngestText', () => {
  it('reads a visible message', () => {
    expect(getIngestText({ mes: 'Yumi drew her sword.' }, false)).toBe('Yumi drew her sword.');
  });

  it('skips hidden messages unless includeHidden is set', () => {
    const msg = { mes: 'Yumi drew her sword.', is_system: true };
    expect(getIngestText(msg, false)).toBeNull();
    expect(getIngestText(msg, true)).toBe('Yumi drew her sword.');
  });

  it('never reads TunnelVision summary markers', () => {
    const marker = { mes: '📝 **Chapter 1**\n\nThey met.', is_system: true, extra: { tunnelvision_summary: true } };
    expect(getIngestText(marker, true)).toBeNull();
  });

  it('drops markdown-image messages, with or without includeHidden', () => {
    const img = { mes: '![generated image](/user/images/Yumi/imagine_1786700703934_0.webp)' };
    expect(getIngestText(img, false)).toBeNull();
    expect(getIngestText(img, true)).toBeNull();
  });

  it('keeps the caption when a message has both text and an image', () => {
    const msg = { mes: 'Yumi at the shrine.\n\n![generated image](/user/images/Yumi/imagine_1.webp)' };
    expect(getIngestText(msg, false)).toBe('Yumi at the shrine.');
  });

  it('drops html media and native ST attachments', () => {
    expect(getIngestText({ mes: '<video src="/user/images/a.mp4"></video>' }, false)).toBeNull();
    expect(getIngestText({
      mes: 'masterpiece, 1girl, shrine',
      extra: { media: [{ type: 'image', url: '/user/images/a.png' }], inline_image: false },
    }, false)).toBeNull();
  });
});
