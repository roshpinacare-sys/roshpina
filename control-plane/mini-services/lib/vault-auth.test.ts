/* vault-auth · דגמי-אדום-לירוק (TDD) — הסף-הריבוני deny-by-default */
import { describe, test, expect, beforeAll } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "vault-auth-test-"));
const TOKEN_FILE = path.join(TMP, "vault", "operator-token");
process.env.VAULT_TOKEN_FILE = TOKEN_FILE;
delete process.env.SOVEREIGN_VAULT_TOKEN; // מבטיחים-נתיב-קובץ

let M: typeof import("./vault-auth.ts");
beforeAll(async () => { M = await import("./vault-auth.ts"); });

const gw = (method: string, token?: string): Request => {
  const h: Record<string, string> = { "x-real-ip": "203.0.113.9" };
  if (token) h["x-vault-token"] = token;
  return new Request("http://127.0.0.1:3016/tx/ingest", { method, headers: h });
};
const lo = (method: string): Request => new Request("http://127.0.0.1:3016/cycle", { method });

describe("vault-auth · חוק-הסף-הריבוני", () => {
  test("T1 המצאה-עצמית: אין-קובץ → טוקן-חדש 0600 נטבע", () => {
    const t = M.vaultToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    const st = fs.statSync(TOKEN_FILE);
    expect(st.mode & 0o777).toBe(0o600);
    expect(M.vaultFingerprint()).toMatch(/^[0-9a-f]{16}$/);
  });

  test("T2 אותו-טוקן נקרא שוב מהקובץ (יציבות)", () => {
    expect(M.vaultToken()).toBe(M.vaultToken());
  });

  test("T3 classify: שער-ציבורי זוהה לפי-כותרות; לופבק לא", () => {
    expect(M.isGatewayBorne(gw("POST"))).toBe(true);
    expect(M.isGatewayBorne(lo("POST"))).toBe(false);
    expect(M.isMutation(gw("POST"))).toBe(true);
    expect(M.isMutation(gw("GET"))).toBe(false);
  });

  test("T4 דחייה fail-closed: מוטציה-ציבורית בלי-טוקן → 403 מפורש", () => {
    const deny = M.denyIfPublic(gw("POST"), "test-organ")!;
    expect(deny.status).toBe(403);
  });

  test("T5 אישור: אותה-מוטציה עם-טוקן-תקף עוברת (null)", () => {
    expect(M.denyIfPublic(gw("POST", M.vaultToken()), "test-organ")).toBe(null);
    expect(M.denyIfPublic(gw("POST", undefined), "test-organ")!.status).toBe(403); // שליטה
    const bearerReq = new Request("http://x/tx/ingest", { method: "POST", headers: { "x-real-ip": "1.2.3.4", authorization: `Bearer ${M.vaultToken()}` } });
    expect(M.denyIfPublic(bearerReq, "test-organ")).toBe(null);
  });

  test("T6 מישור-האמון-הפנימי: לופבק-ישיר בלי-טוקן עובר (הלולאות-חיות)", () => {
    expect(M.denyIfPublic(lo("POST"), "test-organ")).toBe(null);
    expect(M.denyIfPublic(lo("GET"), "test-organ")).toBe(null);
  });

  test("T7 GET-ציבורי (קריאה) לא נחסם — רק-מוטציות", () => {
    expect(M.denyIfPublic(gw("GET"), "test-organ")).toBe(null);
  });

  test("T8 טוקן-שגוי → דחייה; רוטציה: env-לא-ריק דורס את-הקובץ (החלפת-טוקן-בעלים)", () => {
    expect(M.denyIfPublic(gw("POST", "deadbeef".repeat(8)), "test-organ")!.status).toBe(403);
    const rotated = "f".repeat(64);
    process.env.SOVEREIGN_VAULT_TOKEN = rotated;
    expect(M.verifyVaultToken(gw("POST", rotated))).toBe(true);            // הטוקן-החדש עובד
    expect(M.verifyVaultToken(gw("POST", fs.readFileSync(TOKEN_FILE, "utf8").trim()))).toBe(false); // הישן נדחה
    delete process.env.SOVEREIGN_VAULT_TOKEN;
    expect(M.verifyVaultToken(gw("POST", M.vaultToken()))).toBe(true);     // חזרה לקובץ
  });

  test("T10 vaultTokenFile(): פתרון-פר-קריאה — env חי-תמיד (אין-קפאה-בייבוא)", () => {
    const perCall = path.join(TMP, "per-call", "token");
    process.env.VAULT_TOKEN_FILE = perCall;
    expect(M.vaultTokenFile()).toBe(perCall);
    delete process.env.VAULT_TOKEN_FILE;
    expect(M.vaultTokenFile()).toBe("/home/z/coord-work/vault/operator-token");
    process.env.VAULT_TOKEN_FILE = TOKEN_FILE; // משחזרים-לשאר-המבחנים
  });

  test("T9 חוק-הטבעה-tmp-בלבד: ייבוא-לפני-env לא מסיט הטבעה אל-נתיב-הראנטיים (מדוד 2/8↔8/8)", async () => {
    const DEFAULT = "/home/z/coord-work/vault/operator-token";
    const TMP_TARGET = path.join(TMP, "tmp-only-law", "minted-token");
    const probe = `
      const M = await import(${JSON.stringify(path.resolve("mini-services/lib/vault-auth.ts"))});
      const fs = await import("fs");
      const before = fs.existsSync(${JSON.stringify(DEFAULT)}) ? fs.readFileSync(${JSON.stringify(DEFAULT)}, "utf8") : null;
      process.env.VAULT_TOKEN_FILE = ${JSON.stringify(TMP_TARGET)};
      const t = M.vaultToken();
      const after = fs.existsSync(${JSON.stringify(DEFAULT)}) ? fs.readFileSync(${JSON.stringify(DEFAULT)}, "utf8") : null;
      console.log(JSON.stringify({ tokenHex64: /^[0-9a-f]{64}$/.test(t), tmpMinted: fs.existsSync(${JSON.stringify(TMP_TARGET)}), defaultUntouched: before === after }));
    `;
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) cleanEnv[k] = v;
    delete cleanEnv.VAULT_TOKEN_FILE;
    delete cleanEnv.SOVEREIGN_VAULT_TOKEN;
    const hadDefault = fs.existsSync(DEFAULT);
    const backup = hadDefault ? fs.readFileSync(DEFAULT) : null;
    let out = { tokenHex64: false, tmpMinted: false, defaultUntouched: false };
    try {
      const p = Bun.spawn(["bun", "-e", probe], { env: cleanEnv, stdout: "pipe", stderr: "pipe" });
      const raw = await new Response(p.stdout).text();
      const lines = raw.trim().split("\n");
      out = JSON.parse(lines[lines.length - 1]); // המימוש-רשאי ללוג-לstdout — החוזה: שורת-הJSON האחרונה
      await p.exited;
    } finally {
      // מעיל-בלימה: המבחן-אף-פעם לא כותב/משאיר-טביעה בנתיב-הראנטיים —
      // אם-מימוש-פר-החוק טבע שם (המדידה-החיה של-הפגם), משחזרים-בייטים-אמת ומנקים.
      if (hadDefault && backup) fs.writeFileSync(DEFAULT, backup);
      else if (!hadDefault && fs.existsSync(DEFAULT)) { fs.rmSync(DEFAULT); console.warn("[vault-auth-test] containment: law-violating mint at runtime path removed (was absent before probe)"); }
      fs.rmSync(path.dirname(TMP_TARGET), { recursive: true, force: true });
    }
    expect(out.tmpMinted).toBe(true);
    expect(out.defaultUntouched).toBe(true);
    expect(out.tokenHex64).toBe(true);
  });
});
