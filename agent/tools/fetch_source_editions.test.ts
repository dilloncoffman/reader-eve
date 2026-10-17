import { describe, it, expect, vi } from 'vitest';
import toolDefault from './fetch_source_editions';

// eve's `defineTool` return type intersects a generic base `execute` signature
// with the specific one inferred from our function, so TS widens
// `tool.execute(...)`'s awaited type to include `AsyncIterable<...>`. Casting
// here avoids fighting that framework typing quirk; runtime behavior is
// untouched (vitest doesn't type-check).
const tool = toolDefault as { execute: (input: unknown, ctx: unknown) => Promise<{ chunks: any[] }> };
import type { ReadwiseClient } from '../../lib/readwise-client';

function fakeClient(docs: Array<{ id: string; title: string; tags: string[]; savedAt: string }>): ReadwiseClient {
  return {
    listDocuments: vi.fn().mockResolvedValue({ count: docs.length, nextPageCursor: null, results: docs.map(d => ({ id: d.id, title: d.title, tags: d.tags, savedAt: d.savedAt })) }),
    getDocumentContent: vi.fn().mockResolvedValue('tweet content'),
    createDocument: vi.fn(),
    getDocumentTags: vi.fn(),
    updateDocumentTags: vi.fn(),
    bulkArchive: vi.fn(),
  };
}

describe('fetch_source_editions', () => {
  it('excludes unrelated feed content via title-prefix matching', async () => {
    const client = fakeClient([
      { id: 'd1', title: 'Dev Twitter List: October 17, 2026 AM Edition', tags: [], savedAt: '2026-10-17T09:00:00Z' },
      { id: 'd2', title: 'The race to the bottom feels inevitable…', tags: [], savedAt: '2026-10-17T08:00:00Z' },
    ]);
    const result = await tool.execute({ sourceKey: 'dev', mode: 'catchup' }, { client } as any);
    const ids = result.chunks.flatMap((c: any) => c.editions.map((e: any) => e.documentId));
    expect(ids).toEqual(['d1']);
  });

  it('returns an empty chunks array when nothing matches (no new editions)', async () => {
    const client = fakeClient([]);
    const result = await tool.execute({ sourceKey: 'dev', mode: 'daily' }, { client } as any);
    expect(result.chunks).toEqual([]);
  });

  it('daily mode only includes yesterday\'s AM and PM editions for the source', async () => {
    const client = fakeClient([
      { id: 'old', title: 'Dev Twitter List: October 10, 2026 AM Edition', tags: [], savedAt: '2026-10-10T09:00:00Z' },
      { id: 'am', title: 'Dev Twitter List: October 16, 2026 AM Edition', tags: [], savedAt: '2026-10-16T09:00:00Z' },
      { id: 'pm', title: 'Dev Twitter List: October 16, 2026 PM Edition', tags: [], savedAt: '2026-10-16T21:00:00Z' },
    ]);
    const result = await tool.execute({ sourceKey: 'dev', mode: 'daily' }, { client, now: new Date('2026-10-17T09:00:00Z') } as any);
    const ids = result.chunks.flatMap((c: any) => c.editions.map((e: any) => e.documentId));
    expect(ids.sort()).toEqual(['am', 'pm']);
  });

  it('catchup mode never returns more than 10 chunks', async () => {
    const docs = Array.from({ length: 40 }, (_, i) => ({
      id: `d${i}`,
      title: `Dev Twitter List: ${['January','February','March','April','May','June','July','August','September','October','November','December'][Math.floor(i/4)%12]} ${1 + (i % 28)}, 2026 AM Edition`,
      tags: [],
      savedAt: '2026-01-01T09:00:00Z',
    }));
    const client = fakeClient(docs);
    const result = await tool.execute({ sourceKey: 'dev', mode: 'catchup' }, { client } as any);
    expect(result.chunks.length).toBeLessThanOrEqual(10);
  });
});
