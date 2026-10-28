import { z } from "zod";
import {
  idListOf,
  isDay,
  LIEU_ID,
  listItems,
  PLACE_IDS_MAX,
  searchTextOk,
  SEARCH_TEXT_MAX,
  THEME_TOKEN,
  themeListOf,
  UNIT_ID,
} from "./placeFilters";

// The place reads' filter parameters as the API validates them (zod), by the
// rules of placeFilters.ts. A module of its own: the web builds its queries
// with placeFilterQueryOf and never loads zod for them.

/** zod's error for a parameter that must come once, as a string (a repeated one comes as a list). */
export const oneParam = (what: string) => ({
  error: `Paramètre ${what} invalide (un seul attendu).`,
});
const one = oneParam;

const idList = (re: RegExp, param: string, plural: string, invalid: string) =>
  z
    .string(one(param))
    .refine((s) => listItems(s).length <= PLACE_IDS_MAX, {
      error: `${PLACE_IDS_MAX} ${plural} au plus.`,
    })
    .refine((s) => listItems(s).every((id) => re.test(id)), { error: invalid })
    .transform(idListOf);

const day = (param: string, what: string) =>
  z.string(one(param)).refine(isDay, { error: `Date ${what} invalide (AAAA-MM-JJ).` });

const TOO_LONG = `Texte trop long (${SEARCH_TEXT_MAX} caractères au plus).`;

/** The filter parameters of a place read, validated (a querystring's values: strings). */
export const placeFilterQuerySchema = z.object({
  v: z.enum(["0", "1"], { error: "Paramètre v invalide (0 ou 1)." }).optional(),
  t: z
    .string(one("t"))
    .refine((s) => listItems(s).every((x) => THEME_TOKEN.test(x)), { error: "Thème inconnu." })
    .transform(themeListOf)
    .optional(),
  q: z
    .string(one("q"))
    .max(SEARCH_TEXT_MAX, TOO_LONG)
    // Postgres text cannot hold a NUL (22P05).
    .refine((s) => !s.includes("\u0000"), { error: "Texte invalide." })
    .refine(searchTextOk, { error: TOO_LONG })
    .optional(),
  from: day("from", "de début").optional(),
  to: day("to", "de fin").optional(),
  u: idList(UNIT_ID, "u", "unités", "Identifiant d'unité invalide.").optional(),
  l: idList(LIEU_ID, "l", "lieux", "Identifiant de lieu invalide.").optional(),
});
