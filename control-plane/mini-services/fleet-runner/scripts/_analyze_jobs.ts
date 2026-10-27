const lines = (await Bun.file('/tmp/recent_jobs.jsonl').text()).trim().split('\n');
const last: Record<string, string[]> = {};
for (const line of lines) {
  let j: any; try { j = JSON.parse(line); } catch { continue; }
  if (j.kind === 'end' || j.phase === 'end') {
    (last[j.preset] ??= []).push(`${j.status}:${j.exitCode}@${String(j.startedAt || '').slice(11, 19)}`);
  }
}
for (const p of Object.keys(last).sort()) console.log(p.padEnd(24), '->', last[p].slice(-4).join(' | '));
