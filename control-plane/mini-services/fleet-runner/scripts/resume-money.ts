/**
 * resume-money — משחרר את צמתי-הכסף ממצב quiesce תקוע.
 *
 * האירוע החי שבנה את המתקן הזה (2026-10-20 09:28Z): state-backup כתב את
 * הקפסולה בהצלחה אך קרס ב-finally (ReferenceError) לפני לולאת-ההשבה —
 * השוק נשאר quiesced=true והכלכלה קפואה בשקט. כלי-הגיבוי לא רשאי להיות
 * הגורם-היחיד שיודע להשיב; מתקן עצמאי וזהה-סמכות חייב להיות בקוד.
 *
 * שימוש: bun scripts/resume-money.ts   (idempotent; בטוח גם כשאין quiesce)
 * fail-closed: צומת שמסרב 3 פעמים = exit 1 + הנחיה ידנית מפורשת ב-stderr.
 */
import { existsSync } from "fs";

const KEYS = `${import.meta.dir.replace(/\/scripts$/, "")}/data/keys`;
const NODES = [
  { name: "ledger", url: "http://127.0.0.1:3032" },
  { name: "market", url: "http://127.0.0.1:3033" },
];

if (!existsSync(`${KEYS}/operator.priv.pem`)) {
  console.error("RESUME-MONEY-FAIL: operator keys missing — cannot sign the unquiesce (fail-closed)");
  process.exit(1);
}
const publicPem = (await Bun.file(`${KEYS}/operator.pub.pem`).text()).trim();
const privatePem = (await Bun.file(`${KEYS}/operator.priv.pem`).text()).trim();
const { AgentClient } = await import("/home/z/repos/roshpina/kernel/fleet/sovereign-agents");
const { sha256Hex } = await import("/home/z/repos/roshpina/src/lib/route-auth");
const keys = { agentId: "operator", publicPem, privatePem, kid: sha256Hex(publicPem).slice(0, 16) };

let failures = 0;
for (const n of NODES) {
  const up = await fetch(`${n.url}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false);
  if (!up) {
    console.log(`${n.name}: down — nothing to resume (quiesce dies with the process)`);
    continue;
  }
  let done = false;
  for (let attempt = 1; attempt <= 3 && !done; attempt++) {
    try {
      const r = await new AgentClient(n.url, keys).post("/internal/quiesce", { on: false });
      console.log(`${n.name} unquiesce attempt ${attempt}: http ${r.status}`);
      if (r.status === 200) done = true;
    } catch (e) {
      console.error(`${n.name} attempt ${attempt} threw: ${e}`);
    }
    if (!done && attempt < 3) await Bun.sleep(500);
  }
  if (!done) failures++;
}
for (const n of NODES) {
  const h = await fetch(`${n.url}/health`).then((r) => r.json()).catch(() => null);
  console.log(`${n.name} health: quiesced=${(h as any)?.quiesced ?? "n/a"} ok=${(h as any)?.ok ?? "down"}`);
}
if (failures > 0) {
  console.error(`RESUME-MONEY-FAIL: ${failures} node(s) refused — MANUAL: POST /internal/quiesce {"on":false} signed`);
  process.exit(1);
}
console.log("RESUME-MONEY-OK");
