import { describe, it, expect, vi } from 'vitest';
import toolDefault from './create_digest_and_finalize_sources';
import type { ReadwiseClient } from '../../lib/readwise-client';

// See the matching comment in fetch_source_editions.test.ts for why this cast exists.
const tool = toolDefault as { execute: (input: unknown, ctx: unknown) => Promise<any> };

function fakeClient(overrides: Partial<ReadwiseClient> = {}): ReadwiseClient {
  return {
    listDocuments: vi.fn(),
    getDocumentContent: vi.fn(),
    createDocument: vi.fn().mockResolvedValue({ id: 'digest1', url: 'https://read.readwise.io/new/read/digest1' }),
    getDocumentTags: vi.fn().mockResolvedValue(['shortlist']),
    updateDocumentTags: vi.fn().mockResolvedValue(undefined),
    bulkArchive: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const baseInput = {
  sourceKey: 'dev' as const,
  dateRangeLabel: 'Oct 16, 2026',
  digestTitle: 'Dev Digest — Oct 16, 2026',
  digestMarkdown: '# Dev Digest',
  sourceDocumentIds: ['s1', 's2'],
  reviewWorthyDocumentIds: ['s1'],
};

describe('create_digest_and_finalize_sources', () => {
  it('creates the digest, then tags review-worthy docs additively and archives all source docs', async () => {
    const client = fakeClient();
    const result = await tool.execute(baseInput, { client } as any);
    expect(result).toMatchObject({ ok: true, digestId: 'digest1' });
    expect(client.getDocumentTags).toHaveBeenCalledWith('s1');
    expect(client.updateDocumentTags).toHaveBeenCalledWith('s1', ['shortlist', 'reader-eve']);
    expect(client.updateDocumentTags).not.toHaveBeenCalledWith('s2', expect.anything());
    expect(client.bulkArchive).toHaveBeenCalledWith(['s1', 's2']);
  });

  it('does not duplicate the reader-eve tag if already present', async () => {
    const client = fakeClient({ getDocumentTags: vi.fn().mockResolvedValue(['reader-eve']) });
    await tool.execute(baseInput, { client } as any);
    expect(client.updateDocumentTags).toHaveBeenCalledWith('s1', ['reader-eve']);
  });

  it('touches no source documents if digest creation fails', async () => {
    const client = fakeClient({ createDocument: vi.fn().mockRejectedValue(new Error('500')) });
    const result = await tool.execute(baseInput, { client } as any);
    expect(result).toEqual({ ok: false, error: 'Digest creation failed: Error: 500' });
    expect(client.getDocumentTags).not.toHaveBeenCalled();
    expect(client.updateDocumentTags).not.toHaveBeenCalled();
    expect(client.bulkArchive).not.toHaveBeenCalled();
  });

  it('archives non-review-worthy docs with no tag change at all', async () => {
    const client = fakeClient();
    await tool.execute({ ...baseInput, reviewWorthyDocumentIds: [] }, { client } as any);
    expect(client.getDocumentTags).not.toHaveBeenCalled();
    expect(client.updateDocumentTags).not.toHaveBeenCalled();
    expect(client.bulkArchive).toHaveBeenCalledWith(['s1', 's2']);
  });
});
