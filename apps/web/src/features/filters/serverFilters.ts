// The filters as the place reads take them (map phase 1, design D2, E1): the
// page's filter state turned into @ac/shared's query, keyed by the very
// functions the API uses, so that the web's query keys and its list mode
// follow the API's cache key. The free text counts 300 ms after the last
// keystroke, and while it waits the other filters wait with it: each key is a
// round trip (D6), and a key must not pass through a state the reader never
// asked for (a theme taken off as a text is typed: list mode would go off and
// on). Places are picked by unit and lieu ids (D2).

import { computed, onScopeDispose, ref, shallowRef, watch, type ComputedRef, type Ref } from "vue";
import {
  LIEU_ID,
  placeFilterKey,
  placeFilterQueryOf,
  placeFilterQueryParams,
  placeFiltersOf,
  SEARCH_MIN_CHARS_DEFAULT,
  SEARCH_TEXT_MAX,
  themeIndexesOf,
  UNIT_ID,
  type PlaceFilters,
} from "@ac/shared";

/** How long the text waits after the last keystroke. */
export const TEXT_DEBOUNCE_MS = 300;

/** The timer the text's pause runs on: the browser's, or a test's own clock. */
export interface FilterTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (timer: unknown) => void;
}
const REAL_TIMERS: FilterTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

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
  /** The filters in force (as debounced, below the minimum the text dropped). */
  filters: ComputedRef<PlaceFilters>;
  /** Their canonical key: "" when nothing filters (placeFilterKey). */
  key: ComputedRef<string>;
  /** Their query parameters (the ignored text left out). */
  params: ComputedRef<Readonly<Record<string, string>>>;
  /** The text as debounced, raw: what the results were looked up with. */
  text: ComputedRef<string>;
  /** Text was typed but is shorter than the search accepts: not applied. */
  textTooShort: ComputedRef<boolean>;
  /** The shortest text applied. */
  minChars: Ref<number>;
  /** An answer said its text was ignored (the API's SEARCH_MIN_CHARS is above
   *  ours): its minimum taken (`minChars`, when the answer gives it; else one
   *  more than the text's), and the key dropped to the one without the text. */
  noteTextIgnored: (needle: string, minChars?: number) => void;
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
 * answer says otherwise). `timers`: what the text's pause runs on (the
 * browser's timers unless given).
 */
export function useServerFilters(
  state: FilterState,
  opts: { minChars?: number; debounceMs?: number; timers?: FilterTimers } = {},
): ServerFilters {
  const debounceMs = opts.debounceMs ?? TEXT_DEBOUNCE_MS;
  const timers = opts.timers ?? REAL_TIMERS;
  const minChars = ref(opts.minChars ?? SEARCH_MIN_CHARS_DEFAULT);

  // The state applied: at once, unless a text is waiting for typing to pause
  // — then all of it once it has (a text emptied applies at once).
  const read = () => ({
    verified: state.verified.value,
    topics: [...state.topics.value],
    locations: [...state.locations.value],
    dateFrom: state.dateFrom.value,
    dateTo: state.dateTo.value,
    text: state.text.value,
  });
  const applied = shallowRef(read());
  let timer: unknown;
  const drop = () => {
    if (timer !== undefined) timers.clear(timer);
    timer = undefined;
  };
  watch(read, (next, prev) => {
    const textWaits = next.text !== applied.value.text && next.text.trim() !== "";
    if (!textWaits) {
      drop();
      applied.value = next;
      return;
    }
    if (timer !== undefined && next.text === prev.text) return; // the text's pause still runs
    drop();
    timer = timers.set(() => {
      timer = undefined;
      applied.value = read();
    }, debounceMs);
  });
  onScopeDispose(drop);

  const query = computed(() => {
    const a = applied.value;
    const { units, lieux } = placeIdsOf(a.locations);
    return placeFilterQueryOf({
      verified: a.verified,
      themes: themeIndexesOf(a.topics),
      text: a.text.slice(0, SEARCH_TEXT_MAX),
      from: a.dateFrom,
      to: a.dateTo,
      units,
      lieux,
    });
  });
  const filters = computed(() => placeFiltersOf(query.value, minChars.value));
  const key = computed(() => placeFilterKey(filters.value));
  // The text left out when it is not applied (the API would ignore it).
  const params = computed(() =>
    placeFilterQueryParams(filters.value.needle ? query.value : { ...query.value, q: undefined }),
  );
  const text = computed(() => applied.value.text);
  const textTooShort = computed(() => filters.value.textIgnored);

  function noteTextIgnored(needle: string, apiMin?: number) {
    const length = [...needle].length;
    if (apiMin !== undefined && apiMin > length) minChars.value = Math.max(minChars.value, apiMin);
    else if (length >= minChars.value) minChars.value = length + 1;
  }

  return { filters, key, params, text, textTooShort, minChars, noteTextIgnored };
}
