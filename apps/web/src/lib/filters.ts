import { answersText, themesOf } from "@ac/shared";
import type { LocNode } from "@/shared/ui/select/treeNode";

// The filters of the Témoignages page — place, dates, themes, verified, free
// text, order — as plain functions, so that every list offering them (the map's
// panel, the admin's list of auditions) filters the same way.

/** Accent- and case-insensitive haystack for the free-text search. */
export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Where something is, as the place filter knows it (a LocationGroup is one). */
export interface Area {
  region?: string | null;
  departementCode?: string | null;
  departementName?: string | null;
  city?: string | null;
  canonicalName: string;
}

/** The tokens an area can be matched against by the place filter. */
export function areaTokens(a: Area): string[] {
  const t: string[] = [];
  if (a.region) t.push(`r:${a.region}`);
  if (a.departementCode) t.push(`d:${a.departementCode}`);
  if (a.city) t.push(`v:${a.city}`);
  t.push(`p:${a.canonicalName}`);
  return t;
}

/** The filters judged on a testimony's own content. */
export interface ContentFilter {
  verified: boolean;
  topics: string[];
  /** The free text, folded (see `fold`); "" for none. */
  needle: string;
}

/** What a testimony needs for its content to be judged. */
export interface TestimonyContent {
  person_name: string;
  person_info: string | null;
  content: string;
  topics: string[] | null;
  verification_status: string | null;
}

/**
 * Whether a testimony passes the content filters. `textMatched`: the free text
 * was already found around it (in its audition, say), so it need not be in it.
 */
export function passesContent(t: TestimonyContent, f: ContentFilter, textMatched = false): boolean {
  if (f.verified && t.verification_status !== "verified") return false;
  if (f.topics.length) {
    // Read in the theme grid: an old "démocratie" tag matches its theme.
    const has: readonly string[] = themesOf(t.topics);
    if (!f.topics.some((sel) => has.includes(sel))) return false;
  }
  if (f.needle && !textMatched) {
    // The witness's words only: not the questions of a testimony sent online.
    const hay = fold(`${t.person_name} ${t.person_info ?? ""} ${answersText(t.content)}`);
    if (!hay.includes(f.needle)) return false;
  }
  return true;
}

/** Whether an area is among the places picked (none picked: all are). */
export function passesLocation(a: Area | null, picked: string[]): boolean {
  if (!picked.length) return true;
  if (!a) return false;
  const tokens = areaTokens(a);
  return picked.some((sel) => tokens.includes(sel));
}

/** Whether a date is within the range (an undated thing only when there is none). */
export function passesDate(
  date: string | null | undefined,
  from: string | null,
  to: string | null,
): boolean {
  if (!date) return !from && !to;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

/**
 * The place picker's tree — région > département > ville > lieu — with how
 * many things (`weight`) each node holds. Areas without a région are left out:
 * they cannot be placed in it.
 */
export function buildLocationTree(items: { area: Area; weight: number }[]): LocNode[] {
  interface Draft {
    token: string;
    label: string;
    hint?: string;
    count: number;
    children: Map<string, Draft>;
  }
  const make = (token: string, label: string, hint?: string): Draft => ({
    token,
    label,
    hint,
    count: 0,
    children: new Map(),
  });
  const roots = new Map<string, Draft>();
  const ensure = (into: Map<string, Draft>, token: string, label: string, hint?: string) => {
    let n = into.get(token);
    if (!n) {
      n = make(token, label, hint);
      into.set(token, n);
    }
    return n;
  };
  for (const { area: a, weight: n } of items) {
    if (!a.region) continue;
    const region = ensure(roots, `r:${a.region}`, a.region);
    region.count += n;
    let level = region;
    if (a.departementCode) {
      level = ensure(
        level.children,
        `d:${a.departementCode}`,
        a.departementName ?? a.departementCode,
        a.departementCode,
      );
      level.count += n;
    }
    if (a.city) {
      level = ensure(level.children, `v:${a.city}`, a.city);
      level.count += n;
    }
    const place = ensure(level.children, `p:${a.canonicalName}`, a.canonicalName);
    place.count += n;
  }
  const toNode = (d: Draft): LocNode => ({
    token: d.token,
    label: d.label,
    hint: d.hint,
    count: d.count,
    children: d.children.size
      ? [...d.children.values()].sort((a, b) => b.count - a.count).map(toNode)
      : undefined,
  });
  return [...roots.values()].sort((a, b) => b.count - a.count).map(toNode);
}

/** The theme picker's options: every theme of the grid found (old tags read as
 *  their theme), the most frequent first; counted in testimonies, not tags. */
export function buildTopicOptions(
  topicLists: Iterable<string[] | null | undefined>,
): { value: string; label: string; hint: string }[] {
  const counts = new Map<string, number>();
  for (const list of topicLists) {
    for (const theme of themesOf(list)) counts.set(theme, (counts.get(theme) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, n]) => ({ value, label: value, hint: String(n) }));
}

/** Earliest/latest date present — the date picker is bounded by them. */
export function dateBoundsOf(dates: Iterable<string | null | undefined>): {
  min: string | null;
  max: string | null;
} {
  let min: string | null = null;
  let max: string | null = null;
  for (const d of dates) {
    if (!d) continue;
    if (!min || d < min) min = d;
    if (!max || d > max) max = d;
  }
  return { min, max };
}
