// FROZEN — the reference of npm run db:parity (scripts/parity): a copy of
// packages/shared/src/filters.ts (passesContent, passesDate)
// as of b3cb304, before map phase 1 moved the Témoignages map onto the
// server. Never edited to follow the app; only to run in Node (imports, Vue
// refs turned into arguments).

import { searchHaystack, themesOf } from "@ac/shared";

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
  if (f.needle && !textMatched && !searchHaystack(t).includes(f.needle)) return false;
  return true;
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
