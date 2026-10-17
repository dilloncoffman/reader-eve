// Plans the one-time backlog catch-up locally (no 300s function limit): scans
// the whole feed once per source and writes the chunk plan to a JSON file.
// Read-only. Usage: tsx scripts/plan-catchup.ts <out.json>
import { writeFileSync } from 'node:fs';
import findSourceEditions from '../agent/tools/find_source_editions';

async function main() {
  const out = process.argv[2];
  if (!out) throw new Error('usage: plan-catchup.ts <out.json>');
  const plan: Record<string, unknown> = {};
  for (const sourceKey of ['dev', 'learn'] as const) {
    const { chunks } = await (findSourceEditions as any).execute({ sourceKey, mode: 'catchup' }, {});
    plan[sourceKey] = chunks;
    const total = chunks.reduce((n: number, c: any) => n + c.editions.length, 0);
    console.log(`${sourceKey}: ${total} editions in ${chunks.length} chunks`);
    for (const c of chunks) console.log(`  ${c.chunkId}  ${c.dateRangeLabel}  (${c.editions.length} editions)`);
  }
  writeFileSync(out, JSON.stringify(plan, null, 2));
}
main();
