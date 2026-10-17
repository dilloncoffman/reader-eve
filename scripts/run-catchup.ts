// Runs the one-time backlog catch-up: one agent session per pre-planned chunk,
// oldest first, verifying Reader after each. Safe to restart — chunks whose
// digest already exists are skipped. Stops at the first problem.
// Usage: tsx scripts/run-catchup.ts <plan.json> <agentUrl> [dev|learn]
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createReadwiseClient } from '../lib/readwise-client';
import { chunkEditionsByDateRange } from '../lib/chunking';
import { parseEditionTitle } from '../lib/title-matching';
import { SOURCES } from '../lib/sources';

const [planPath, agentUrl, only] = process.argv.slice(2);
if (!planPath || !agentUrl) throw new Error('usage: run-catchup.ts <plan.json> <agentUrl> [dev|learn]');

const plan = JSON.parse(readFileSync(planPath, 'utf8')) as Record<string, any[]>;
const client = createReadwiseClient(process.env.READWISE_API_TOKEN!);
const labelFor = (key: string) => (key === 'dev' ? 'Dev' : 'Learn');

async function digestExists(title: string): Promise<boolean> {
  let pageCursor: string | undefined;
  do {
    const page = await client.listDocuments({ tag: 'reader-eve-digest', limit: 100, pageCursor });
    if (page.results.some((d) => d.title === title)) return true;
    pageCursor = page.nextPageCursor ?? undefined;
  } while (pageCursor);
  return false;
}

async function runChunk(sourceKey: string, label: string, ids: string[]): Promise<void> {
  const title = `${labelFor(sourceKey)} Digest — ${label}`;
  if (await digestExists(title)) {
    console.log(`skip (digest exists): ${title}`);
    return;
  }
  const message = `Digest this chunk: sourceKey ${sourceKey}, dateRangeLabel "${label}", documentIds ${JSON.stringify(ids)}.`;
  console.log(`\n== ${title} (${ids.length} editions) — ${new Date().toISOString()}`);
  let out = '';
  try {
    out = execFileSync('npx', ['eve', 'remote', 'invoke', '--url', agentUrl, message], {
      encoding: 'utf8',
      timeout: 20 * 60 * 1000,
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (e: any) {
    console.log('invoke failed:', String(e.message).slice(0, 400));
    process.exit(1);
  }
  const parsed = JSON.parse(out);
  console.log('agent said:', String(parsed.outcome?.message ?? parsed.outcome?.status).slice(0, 600));
  if (!(await digestExists(title))) {
    console.log(`STOP: no digest titled "${title}" found in Reader after this run.`);
    process.exit(1);
  }
  console.log(`ok: digest present — ${title}`);
}

// The agent has been seen to pass only part of a chunk's ids to the archive
// step. After a source finishes, find planned editions still sitting in the
// feed and digest them in a follow-up session covering their own date range.
async function findStragglers(sourceKey: string): Promise<Array<{ documentId: string; title: string; date: string }>> {
  const planned = new Map<string, string>(
    plan[sourceKey].flatMap((c: any) => c.editions.map((e: any) => [e.documentId, e.title])),
  );
  const listLabel = SOURCES.find((s) => s.key === sourceKey)!.listLabel;
  const stragglers: Array<{ documentId: string; title: string; date: string }> = [];
  let pageCursor: string | undefined;
  do {
    const page = await client.listDocuments({ location: 'feed', category: 'rss', limit: 100, pageCursor });
    for (const d of page.results) {
      if (!planned.has(d.id)) continue;
      const parsed = parseEditionTitle(d.title, listLabel);
      if (parsed) stragglers.push({ documentId: d.id, title: d.title, date: parsed.date });
    }
    pageCursor = page.nextPageCursor ?? undefined;
  } while (pageCursor);
  return stragglers;
}

async function main() {
  for (const sourceKey of ['dev', 'learn']) {
    if (only && only !== sourceKey) continue;
    for (const chunk of plan[sourceKey]) {
      await runChunk(sourceKey, chunk.dateRangeLabel, chunk.editions.map((e: any) => e.documentId));
    }
    for (let pass = 1; pass <= 2; pass++) {
      const stragglers = await findStragglers(sourceKey);
      console.log(`\n${sourceKey}: ${stragglers.length} planned editions still unarchived (pass ${pass})`);
      if (stragglers.length === 0) break;
      const [followUp] = chunkEditionsByDateRange(stragglers.map((s) => ({ documentId: s.documentId, date: s.date })), 1);
      await runChunk(sourceKey, followUp.dateRangeLabel, followUp.documentIds);
    }
  }
  console.log('\nAll chunks done.');
}
main();
