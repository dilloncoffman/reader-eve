# reader-eve Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and deploy an eve agent that digests Dillon's Dev/Learn Reader Twitter-list editions into personalized summaries, triages what's worth his review or a mymind save, and keeps his Reader inbox empty.

**Architecture:** A single eve agent (deployed to Vercel) with two custom, fully deterministic tools and one daily cron schedule. All Reader access goes through a hand-written TypeScript client that calls **Readwise Reader's public REST API directly** (`https://readwise.io/api/v3/`), not through an `eve/connections` MCP client. This is a deliberate deviation from the design doc's MCP mention — see "Why direct REST, not an MCP connection" below. The model's job is narrowed to judgment only (writing digest prose, deciding which source documents are review-worthy); every constraint the design doc calls load-bearing — the 10-digest cap, write-before-archive ordering, and tag preservation — lives in plain TypeScript that unit tests pin down, not in agent instructions the model has to follow correctly every single run.

**Durability at catch-up scale:** no extra configuration is needed here — eve sessions run on Vercel Workflows and are durable by default (they survive cold starts, redeploys, and long pauses without any opt-in), which is exactly what the design doc's "use durable/resumable sessions for the catch-up pass" default calls for.

**Why direct REST, not an MCP connection:** eve's documented `ctx` (passed to a custom tool's `execute`) exposes `session`, `getSandbox()`, `getToken()`, `requireAuth()`, and `approval` — there is no documented way for a custom tool's own code to call another connection's tools programmatically. Connections are exposed to the *model*, which calls them itself via `eve__tool`. That means if Reader access went through `defineMcpClientConnection`, the model — not our code — would be the one deciding the order of "create digest" vs "archive sources," and the one deciding whether to use the tag-replacing `bulk_update` endpoint vs. an additive one. Those are exactly the three things the design doc says must never go wrong. Calling Reader's REST API directly from inside our own `defineTool` `execute()` functions keeps that logic in code we can unit test, while the model still fully owns the parts that are genuinely its job: writing good Dev/Learn-lens prose and judging what's worth Dillon's review.

**Tech Stack:** TypeScript, eve (`npx eve@latest init`), Vercel (deployment target), Zod (tool input schemas), vitest (unit tests), Readwise Reader REST API v3.

**Spec:** `docs/superpowers/specs/2026-10-17-reader-eve-design.md`

## Global Constraints

- Source documents live in Reader's `feed` location, category `rss`, titled exactly `"Dev Twitter List: <Month> <Day>, <Year> <AM|PM> Edition"` or `"Learn Twitter List: <Month> <Day>, <Year> <AM|PM> Edition"` — matching must be by this exact title prefix, since `feed` mixes in other RSS subscriptions.
- Catch-up pass: digest **everything currently unarchived** per list, capped at **10 digest documents per list**, each labeled with the date range it covers.
- Ongoing cadence: **once daily**, covering the previous day's editions (both AM and PM) — one digest per list per day.
- Daily cron target is **5am**; Vercel Cron evaluates in **UTC only** (no timezone config). This plan assumes **America/New_York** and sets the cron to `0 9 * * *` (5am EST = 9am UTC) — **confirm this with Dillon before deploy**; it will drift to 4am local during EDT since Vercel cron has no DST awareness.
- Per source document after processing: archived always; additionally tagged `reader-eve` (never replacing existing tags) if anything in it is review-worthy.
- Digest documents: created in Reader location `new` (so they land in the inbox Dillon actually opens), category `article`, tagged `['reader-eve-digest', <sourceKey>]`. Never auto-archived or auto-deleted by the agent.
- Digest creation must complete successfully *before* any of its covered source documents are archived or tagged. A failed digest write must leave every source document in that batch completely untouched.
- mymind candidates are never saved anywhere by the agent — described with a direct link in digest prose only.
- The agent never writes a Readwise highlight.
- Source → persona mapping lives in one config file (`lib/sources.ts`), not scattered across code, so adding a third list later is a config addition.
- Readwise Reader REST API: base `https://readwise.io/api/v3/`, `Authorization: Token <READWISE_API_TOKEN>`. Rate limits: `GET /list/` 20/min, `POST /save/` 50/min, `PATCH /update/<id>/` 50/min, `PATCH /bulk_update/` 20/min (max 50 items/call). 429 responses carry `Retry-After` in seconds.

## Review Focus

- **Mixed feed content**: Dillon's `feed` location holds other RSS subscriptions interleaved with Dev/Learn editions (confirmed live: 2,116 items, only a subset are list editions). A title-prefix bug would either digest unrelated RSS content as a tweet or silently skip real editions. → tested in Task 4.
- **Zero new editions for a day**: if Reader's AM/PM pull didn't produce a new edition (or it's already archived from a retry), a reasonable person expects no digest that day, not an empty "nothing happened" document. → tested in Task 4.
- **Digest-write failure mid-run**: if `POST /save/` throws (network blip, 500, rate limit), a reasonable person expects the source editions it would have covered to remain exactly as they were — not archived without ever being summarized. → tested in Task 5.
- **Pre-existing manual tags** (`shortlist`, `mymind` already in active use in Dillon's Reader): a reasonable person expects their own prior triage to survive this system running over a document, not get silently wiped by a tag update. → tested in Task 5.
- **Reader API rate limiting mid-catch-up**: with up to 10 chunks × 2 lists, each doing several REST calls, a reasonable person expects the run to slow down and keep going on a 429, not crash partway through and leave the backlog half-processed with no record of where it stopped. → tested in Task 1.

---

## Task 1: Readwise REST client

**Files:**
- Create: `lib/readwise-client.ts`
- Test: `lib/readwise-client.test.ts`
- Also in this task: run `npx eve@latest init .` in the (currently empty) `reader-eve` directory to scaffold the base eve project; add vitest (`pnpm add -D vitest`) and a `"test": "vitest run"` script to `package.json`.

**Interfaces:**
- Produces:
  ```ts
  export interface ReaderDocument {
    id: string;
    title: string;
    tags: string[];
    savedAt: string; // ISO 8601
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

  export function createReadwiseClient(
    apiToken: string,
    fetchImpl?: typeof fetch,
  ): ReadwiseClient;
  ```

- [ ] **Step 1: Write failing tests for `listDocuments`, `createDocument`, `getDocumentTags`, `updateDocumentTags`, `bulkArchive`, and 429 retry behavior**

```ts
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

  it('retries once after a 429 with Retry-After, then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ count: 0, nextPageCursor: null, results: [] }), { status: 200 }));
    const client = createReadwiseClient('tok', fetchMock);
    const result = await client.listDocuments({ location: 'feed' });
    expect(result.count).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/readwise-client.test.ts`
Expected: FAIL — `readwise-client.ts` does not exist yet.

- [ ] **Step 3: Scaffold the eve project and implement `createReadwiseClient`**

Run `npx eve@latest init .` in `/Users/dilloncoffman/Desktop/projects/reader-eve` (currently empty), then add vitest. Implement `lib/readwise-client.ts` per the interface above. Normalize Reader's tag shape (`{tagname: {...}}` object) to `string[]` of keys in `listDocuments` and `getDocumentTags`. On a 429, read `Retry-After` (seconds), `await` that long, and retry the request exactly once more before throwing. `getDocumentContent(id)` calls `GET /list/?id=<id>` and returns the `content` field (verify this exact field name against one live call during this task — the MCP wrapper used during brainstorming returned it as `content`, but confirm the raw REST response uses the same key before relying on it elsewhere).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/readwise-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent lib package.json pnpm-lock.yaml tsconfig.json .gitignore
git commit -m "feat: scaffold eve project and add Readwise REST client"
```

---

## Task 2: Source config and edition-title parsing

**Files:**
- Create: `lib/sources.ts`
- Create: `lib/title-matching.ts`
- Test: `lib/title-matching.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  ```ts
  // lib/sources.ts
  export interface SourceConfig {
    key: 'dev' | 'learn';
    listLabel: string;   // "Dev" | "Learn" — exact title prefix word
    lensSkill: string;   // filename under agent/skills/
  }
  export const SOURCES: SourceConfig[];

  // lib/title-matching.ts
  export interface ParsedEditionTitle {
    date: string; // 'YYYY-MM-DD'
    half: 'AM' | 'PM';
  }
  export function parseEditionTitle(title: string, listLabel: string): ParsedEditionTitle | null;
  ```

- [ ] **Step 1: Write failing tests for `parseEditionTitle`**

```ts
import { describe, it, expect } from 'vitest';
import { parseEditionTitle } from './title-matching';

describe('parseEditionTitle', () => {
  it('parses a matching Dev edition title', () => {
    expect(parseEditionTitle('Dev Twitter List: October 17, 2026 AM Edition', 'Dev')).toEqual({
      date: '2026-10-17',
      half: 'AM',
    });
  });

  it('parses a matching Learn edition title with PM', () => {
    expect(parseEditionTitle('Learn Twitter List: October 16, 2026 PM Edition', 'Learn')).toEqual({
      date: '2026-10-16',
      half: 'PM',
    });
  });

  it('returns null for a title with the wrong list label', () => {
    expect(parseEditionTitle('Learn Twitter List: October 16, 2026 PM Edition', 'Dev')).toBeNull();
  });

  it('returns null for unrelated feed content', () => {
    expect(parseEditionTitle('The race to the bottom feels inevitable…', 'Dev')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/title-matching.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `lib/sources.ts` and `parseEditionTitle`**

`SOURCES` has exactly two entries: `{ key: 'dev', listLabel: 'Dev', lensSkill: 'dev-lens.md' }` and `{ key: 'learn', listLabel: 'Learn', lensSkill: 'learn-lens.md' }`. `parseEditionTitle` matches `^${listLabel} Twitter List: (.+) (AM|PM) Edition$`; on match, parse the captured date string (e.g. `"October 17, 2026"`) with `new Date(...)` and format to `YYYY-MM-DD`; return `null` on no match or an unparseable date.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/title-matching.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/sources.ts lib/title-matching.ts lib/title-matching.test.ts
git commit -m "feat: add source config and edition-title parsing"
```

---

## Task 3: Backlog chunking

**Files:**
- Create: `lib/chunking.ts`
- Test: `lib/chunking.test.ts`

**Interfaces:**
- Consumes: nothing directly (operates on plain `{documentId, date}` pairs the caller already parsed via Task 2's `parseEditionTitle`).
- Produces:
  ```ts
  export interface EditionMeta {
    documentId: string;
    date: string; // 'YYYY-MM-DD'
  }
  export interface EditionChunk {
    dateRangeLabel: string; // e.g. "Apr 29 – May 12, 2026" or "Oct 17, 2026" for a single day
    documentIds: string[];
  }
  export function chunkEditionsByDateRange(editions: EditionMeta[], maxChunks: number): EditionChunk[];
  ```

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { chunkEditionsByDateRange } from './chunking';

describe('chunkEditionsByDateRange', () => {
  it('returns an empty array for no editions', () => {
    expect(chunkEditionsByDateRange([], 10)).toEqual([]);
  });

  it('groups a single day into one chunk with a single-date label', () => {
    const chunks = chunkEditionsByDateRange(
      [{ documentId: 'a', date: '2026-10-17' }, { documentId: 'b', date: '2026-10-17' }],
      10,
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].documentIds.sort()).toEqual(['a', 'b']);
    expect(chunks[0].dateRangeLabel).toBe('Oct 17, 2026');
  });

  it('never produces more than maxChunks groups, merging adjacent days evenly', () => {
    const editions = Array.from({ length: 25 }, (_, i) => ({
      documentId: `d${i}`,
      date: `2026-05-${String(1 + i).padStart(2, '0')}`,
    }));
    const chunks = chunkEditionsByDateRange(editions, 10);
    expect(chunks.length).toBeLessThanOrEqual(10);
    expect(chunks.flatMap((c) => c.documentIds).sort()).toEqual(editions.map((e) => e.documentId).sort());
  });

  it('labels a merged multi-day chunk with a date range', () => {
    const editions = [
      { documentId: 'a', date: '2026-04-29' },
      { documentId: 'b', date: '2026-04-30' },
      { documentId: 'c', date: '2026-05-01' },
    ];
    const chunks = chunkEditionsByDateRange(editions, 1);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].dateRangeLabel).toBe('Apr 29 – May 1, 2026');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run lib/chunking.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `chunkEditionsByDateRange`**

Group editions by calendar date first (one natural group per distinct date, sorted ascending). If the number of date-groups is `<= maxChunks`, return one chunk per date-group. Otherwise, merge adjacent date-groups into exactly `maxChunks` contiguous chunks as evenly as possible (e.g. via `Math.ceil(dateGroups.length / maxChunks)` groups per chunk). Label a chunk spanning one date as `"Mon D, YYYY"`; a chunk spanning multiple dates as `"Mon D – Mon D, YYYY"` (use the chunk's first and last date; only show the year once, at the end).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run lib/chunking.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add lib/chunking.ts lib/chunking.test.ts
git commit -m "feat: add backlog chunking by date range"
```

---

## Task 4: `fetch_source_editions` tool

**Files:**
- Create: `agent/tools/fetch_source_editions.ts`
- Test: `agent/tools/fetch_source_editions.test.ts`

**Interfaces:**
- Consumes: `createReadwiseClient`, `ReadwiseClient` (Task 1); `SOURCES`, `SourceConfig` (Task 2); `parseEditionTitle` (Task 2); `chunkEditionsByDateRange`, `EditionMeta` (Task 3).
- Produces:
  ```ts
  // tool name seen by the model: "fetch_source_editions"
  inputSchema: z.object({
    sourceKey: z.enum(['dev', 'learn']),
    mode: z.enum(['daily', 'catchup']),
  })

  interface FetchedChunk {
    chunkId: string;
    dateRangeLabel: string;
    editions: Array<{ documentId: string; title: string; existingTags: string[]; content: string }>;
  }
  // execute() resolves to: { chunks: FetchedChunk[] }
  ```

- [ ] **Step 1: Write failing tests (inject a fake `ReadwiseClient`)**

```ts
import { describe, it, expect, vi } from 'vitest';
import tool from './fetch_source_editions';
import type { ReadwiseClient } from '../../lib/readwise-client';

function fakeClient(docs: Array<{ id: string; title: string; tags: string[]; savedAt: string }>): ReadwiseClient {
  return {
    listDocuments: vi.fn().mockResolvedValue({ count: docs.length, nextPageCursor: null, results: docs.map(d => ({ id: d.id, title: d.title, tags: d.tags, savedAt: d.savedAt })) }),
    getDocumentContent: vi.fn().mockResolvedValue('tweet content'),
    createDocument: vi.fn(),
    getDocumentTags: vi.fn(),
    updateDocumentTags: vi.fn(),
    bulkArchive: vi.fn(),
  };
}

describe('fetch_source_editions', () => {
  it('excludes unrelated feed content via title-prefix matching', async () => {
    const client = fakeClient([
      { id: 'd1', title: 'Dev Twitter List: October 17, 2026 AM Edition', tags: [], savedAt: '2026-10-17T09:00:00Z' },
      { id: 'd2', title: 'The race to the bottom feels inevitable…', tags: [], savedAt: '2026-10-17T08:00:00Z' },
    ]);
    const result = await tool.execute({ sourceKey: 'dev', mode: 'catchup' }, { client } as any);
    const ids = result.chunks.flatMap((c: any) => c.editions.map((e: any) => e.documentId));
    expect(ids).toEqual(['d1']);
  });

  it('returns an empty chunks array when nothing matches (no new editions)', async () => {
    const client = fakeClient([]);
    const result = await tool.execute({ sourceKey: 'dev', mode: 'daily' }, { client } as any);
    expect(result.chunks).toEqual([]);
  });

  it('daily mode only includes yesterday\'s AM and PM editions for the source', async () => {
    const client = fakeClient([
      { id: 'old', title: 'Dev Twitter List: October 10, 2026 AM Edition', tags: [], savedAt: '2026-10-10T09:00:00Z' },
      { id: 'am', title: 'Dev Twitter List: October 16, 2026 AM Edition', tags: [], savedAt: '2026-10-16T09:00:00Z' },
      { id: 'pm', title: 'Dev Twitter List: October 16, 2026 PM Edition', tags: [], savedAt: '2026-10-16T21:00:00Z' },
    ]);
    const result = await tool.execute({ sourceKey: 'dev', mode: 'daily' }, { client, now: new Date('2026-10-17T09:00:00Z') } as any);
    const ids = result.chunks.flatMap((c: any) => c.editions.map((e: any) => e.documentId));
    expect(ids.sort()).toEqual(['am', 'pm']);
  });

  it('catchup mode never returns more than 10 chunks', async () => {
    const docs = Array.from({ length: 40 }, (_, i) => ({
      id: `d${i}`,
      title: `Dev Twitter List: ${['January','February','March','April','May','June','July','August','September','October','November','December'][Math.floor(i/4)%12]} ${1 + (i % 28)}, 2026 AM Edition`,
      tags: [],
      savedAt: '2026-01-01T09:00:00Z',
    }));
    const client = fakeClient(docs);
    const result = await tool.execute({ sourceKey: 'dev', mode: 'catchup' }, { client } as any);
    expect(result.chunks.length).toBeLessThanOrEqual(10);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run agent/tools/fetch_source_editions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tool**

Use `defineTool` from `eve/tools`. `execute(input, ctx)` builds a `ReadwiseClient` via `createReadwiseClient(process.env.READWISE_API_TOKEN!)` unless `ctx.client`/`ctx.now` are injected (support both so tests can inject a fake client and a fixed clock; production path ignores `ctx.client`/`ctx.now` if absent and uses the real client and `new Date()`). Resolve the source's `listLabel` from `SOURCES` by `sourceKey`. Paginate `listDocuments({location: 'feed', category: 'rss', limit: 100, pageCursor})` until `nextPageCursor` is `null`, capping at 50 pages as a runaway-loop guard (log and stop if hit). For each result, run `parseEditionTitle(title, listLabel)`; skip non-matches. In `daily` mode, keep only editions whose parsed `date` equals "yesterday" relative to `ctx.now ?? new Date()` (UTC date arithmetic); if none match, return `{ chunks: [] }` without calling `getDocumentContent`. In `catchup` mode, keep every match found across all pages. For each kept edition, call `getDocumentContent(id)` to fetch its markdown body. Build `EditionMeta[]` from the kept editions and call `chunkEditionsByDateRange(..., 10)`; map the resulting document-id groups back to full `{documentId, title, existingTags, content}` records to build `FetchedChunk[]`, generating `chunkId` as `${sourceKey}-${index}`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run agent/tools/fetch_source_editions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/tools/fetch_source_editions.ts agent/tools/fetch_source_editions.test.ts
git commit -m "feat: add fetch_source_editions tool"
```

---

## Task 5: `create_digest_and_finalize_sources` tool

**Files:**
- Create: `agent/tools/create_digest_and_finalize_sources.ts`
- Test: `agent/tools/create_digest_and_finalize_sources.test.ts`

**Interfaces:**
- Consumes: `ReadwiseClient`, `createReadwiseClient` (Task 1).
- Produces:
  ```ts
  // tool name seen by the model: "create_digest_and_finalize_sources"
  inputSchema: z.object({
    sourceKey: z.enum(['dev', 'learn']),
    dateRangeLabel: z.string(),
    digestTitle: z.string(),
    digestMarkdown: z.string(),
    sourceDocumentIds: z.array(z.string()).min(1),
    reviewWorthyDocumentIds: z.array(z.string()),
  })
  // execute() resolves to:
  //   { ok: true; digestId: string; digestUrl: string; archivedCount: number; taggedCount: number }
  //   | { ok: false; error: string }
  ```

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, vi } from 'vitest';
import tool from './create_digest_and_finalize_sources';
import type { ReadwiseClient } from '../../lib/readwise-client';

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run agent/tools/create_digest_and_finalize_sources.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the tool**

Use `defineTool` from `eve/tools`. `execute(input, ctx)` resolves a `ReadwiseClient` the same way as Task 4 (real client by default, `ctx.client` override for tests). Step order, exactly:
1. `createDocument({ title: digestTitle, markdown: digestMarkdown, location: 'new', category: 'article', tags: ['reader-eve-digest', sourceKey] })`. On rejection, return `{ ok: false, error: `Digest creation failed: ${String(error)}` }` immediately — do not call any other client method.
2. For each id in `reviewWorthyDocumentIds`: `getDocumentTags(id)`, append `'reader-eve'` only if not already present, `updateDocumentTags(id, mergedTags)`.
3. `bulkArchive(sourceDocumentIds)` (all of them, regardless of review-worthy status).
4. Return `{ ok: true, digestId, digestUrl, archivedCount: sourceDocumentIds.length, taggedCount: reviewWorthyDocumentIds.length }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run agent/tools/create_digest_and_finalize_sources.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/tools/create_digest_and_finalize_sources.ts agent/tools/create_digest_and_finalize_sources.test.ts
git commit -m "feat: add create_digest_and_finalize_sources tool"
```

---

## Task 6: Agent persona, lens skills, and instructions

**Files:**
- Create: `agent/agent.ts`
- Create: `agent/instructions.md`
- Create: `agent/skills/dev-lens.md`
- Create: `agent/skills/learn-lens.md`

**Interfaces:**
- Consumes: tool names `fetch_source_editions` and `create_digest_and_finalize_sources` (Tasks 4–5, filenames become these names automatically); `SOURCES` (Task 2) for the two `sourceKey` values the instructions must mention.
- Produces: the running agent's behavior for Tasks 7–8 to trigger.

No unit test is possible here — this is prose that steers model judgment, not a function with a return value. Verification is manual, via local dev, in this task's own steps.

- [ ] **Step 1: Write `agent/agent.ts`**

```ts
import { defineAgent } from 'eve';

export default defineAgent({
  model: 'anthropic/claude-sonnet-5',
});
```

- [ ] **Step 2: Write `agent/instructions.md`**

State the agent's one job in imperative steps: for each of `dev` and `learn`, call `fetch_source_editions` with that `sourceKey` and the mode given in the request; if `chunks` is empty, skip that source entirely (no digest); otherwise, for each chunk, load the matching lens skill (`dev-lens.md` or `learn-lens.md`) and write `digestTitle` (format: `"<Dev|Learn> Digest — <dateRangeLabel>"`) and `digestMarkdown` per that skill's criteria, decide `reviewWorthyDocumentIds` (edition documents containing something worth Dillon's own Readwise-highlight review), then call `create_digest_and_finalize_sources` with that chunk's data before moving to the next chunk or source. State explicitly: never call `create_digest_and_finalize_sources` before `digestMarkdown` is fully written, and never skip calling it for a chunk that `fetch_source_editions` returned.

- [ ] **Step 3: Write `agent/skills/dev-lens.md` and `agent/skills/learn-lens.md`**

Dev lens: audience is software engineers/developers Dillon follows for React, AI, and tech-product takes; digest prose should surface what's genuinely novel or actionable, not restate every tweet. Learn lens: audience is solo founders, writers, and business/content people; same bar. Both skills must instruct the model to end the digest with a "Worth considering for mymind" section listing any products, novel ideas, art, or music mentioned — each as a one-line description plus the direct tweet link — and to never save anything to mymind itself, only describe it. Pull the exact persona wording from `docs/superpowers/specs/2026-10-17-reader-eve-design.md`'s "Intent & why" section.

- [ ] **Step 4: Manual verification**

Run `pnpm dev`. POST a daily-mode test session: `curl -X POST http://127.0.0.1:3000/eve/v1/session -H 'content-type: application/json' -d '{"message":"Run the daily digest for sourceKey dev."}'`. Confirm in the terminal/stream output that the agent calls `fetch_source_editions` before `create_digest_and_finalize_sources`, and that it skips the finalize call entirely if `chunks` came back empty (test this by running against a date with no real editions, e.g. temporarily point at a day you know is already archived).

- [ ] **Step 5: Commit**

```bash
git add agent/agent.ts agent/instructions.md agent/skills
git commit -m "feat: add agent instructions and dev/learn lens skills"
```

---

## Task 7: Daily schedule

**Files:**
- Create: `agent/schedules/daily-digest.ts`

**Interfaces:**
- Consumes: nothing new; triggers a normal agent turn that uses Tasks 4–6.

- [ ] **Step 1: Write `agent/schedules/daily-digest.ts`**

```ts
import { defineSchedule } from 'eve/schedules';

export default defineSchedule({
  cron: '0 9 * * *', // 5am America/New_York (EST); Vercel Cron is UTC-only — confirm timezone before deploy
  markdown:
    'Run the daily digest for sourceKey dev in mode daily, then run the daily digest for sourceKey learn in mode daily.',
});
```

- [ ] **Step 2: Manual verification**

Run `pnpm dev` and confirm eve's startup log lists the `daily-digest` schedule without a validation error (eve validates schedule files at boot). There is no automated test for cron registration itself — this is infrastructure wiring, confirmed at Task 9's deploy step by checking the Vercel dashboard's Cron Jobs list after `eve deploy`.

- [ ] **Step 3: Commit**

```bash
git add agent/schedules/daily-digest.ts
git commit -m "feat: add daily digest cron schedule"
```

---

## Task 8: Env wiring, deployment, and catch-up run

**Files:**
- Create: `README.md`
- Modify: none (Vercel project environment variables are configured outside the repo)

- [ ] **Step 1: Write `README.md`** covering:
  - How to get a Readwise access token (readwise.io/access_token) and set it as `READWISE_API_TOKEN` in both `.env.local` (for `pnpm dev`) and the Vercel project's environment variables (for `eve deploy`), per eve's documented credential setup.
  - `eve link` then `eve deploy` to ship.
  - After the first successful deploy, **before** the daily schedule's first 5am firing, manually run the catch-up pass once per source by starting a session against the deployed agent (via `eve remote connect` or an authenticated POST to the deployed `/eve/v1/session` route) with the message: `"Run the daily digest for sourceKey dev in mode catchup, then run the daily digest for sourceKey learn in mode catchup."`
  - Recommend a local dry run first: temporarily point `READWISE_API_TOKEN` at a disposable/test Reader setup if Dillon wants to avoid running catch-up against his real backlog on the first try — otherwise, since Task 1–5's unit tests already cover the ordering/cap/tag-preservation guarantees, running catch-up directly against the real account is reasonable once those tests pass.
  - Note the open timezone assumption from Task 7 and ask Dillon to confirm or correct the cron expression before relying on the 5am daily run.

- [ ] **Step 2: Confirm `READWISE_API_TOKEN` is set, then run `pnpm vitest run` for the full suite**

Run: `pnpm vitest run`
Expected: PASS (all tests from Tasks 1–5)

- [ ] **Step 3: Deploy**

Run: `eve link` (interactive, links to a Vercel project), then `eve deploy`.
Expected: deploy succeeds; Vercel dashboard shows the project with a Cron Jobs entry for `daily-digest`.

- [ ] **Step 4: Run the one-time catch-up pass** (per the README instructions above), for `dev` then `learn`.

Expected: up to 10 new digest documents per list appear in Reader's inbox (`new` location), each titled with its date range; the `feed` location's unarchived Dev/Learn editions are gone (moved to `archive`); any edition that was review-worthy carries the `reader-eve` tag; no existing `shortlist`/`mymind` tags were removed from any source document.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: add setup, deploy, and catch-up run instructions"
```
