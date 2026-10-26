// Compile-time checks of db.ts, run by `npm run typecheck`; never imported.
// The generated Insert and Update types accept place_stale and lieu_id, which
// the database refuses (428C9): the write types must not.

import type {
  AuditionGeneratedColumn,
  AuditionInsert,
  AuditionPlace,
  AuditionPlaceWrite,
  AuditionUpdate,
} from "./db";

declare const placed: AuditionPlace;
declare const writable: Omit<AuditionPlace, AuditionGeneratedColumn>;
declare const place: AuditionPlaceWrite;

// A placed row's place copied onto another row, as reuse does.
// @ts-expect-error -- place_stale and lieu_id are generated
export const copied: AuditionPlaceWrite = { ...placed };
export const reused: AuditionUpdate = { ...writable, location: "Place Bellecour, Lyon" };
export const relocated: AuditionUpdate = { ...place, location: "Place Bellecour, Lyon" };

export const created: AuditionInsert = {
  title: "Audition",
  date: "2026-10-26",
  location: "Place Bellecour, Lyon",
  content: "",
  ...place,
};
export const flagged: AuditionUpdate = {
  // @ts-expect-error -- place_stale is generated
  place_stale: false,
};
