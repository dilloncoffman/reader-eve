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
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.url).toBe('https://reader-eve.vercel.app/digest/dev-digest-oct-17-2026');
    expect(body.html).toContain('<h1>Dev Digest</h1>');
    expect(body.markdown).toBeUndefined();
    expect(body.tags).toEqual(['reader-eve-digest', 'dev']);
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

  it('listDocuments passes tag, updatedAfter and withHtmlContent, and location is optional', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ count: 0, nextPageCursor: null, results: [] }), { status: 200 }),
    );
    const client = createReadwiseClient('tok', fetchMock);
    await client.listDocuments({ tag: 'reader-eve-digest', updatedAfter: '2026-10-15T00:00:00.000Z', withContent: true });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('tag=reader-eve-digest');
    expect(url).toContain('updatedAfter=2026-10-15T00%3A00%3A00.000Z');
    expect(url).toContain('withHtmlContent=true');
    expect(url).not.toContain('location=');
  });

  it('listDocuments with withContent returns compact readable text for rw-embedded-tweet html', async () => {
    const html = `<div><div>
<article class="rw-embedded-tweet" data-rw-tweet-id="2111266470865088656"><span><a href="https://twitter.com/acemarke">
<svg><path d="M0"></path></svg>
         @acemarke retweeted</a></span>
<header class="rw-embedded-tweet-header">
<div><img src="https://pbs.twimg.com/profile_images/1.jpg"/></div>
<div>
<span><a href="https://twitter.com/replayio">Replay</a></span>
<span><a href="https://twitter.com/replayio">@replayio</a></span>
</div>
<div><a href="https://twitter.com/replayio/status/2111266470865088656"><svg aria-label="X"><path d="M1"></path></svg></a></div>
</header>
<main>
<p></p><p>Gaps don't disappear when you move fast.</p><p><a href="https://twitter.com/natgj11">@natgj11</a>, founder of <a href="https://example.com/x">Swoon</a></p><p></p>
</main>
<footer class="rw-embedded-tweet-footer" data-rw-created-timestamp="1792166676000">
<span><a href="https://twitter.com/replayio/status/2111266470865088656">Posted Oct 16, 2026 at 4:04PM</a></span>
</footer>
</article>
</div></div>`;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          count: 1,
          nextPageCursor: null,
          results: [{ id: 'd1', title: 'Dev Twitter List: October 16, 2026 PM Edition', tags: {}, saved_at: '2026-10-16T21:00:00Z', content: null, html_content: html }],
        }),
        { status: 200 },
      ),
    );
    const client = createReadwiseClient('tok', fetchMock);
    const page = await client.listDocuments({ location: 'feed', withContent: true });
    expect(page.results[0].content).toBe(
      [
        '@acemarke retweeted',
        'Replay (@replayio) — Posted Oct 16, 2026 at 4:04PM — https://twitter.com/replayio/status/2111266470865088656',
        "Gaps don't disappear when you move fast.",
        '@natgj11, founder of Swoon (https://example.com/x)',
      ].join('\n'),
    );
  });

  it('listDocuments without withContent leaves content undefined', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ count: 1, nextPageCursor: null, results: [{ id: 'd1', title: 't', tags: {}, saved_at: 'x' }] }), { status: 200 }),
    );
    const client = createReadwiseClient('tok', fetchMock);
    const page = await client.listDocuments({ location: 'feed' });
    expect(page.results[0].content).toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).not.toContain('withHtmlContent');
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
