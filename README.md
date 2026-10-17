# reader-eve

An [eve](https://eve.dev) agent that digests Dillon's Readwise Reader "Dev" and "Learn" Twitter-list editions into short, personalized digests, and keeps the Reader inbox from piling up. See `docs/superpowers/specs/2026-10-17-reader-eve-design.md` for the full design and `docs/superpowers/plans/2026-10-17-reader-eve-plan.md` for how it was built.

## Setup

1. Get a Readwise access token from [readwise.io/access_token](https://readwise.io/access_token).
2. Create `.env.local` in the project root with:
   ```
   READWISE_API_TOKEN=<your token>
   ```
   This file is gitignored — never commit it.
3. Install dependencies and run the test suite:
   ```bash
   npm install
   npm test
   npm run typecheck
   ```

## Local development

```bash
npm exec -- eve dev --no-ui
```

This starts the dev server (default `http://127.0.0.1:2000`) without the interactive TUI, so it can be driven by curl or another process. `eve dev` never fires schedules on their cron cadence — use the dispatch route to trigger `daily-digest` on demand while iterating:

```bash
curl -X POST http://127.0.0.1:2000/eve/v1/dev/schedules/daily-digest
```

Sending a session message directly also works, for testing a specific `sourceKey`/`mode` combination:

```bash
curl -X POST http://127.0.0.1:2000/eve/v1/session \
  -H 'content-type: application/json' \
  -d '{"message":"Run the daily digest for sourceKey dev in mode daily."}'
```

Local dev needs a model credential to actually run a turn (not just boot) — either `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` for a direct provider model, or `AI_GATEWAY_API_KEY` / a linked Vercel project (`vercel env pull`, after `eve link`) for the Gateway-style model string this agent uses (`anthropic/claude-sonnet-5`).

## Deploy

```bash
eve link    # interactive; links to a Vercel project, pulls an AI Gateway credential into .env.local
eve deploy  # installs dependencies, runs `vercel deploy --prod --logs`
```

Before deploying, add `READWISE_API_TOKEN` to the Vercel project's environment variables (Vercel dashboard → Settings → Environment Variables) — `.env.local` is never uploaded by `eve deploy`.

After deploy, confirm in the Vercel dashboard under **Settings → Cron Jobs** that `daily-digest` is registered.

**Timezone note:** `agent/schedules/daily-digest.ts` runs at `0 9 * * *` UTC, which is 5am EDT (America/New_York, confirmed from Vercel's GMT-4 log timestamps) and 4am EST after the clocks go back. Vercel Cron is UTC-only with no DST handling, so the local time shifts by an hour twice a year. Change the cron expression and redeploy if a different time is wanted.

## One-time backlog catch-up

The daily run only looks at "yesterday", so the existing backlog is digested once by hand. It's planned locally (no 300s function limit) and run one chunk per agent session, which keeps each session's context and runtime bounded:

```bash
set -a; source .env.local; set +a
export PATH="/opt/homebrew/bin:$HOME/.npm-global/bin:$PATH"   # Node >=24 and a current vercel CLI

npx tsx scripts/plan-catchup.ts .superpowers/catchup-plan.json   # read-only: scans the feed, writes <=10 date-range chunks per list
npx tsx scripts/run-catchup.ts .superpowers/catchup-plan.json https://reader-eve.vercel.app
```

`run-catchup.ts` goes oldest chunk first (so the newest digests end up on top of the inbox), verifies Reader after each chunk, skips chunks whose digest already exists (safe to restart), and stops at the first problem. The planned backlog on 2026-10-17 was 653 Dev and 659 Learn editions back to October 2025, about 65 editions per chunk.

Each digest is capped by design at 10 per list and titled with the date range it covers. Source editions end up archived; those worth a closer look also get the `reader-eve` tag.

## How fetching works

- `find_source_editions` lists editions (ids and titles only). In daily mode it filters server-side with `updatedAfter`, so it needs about one page instead of scanning the whole feed.
- `read_editions` reads content by scanning feed pages with `withHtmlContent=true` (about 100 documents per request, versus one request per document), time-boxed to stay under Vercel's 300s function limit, with a cursor to resume.
- `create_digest_and_finalize_sources` writes the digest first, and only then tags and archives sources. It reuses an existing digest with the same title rather than creating a duplicate, because Reader does not dedupe `/save/` by url.
- Reader's API is rate-limited (20 requests/min for `/list/`); `lib/readwise-client.ts` retries 429s up to 5 times honoring `Retry-After`.

## Architecture notes

- Reader access goes through a hand-written REST client (`lib/readwise-client.ts`), not an `eve/connections` MCP client — see the plan's "Why direct REST, not an MCP connection" for why.
- Source → persona mapping lives in `lib/sources.ts`; add a third list later by adding a config entry and a matching skill under `agent/skills/`, no other code changes needed.
