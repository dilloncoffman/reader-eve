# reader-eve: personalized Reader digest agent

## Intent & why

Dillon uses Readwise Reader to save things to read later, and ingests two
Twitter lists into it automatically — "Dev" (software engineers/developers:
React, AI, tech products) and "Learn" (solo founders, writers, business and
content people). Reader pulls each list in twice a day (AM/PM), and each pull
lands as one bundled RSS-style document per list (e.g. "Dev Twitter List:
October 17, 2026 AM Edition"), not as individual tweets.

This has piled up — confirmed during brainstorming: the `feed` location holds
2,116 items total, and unprocessed Dev/Learn editions go back to at least
April 29, 2026. The backlog is a big part of *why* Dillon has stopped opening
Reader: there's too much sitting there to face.

The goal is not "summarize everything" — it's to make Reader usable again.
Dillon should be able to open Reader and see a small number of short,
personalized digests that tell him what actually mattered, instead of
hundreds of raw tweet bundles. The system does the reading and triage; Dillon
still does the two acts that matter to him: deciding what to actually
highlight in Readwise, and what to actually save to mymind.

The agent is built on [eve](https://vercel.com/docs/eve), Vercel's open-source
agent framework (currently in beta), and deployed to Vercel — not run as a
local script — so it keeps running on its own schedule without Dillon's
machine needing to be on.

## Goals

- Once a week (Mondays at 5am Eastern), automatically digest the Dev and
  Learn Reader editions that are still unarchived, in a lens appropriate to each list (Dev = tools/
  React/AI/product takes; Learn = founder/writer/business/content takes).
- One catch-up pass that clears the *entire* existing backlog of unarchived
  Dev/Learn editions (not just a recent window), capped at 10 digest
  documents per list, each one clearly labeled with the date range it covers.
- After processing, every source edition document ends up archived — the
  Reader inbox/feed never stays cluttered with processed editions.
- Within each digest, call out which underlying items are worth Dillon's own
  follow-up — either to review and possibly highlight in Readwise, or to
  consider saving to mymind (products, novel ideas, art, music — things
  beyond a highlighted quote). The agent never writes Readwise highlights or
  mymind saves itself; it only surfaces candidates with links for Dillon to
  act on.
- Documents containing at least one "worth reviewing" item get tagged
  `reader-eve` (in addition to being archived), so Dillon's own saved Reader
  filter on that tag surfaces them regardless of location.
- Generalize past just these two lists: the source list (which Reader
  locations/title patterns/tags map to which persona) should be config, not
  hardcoded, so Dillon can point the same system at other things in Reader
  later.
- Digests are Dillon's deliberate review step. The agent never archives or
  deletes a digest it created — only Dillon does that, manually, once he's
  gone through it.

## Non-goals (for this version)

- No mymind API integration. mymind candidates are described in the digest
  text with a direct link to the source tweet; Dillon saves them himself.
- No automatic Readwise highlighting. The agent flags documents as worth
  review; Dillon decides what, if anything, gets highlighted.
- No chat/Slack/Discord interface. Output lives entirely inside Reader as
  documents. (eve supports other channels later if Dillon wants them, but
  it's out of scope now.)
- No deduplication/cross-referencing against Dillon's existing Readwise
  highlights or mymind library when deciding what's worth flagging — the
  triage is based on the tweet content itself, not what's already saved.

## Anti-goals (would mean this failed even if it "works")

- Digests that just restate every tweet in list form — the point is
  judgment ("what mattered"), not transcription.
- The catch-up pass itself becoming new clutter (this is why it's capped at
  10 digests/list instead of one-per-edition).
- Anything that writes to Readwise highlights or mymind without Dillon's
  hand in it.

## Constraints

- **Framework**: eve (beta). Filesystem-first: `agent/agent.ts` (model
  config), `agent/instructions.md` (persona), `agent/tools/*.ts` (custom
  tools), `agent/skills/*.md` (reference knowledge), `agent/schedules/`
  (cron triggers). Deploys to Vercel as a standard project; same code runs
  locally (`pnpm dev`) and in production.
- **Data source**: Readwise's MCP server (`https://mcp2.readwise.io/mcp`),
  already connected in this Claude Code session. The deployed eve agent
  needs its own Readwise API access configured as a Vercel
  project secret/env var — this is a separate credential from the MCP
  connection used in this chat.
- **Confirmed Reader structure** (checked live during brainstorming):
  - Each list edition is one document, category `rss`, location `feed`,
    titled `"<List> Twitter List: <Month> <Day>, <Year> <AM|PM> Edition"`.
  - Document body is markdown: repeated blocks of
    `[author](url)` / tweet text / optional image / `[Posted <date>](status url)`.
    Each tweet's own permalink is present in the body, so per-tweet links are
    available for flagging individual items even though the document itself
    bundles several tweets.
  - `feed` location mixes in other RSS subscriptions Dillon has — matching
    must be done by title pattern (`"Dev Twitter List:"` / `"Learn Twitter
    List:"`), not just location/category.
  - Reader already has a `mymind` tag and a `shortlist` tag in active use;
    `reader-eve` is a new tag this system introduces.
- **No existing MCP server for mymind** — confirmed while researching;
  mymind only exposes a REST API (bearer token). Not needed for this
  version per the non-goals above, but worth knowing if mymind integration
  is ever added later.

## Decisions made (Dillon's calls)

- Build on eve, deployed to Vercel, using Readwise's MCP for all Reader
  access.
- Output lands back inside Reader as documents — that's the whole point,
  so Reader itself becomes usable again.
- Per processed edition document:
  - If nothing in it is worth review or a mymind candidate: archive it,
    no tag.
  - If something in it is worth Dillon reviewing (and possibly
    highlighting himself later): tag it `reader-eve` **and** archive it.
    The tag makes it findable via Dillon's own saved filter regardless of
    archive status.
  - mymind-worthy items (products, novel ideas, art, music) are never
    saved anywhere by the agent — they're described with a link inside the
    digest text for Dillon to act on manually.
- Catch-up pass: digest **everything currently unarchived** in the
  Dev/Learn feeds (full backlog, no staleness cutoff), capped at **10
  digest documents per list**, each digest's title/body clearly stating
  the date range of editions it covers.
- Ongoing cadence: **once weekly, Mondays at 5am Eastern** (changed from
  daily after the backlog run). Each run covers everything still unarchived
  for a list, so a missed run is caught by the next. One digest per list per
  week — not per edition.
- Digest lifecycle: digests are never auto-archived or auto-deleted by the
  agent. They sit as Dillon's own queue of "things reader-eve already went
  through" until he manually archives or deletes each one after reading
  it.

## Defaults set during review (sensible calls, not asked of Dillon)

A fresh-eyes builder-check of this document flagged a few gaps; these three
were straightforward enough to settle without going back to Dillon:

- **Write-then-archive ordering**: for any run, the digest covering a batch
  of source editions must be successfully created in Reader *before* those
  source editions are archived/tagged. If digest creation fails partway,
  the sources it would have covered are left untouched so they're picked
  up again on the next run — nothing gets archived without a digest that
  already covers it existing first.
- **Catch-up at scale**: with 100+ backlog editions likely per list, the
  catch-up pass should use eve's built-in durable/resumable sessions
  (designed for exactly this — surviving cold starts and long pauses)
  rather than a custom job queue, to avoid Vercel function execution
  limits.
- **Preserve existing tags**: if a backlog edition already carries a
  manual tag Dillon added himself (e.g. `shortlist`, `mymind`), the agent
  never strips it when archiving/tagging — `reader-eve` is only ever added
  on top, so his own prior triage signal isn't lost.

## What's left to the builder

- Exact eve project scaffold (`npx eve@latest init`), model choice for the
  agent, and how the Dev-lens vs Learn-lens persona split is implemented
  (e.g. two skills files selected by which list is being processed, vs.
  two subagents) — either is reasonable; pick what keeps the instructions
  cleanest.
- The config structure that maps a Reader title-pattern/location/tag to a
  persona + output destination, so a third source can be added later
  without code changes beyond adding a config entry.
- How the backlog is chunked into up to 10 digests per list (e.g. by
  roughly equal date ranges, or by week) — just ensure each digest's date
  range is accurate and non-overlapping, and that it's capped at 10.
- How the agent authenticates to Readwise's MCP/API from the deployed
  Vercel project (env var vs Vercel Connect) — follow eve's documented
  pattern for MCP client connections.
- Digest document format/title convention (e.g. `"Dev Digest — Oct 17,
  2026"`) and exactly which Reader fields get set when creating it
  (category, location, tags).
- Idempotency: how the agent tracks "already processed" editions across
  runs so a re-run or retry doesn't double-digest or re-archive. (Likely:
  query unarchived editions matching the title pattern each run; once
  archived, they won't be picked up again — but confirm this holds for
  retries within a single run too.)
- Test/dry-run strategy before pointing this at the real backlog (eve runs
  identically locally — use that to verify against a few real editions
  before doing the full catch-up pass).
