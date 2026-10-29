// What the place reads answer (/api/places and its siblings, map phase 1):
// the read RPCs' jsonb as the API passes it on (supabase/migrations/
// 20261026200000_read_rpcs.sql), plus `textIgnored` when a text below
// SEARCH_MIN_CHARS was dropped.

/** [min lat, min lng, max lat, max lng] */
export type PlaceBBox = [number, number, number, number];

/** A unit's analyses figures (scopeStats' buildUnitStats, from the database). */
export interface PlaceFacts {
  testimonies: number;
  auditions: number;
  lieux: number;
  /** Municipalities: arrondissements roll up. */
  communes: number;
  /** [terrain, cahier2019, archive] */
  cohorts: [number, number, number];
  /** Per AUDITION_THEMES index. */
  themes: number[];
  themeAuditions: number[];
  themeBase: number;
  untagged: number;
  approx: number;
  first: string | null;
  last: string | null;
  /** [audition id, lieu id, lieu key, n, lieu city] */
  largest: [string, string, string, number, string | null] | null;
}

export interface PlaceUnitRow {
  id: string;
  parent: string | null;
  level: string;
  name: string;
  code: string | null;
  country: string;
  polygon: boolean;
  /** Levels below the unit asked for. */
  d: number;
  n: number;
  auditions: number;
  rank: string;
  /** The id of the newest audition of its first lieu (today's order, design A18). */
  tie: string;
  bbox: PlaceBBox;
  wrap: boolean;
  facts?: PlaceFacts;
}

/** A lieu's audition in a complete answer: [id, title, date, n], newest first. */
export type PlaceLieuListItem = [string, string, string, number];

export interface PlaceLieuRow {
  id: string;
  unit: string;
  key: string;
  city: string | null;
  lat: number;
  lng: number;
  precision: string;
  n: number;
  auditions: number;
  rank: string;
  /** The id of its newest audition. */
  tie: string;
  list?: PlaceLieuListItem[];
}

/** GET /api/places?unit=… (and each of `results` for units=…). */
export interface PlaceCounts {
  unit: string;
  /** The whole subtree is here (at most the budget of units plus lieux). */
  complete: boolean;
  self: {
    n: number;
    auditions: number;
    rank: string | null;
    bbox: PlaceBBox | null;
    facts?: PlaceFacts;
  };
  /** World only: the published auditions on no point. */
  unplaced?: { n: number; auditions: number };
  units: PlaceUnitRow[];
  lieux: PlaceLieuRow[];
  textIgnored?: true;
  /** With textIgnored: the shortest text searched (SEARCH_MIN_CHARS). */
  minChars?: number;
}

/** GET /api/places?units=… */
export interface PlaceCountsBatch {
  results: PlaceCounts[];
  textIgnored?: true;
  /** With textIgnored: the shortest text searched (SEARCH_MIN_CHARS). */
  minChars?: number;
}

/** Where a result, or a lieu, is on the map. */
export interface PlaceResultLieu {
  id: string;
  key: string;
  unit: string;
  path: string[];
  lat: number;
  lng: number;
  city: string | null;
}

export interface PlaceResultRow {
  id: string;
  title: string;
  date: string;
  n: number;
  lieu: PlaceResultLieu;
}

/**
 * The key of the next results page, as audition_results gives it: [date,
 * rank, tie, id], the tie being the id of the lieu's newest audition (a
 * uuid, not the lieu's id). Sent back as is, comma-separated, as `after`.
 */
export type PlaceResultsCursor = [string, string, string, string];

/** GET /api/places/results */
export interface PlaceResultsPage {
  auditions: PlaceResultRow[];
  next: PlaceResultsCursor | null;
  /** First page only. */
  total?: { auditions: number; lieux: number; n: number };
  /** First page only: resultBounds over the result lieux. */
  frame?: PlaceBBox | null;
  /** With `through`. */
  throughFound?: boolean;
  textIgnored?: true;
  /** With textIgnored: the shortest text searched (SEARCH_MIN_CHARS). */
  minChars?: number;
}

/** GET /api/places/lieu */
export interface PlaceLieuAuditions {
  /** null: no such lieu on the map. */
  lieu: PlaceResultLieu | null;
  auditions: { id: string; title: string; date: string; n: number }[];
  textIgnored?: true;
  /** With textIgnored: the shortest text searched (SEARCH_MIN_CHARS). */
  minChars?: number;
}

/** GET /api/places/facets */
export interface PlaceFacets {
  /** Theme index and its public testimonies, the most frequent first. */
  themes: { i: number; n: number }[];
  /** [first, last] date of the auditions on the map; null when none. */
  dates: [string, string] | null;
}

export interface PlaceTestimony {
  id: string;
  audition_id: string;
  person_name: string;
  person_info: string | null;
  content: string;
  topics: string[] | null;
  verification_status: string | null;
  created_at: string | null;
}

/** The key of the next testimony page: [created_at or null, id]. */
export type TestimonyPageCursor = [string | null, string];

/** GET /api/auditions/:id/testimonies */
export interface TestimonyPage {
  testimonies: PlaceTestimony[];
  next: TestimonyPageCursor | null;
  textIgnored?: true;
  /** With textIgnored: the shortest text searched (SEARCH_MIN_CHARS). */
  minChars?: number;
}

/** GET /api/auditions/admin/filter */
export interface AdminAuditionFilter {
  /** Per audition: [testimonies passing every filter, passing all but the text]. */
  matches: Record<string, [number, number]>;
  /** Per AUDITION_THEMES index, over the auditions the admin may open. */
  themes: number[];
}
