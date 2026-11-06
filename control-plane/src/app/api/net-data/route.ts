import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "fs";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

// הקובץ היחיד שהרשת רשאית לכתוב מחוץ-ל-roshpina — מסלול site-data://sovereign-net.json
// (code-executor מאמת סכמה + סריקת-סודות + שער-אתר-חי לפני כל פרסום; כאן רק קוראים)
const NET_DATA = "/home/z/my-project/src/data/sovereign-net.json";

export type NetItem = {
  id: string;
  title: string;
  body: string;
  kind: string;
  createdAt: string;
};

type NetData = { items: NetItem[]; publishedAt?: string };

// GET /api/net-data — שידורי-הרשת: מה שהרשת כתבה לאתר בעצמה (אפס-סודות, קריאת-קבצים צד-שרת)
export async function GET() {
  try {
    if (!existsSync(NET_DATA)) {
      return NextResponse.json(
        { items: [], exists: false },
        { headers: NO_STORE }
      );
    }
    let data: NetData = { items: [] };
    try {
      const parsed = JSON.parse(readFileSync(NET_DATA, "utf8")) as NetData;
      if (parsed && Array.isArray(parsed.items)) data = parsed;
    } catch {
      // torn/invalid file — honest empty state, never fake
      return NextResponse.json({ items: [], exists: true, invalid: true }, { headers: NO_STORE });
    }
    const items = [...data.items].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    return NextResponse.json(
      { items, exists: true, publishedAt: data.publishedAt ?? items[0]?.createdAt ?? null },
      { headers: NO_STORE }
    );
  } catch (err) {
    return NextResponse.json(
      { error: "net_data_unavailable", detail: String(err).slice(0, 200) },
      { status: 502, headers: NO_STORE }
    );
  }
}
