import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "fs";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

const RUNNER = "/home/z/my-project/mini-services/fleet-runner";
const AI_FILE = `${RUNNER}/data/ai/latest-analysis.json`;
const VAULT_FILE = `${RUNNER}/data/vault/nim-api.env`;
const SEALED_BLOB = "/home/z/my-project/vault-sealed/nim-api.env.enc";
const MANIFEST = "/home/z/my-project/vault-sealed/vault.manifest.json";

// GET /api/ai — מצב-המוח והניתוח האחרון. אפס-סודות: המפתח לעולם לא נקרא לכאן,
// רק קיום-הקבצים + מטא-דאטה מהמניפסט + הניתוח האחרון (שאינו סוד).
export async function GET() {
  try {
    const unsealed = existsSync(VAULT_FILE);
    const sealedBlob = existsSync(SEALED_BLOB);

    let manifest: Record<string, unknown> | null = null;
    try {
      if (existsSync(MANIFEST)) manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Record<string, unknown>;
    } catch {
      manifest = null;
    }

    let latest: Record<string, unknown> | null = null;
    try {
      if (existsSync(AI_FILE)) latest = JSON.parse(readFileSync(AI_FILE, "utf8")) as Record<string, unknown>;
    } catch {
      latest = null;
    }

    return NextResponse.json(
      {
        vault: { unsealed, sealedBlob, entries: manifest?.entries ?? [], passphraseHolder: manifest?.passphraseHolder ?? null },
        latest,
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    return NextResponse.json({ error: "ai_status_unavailable", detail: String(err).slice(0, 200) }, { status: 502, headers: NO_STORE });
  }
}
