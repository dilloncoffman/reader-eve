import { marked } from 'marked';

const BASE_URL = 'https://readwise.io/api/v3';
const DIGEST_URL_BASE = 'https://reader-eve.vercel.app/digest';
const MAX_429_RETRIES = 5;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export type ReaderDocument = {
  id: string;
  title: string;
  tags: string[];
  savedAt: string;
  // Compact readable text; only present when listDocuments was called with withContent.
  content?: string;
};

export type ReadwiseClient = {
  listDocuments(params: {
    location?: string;
    category?: string;
    tag?: string;
    updatedAfter?: string;
    withContent?: boolean;
    pageCursor?: string;
    limit?: number;
  }): Promise<{ count: number; nextPageCursor: string | null; results: ReaderDocument[] }>;

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
};

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

function stripTags(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

// Reader's feed gives us each tweet as an `rw-embedded-tweet` article, which is
// mostly icons and duplicated links. Keep what a reader needs: who, when, the
// permalink, and the text with inline links (mentions drop their profile URL).
function inlineText(html: string): string {
  const withLinks = html.replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (_m, href, inner) => {
    const text = stripTags(inner);
    if (!text) return '';
    return text.startsWith('@') ? text : `${text} (${href})`;
  });
  return stripTags(withLinks);
}

function tweetArticleToText(articleHtml: string): string {
  const retweetMatch = articleHtml.match(/^\s*<span><a[^>]*>([\s\S]*?retweeted)<\/a><\/span>/);
  const headerMatch = articleHtml.match(/<header class="rw-embedded-tweet-header">([\s\S]*?)<\/header>/);
  const mainMatch = articleHtml.match(/<main>([\s\S]*?)<\/main>/);
  const footerMatch = articleHtml.match(/<footer class="rw-embedded-tweet-footer"[^>]*>([\s\S]*?)<\/footer>/);

  const lines: string[] = [];
  if (retweetMatch) lines.push(stripTags(retweetMatch[1]));

  const names = headerMatch
    ? Array.from(headerMatch[1].matchAll(/<a\s+[^>]*href="[^"]*"[^>]*>([\s\S]*?)<\/a>/g))
        .map((m) => stripTags(m[1]))
        .filter(Boolean)
    : [];
  const footerLink = footerMatch?.[1].match(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
  const byline = [
    names.length >= 2 ? `${names[0]} (${names[1]})` : names[0],
    footerLink ? stripTags(footerLink[2]) : undefined,
    footerLink?.[1],
  ].filter(Boolean);
  if (byline.length > 0) lines.push(byline.join(' — '));

  if (mainMatch) {
    for (const m of mainMatch[1].matchAll(/<p>([\s\S]*?)<\/p>/g)) {
      const text = inlineText(m[1]);
      if (text) lines.push(text);
    }
  }
  return lines.join('\n');
}

function htmlToReadableText(html: string): string {
  return Array.from(html.matchAll(/<article class="rw-embedded-tweet"[^>]*>([\s\S]*?)<\/article>/g))
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
  async function request(path: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
    const response = await fetchImpl(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Token ${apiToken}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });

    if (response.status === 429 && attempt < MAX_429_RETRIES) {
      const retryAfterSeconds = Number(response.headers.get('Retry-After') ?? '0');
      await new Promise((resolve) => setTimeout(resolve, Math.max(retryAfterSeconds, 1) * 1000));
      return request(path, init, attempt + 1);
    }

    if (!response.ok) {
      throw new Error(`Readwise API request failed: ${response.status} ${path}`);
    }

    return response;
  }

  return {
    async listDocuments({ location, category, tag, updatedAfter, withContent, pageCursor, limit }) {
      const query = new URLSearchParams();
      if (location) query.set('location', location);
      if (category) query.set('category', category);
      if (tag) query.set('tag', tag);
      if (updatedAfter) query.set('updatedAfter', updatedAfter);
      if (withContent) query.set('withHtmlContent', 'true');
      if (pageCursor) query.set('pageCursor', pageCursor);
      if (limit) query.set('limit', String(limit));

      const response = await request(`/list/?${query.toString()}`);
      const body = (await response.json()) as {
        count: number;
        nextPageCursor: string | null;
        results: Array<{
          id: string;
          title: string;
          tags: unknown;
          saved_at: string;
          content?: string | null;
          html_content?: string | null;
        }>;
      };

      return {
        count: body.count,
        nextPageCursor: body.nextPageCursor,
        results: body.results.map((doc) => {
          const result: ReaderDocument = {
            id: doc.id,
            title: doc.title,
            tags: normalizeTags(doc.tags),
            savedAt: doc.saved_at,
          };
          if (withContent) {
            result.content = doc.content || (doc.html_content ? htmlToReadableText(doc.html_content) : '');
          }
          return result;
        }),
      };
    },

    async createDocument({ title, markdown, location, category, tags }) {
      const response = await request('/save/', {
        method: 'POST',
        // Reader's /save/ requires a url and takes html.
        body: JSON.stringify({
          url: `${DIGEST_URL_BASE}/${slugify(title)}`,
          html: await marked.parse(markdown),
          title,
          location,
          category,
          tags,
        }),
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
