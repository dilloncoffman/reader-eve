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

**Timezone note:** `agent/schedules/daily-digest.ts` sets `cron: '0 9 * * *'`, assuming Dillon is in America/New_York (5am EST = 9am UTC; Vercel Cron has no DST awareness, so this will fire at 4am local during EDT). **Confirm or correct this before relying on the 5am daily run** — if a different timezone or time is wanted, change the cron expression and redeploy.

## One-time catch-up pass

Before the daily schedule's first 5am firing, run the catch-up pass once per source against the deployed agent, so the existing backlog gets digested instead of silently waiting for the next `daily` run (which only ever looks at "yesterday"):

```bash
eve remote connect   # or an authenticated POST to the deployed /eve/v1/session route
```

Then send:

```
Run the daily digest for sourceKey dev in mode catchup, then run the daily digest for sourceKey learn in mode catchup.
```

**Expect this to take a while** — it pages through the entire unarchived backlog per source, and eve's durable sessions are built to survive exactly that.

**Before running catch-up for real:** Tasks 1–5's unit tests already cover the load-bearing guarantees (write-before-archive ordering, additive tag preservation, the 10-chunk cap), so running catch-up directly against the real Reader account is reasonable once `npm test` passes. If more confidence is wanted first, point `READWISE_API_TOKEN` at a disposable/test Reader account for one dry run before switching back to the real token.

**What to expect when it's done:** up to 10 new digest documents per list in Reader's inbox (`new` location), each titled with the date range it covers; the `feed` location's previously-unarchived Dev/Learn editions moved to `archive`; any edition judged worth reviewing carries the `reader-eve` tag; and no pre-existing `shortlist`/`mymind` tags removed from any source document.

## Architecture notes

- Reader access goes through a hand-written REST client (`lib/readwise-client.ts`), not an `eve/connections` MCP client — see the plan's "Why direct REST, not an MCP connection" for why.
- Source → persona mapping lives in `lib/sources.ts`; add a third list later by adding a config entry and a matching skill under `agent/skills/`, no other code changes needed.
