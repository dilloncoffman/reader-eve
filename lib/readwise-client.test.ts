import { describe, it, expect, vi } from 'vitest';
import { createReadwiseClient } from './readwise-client';

describe('createReadwiseClient', () => {
  it('listDocuments sends location/category/pageCursor and normalizes tags to string[]', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          count: 1,
          nextPageCursor: null,
          results: [{ id: 'd1', title: 'Dev Twitter List: October 17, 2026 AM Edition', tags: { shortlist: {} }, saved_at: '2026-10-17T00:00:00Z' }],
        }),
        { status: 200 },
      ),
    );
    const client = createReadwiseClient('tok', fetchMock);
    const result = await client.listDocuments({ location: 'feed', category: 'rss' });
    expect(result.results[0]).toEqual({
      id: 'd1',
      title: 'Dev Twitter List: October 17, 2026 AM Edition',
      tags: ['shortlist'],
      savedAt: '2026-10-17T00:00:00Z',
    });
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain('location=feed');
    expect(calledUrl).toContain('category=rss');
  });

  it('createDocument posts to /save/ and returns {id, url}', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'new1', url: 'https://read.readwise.io/new/read/new1' }), { status: 201 }),
    );
    const client = createReadwiseClient('tok', fetchMock);
    const result = await client.createDocument({
      title: 'Dev Digest — Oct 17, 2026',
      markdown: '# Dev Digest',
      location: 'new',
      category: 'article',
      tags: ['reader-eve-digest', 'dev'],
    });
    expect(result).toEqual({ id: 'new1', url: 'https://read.readwise.io/new/read/new1' });
    expect(fetchMock.mock.calls[0][0]).toContain('/save/');
  });

  it('updateDocumentTags PATCHes /update/<id>/ with the full tag list given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const client = createReadwiseClient('tok', fetchMock);
    await client.updateDocumentTags('d1', ['shortlist', 'reader-eve']);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/update/d1/');
    expect(JSON.parse(init.body as string).tags).toEqual(['shortlist', 'reader-eve']);
  });

  it('bulkArchive PATCHes /bulk_update/ with location: archive for every id, chunked at 50', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));
    const client = createReadwiseClient('tok', fetchMock);
    const ids = Array.from({ length: 75 }, (_, i) => `d${i}`);
    await client.bulkArchive(ids);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(firstBody.updates).toHaveLength(50);
    expect(firstBody.updates[0]).toEqual({ id: 'd0', location: 'archive' });
  });

  it('getDocumentContent requests withHtmlContent and converts rw-embedded-tweet HTML to readable text', async () => {
    const html = `<div><div>
<article class="rw-embedded-tweet" data-rw-tweet-id="2111387957072445938">
<header class="rw-embedded-tweet-header">
<div><img src="https://pbs.twimg.com/profile_images/1.jpg"/></div>
<div>
<span><a href="https://twitter.com/shadcn">shadcn</a></span>
<span><a href="https://twitter.com/shadcn">@shadcn</a></span>
</div>
</header>
<main>
<p></p><p>I need early access to whatever model Anthropic is using internally to build Claude Code.</p><p></p>
</main>
<footer class="rw-embedded-tweet-footer" data-rw-created-timestamp="1792229091000">
<span><a href="https://twitter.com/shadcn/status/2111387957072445938">Posted Oct 17, 2026 at 9:24AM</a></span>
</footer>
</article>
</div></div>`;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ count: 1, nextPageCursor: null, results: [{ content: null, html_content: html }] }), { status: 200 }),
    );
    const client = createReadwiseClient('tok', fetchMock);
    const content = await client.getDocumentContent('d1');

    expect(fetchMock.mock.calls[0][0]).toContain('withHtmlContent=true');
    expect(content).toContain('shadcn');
    expect(content).toContain('I need early access to whatever model Anthropic is using internally to build Claude Code.');
    expect(content).toContain('https://twitter.com/shadcn/status/2111387957072445938');
  });

  it('getDocumentContent returns an empty string when there are no tweet articles in the HTML', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ count: 1, nextPageCursor: null, results: [{ content: null, html_content: '<div></div>' }] }), { status: 200 }),
    );
    const client = createReadwiseClient('tok', fetchMock);
    const content = await client.getDocumentContent('d1');
    expect(content).toBe('');
  });

  it('retries once after a 429 with Retry-After, then succeeds', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '0' } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ count: 0, nextPageCursor: null, results: [] }), { status: 200 }));
      const client = createReadwiseClient('tok', fetchMock);
      const resultPromise = client.listDocuments({ location: 'feed' });
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      expect(result.count).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries across several consecutive 429s before succeeding', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '0' } }))
        .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '0' } }))
        .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '0' } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ count: 0, nextPageCursor: null, results: [] }), { status: 200 }));
      const client = createReadwiseClient('tok', fetchMock);
      const resultPromise = client.listDocuments({ location: 'feed' });
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      expect(result.count).toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws after exhausting retries on persistent 429s', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 429, headers: { 'Retry-After': '0' } }));
      const client = createReadwiseClient('tok', fetchMock);
      const resultPromise = client.listDocuments({ location: 'feed' });
      const assertion = expect(resultPromise).rejects.toThrow(/429/);
      await vi.runAllTimersAsync();
      await assertion;
      expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
