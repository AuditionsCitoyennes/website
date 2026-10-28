// The admin list's content filters — verified only, themes, free text — judged
// by the server (map phase 1, design A22): GET /api/auditions/admin/filter
// answers, per audition with testimonies, how many pass every filter and how
// many pass all but the text, and per theme how many testimonies the admin's
// auditions hold. The text found in the audition itself (its title, place or
// context) is still judged here, as before. Pure: no Vue, no alias, so that
// `node --import tsx --test` runs its test (root "test:scripts").

import {
  AUDITION_THEMES,
  fold,
  placeFilterKey,
  placeFilterParams,
  placeFilterQuerySchema,
  placeFiltersOf,
  themeIndexesOf,
  type AdminAuditionFilter,
} from "@ac/shared";

/** The content filters as they are asked of the server. */
export interface ContentAsk {
  /** Their canonical key ("" when none is on): the query's. */
  key: string;
  /** Its query parameters (v, t, q). */
  params: Record<string, string>;
  verified: boolean;
  /** AUDITION_THEMES indexes. */
  themes: number[];
  /** The text, folded as the list always looked for it: any length. */
  needle: string;
  /** The text could not be sent (too long once folded, or a NUL): no
   *  testimony is taken to hold it. */
  textUnsent: boolean;
}

/** The admin search: any text however short, as it always was. */
const ADMIN_MIN_CHARS = 1;

export function contentAskOf(input: {
  verified: boolean;
  topics: readonly string[];
  text: string;
}): ContentAsk {
  const verified = input.verified;
  const themes = themeIndexesOf(input.topics);
  const needle = fold(input.text.trim());
  let parsed = placeFilterQuerySchema.safeParse(
    placeFilterParams({ verified, themes, text: input.text }),
  );
  let textUnsent = false;
  if (!parsed.success) {
    // The API would refuse it: asked without it.
    textUnsent = true;
    parsed = placeFilterQuerySchema.safeParse(placeFilterParams({ verified, themes }));
  }
  const filters = placeFiltersOf(parsed.success ? parsed.data : {}, ADMIN_MIN_CHARS);
  const sent = placeFilterKey(filters);
  return {
    // An unsent text keeps a key of its own: its answers are read without it.
    key: textUnsent && needle ? `${sent}|unsent:${encodeURIComponent(needle)}` : sent,
    params: placeFilterParams({
      verified: filters.verified,
      themes: filters.themes,
      text: filters.needle ? input.text : "",
    }),
    verified,
    themes,
    needle,
    textUnsent: textUnsent && needle !== "",
  };
}

/** Whether a content filter is asked for at all. */
export function contentOn(ask: Pick<ContentAsk, "verified" | "themes" | "needle">): boolean {
  return ask.verified || ask.themes.length > 0 || ask.needle !== "";
}

/** A server's answer, with what it was asked for. */
export interface ContentMatches extends AdminAuditionFilter {
  ask: ContentAsk;
}

/** What the list judges an audition on. */
export interface AuditionText {
  id: string;
  title: string;
  location: string;
  content: string;
}

/**
 * Whether an audition passes the content filters of an answer (null: none
 * could be had — no testimony is taken to pass). Text only: the text is in
 * the audition, or in one of its testimonies. Verified or themes on: one of
 * its testimonies passes them and, when the audition does not hold the text
 * itself, holds the text.
 */
export function passesContentMatches(
  a: AuditionText,
  ask: ContentAsk,
  matches: AdminAuditionFilter["matches"] | null,
): boolean {
  const onTestimonies = ask.verified || ask.themes.length > 0;
  if (!onTestimonies && !ask.needle) return true;
  const textInAudition =
    ask.needle !== "" && fold(`${a.title} ${a.location} ${a.content}`).includes(ask.needle);
  const [all, noText] = matches?.[a.id] ?? [0, 0];
  const nAll = ask.textUnsent ? 0 : all;
  if (!onTestimonies) return textInAudition || nAll > 0;
  return textInAudition ? noText > 0 : nAll > 0;
}

/** Each theme's count of an answer, by name (topicOptionsOf's input). */
export function themeCountsOf(themes: readonly number[]): Map<string, number> {
  return new Map(AUDITION_THEMES.map((t, i) => [t, themes[i] ?? 0]));
}
