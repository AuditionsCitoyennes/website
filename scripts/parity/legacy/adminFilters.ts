// FROZEN — the reference of npm run db:parity (scripts/parity): a copy of
// apps/web/src/features/admin/auditions/useAuditionFilters.ts (passes,
// topicOptions, testimoniesByAudition)
// as of b3cb304, before map phase 1 moved the admin filters onto the
// server. Never edited to follow the app; only to run in Node (imports, Vue
// refs turned into arguments). Place and date stay the client's: not here.

import { answersText } from "@ac/shared";
import { buildTopicOptions, fold, passesContent, type TestimonyContent } from "./filters";

/** A testimony as the filters judge it (see /api/testimonies/admin/filterable). */
export interface FilterableTestimony extends TestimonyContent {
  audition_id: string;
}

/** What the content filters read of an audition of the admin list. */
export interface AdminAuditionText {
  id: string;
  title: string;
  location: string;
  content: string;
}

export interface AdminContentFilters {
  verified: boolean;
  topics: string[];
  needle: string;
}

// Each audition's testimonies, with the text the free search looks in folded
// once — not on every keystroke.
export function testimoniesByAudition(filterable: FilterableTestimony[]) {
  const byAudition = new Map<string, { t: FilterableTestimony; hay: string }[]>();
  for (const t of filterable) {
    // The witness's words only: not the questions of a testimony sent online.
    const entry = {
      t,
      hay: fold(`${t.person_name} ${t.person_info ?? ""} ${answersText(t.content)}`),
    };
    const list = byAudition.get(t.audition_id);
    if (list) list.push(entry);
    else byAudition.set(t.audition_id, [entry]);
  }
  return byAudition;
}

export function topicOptions(filterable: FilterableTestimony[], reachableIds: Set<string>) {
  return buildTopicOptions(
    filterable.filter((t) => reachableIds.has(t.audition_id)).map((t) => t.topics),
  );
}

/** passes() without its place and date tests (the client keeps those). */
export function passesContentFilters(
  a: AdminAuditionText,
  f: AdminContentFilters,
  byAudition: ReturnType<typeof testimoniesByAudition>,
): boolean {
  const { verified, topics, needle } = f;
  const onTestimonies = verified || topics.length > 0;
  if (!onTestimonies && !needle) return true;
  const textInAudition =
    Boolean(needle) && fold(`${a.title} ${a.location} ${a.content}`).includes(needle);
  const textIn = (hay: string) => !needle || textInAudition || hay.includes(needle);
  const own = byAudition.get(a.id) ?? [];
  if (!onTestimonies) return textInAudition || own.some((e) => textIn(e.hay));
  // The text was looked for above, once per testimony: not again inside.
  const others = { verified, topics, needle: "" };
  return own.some((e) => passesContent(e.t, others) && textIn(e.hay));
}
