/**
 * health-sweep.ts — real probe of every node in the execution network.
 * Prints a truth table: who is up, at what latency, and their real health payload.
 */

const NODES = [
  { id: "control-plane", url: "http://127.0.0.1:3000/" },
  { id: "runner", url: "http://127.0.0.1:3031/health" },
  { id: "ledger", url: "http://127.0.0.1:3032/health" },
  { id: "market", url: "http://127.0.0.1:3033/health" },
];

console.log(`fleet health sweep — ${new Date().toISOString()}`);
console.log("");

let upCount = 0;
for (const n of NODES) {
  const t0 = Date.now();
  try {
    const res = await fetch(n.url, { signal: AbortSignal.timeout(2500) });
    const ms = Date.now() - t0;
    let detail = "";
    try {
      const body = await res.json();
      if (n.id === "ledger" && body) detail = `seq=${body.seq ?? body.boot?.seq ?? "?"} accounts=${body.accounts ?? "?"}`;
      else if (n.id === "market" && body) detail = `trades=${body.trades ?? body.boot?.settled ?? "?"} escrow=${body.escrow != null ? "present" : "?"}`;
      else if (n.id === "runner" && body) detail = `uptime=${body.uptimeSec}s jobs=${body.jobsTotal}`;
      else if (n.id === "control-plane") detail = `http ${res.status}`;
    } catch { detail = `http ${res.status}`; }
    console.log(`  ${res.ok ? "UP  " : "DOWN"} ${n.id.padEnd(15)} ${String(ms).padStart(5)}ms  ${detail}`);
    if (res.ok) upCount++;
  } catch {
    console.log(`  DOWN ${n.id.padEnd(15)} ${String(Date.now() - t0).padStart(5)}ms  unreachable`);
  }
}

console.log("");
console.log(`result: ${upCount}/${NODES.length} nodes up`);
if (upCount !== NODES.length) process.exit(1); // honest exit code: sweep fails when any node is down
