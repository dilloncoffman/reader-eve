import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { createReadwiseClient, type ReadwiseClient } from '../../lib/readwise-client';
import { SOURCES } from '../../lib/sources';
import { parseEditionTitle } from '../../lib/title-matching';
import { chunkEditionsByDateRange, type EditionMeta } from '../../lib/chunking';

type FetchedChunk = {
  chunkId: string;
  dateRangeLabel: string;
  editions: Array<{ documentId: string; title: string; existingTags: string[]; content: string }>;
};

function yesterdayUtc(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export default defineTool({
  description: "Fetch unarchived Dev/Learn Twitter-list editions for a source, grouped into date-range chunks.",
  inputSchema: z.object({
    sourceKey: z.enum(['dev', 'learn']),
    mode: z.enum(['daily', 'catchup']),
  }),
  async execute({ sourceKey, mode }, ctx: any): Promise<{ chunks: FetchedChunk[] }> {
    const client: ReadwiseClient = ctx?.client ?? createReadwiseClient(process.env.READWISE_API_TOKEN!);
    const now: Date = ctx?.now ?? new Date();
    const source = SOURCES.find((s) => s.key === sourceKey)!;

    const matched: Array<{ documentId: string; title: string; existingTags: string[]; date: string }> = [];
    let pageCursor: string | undefined;
    let pages = 0;
    do {
      const page = await client.listDocuments({ location: 'feed', category: 'rss', limit: 100, pageCursor });
      for (const doc of page.results) {
        const parsed = parseEditionTitle(doc.title, source.listLabel);
        if (!parsed) continue;
        matched.push({ documentId: doc.id, title: doc.title, existingTags: doc.tags, date: parsed.date });
      }
      pageCursor = page.nextPageCursor ?? undefined;
      pages += 1;
      if (pages >= 50) {
        console.warn(`fetch_source_editions: hit 50-page pagination guard for source "${sourceKey}"`);
        break;
      }
    } while (pageCursor);

    const kept = mode === 'daily' ? matched.filter((m) => m.date === yesterdayUtc(now)) : matched;

    if (kept.length === 0) {
      return { chunks: [] };
    }

    const withContent = await Promise.all(
      kept.map(async (m) => ({ ...m, content: await client.getDocumentContent(m.documentId) })),
    );

    const editionMetas: EditionMeta[] = withContent.map((m) => ({ documentId: m.documentId, date: m.date }));
    const chunks = chunkEditionsByDateRange(editionMetas, 10);
    const byId = new Map(withContent.map((m) => [m.documentId, m]));

    const fetchedChunks: FetchedChunk[] = chunks.map((chunk, index) => ({
      chunkId: `${sourceKey}-${index}`,
      dateRangeLabel: chunk.dateRangeLabel,
      editions: chunk.documentIds.map((id) => {
        const m = byId.get(id)!;
        return { documentId: m.documentId, title: m.title, existingTags: m.existingTags, content: m.content };
      }),
    }));

    return { chunks: fetchedChunks };
  },
});
