import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { createReadwiseClient, type ReadwiseClient } from '../../lib/readwise-client';
import { SOURCES } from '../../lib/sources';
import { parseEditionTitle } from '../../lib/title-matching';
import { chunkEditionsByDateRange, type EditionMeta } from '../../lib/chunking';

type FoundChunk = {
  chunkId: string;
  dateRangeLabel: string;
  editions: Array<{ documentId: string; title: string; existingTags: string[] }>;
};

export default defineTool({
  description:
    'Find unarchived Dev/Learn Twitter-list editions for a source and group them into date-range chunks. Returns document ids and titles only — use read_editions to get their content.',
  inputSchema: z.object({
    sourceKey: z.enum(['dev', 'learn']),
    mode: z.enum(['weekly', 'catchup']),
    maxEditions: z.number().int().positive().optional(),
  }),
  async execute({ sourceKey, mode, maxEditions }, ctx: any): Promise<{ chunks: FoundChunk[] }> {
    const client: ReadwiseClient = ctx?.client ?? createReadwiseClient(process.env.READWISE_API_TOKEN!);
    const now: Date = ctx?.now ?? new Date();
    const source = SOURCES.find((s) => s.key === sourceKey)!;

    // Weekly mode takes whatever is still unarchived rather than a fixed
    // 7-day window, so a missed run is picked up by the next one. Three weeks
    // of lookback covers that and keeps the scan to a few pages instead of the
    // whole feed.
    const updatedAfter =
      mode === 'weekly' ? new Date(now.getTime() - 21 * 24 * 60 * 60 * 1000).toISOString() : undefined;

    const matched: Array<{ documentId: string; title: string; existingTags: string[]; date: string }> = [];
    let pageCursor: string | undefined;
    let pages = 0;
    do {
      const page = await client.listDocuments({
        location: 'feed',
        category: 'rss',
        limit: 100,
        pageCursor,
        updatedAfter,
      });
      for (const doc of page.results) {
        const parsed = parseEditionTitle(doc.title, source.listLabel);
        if (!parsed) continue;
        matched.push({ documentId: doc.id, title: doc.title, existingTags: doc.tags, date: parsed.date });
      }
      pageCursor = page.nextPageCursor ?? undefined;
      pages += 1;
      // Feed results are newest-first, so once we have enough matches the
      // rest of the (large, mixed) feed doesn't need to be scanned.
      if (maxEditions && matched.length >= maxEditions) break;
      if (pages >= 50) {
        console.warn(`find_source_editions: hit 50-page pagination guard for source "${sourceKey}"`);
        break;
      }
    } while (pageCursor);

    const kept = maxEditions ? matched.slice(0, maxEditions) : matched;

    if (kept.length === 0) {
      return { chunks: [] };
    }

    const editionMetas: EditionMeta[] = kept.map((m) => ({ documentId: m.documentId, date: m.date }));
    // One digest for a weekly run; catchup spreads the backlog over at most 10.
    const chunks = chunkEditionsByDateRange(editionMetas, mode === 'weekly' ? 1 : 10);
    const byId = new Map(kept.map((m) => [m.documentId, m]));

    return {
      chunks: chunks.map((chunk, index) => ({
        chunkId: `${sourceKey}-${index}`,
        dateRangeLabel: chunk.dateRangeLabel,
        editions: chunk.documentIds.map((id) => {
          const m = byId.get(id)!;
          return { documentId: m.documentId, title: m.title, existingTags: m.existingTags };
        }),
      })),
    };
  },
});
