// The filters as the place reads take them (map phase 1, design D2, E1): the
// page's filter state turned into @ac/shared's query parameters, parsed and
// keyed by the very functions the API uses, so that the web's query keys and
// its list mode follow the API's cache key. The free text counts 300 ms after
// the last keystroke: each key is a round trip (D6). Places are picked by unit
// and lieu ids (D2).

import { computed, onScopeDispose, ref, watch, type ComputedRef, type Ref } from "vue";
import {
  LIEU_ID,
  placeFilterKey,
  placeFilterParams,
  placeFilterQuerySchema,
  placeFiltersOf,
  SEARCH_MIN_CHARS_DEFAULT,
  SEARCH_TEXT_MAX,
  themeIndexesOf,
  UNIT_ID,
  type PlaceFilters,
} from "@ac/shared";

/** How long the text waits after the last keystroke. */
export const TEXT_DEBOUNCE_MS = 300;

/** What the page filters on (useFilters' refs). */
export interface FilterState {
  text: Ref<string>;
  topics: Ref<string[]>;
  locations: Ref<string[]>;
  dateFrom: Ref<string | null>;
  dateTo: Ref<string | null>;
  verified: Ref<boolean>;
}

export interface ServerFilters {
  /** The filters in force (the text as debounced, below the minimum dropped). */
  filters: ComputedRef<PlaceFilters>;
  /** Their canonical key: "" when nothing filters (placeFilterKey). */
  key: ComputedRef<string>;
  /** Their query parameters (the ignored text left out). */
  params: ComputedRef<Readonly<Record<string, string>>>;
  /** The text as debounced, raw: what the results were looked up with. */
  text: Ref<string>;
  /** Text was typed but is shorter than the search accepts: not applied. */
  textTooShort: ComputedRef<boolean>;
  /** The shortest text applied. */
  minChars: Ref<number>;
  /** An answer said its text was ignored (the API's SEARCH_MIN_CHARS is above
   *  it): the minimum is learnt, and the key dropped to the unfiltered one. */
  noteTextIgnored: (needle: string) => void;
}

/** Picked places split into unit and lieu ids (anything else is not an id). */
export function placeIdsOf(tokens: readonly string[]): { units: string[]; lieux: string[] } {
  return {
    units: tokens.filter((t) => UNIT_ID.test(t)),
    lieux: tokens.filter((t) => LIEU_ID.test(t)),
  };
}

/** Whether an audition's place (its unit path and lieu id, as /api/map's
 *  groups carry them) is among the places picked — none picked: all are. */
export function passesPlaceIds(
  place: { unitPath?: readonly string[] | null; lieuId?: string | null } | null,
  picked: readonly string[],
): boolean {
  if (!picked.length) return true;
  if (!place) return false;
  return picked.some((id) => id === place.lieuId || (place.unitPath?.includes(id) ?? false));
}

/**
 * The filters as the server takes them, from the page's state. `minChars`:
 * the shortest text applied (SEARCH_MIN_CHARS, the API's default unless an
 * answer says otherwise).
 */
export function useServerFilters(
  state: FilterState,
  opts: { minChars?: number; debounceMs?: number } = {},
): ServerFilters {
  const debounceMs = opts.debounceMs ?? TEXT_DEBOUNCE_MS;
  const minChars = ref(opts.minChars ?? SEARCH_MIN_CHARS_DEFAULT);

  // The text, once typing has paused; emptied at once (a chip taken off).
  const text = ref(state.text.value);
  let timer: ReturnType<typeof setTimeout> | undefined;
  watch(state.text, (next) => {
    clearTimeout(timer);
    if (!next.trim()) {
      text.value = next;
      return;
    }
    timer = setTimeout(() => (text.value = next), debounceMs);
  });
  onScopeDispose(() => clearTimeout(timer));

  const parsed = computed(() => {
    const { units, lieux } = placeIdsOf(state.locations.value);
    const input = {
      verified: state.verified.value,
      themes: themeIndexesOf(state.topics.value),
      text: text.value.slice(0, SEARCH_TEXT_MAX),
      from: state.dateFrom.value,
      to: state.dateTo.value,
      units,
      lieux,
    };
    let q = placeFilterQuerySchema.safeParse(placeFilterParams(input));
    // A text the API would refuse (too long once folded, a NUL): searched
    // without it rather than not at all.
    if (!q.success) q = placeFilterQuerySchema.safeParse(placeFilterParams({ ...input, text: "" }));
    return q.success ? placeFiltersOf(q.data, minChars.value) : placeFiltersOf({}, minChars.value);
  });

  const filters = computed(() => parsed.value);
  const key = computed(() => placeFilterKey(parsed.value));
  const params = computed(() => {
    const f = parsed.value;
    return placeFilterParams({
      verified: f.verified,
      themes: f.themes,
      // The needle stands for the text: the API folds it again, to itself.
      text: f.needle ? text.value.slice(0, SEARCH_TEXT_MAX) : "",
      from: f.from,
      to: f.to,
      units: f.units,
      lieux: f.lieux,
    });
  });
  const textTooShort = computed(() => parsed.value.textIgnored);

  function noteTextIgnored(needle: string) {
    const length = [...needle].length;
    if (length >= minChars.value) minChars.value = length + 1;
  }

  return { filters, key, params, text, textTooShort, minChars, noteTextIgnored };
}
