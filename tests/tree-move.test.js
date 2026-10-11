import { describe, it, expect } from 'vitest';
import { createEmptyTree, createTreeNode, flattenNodes } from '../tree-store.js';

// ── flattenNodes ─────────────────────────────────────────────────
// Backs the "Move to…" picker: the tree is a nested structure but the
// picker needs a flat, indented list of every possible destination.

describe('flattenNodes', () => {
    it('returns just the root for a tree with no categories', () => {
        const tree = createEmptyTree();
        expect(flattenNodes(tree.root)).toEqual([{ node: tree.root, depth: 0 }]);
    });

    it('walks depth-first and records nesting depth', () => {
        const tree = createEmptyTree();
        const locations = createTreeNode('Locations');
        const ruins = createTreeNode('Ruins');
        const cities = createTreeNode('Cities');
        const characters = createTreeNode('Characters');
        locations.children = [ruins, cities];
        tree.root.children = [locations, characters];

        expect(flattenNodes(tree.root).map(e => [e.node.label, e.depth])).toEqual([
            [tree.root.label, 0],
            ['Locations', 1],
            ['Ruins', 2],
            ['Cities', 2],
            ['Characters', 1],
        ]);
    });

    it('ignores the collapsed flag — every node is a valid destination', () => {
        const tree = createEmptyTree();
        const hidden = createTreeNode('Hidden');
        hidden.children = [createTreeNode('Deep')];
        tree.root.children = [hidden];
        tree.root.collapsed = true;
        hidden.collapsed = true;

        expect(flattenNodes(tree.root)).toHaveLength(3);
    });

    it('returns an empty list for a missing node', () => {
        expect(flattenNodes(null)).toEqual([]);
    });
});
