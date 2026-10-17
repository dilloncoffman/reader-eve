import { describe, it, expect } from 'vitest';
import { chunkEditionsByDateRange } from './chunking';

describe('chunkEditionsByDateRange', () => {
  it('returns an empty array for no editions', () => {
    expect(chunkEditionsByDateRange([], 10)).toEqual([]);
  });

  it('groups a single day into one chunk with a single-date label', () => {
    const chunks = chunkEditionsByDateRange(
      [{ documentId: 'a', date: '2026-10-17' }, { documentId: 'b', date: '2026-10-17' }],
      10,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].documentIds.sort()).toEqual(['a', 'b']);
    expect(chunks[0].dateRangeLabel).toBe('Oct 17, 2026');
  });

  it('never produces more than maxChunks groups, merging adjacent days evenly', () => {
    const editions = Array.from({ length: 25 }, (_, i) => ({
      documentId: `d${i}`,
      date: `2026-05-${String(1 + i).padStart(2, '0')}`,
    }));
    const chunks = chunkEditionsByDateRange(editions, 10);
    expect(chunks.length).toBeLessThanOrEqual(10);
    expect(chunks.flatMap((c) => c.documentIds).sort()).toEqual(editions.map((e) => e.documentId).sort());
  });

  it('labels a merged multi-day chunk with a date range', () => {
    const editions = [
      { documentId: 'a', date: '2026-04-29' },
      { documentId: 'b', date: '2026-04-30' },
      { documentId: 'c', date: '2026-05-01' },
    ];
    const chunks = chunkEditionsByDateRange(editions, 1);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].dateRangeLabel).toBe('Apr 29 – May 1, 2026');
  });
});
