import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { createReadwiseClient, type ReadwiseClient } from '../../lib/readwise-client';

type Result =
  | { ok: true; digestId: string; digestUrl: string; archivedCount: number; taggedCount: number }
  | { ok: false; error: string };

export default defineTool({
  description:
    'Create a digest document from already-written content, then additively tag review-worthy source editions and archive every source edition in the batch. Only call this once the digest markdown is fully written.',
  inputSchema: z.object({
    sourceKey: z.enum(['dev', 'learn']),
    dateRangeLabel: z.string(),
    digestTitle: z.string(),
    digestMarkdown: z.string(),
    sourceDocumentIds: z.array(z.string()).min(1),
    reviewWorthyDocumentIds: z.array(z.string()),
  }),
  async execute(
    { sourceKey, digestTitle, digestMarkdown, sourceDocumentIds, reviewWorthyDocumentIds },
    ctx: any,
  ): Promise<Result> {
    const client: ReadwiseClient = ctx?.client ?? createReadwiseClient(process.env.READWISE_API_TOKEN!);

    let digest: { id: string; url: string };
    try {
      digest = await client.createDocument({
        title: digestTitle,
        markdown: digestMarkdown,
        location: 'new',
        category: 'article',
        tags: ['reader-eve-digest', sourceKey],
      });
    } catch (error) {
      return { ok: false, error: `Digest creation failed: ${String(error)}` };
    }

    for (const id of reviewWorthyDocumentIds) {
      const existingTags = await client.getDocumentTags(id);
      const mergedTags = existingTags.includes('reader-eve') ? existingTags : [...existingTags, 'reader-eve'];
      await client.updateDocumentTags(id, mergedTags);
    }

    await client.bulkArchive(sourceDocumentIds);

    return {
      ok: true,
      digestId: digest.id,
      digestUrl: digest.url,
      archivedCount: sourceDocumentIds.length,
      taggedCount: reviewWorthyDocumentIds.length,
    };
  },
});
