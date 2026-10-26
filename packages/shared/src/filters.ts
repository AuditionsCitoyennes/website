import { answersText } from "./answers";
import { themesOf } from "./themes";

// The testimony filters judged on content and date, shared by the web (the
// Témoignages page, the admin list) and the database: the testimonies'
// search_text column is fold() of the same haystack, kept by a trigger whose
// SQL is generated from this package (scripts/sql-gen/derived.ts).

/** Accent- and case-insensitive haystack for the free-text search. */
export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** What the free text is searched in: the witness's name, details and own
 *  words (not the questions of a testimony sent online), folded. */
export function searchHaystack(t: {
  person_name: string;
  person_info: string | null;
  content: string;
}): string {
  return fold(`${t.person_name} ${t.person_info ?? ""} ${answersText(t.content)}`);
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
