import { z } from "zod";
import { fold } from "./filters";
import { AUDITION_THEMES } from "./themes";

// The Témoignages filters as the place reads take them (/api/places and its
// siblings, map phase 1): one query-string form, parsed and validated here
// for the API and built here by the web, so that both derive the same
// canonical key: the API's cache key and the web's query key (and its list
// mode) are one string.
//
//   v=1            verified testimonies only
//   t=0,11         themes, as AUDITION_THEMES indexes (any of them)
//   q=climat       free text, folded as today (accents and case dropped),
//                  found anywhere in the witness's words
//   from, to       the audition's date range, YYYY-MM-DD
//   u=fr:dep:69,…  units (the audition placed under any of them)
//   l=l:3fa…,…     lieux

/** A unit id: a country (ISO 3166-1), France's régions, départements and communes (INSEE), an Overture division elsewhere. As ac.unit_id_ok. */
export const UNIT_ID = /^([A-Z]{2}|fr:(reg|dep|com):[0-9AB]{2,5}|[0-9a-f-]{32,36})$/;
/** A lieu id, as the auditions table generates it. As ac.lieu_id_ok. */
export const LIEU_ID = /^l:[0-9a-f]{16}$/;
/** At most this many units, or lieux, per filter (and per batched request). */
export const PLACE_IDS_MAX = 50;
/** The free text, at most this long (typed, and folded). */
export const SEARCH_TEXT_MAX = 200;
/** The shortest text applied, by default: any (SEARCH_MIN_CHARS may raise it, design D11). */
export const SEARCH_MIN_CHARS_DEFAULT = 1;

export const PLACE_SORTS = ["recent", "ancien"] as const;
export type PlaceSort = (typeof PLACE_SORTS)[number];

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD and a day of the calendar (no 2025-02-30). */
export function isDay(s: string): boolean {
  if (!DAY.test(s) || s.startsWith("0000")) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** Sorted, without duplicates: one filter, one spelling. */
const canonical = <T extends string | number>(xs: T[]): T[] =>
  [...new Set(xs)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const one = (what: string) => ({ error: `Paramètre ${what} invalide (un seul attendu).` });

const idList = (re: RegExp, param: string, plural: string, invalid: string) =>
  z
    .string(one(param))
    .refine((s) => list(s).length <= PLACE_IDS_MAX, {
      error: `${PLACE_IDS_MAX} ${plural} au plus.`,
    })
    .refine((s) => list(s).every((id) => re.test(id)), { error: invalid })
    .transform((s) => canonical(list(s)));

const day = (param: string, what: string) =>
  z.string(one(param)).refine(isDay, { error: `Date ${what} invalide (AAAA-MM-JJ).` });

/** The filter parameters of a place read, validated (a querystring's values: strings). */
export const placeFilterQuerySchema = z.object({
  v: z.enum(["0", "1"], { error: "Paramètre v invalide (0 ou 1)." }).optional(),
  t: z
    .string(one("t"))
    .refine((s) => list(s).every((x) => /^(\d|1[0-5])$/.test(x)), { error: "Thème inconnu." })
    .transform((s) => canonical(list(s).map(Number)))
    .optional(),
  q: z
    .string(one("q"))
    .max(SEARCH_TEXT_MAX, `Texte trop long (${SEARCH_TEXT_MAX} caractères au plus).`)
    .refine((s) => fold(s.trim()).length <= SEARCH_TEXT_MAX, {
      error: `Texte trop long (${SEARCH_TEXT_MAX} caractères au plus).`,
    })
    .optional(),
  from: day("from", "de début").optional(),
  to: day("to", "de fin").optional(),
  u: idList(UNIT_ID, "u", "unités", "Identifiant d'unité invalide.").optional(),
  l: idList(LIEU_ID, "l", "lieux", "Identifiant de lieu invalide.").optional(),
});

export type PlaceFilterQuery = z.infer<typeof placeFilterQuerySchema>;

/** The filters of a place read, normalised. */
export interface PlaceFilters {
  verified: boolean;
  /** AUDITION_THEMES indexes, sorted. */
  themes: number[];
  /** The free text folded (fold(q.trim())); "" for none, or below the minimum. */
  needle: string;
  /** Text was given but is shorter than the minimum: it was not applied. */
  textIgnored: boolean;
  from: string | null;
  to: string | null;
  /** Unit ids, sorted. */
  units: string[];
  /** Lieu ids, sorted. */
  lieux: string[];
}

export const NO_PLACE_FILTERS: PlaceFilters = {
  verified: false,
  themes: [],
  needle: "",
  textIgnored: false,
  from: null,
  to: null,
  units: [],
  lieux: [],
};

/**
 * The filters a parsed query asks for. Text below `minChars` characters
 * (SEARCH_MIN_CHARS) is dropped, and said so: the key is built after this
 * rule, so a short text shares the unfiltered answer.
 */
export function placeFiltersOf(
  q: PlaceFilterQuery,
  minChars: number = SEARCH_MIN_CHARS_DEFAULT,
): PlaceFilters {
  const folded = fold((q.q ?? "").trim());
  const short = folded !== "" && [...folded].length < minChars;
  return {
    verified: q.v === "1",
    themes: q.t ?? [],
    needle: short ? "" : folded,
    textIgnored: short,
    from: q.from ?? null,
    to: q.to ?? null,
    units: q.u ?? [],
    lieux: q.l ?? [],
  };
}

/** The filters judged on a testimony's own content alone (verified, themes, text). */
export function contentFiltersOf(f: PlaceFilters): PlaceFilters {
  return { ...f, from: null, to: null, units: [], lieux: [] };
}

/** theme_mask's bits for these themes (bit i: AUDITION_THEMES[i]). */
export function themeMask(themes: readonly number[]): number {
  return themes.reduce((m, i) => m | (1 << i), 0);
}

/** AUDITION_THEMES indexes of theme names (the web's picked topics); unknown names are dropped. */
export function themeIndexesOf(topics: readonly string[]): number[] {
  const all: readonly string[] = AUDITION_THEMES;
  return canonical(topics.map((t) => all.indexOf(t)).filter((i) => i >= 0));
}

/** `s` for a LIKE pattern: its \, % and _ taken literally. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The LIKE pattern of a needle: found anywhere. */
export function likePattern(needle: string): string {
  return `%${escapeLike(needle)}%`;
}

/**
 * The canonical key of the filters: "" when nothing filters, else the active
 * filters in a fixed order, `v1|m<mask>|q<needle>|f<from>|t<to>|u<units>|l<lieux>`
 * (the needle URI-encoded, so that no text can pass for another filter).
 */
export function placeFilterKey(f: PlaceFilters): string {
  const parts: string[] = [];
  if (f.verified) parts.push("v1");
  const mask = themeMask(f.themes);
  if (mask) parts.push(`m${mask}`);
  if (f.needle) parts.push(`q${encodeURIComponent(f.needle)}`);
  if (f.from) parts.push(`f${f.from}`);
  if (f.to) parts.push(`t${f.to}`);
  if (f.units.length) parts.push(`u${f.units.join(",")}`);
  if (f.lieux.length) parts.push(`l${f.lieux.join(",")}`);
  return parts.join("|");
}

/** The filters as the read RPCs take them (p_filters): only the active ones. */
export type RpcPlaceFilters = {
  verified?: true;
  mask?: number;
  like?: string;
  from?: string;
  to?: string;
  units?: string[];
  lieux?: string[];
};

export function rpcPlaceFilters(f: PlaceFilters): RpcPlaceFilters {
  const out: RpcPlaceFilters = {};
  if (f.verified) out.verified = true;
  const mask = themeMask(f.themes);
  if (mask) out.mask = mask;
  if (f.needle) out.like = likePattern(f.needle);
  if (f.from) out.from = f.from;
  if (f.to) out.to = f.to;
  if (f.units.length) out.units = f.units;
  if (f.lieux.length) out.lieux = f.lieux;
  return out;
}

/** What the web filters on, to build a query from. */
export interface PlaceFilterInput {
  verified?: boolean;
  /** AUDITION_THEMES indexes (themeIndexesOf for names). */
  themes?: readonly number[];
  /** The free text as typed. */
  text?: string;
  from?: string | null;
  to?: string | null;
  units?: readonly string[];
  lieux?: readonly string[];
}

/** The query parameters of these filters, in one spelling (sorted lists, nothing empty). */
export function placeFilterParams(input: PlaceFilterInput): Record<string, string> {
  const out: Record<string, string> = {};
  if (input.verified) out.v = "1";
  if (input.themes?.length) out.t = canonical([...input.themes]).join(",");
  const text = input.text?.trim();
  if (text) out.q = text;
  if (input.from) out.from = input.from;
  if (input.to) out.to = input.to;
  if (input.units?.length) out.u = canonical([...input.units]).join(",");
  if (input.lieux?.length) out.l = canonical([...input.lieux]).join(",");
  return out;
}
