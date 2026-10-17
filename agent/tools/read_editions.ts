import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { createReadwiseClient, type ReadwiseClient } from '../../lib/readwise-client';

type Result = {
  editions: Array<{ documentId: string; title: string; content: string }>;
  // Requested editions not found yet. After 'feed-exhausted' they're gone from
  // the feed (e.g. already archived); after 'time-budget' or 'page-cap', call
  // again with these ids and nextCursor.
  missingIds: string[];
  stoppedBecause: 'found-all' | 'feed-exhausted' | 'time-budget' | 'page-cap';
  nextCursor: string | null;
};

// Vercel kills a function at 300s, so stop well before that and hand back a
// cursor to continue from.
const DEFAULT_BUDGET_MS = 200_000;
const MAX_PAGES = 30;

export default defineTool({
  description:
    "Read the content of specific Dev/Learn Twitter-list editions by document id. Scans Reader's feed (newest first) with inline content, so one call covers many editions. If stoppedBecause is 'time-budget' or 'page-cap', call again with missingIds and nextCursor.",
  inputSchema: z.object({
    documentIds: z.array(z.string()).min(1),
    startCursor: z.string().optional(),
  }),
  async execute({ documentIds, startCursor }, ctx: any): Promise<Result> {
    const client: ReadwiseClient = ctx?.client ?? createReadwiseClient(process.env.READWISE_API_TOKEN!);
    const clock: () => number = ctx?.clock ?? Date.now;
    const budgetMs: number = ctx?.budgetMs ?? DEFAULT_BUDGET_MS;
    const startedAt = clock();

    const wanted = new Set(documentIds);
    const editions: Result['editions'] = [];
    let pageCursor: string | undefined = startCursor;
    let pages = 0;
    let stoppedBecause: Result['stoppedBecause'] = 'feed-exhausted';
    let nextCursor: string | null = null;

    while (true) {
      const page = await client.listDocuments({
        location: 'feed',
        category: 'rss',
        withContent: true,
        limit: 100,
        pageCursor,
      });
      pages += 1;
      for (const doc of page.results) {
        if (wanted.has(doc.id)) {
          editions.push({ documentId: doc.id, title: doc.title, content: doc.content ?? '' });
          wanted.delete(doc.id);
        }
      }

      if (wanted.size === 0) {
        stoppedBecause = 'found-all';
        break;
      }
      if (!page.nextPageCursor) {
        stoppedBecause = 'feed-exhausted';
        break;
      }
      nextCursor = page.nextPageCursor;
      pageCursor = page.nextPageCursor;
      if (clock() - startedAt >= budgetMs) {
        stoppedBecause = 'time-budget';
        break;
      }
      if (pages >= MAX_PAGES) {
        stoppedBecause = 'page-cap';
        break;
      }
    }

    return {
      editions,
      missingIds: documentIds.filter((id) => wanted.has(id)),
      stoppedBecause,
      nextCursor: stoppedBecause === 'time-budget' || stoppedBecause === 'page-cap' ? nextCursor : null,
    };
  },
});
