import { NextRequest, NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "fs";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

// The ONLY writer of the owner token: derived from the local-only vault
// passphrase (the same file the fleet-runner derives its gate from). The
// passphrase itself never leaves the server; only the derived sha256 token
// is returned, over the box's TLS-fronted endpoint, for this tab's session.
const PASSPHRASE_FILE = "/home/z/my-project/upload/vault.passphrase";
const deriveOwnerToken = (pass: string): string =>
  createHash("sha256").update(`${pass.trim()}\nowner-gate-v1`).digest("hex");

export async function POST(req: NextRequest) {
  let pass = "";
  try {
    const body = (await req.json()) as { passphrase?: string };
    pass = String(body?.passphrase ?? "");
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: NO_STORE });
  }
  let expected: string | null = null;
  try {
    expected = deriveOwnerToken(readFileSync(PASSPHRASE_FILE, "utf8"));
  } catch {
    expected = null;
  }
  if (!expected) {
    return NextResponse.json(
      { error: "vault_unreadable", detail: "fail-closed — no vault secret on this host; all owner actions stay denied" },
      { status: 503, headers: NO_STORE },
    );
  }
  if (pass.length === 0) {
    return NextResponse.json({ error: "passphrase_required" }, { status: 400, headers: NO_STORE });
  }
  const candidate = deriveOwnerToken(pass);
  const ok = candidate.length === expected.length && timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
  if (!ok) {
    console.warn("[owner/unlock] DENIED wrong passphrase (fail-closed)");
    return NextResponse.json({ error: "wrong_passphrase" }, { status: 401, headers: NO_STORE });
  }
  return NextResponse.json({ ok: true, token: expected }, { headers: NO_STORE });
}
