// Compile-time check, run by `npm run typecheck`; never imported: the API's
// schema parses into placeFilters' PlaceFilterQuery, and back.

import type { z } from "zod";
import type { PlaceFilterQuery } from "./placeFilters";
import type { placeFilterQuerySchema } from "./placeFilterSchema";

type Parsed = z.infer<typeof placeFilterQuerySchema>;
declare const parsed: Parsed;
declare const query: PlaceFilterQuery;

export const asQuery: PlaceFilterQuery = parsed;
export const asParsed: Parsed = query;
