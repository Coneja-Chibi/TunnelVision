/**
 * Tests for shared-utils.js — centralised utility functions.
 */

import { describe, it, expect } from 'vitest';
import {hashString,
    shuffleArray,
    isSystemEntry,
    isActiveFactEntry,
    isActSummaryEntry,
    isStorySummaryEntry,
    isTrackerEntry,
    isSummaryEntry,
    iterActiveEntries,
    collectActiveEntries,
    collectActiveEntryTitles,
    chunkBySize,
    formatShortDateTime,
} from '../shared-utils.js';

//── hashString ───────────────────────────────────────────────────

describe('hashString', () => {
    it('returns a number', () => {
        expect(typeof hashString('hello')).toBe('number');
    });

    it('returns deterministic results', () => {
        expect(hashString('test')).toBe(hashString('test'));
    });

    it('returns different hashes for different inputs', () => {
        expect(hashString('alpha')).not.toBe(hashString('beta'));
    });

    it('handles empty string', () => {
        expect(hashString('')).toBe(0);
    });

    it('handles long strings', () => {
        const long = 'a'.repeat(100_000);
        expect(typeof hashString(long)).toBe('number');
    });

    it('is sensitive to small changes', () => {
        expect(hashString('abc')).not.toBe(hashString('abd'));
    });

    it('matches legacy contentHash / simpleHash behaviour', () => {
        // Manually computed djb2-variant for "hi"
        // hash = 0
        // i=0: ((0 << 5) - 0+ 104) | 0 = 104
        // i=1: ((104 << 5) - 104 + 105) | 0 = 3328- 104 + 105 = 3329
        expect(hashString('hi')).toBe(3329);
    });
});

// ── shuffleArray ─────────────────────────────────────────────────

describe('shuffleArray', () => {
    it('returns the same array reference', () => {
        const arr = [1, 2, 3];
        expect(shuffleArray(arr)).toBe(arr);
    });

    it('preserves array length', () => {
        const arr = [1, 2, 3, 4, 5];
        shuffleArray(arr);
        expect(arr).toHaveLength(5);
    });

    it('preserves all elements', () => {
        const arr = [10, 20, 30, 40, 50];
        shuffleArray(arr);
        expect(arr.sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50]);
    });

    it('handles empty array', () => {
        const arr = [];
        shuffleArray(arr);
        expect(arr).toEqual([]);
    });

    it('handles single-element array', () => {
        const arr = [42];
        shuffleArray(arr);
        expect(arr).toEqual([42]);
    });

    it('handles two-element array', () => {
        const arr = [1, 2];
        shuffleArray(arr);
        expect(arr).toHaveLength(2);
        expect(arr.sort((a, b) => a - b)).toEqual([1, 2]);
    });

    it('eventually produces a different order', () => {
        // Run many shuffles — at least one should differ from sorted order
        const original = [1, 2, 3, 4, 5, 6, 7, 8];
        let sawDifferent = false;
        for (let i = 0; i < 50; i++) {
            const arr = [...original];
            shuffleArray(arr);
            if (arr.some((v, idx) => v !== original[idx])) {
                sawDifferent = true;
                break;
            }
        }
        expect(sawDifferent).toBe(true);
    });
});

// ── Entry classification helpers ─────────────────────────────────

describe('isSystemEntry', () => {
    it('returns true for tracker entries', () => {
        expect(isSystemEntry({ comment: '[Tracker] Character Stats' })).toBe(true);
    });

    it('returns true for tracker with subtypes', () => {
        expect(isSystemEntry({ comment: '[Tracker: Character] Alice' })).toBe(true);
    });

    it('returns true for scene summary entries', () => {
        expect(isSystemEntry({ comment: '[Scene Summary] Something happened' })).toBe(true);
    });

    it('returns true for summary entries', () => {
        expect(isSystemEntry({ comment: '[Summary] A brief note' })).toBe(true);
    });

    it('returns true for act summary entries', () => {
        expect(isSystemEntry({ comment: '[Act Summary] Act 1' })).toBe(true);
    });

    it('returns true for story summary entries', () => {
        expect(isSystemEntry({ comment: '[Story Summary] Full story' })).toBe(true);
    });

    it('returns false for regular fact entries', () => {
        expect(isSystemEntry({ comment: 'Alice is a dragon tamer' })).toBe(false);
    });

    it('returns false for entries with no comment', () => {
        expect(isSystemEntry({ comment: '' })).toBe(false);
    });

    it('returns false for null/undefined entry', () => {
        expect(isSystemEntry(null)).toBe(false);
        expect(isSystemEntry(undefined)).toBe(false);
    });

    it('returns false for entry with null comment', () => {
        expect(isSystemEntry({ comment: null })).toBe(false);
    });

    it('is case-insensitive', () => {
        expect(isSystemEntry({ comment: '[TRACKER] Loud' })).toBe(true);
        expect(isSystemEntry({ comment: '[summary] quiet' })).toBe(true);});
});

describe('isActiveFactEntry', () => {
    it('returns true for enabled non-system entries', () => {
        expect(isActiveFactEntry({ comment:'A regular fact', disable: false })).toBe(true);
    });

    it('returns false for disabled entries', () => {
        expect(isActiveFactEntry({ comment: 'A fact', disable: true })).toBe(false);
    });

    it('returns false for system entries', () => {
        expect(isActiveFactEntry({ comment: '[Tracker] Stats', disable: false })).toBe(false);expect(isActiveFactEntry({ comment: '[Summary] Scene', disable: false })).toBe(false);
    });

    it('returns false for null/undefined', () => {
        expect(isActiveFactEntry(null)).toBe(false);
        expect(isActiveFactEntry(undefined)).toBe(false);
    });

    it('treats entries without disable property as enabled', () => {
        expect(isActiveFactEntry({ comment: 'A fact' })).toBe(true);});
});

describe('isActSummaryEntry', () => {
    it('returns true for act summary entries', () => {
        expect(isActSummaryEntry({ comment: '[Act Summary] Act 1: The Beginning' })).toBe(true);
    });

    it('returns false for scene summaries', () => {
        expect(isActSummaryEntry({ comment: '[Summary] Something happened' })).toBe(false);
        expect(isActSummaryEntry({ comment: '[Scene Summary] Something' })).toBe(false);
    });

    it('returns false for story summaries', () => {
        expect(isActSummaryEntry({ comment: '[Story Summary] Full story' })).toBe(false);
    });

    it('handles null entry', () => {
        expect(isActSummaryEntry(null)).toBe(false);
    });
});

describe('isStorySummaryEntry', () => {
    it('returns true for story summary entries', () => {
        expect(isStorySummaryEntry({ comment: '[Story Summary] Story So Far' })).toBe(true);
    });

    it('returns false for act summaries', () => {
        expect(isStorySummaryEntry({ comment: '[Act Summary] Act 1' })).toBe(false);
    });

    it('returns false for scene summaries', () => {
        expect(isStorySummaryEntry({ comment: '[Summary] A scene' })).toBe(false);
    });

    it('handles null entry', () => {
        expect(isStorySummaryEntry(null)).toBe(false);
    });
});

describe('isTrackerEntry', () => {
    it('returns true for tracker entries', () => {
        expect(isTrackerEntry({ comment: '[Tracker] Alice' })).toBe(true);
    });

    it('returns false for summaries', () => {
        expect(isTrackerEntry({ comment: '[Summary] Something' })).toBe(false);
    });

    it('returns false for regular entries', () => {
        expect(isTrackerEntry({ comment: 'Just a fact' })).toBe(false);
    });

    it('handles null entry', () => {
        expect(isTrackerEntry(null)).toBe(false);
    });
});

describe('isSummaryEntry', () => {
    it('returns true for all summary types', () => {
        expect(isSummaryEntry({ comment: '[Summary] Scene' })).toBe(true);
        expect(isSummaryEntry({ comment: '[Scene Summary] Scene' })).toBe(true);
        expect(isSummaryEntry({ comment: '[Act Summary] Act 1' })).toBe(true);
        expect(isSummaryEntry({ comment: '[Story Summary] Full' })).toBe(true);});

    it('returns false for trackers', () => {
        expect(isSummaryEntry({ comment: '[Tracker] Alice' })).toBe(false);});

    it('returns false for regular entries', () => {
        expect(isSummaryEntry({ comment: 'A dragon' })).toBe(false);
    });

    it('handles null entry', () => {
        expect(isSummaryEntry(null)).toBe(false);
    });
});

// ── Entry iteration──────────────────────────────────────────────

describe('iterActiveEntries', () => {
    const entries = {
        0: { uid: 1, comment: 'Alice the brave', disable: false },
        1: { uid: 2, comment: '[Tracker] Alice Stats', disable: false },
        2: { uid: 3, comment: 'Bob the wizard', disable: true },
        3: { uid: 4, comment: '[Summary] What happened', disable: false },
        4: { uid: 5, comment: 'The magic sword', disable: false },
    };

    it('yields only active non-system entries by default', () => {
        const results = [];
        iterActiveEntries(entries, (entry) => results.push(entry.uid));
        expect(results).toEqual([1, 5]);
    });

    it('includes system entries when skipSystem=false', () => {
        const results = [];
        iterActiveEntries(entries, (entry) => results.push(entry.uid), { skipSystem: false });
        expect(results).toEqual([1, 2, 4, 5]);
    });

    it('passes key as second argument', () => {
        const keys = [];
        iterActiveEntries(entries, (_entry, key) => keys.push(key));
        expect(keys).toEqual(['0', '4']);
    });

    it('handles null/undefined entries gracefully', () => {
        expect(() => iterActiveEntries(null, () => {})).not.toThrow();
        expect(() => iterActiveEntries(undefined, () => {})).not.toThrow();
    });

    it('handles empty entries', () => {
        const results = [];
        iterActiveEntries({}, (entry) => results.push(entry));
        expect(results).toEqual([]);
    });

    it('skips null entry values in the map', () => {
        const entries = { 0: null, 1: { uid: 1, comment: 'Good', disable: false } };
        const results = [];
        iterActiveEntries(entries, (entry) => results.push(entry.uid));
        expect(results).toEqual([1]);
    });
});

describe('collectActiveEntries', () => {
    const entries = {
        0: { uid: 1, comment: 'Alice', disable: false },
        1: { uid: 2, comment: '[Tracker] Stats', disable: false },
        2: { uid: 3, comment: 'Bob', disable: true },
        3: { uid: 4, comment: 'Carl', disable: false },
    };

    it('returns only active non-system entries', () => {
        const result = collectActiveEntries(entries);
        expect(result.map(e => e.uid)).toEqual([1, 4]);
    });

    it('includes system entries when skipSystem=false', () => {
        const result = collectActiveEntries(entries, { skipSystem: false });
        expect(result.map(e => e.uid)).toEqual([1, 2, 4]);
    });

    it('returns empty array for null entries', () => {
        expect(collectActiveEntries(null)).toEqual([]);
    });
});

describe('collectActiveEntryTitles', () => {
    const entries = {
        0: { uid: 1, comment: 'Alice the brave  ', disable: false },
        1: { uid: 2, comment: '[Tracker] Stats', disable: false },
        2: { uid: 3, comment: '', disable: false },
        3: { uid: 4, comment: 'Bob the wizard', disable: true },
        4: { uid: 5, comment: '[Summary] Scene recap', disable: false },
        5: { uid: 6, comment: 'The magic sword', disable: false },
    };

    it('returns trimmed titles of active non-system entries', () => {
        const result = collectActiveEntryTitles(entries);
        expect(result).toEqual(['Alice the brave', 'The magic sword']);
    });

    it('skips entries with empty comments', () => {
        const result = collectActiveEntryTitles(entries);
        expect(result).not.toContain('');
    });

    it('skips tracker and summary entries', () => {
        const result = collectActiveEntryTitles(entries);
        expect(result.some(t => t.includes('Tracker'))).toBe(false);
        expect(result.some(t => t.includes('Summary'))).toBe(false);
    });

    it('returns empty array for null entries', () => {
        expect(collectActiveEntryTitles(null)).toEqual([]);
    });
});

// ── chunkBySize ──────────────────────────────────────────────────

describe('chunkBySize', () => {
    it('returns empty array for empty input', () => {
        expect(chunkBySize([], () => 10, 100)).toEqual([]);
    });

    it('puts all items in one chunk when they fit', () => {
        const items = ['a', 'bb', 'ccc'];
        const result = chunkBySize(items, (s) => s.length, 100);
        expect(result).toEqual([['a', 'bb', 'ccc']]);
    });

    it('splits items across chunks based on size', () => {
        const items = [10, 20, 30, 40];
        // charLimit = 35, sizes = item values
        const result = chunkBySize(items, (n) => n, 35);
        //10 fits, 20 fits (30 total), 30 would make 60 > 35 → overfill: chunk [10, 20, 30]
        // 40 alone → chunk [40]
        expect(result).toEqual([[10, 20, 30], [40]]);
    });

    it('overfills when a single item exceeds the limit', () => {
        const items = ['huge'];
        const result = chunkBySize(items, () => 9999, 10);
        expect(result).toEqual([['huge']]);
    });

    it('uses the overfill strategy correctly', () => {
        // Items with sizes: [5, 5, 5, 5], limit = 12
        const items = ['a', 'b', 'c', 'd'];
        const result = chunkBySize(items, () => 5, 12);
        // a(5), b(10), c would be15 > 12 → overfill: [a, b, c] sealed
        // d alone → [d]
        expect(result).toEqual([['a', 'b', 'c'], ['d']]);
    });

    it('handles single item', () => {
        const result = chunkBySize(['only'], () => 5, 100);
        expect(result).toEqual([['only']]);
    });

    it('all items trigger overfill on second item', () => {
        // Each item is size 10, limit is 5
        const items = ['x', 'y', 'z'];
        const result = chunkBySize(items, () => 10, 5);
        // x(10) fits (first in chunk), y(+10=20> 5) → overfill [x, y]
        // z alone → [z]
        expect(result).toEqual([['x', 'y'], ['z']]);
    });

    it('preserves item order', () => {
        const items = [1, 2, 3, 4, 5];
        const result = chunkBySize(items, () => 1, 2);
        const flat = result.flat();
        expect(flat).toEqual([1, 2, 3, 4, 5]);
    });

    it('works with heterogeneous sizes', () => {
        const items = [
            { name: 'short', size: 10 },
            { name: 'medium', size: 50 },
            { name: 'tiny', size: 5 },{ name: 'big', size: 80 },
            { name: 'small', size: 15 },
        ];
        const result = chunkBySize(items, (i) => i.size, 60);
        // short(10) + medium(+50=60) fits, tiny(+5=65 > 60) → overfill [short, medium, tiny]
        // big(80) fits (first), small(+15=95 > 60) → overfill [big, small]
        expect(result.map(chunk => chunk.map(i => i.name))).toEqual([
            ['short', 'medium', 'tiny'],
            ['big', 'small'],
        ]);
    });
});

// ── formatShortDateTime ──────────────────────────────────────────

describe('formatShortDateTime', () => {
    it('formats a Date object', () => {
        const date = new Date(2024, 0, 15, 14, 30); // Jan 15, 2024 2:30 PM
        const result = formatShortDateTime(date);
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);expect(result).not.toBe('—');
        // Should contain the day number
        expect(result).toContain('15');
    });

    it('formats a timestamp number', () => {
        const ts = new Date(2024, 5, 1, 9, 0).getTime(); // Jun 1, 2024
        const result = formatShortDateTime(ts);
        expect(result).not.toBe('—');
        expect(result).toContain('1');
    });

    it('formats an ISO date string', () => {
        const result = formatShortDateTime('2024-03-20T10:00:00Z');
        expect(result).not.toBe('—');
        expect(result).toContain('20');
    });

    it('returns dash for invalid date', () => {
        expect(formatShortDateTime('not-a-date')).toBe('—');
    });

    it('returns dash for NaN', () => {
        expect(formatShortDateTime(NaN)).toBe('—');
    });

    it('returns dash for null', () => {
        expect(formatShortDateTime(null)).toBe('—');
    });

    it('returns dash for undefined', () => {
        expect(formatShortDateTime(undefined)).toBe('—');
    });

    it('handles epoch zero', () => {
        const result = formatShortDateTime(0);
        // Epoch 0 is a valid date (Jan 1, 1970) — should not return dash
        expect(result).not.toBe('—');
    });

    it('returns consistent results for the same input', () => {
        const date = new Date(2024, 11, 25, 8, 0);
        expect(formatShortDateTime(date)).toBe(formatShortDateTime(date));
    });

    it('includes time component', () => {
        // Two dates on the same day at different times should produce different strings
        const morning = new Date(2024, 0, 1, 8, 0);
        const evening = new Date(2024, 0, 1, 20, 0);
        const morningStr = formatShortDateTime(morning);
        const eveningStr = formatShortDateTime(evening);
        expect(morningStr).not.toBe(eveningStr);
    });
});

import {
    SECRET_TAG_RE,
    SECRET_GUARD_LINE,
    SECRET_AUTHORING_INSTRUCTION,
} from '../shared-utils.js';

describe('secret tag', () => {
    it('matches a tagged entry regardless of case and suffix', () => {
        expect(SECRET_TAG_RE.test('[SECRET — Elena is unaware] She is the heir.')).toBe(true);
        expect(SECRET_TAG_RE.test('[secret] hidden')).toBe(true);
        expect(SECRET_TAG_RE.test('[SECRET: king] plot')).toBe(true);
    });

    it('does not match the plain word secret in prose', () => {
        expect(SECRET_TAG_RE.test('She kept the secret well.')).toBe(false);
        expect(SECRET_TAG_RE.test('[SECRETARY] role note')).toBe(false);
    });

    it('guard line and authoring instruction reference the tag without presenting it as privacy control', () => {
        expect(SECRET_GUARD_LINE).toContain('[SECRET');
        expect(SECRET_AUTHORING_INSTRUCTION).toContain('[SECRET');
        expect(SECRET_GUARD_LINE).toContain('does not hide content');
        expect(SECRET_AUTHORING_INSTRUCTION).toContain('not privacy or access control');
    });
});
