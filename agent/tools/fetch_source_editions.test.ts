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

  it('fetches edition content sequentially, never more than one getDocumentContent call in flight at once', async () => {
    const docs = Array.from({ length: 5 }, (_, i) => ({
      id: `d${i}`,
      title: `Dev Twitter List: October ${10 + i}, 2026 AM Edition`,
      tags: [],
      savedAt: '2026-10-10T09:00:00Z',
    }));
    const client = fakeClient(docs);
    let inFlight = 0;
    let maxInFlight = 0;
    client.getDocumentContent = vi.fn().mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return 'tweet content';
    });
    await tool.execute({ sourceKey: 'dev', mode: 'catchup' }, { client } as any);
    expect(maxInFlight).toBe(1);
    expect(client.getDocumentContent).toHaveBeenCalledTimes(5);
  });

  it('maxEditions stops paginating once enough matching editions are found, keeping the newest', async () => {
    const page1 = ['a', 'b', 'c'].map((id, i) => ({
      id,
      title: `Dev Twitter List: October ${17 - i}, 2026 AM Edition`,
      tags: [],
      savedAt: '2026-10-17T09:00:00Z',
    }));
    const client = fakeClient([]);
    client.listDocuments = vi
      .fn()
      .mockResolvedValueOnce({ count: 6, nextPageCursor: 'page2', results: page1 })
      .mockResolvedValueOnce({ count: 6, nextPageCursor: null, results: [] });
    const result = await tool.execute({ sourceKey: 'dev', mode: 'catchup', maxEditions: 2 }, { client } as any);
    const ids = result.chunks.flatMap((c: any) => c.editions.map((e: any) => e.documentId));
    expect(ids.sort()).toEqual(['a', 'b']);
    expect(client.listDocuments).toHaveBeenCalledTimes(1);
    expect(client.getDocumentContent).toHaveBeenCalledTimes(2);
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
