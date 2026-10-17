// Runs the one-time backlog catch-up: one agent session per pre-planned chunk,
// oldest first. Safe to restart: it works from the editions still unarchived in
// Reader, so finished chunks are not repeated. Stops at the first failure.
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

async function runChunk(sourceKey: string, label: string, ids: string[]): Promise<void> {
  const title = `${labelFor(sourceKey)} Digest — ${label}`;
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
}

// State lives in Reader, not in digests: an edition still in the feed has not
// been digested and archived yet. (Digests get deleted by hand once reviewed,
// so their absence says nothing.) Returns planned editions still in the feed.
async function pendingEditions(sourceKey: string): Promise<Set<string>> {
  const planned = new Set<string>(plan[sourceKey].flatMap((c: any) => c.editions.map((e: any) => e.documentId)));
  const pending = new Set<string>();
  let pageCursor: string | undefined;
  do {
    const page = await client.listDocuments({ location: 'feed', category: 'rss', limit: 100, pageCursor });
    for (const d of page.results) if (planned.has(d.id)) pending.add(d.id);
    pageCursor = page.nextPageCursor ?? undefined;
  } while (pageCursor);
  return pending;
}

async function main() {
  const listLabels = Object.fromEntries(SOURCES.map((s) => [s.key, s.listLabel]));
  for (const sourceKey of ['dev', 'learn']) {
    if (only && only !== sourceKey) continue;
    // The second pass picks up editions the agent left out of the archive step.
    for (let pass = 1; pass <= 2; pass++) {
      const pending = await pendingEditions(sourceKey);
      console.log(`\n${sourceKey}: ${pending.size} planned editions still unarchived (pass ${pass})`);
      if (pending.size === 0) break;
      for (const chunk of plan[sourceKey]) {
        const todo = chunk.editions.filter((e: any) => pending.has(e.documentId));
        if (todo.length === 0) continue;
        // A whole chunk keeps its planned label; a partial one is labeled by the dates it actually covers.
        const label =
          todo.length === chunk.editions.length
            ? chunk.dateRangeLabel
            : chunkEditionsByDateRange(
                todo.map((e: any) => ({ documentId: e.documentId, date: parseEditionTitle(e.title, listLabels[sourceKey])!.date })),
                1,
              )[0].dateRangeLabel;
        await runChunk(sourceKey, label, todo.map((e: any) => e.documentId));
      }
    }
  }
  console.log('\nAll chunks done.');
}
main();
