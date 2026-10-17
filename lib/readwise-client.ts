const BASE_URL = 'https://readwise.io/api/v3';

export interface ReaderDocument {
  id: string;
  title: string;
  tags: string[];
  savedAt: string;
}

export interface ReadwiseClient {
  listDocuments(params: {
    location: string;
    category?: string;
    pageCursor?: string;
    limit?: number;
  }): Promise<{ count: number; nextPageCursor: string | null; results: ReaderDocument[] }>;

  getDocumentContent(documentId: string): Promise<string>;

  createDocument(input: {
    title: string;
    markdown: string;
    location: string;
    category: string;
    tags: string[];
  }): Promise<{ id: string; url: string }>;

  getDocumentTags(documentId: string): Promise<string[]>;

  updateDocumentTags(documentId: string, tags: string[]): Promise<void>;

  bulkArchive(documentIds: string[]): Promise<void>;
}

function normalizeTags(rawTags: unknown): string[] {
  if (!rawTags || typeof rawTags !== 'object') return [];
  return Object.keys(rawTags as Record<string, unknown>);
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function stripTagsKeepingLinks(html: string): string {
  const withLinks = html.replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_m, href, inner) => {
    const text = decodeHtmlEntities(inner.replace(/<[^>]+>/g, '').trim());
    return text ? `${text} (${href})` : href;
  });
  return decodeHtmlEntities(withLinks.replace(/<[^>]+>/g, '')).replace(/[ \t]+/g, ' ').trim();
}

function tweetArticleToText(articleHtml: string): string {
  const headerMatch = articleHtml.match(/<header class="rw-embedded-tweet-header">([\s\S]*?)<\/header>/);
  const mainMatch = articleHtml.match(/<main>([\s\S]*?)<\/main>/);
  const footerMatch = articleHtml.match(/<footer class="rw-embedded-tweet-footer"[^>]*>([\s\S]*?)<\/footer>/);
  const retweetMatch = articleHtml.match(/^\s*<span><a[^>]*>([\s\S]*?retweeted)<\/a><\/span>/);

  const lines: string[] = [];
  if (retweetMatch) lines.push(stripTagsKeepingLinks(retweetMatch[1]));
  if (headerMatch) lines.push(stripTagsKeepingLinks(headerMatch[1]));
  if (mainMatch) {
    const paragraphs = Array.from(mainMatch[1].matchAll(/<p>([\s\S]*?)<\/p>/g))
      .map((m) => stripTagsKeepingLinks(m[1]))
      .filter((text) => text.length > 0);
    lines.push(...paragraphs);
  }
  if (footerMatch) lines.push(stripTagsKeepingLinks(footerMatch[1]));

  return lines.filter((line) => line.length > 0).join('\n');
}

function htmlToReadableText(html: string): string {
  const articles = Array.from(html.matchAll(/<article class="rw-embedded-tweet"[^>]*>([\s\S]*?)<\/article>/g));
  return articles
    .map((m) => tweetArticleToText(m[1]))
    .filter((text) => text.length > 0)
    .join('\n\n');
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function createReadwiseClient(apiToken: string, fetchImpl: typeof fetch = fetch): ReadwiseClient {
  async function request(path: string, init: RequestInit = {}, isRetry = false): Promise<Response> {
    const response = await fetchImpl(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Token ${apiToken}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });

    if (response.status === 429 && !isRetry) {
      const retryAfterSeconds = Number(response.headers.get('Retry-After') ?? '0');
      await new Promise((resolve) => setTimeout(resolve, retryAfterSeconds * 1000));
      return request(path, init, true);
    }

    if (!response.ok) {
      throw new Error(`Readwise API request failed: ${response.status} ${path}`);
    }

    return response;
  }

  return {
    async listDocuments({ location, category, pageCursor, limit }) {
      const query = new URLSearchParams();
      query.set('location', location);
      if (category) query.set('category', category);
      if (pageCursor) query.set('pageCursor', pageCursor);
      if (limit) query.set('limit', String(limit));

      const response = await request(`/list/?${query.toString()}`);
      const body = (await response.json()) as {
        count: number;
        nextPageCursor: string | null;
        results: Array<{ id: string; title: string; tags: unknown; saved_at: string }>;
      };

      return {
        count: body.count,
        nextPageCursor: body.nextPageCursor,
        results: body.results.map((doc) => ({
          id: doc.id,
          title: doc.title,
          tags: normalizeTags(doc.tags),
          savedAt: doc.saved_at,
        })),
      };
    },

    async getDocumentContent(documentId) {
      const response = await request(
        `/list/?${new URLSearchParams({ id: documentId, withHtmlContent: 'true' }).toString()}`,
      );
      const body = (await response.json()) as {
        results: Array<{ content: string | null; html_content: string | null }>;
      };
      const doc = body.results[0];
      if (doc?.content) return doc.content;
      if (doc?.html_content) return htmlToReadableText(doc.html_content);
      return '';
    },

    async createDocument({ title, markdown, location, category, tags }) {
      const response = await request('/save/', {
        method: 'POST',
        body: JSON.stringify({ title, markdown, location, category, tags }),
      });
      const body = (await response.json()) as { id: string; url: string };
      return { id: body.id, url: body.url };
    },

    async getDocumentTags(documentId) {
      const response = await request(`/list/?${new URLSearchParams({ id: documentId }).toString()}`);
      const body = (await response.json()) as { results: Array<{ tags: unknown }> };
      return normalizeTags(body.results[0]?.tags);
    },

    async updateDocumentTags(documentId, tags) {
      await request(`/update/${documentId}/`, {
        method: 'PATCH',
        body: JSON.stringify({ tags }),
      });
    },

    async bulkArchive(documentIds) {
      for (const batch of chunk(documentIds, 50)) {
        await request('/bulk_update/', {
          method: 'PATCH',
          body: JSON.stringify({ updates: batch.map((id) => ({ id, location: 'archive' })) }),
        });
      }
    },
  };
}
