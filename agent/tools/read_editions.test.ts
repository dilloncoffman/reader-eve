import { describe, it, expect, vi } from 'vitest';
import toolDefault from './read_editions';
import type { ReadwiseClient } from '../../lib/readwise-client';

// See the matching comment in find_source_editions.test.ts for why this cast exists.
const tool = toolDefault as { execute: (input: unknown, ctx: unknown) => Promise<any> };

const doc = (id: string) => ({ id, title: `Dev Twitter List: ${id}`, tags: [], savedAt: 'x', content: `content of ${id}` });

function clientWithPages(pages: Array<Array<ReturnType<typeof doc>>>): ReadwiseClient {
  const listDocuments = vi.fn();
  pages.forEach((results, i) => {
    listDocuments.mockResolvedValueOnce({
      count: 99,
      nextPageCursor: i < pages.length - 1 ? `cursor${i + 1}` : null,
      results,
    });
  });
  return { listDocuments, createDocument: vi.fn(), getDocumentTags: vi.fn(), updateDocumentTags: vi.fn(), bulkArchive: vi.fn() } as any;
}

describe('read_editions', () => {
  it('scans feed pages with inline content and returns only the requested editions', async () => {
    const client = clientWithPages([[doc('a'), doc('x')], [doc('b'), doc('y')]]);
    const result = await tool.execute({ documentIds: ['a', 'b'] }, { client });
    expect(result.editions).toEqual([
      { documentId: 'a', title: 'Dev Twitter List: a', content: 'content of a' },
      { documentId: 'b', title: 'Dev Twitter List: b', content: 'content of b' },
    ]);
    expect(result.missingIds).toEqual([]);
    expect(result.stoppedBecause).toBe('found-all');
    expect(client.listDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ location: 'feed', category: 'rss', withContent: true, limit: 100 }),
    );
  });

  it('stops paging as soon as every requested edition is found', async () => {
    const client = clientWithPages([[doc('a'), doc('b')], [doc('z')]]);
    await tool.execute({ documentIds: ['a', 'b'] }, { client });
    expect(client.listDocuments).toHaveBeenCalledTimes(1);
  });

  it('reports editions that are no longer in the feed once the feed is exhausted', async () => {
    const client = clientWithPages([[doc('a')], [doc('x')]]);
    const result = await tool.execute({ documentIds: ['a', 'gone'] }, { client });
    expect(result.editions.map((e: any) => e.documentId)).toEqual(['a']);
    expect(result.missingIds).toEqual(['gone']);
    expect(result.stoppedBecause).toBe('feed-exhausted');
    expect(result.nextCursor).toBeNull();
  });

  it('stops at the time budget and returns a cursor to continue from', async () => {
    const client = clientWithPages([[doc('x')], [doc('a')]]);
    let t = 0;
    const clock = () => (t += 100_000);
    const result = await tool.execute({ documentIds: ['a'] }, { client, clock, budgetMs: 50_000 });
    expect(result.stoppedBecause).toBe('time-budget');
    expect(result.missingIds).toEqual(['a']);
    expect(result.nextCursor).toBe('cursor1');
    expect(client.listDocuments).toHaveBeenCalledTimes(1);
  });

  it('resumes from startCursor', async () => {
    const client = clientWithPages([[doc('a')]]);
    await tool.execute({ documentIds: ['a'], startCursor: 'cursor1' }, { client });
    expect(client.listDocuments).toHaveBeenCalledWith(expect.objectContaining({ pageCursor: 'cursor1' }));
  });
});
