import { defineTool } from 'eve/tools';
import { z } from 'zod';
import { createReadwiseClient, type ReadwiseClient } from '../../lib/readwise-client';

type Result =
  | { ok: true; digestId: string; digestUrl: string; archivedCount: number; taggedCount: number }
  | { ok: false; error: string };

async function findExistingDigest(
  client: ReadwiseClient,
  title: string,
): Promise<{ id: string; url: string } | undefined> {
  let pageCursor: string | undefined;
  do {
    const page = await client.listDocuments({ tag: 'reader-eve-digest', limit: 100, pageCursor });
    const match = page.results.find((doc) => doc.title === title);
    if (match) return { id: match.id, url: `https://read.readwise.io/read/${match.id}` };
    pageCursor = page.nextPageCursor ?? undefined;
  } while (pageCursor);
  return undefined;
}

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
      // eve can replay a step after a crash, and the model may resubmit a
      // digest, and Reader happily stores two documents for one url. So reuse
      // a digest that already has this title rather than creating a duplicate.
      const existing = await findExistingDigest(client, digestTitle);
      digest =
        existing ??
        (await client.createDocument({
          title: digestTitle,
          markdown: digestMarkdown,
          location: 'new',
          category: 'article',
          tags: ['reader-eve-digest', sourceKey],
        }));
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
