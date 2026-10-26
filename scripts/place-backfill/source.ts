// The target's auditions, read through PostgREST with its publishable (or
// legacy anon) key — what anyone visiting the site may read: every offline
// audition, drafts included, and the online ones with a verified testimony.
// Never a secret or service-role key: the backfill must not depend on rows
// the public cannot see, and needs no privilege.

import type { SourceRow } from "./plan";

const COLUMNS = "id,title,date,location,status,audition_en_ligne,citycode,place,created_at";

/** PostgREST answers at most this many rows a request (supabase/config.toml max_rows). */
const PAGE = 1000;

/** Why a key is refused, or null for a publishable or anon key. */
export function refuseKey(key: string): string | null {
  if (key.startsWith("sb_publishable_")) return null;
  if (key.startsWith("sb_secret_")) return "a secret key";
  const parts = key.split(".");
  if (parts.length === 3) {
    try {
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
        role?: unknown;
      };
      return claims.role === "anon" ? null : `a JWT for the role ${String(claims.role)}`;
    } catch {
      return "a JWT whose claims do not parse";
    }
  }
  return "not a publishable (sb_publishable_…) or anon key";
}

export interface Target {
  /** The project's URL (https://<ref>.supabase.co, or a local stack's). */
  url: string;
  key: string;
}

function headers(t: Target, extra: Record<string, string> = {}): Record<string, string> {
  // A publishable key goes in apikey alone; a legacy anon JWT is also the bearer.
  const h: Record<string, string> = { apikey: t.key, Accept: "application/json", ...extra };
  if (t.key.split(".").length === 3) h.Authorization = `Bearer ${t.key}`;
  return h;
}

/** The total of a `Prefer: count=exact` answer: Content-Range "0-999/1234" (null when it gives none). */
function countOf(res: Response): number | null {
  const total = res.headers.get("content-range")?.split("/")[1];
  return total === undefined || total === "*" ? null : Number(total);
}

/** Every audition the key may read, in id order, a page at a time. */
export async function readAuditions(t: Target): Promise<SourceRow[]> {
  const rows: SourceRow[] = [];
  let total: number | null = null;
  for (;;) {
    const q = new URLSearchParams({ select: COLUMNS, order: "id.asc", limit: String(PAGE) });
    if (rows.length) q.set("id", `gt.${rows[rows.length - 1].id}`);
    const res = await fetch(`${t.url}/rest/v1/auditions?${q}`, {
      headers: headers(t, rows.length ? {} : { Prefer: "count=exact" }),
    });
    if (!res.ok)
      throw new Error(`auditions: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    if (!rows.length) total = countOf(res);
    const page = (await res.json()) as SourceRow[];
    // Until an empty page: a server capping pages below PAGE ends nothing early.
    if (page.length === 0) break;
    rows.push(...page);
  }
  if (total !== null && rows.length !== total) {
    throw new Error(
      `read ${rows.length} auditions where the database counts ${total}: written to meanwhile? Run it again.`,
    );
  }
  return rows;
}

/** How many testimonies have no audition, or why the key may not count them. */
export async function countOrphanTestimonies(t: Target): Promise<number | string> {
  const res = await fetch(`${t.url}/rest/v1/testimonies?select=id&audition_id=is.null`, {
    method: "HEAD",
    headers: headers(t, { Prefer: "count=exact" }),
  });
  if (!res.ok) return `not readable with this key (HTTP ${res.status})`;
  return countOf(res) ?? "not counted (no total in the answer)";
}
