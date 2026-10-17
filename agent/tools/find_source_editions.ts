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

function yesterdayUtc(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export default defineTool({
  description:
    'Find unarchived Dev/Learn Twitter-list editions for a source and group them into date-range chunks. Returns document ids and titles only — use read_editions to get their content.',
  inputSchema: z.object({
    sourceKey: z.enum(['dev', 'learn']),
    mode: z.enum(['daily', 'catchup']),
    maxEditions: z.number().int().positive().optional(),
  }),
  async execute({ sourceKey, mode, maxEditions }, ctx: any): Promise<{ chunks: FoundChunk[] }> {
    const client: ReadwiseClient = ctx?.client ?? createReadwiseClient(process.env.READWISE_API_TOKEN!);
    const now: Date = ctx?.now ?? new Date();
    const source = SOURCES.find((s) => s.key === sourceKey)!;

    // Yesterday's editions were added yesterday, so in daily mode two days of
    // lookback is plenty and keeps this to about one page instead of scanning
    // the whole feed.
    const updatedAfter =
      mode === 'daily' ? new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString() : undefined;

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

    const inMode = mode === 'daily' ? matched.filter((m) => m.date === yesterdayUtc(now)) : matched;
    const kept = maxEditions ? inMode.slice(0, maxEditions) : inMode;

    if (kept.length === 0) {
      return { chunks: [] };
    }

    const editionMetas: EditionMeta[] = kept.map((m) => ({ documentId: m.documentId, date: m.date }));
    const chunks = chunkEditionsByDateRange(editionMetas, 10);
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
