/**
 * route-gate.ts — התיל של K5 (C-2) + C-2b: הדלת שכל-כתיבה-יוצרת-מצב בקצה-הנשא
 * עוברת דרכה. השיעור-שנמדד ב-C-2b: קראנו לשער "שער-נתיבי-הכסף" והפרשת-העיגון
 * (bridge/saos POST — התפר ששרשרת-SAOS קוטפת) נשארה פתוחה — השם-היה-צר-מדי.
 * החוק אחד ואחת-אמת-שער: כל POST שיוצר-מצב (מטבע, העברה, escrow-action, עיגון-גשר)
 * עובר באותה-דלת; POST טהור-אימות (passports/verify) נשאר פתוח-לפי-חוק-ומדוד.
 *
 * מחבר את החוק-הטהור (route-auth.ts) אל הקרנל-החי:
 *   • אספקת-עוגנים פעם-אחת-פר-טבעת (WeakMap מפתח=מופע-KeyRing — שורד-HMR בדיוק
 *     כמו הקרנל-עצמו; קרנל-חדש = טבעת-חדשה = אספקה-חדשה, אין-מצב-ישן-שנדבק).
 *   • טעות-אספקה נזכרת ומוחזרת כ-503 צועק בכל-בקשה — לא משתיקים תקלת-קונפיגורציה.
 *   • אפס-עוגנים = כל-נתיבי-הכתיבה סגורים (503 operator_not_provisioned) — אין
 *     מתג-כיבוי לחוק, יש רק עוגן או סירוב.
 *   • מטמון-השחזור חי-פר-טבעת (InMemoryReplayCache — Known-limit: תהליך-יחיד).
 */

import { getKernel } from "./kernel";
import { InMemoryReplayCache, provisionOperatorKeys, requireOperatorSignature, type RouteAuthResult } from "./route-auth";

interface GateState {
  registeredKids: string[];
  errors: string[];
  replay: InMemoryReplayCache;
}

/** מצב-השער פר-טבעת — הטבעת היא-המפתח (קרנל-חדש → מצב-חדש, בלי-זיכרון-דביק). */
const GATE_STATES = new WeakMap<object, GateState>();

function stateFor(ring: object): GateState {
  let st = GATE_STATES.get(ring);
  if (!st) {
    st = { registeredKids: [], errors: [], replay: new InMemoryReplayCache() };
    GATE_STATES.set(ring, st);
  }
  return st;
}

/** פענוח-JSON כנה — גוף-שבור = null (הנתיבים מדווחים 400 משלהם). */
export function parseJsonOrNull(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * שער-הכתיבה (C-2 + C-2b): סירוב מובנה (status/code/detail — הנתיב עוטף-לתשובה)
 * או עבירה עם rawBody. חובה כהצהרה-הראשונה ב-POST handler — השער-קודם-לפריסה,
 * לזריעה ולמשטח. kernel-smoke סעיף-13 אוכף את-חוק-התיל: כל POST חייב שער או
 * רישום-מפורש ברשימת-האימות-הטהור — אין POST שקט.
 */
export async function gateStateRoute(req: Request): Promise<RouteAuthResult> {
  const k = getKernel();
  const st = stateFor(k.keyRing);

  if (st.errors.length === 0 && st.registeredKids.length === 0) {
    const { registered, errors } = provisionOperatorKeys(k.keyRing, process.env);
    st.registeredKids = registered;
    st.errors = errors;
  }

  if (st.errors.length > 0) {
    return {
      ok: false,
      status: 503,
      code: "operator_key_invalid",
      detail: `עוגן-אמון שבור בסביבת-הפריסה — לא מאמתים כלום: ${st.errors.join(" · ")}`,
    };
  }
  if (st.registeredKids.length === 0) {
    return {
      ok: false,
      status: 503,
      code: "operator_not_provisioned",
      detail: "אין עוגן-אמון: כל-נתיבי-הכתיבה סגורים עד-הצבת ROSHPINA_OPERATOR_PUBLIC_KEY (מפתח-ציבור SPKI PEM) בסביבת-הפריסה",
    };
  }

  return requireOperatorSignature(req, k.keyRing, st.replay, { now: Date.now() });
}
