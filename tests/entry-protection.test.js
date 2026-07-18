import { describe, expect, it } from 'vitest';
import { isStaticEntry } from '../entry-protection.js';

describe('isStaticEntry', () => {
    it('identifies only explicit constant entries as static', () => {
        expect(isStaticEntry({ constant: true })).toBe(true);
        expect(isStaticEntry({ constant: false })).toBe(false);
        expect(isStaticEntry({})).toBe(false);
        expect(isStaticEntry(null)).toBe(false);
    });
});
