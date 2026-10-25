// The auditions the panel lists and how they are read: the open lieu's own, or
// — filters on — every audition that matches, a page at a time as the reader
// scrolls; the single-open accordion; the list's scroll kept where the
// reader's eye is while an audition opens or the results change.
import { computed, nextTick, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from "vue";
import type { LocationGroup } from "@ac/shared";
import { formatDateShort } from "@/shared/format/dates";
import type { GeoUnit } from "@/features/geo";
import type { NavState } from "../navState";
import {
  bySort,
  RESULTS_PAGE,
  testimoniesOf,
  toPanelAudition,
  type AuditionGroup,
  type AuditionSort,
  type PanelAudition,
} from "./auditions";

export interface PanelAuditionsInputs {
  nav: NavState;
  groups: Ref<LocationGroup[]>;
  sort: Ref<AuditionSort | undefined>;
  /** Filters are on: the panel lists EVERY audition that matches, in one list. */
  listMode: ComputedRef<boolean>;
  /** The association's own testimonies, grouped by audition (keyed by its id). */
  ownAuditions: ComputedRef<Map<string, AuditionGroup>>;
  selectedPlace: ComputedRef<GeoUnit | null>;
  placeByCanonical: ComputedRef<Map<string, GeoUnit>>;
  /** The list's scroller (`.panel-list`, GeoPanel's). */
  panelListEl: Ref<HTMLElement | null>;
  /** The "more results" sentinel at the end of the list (AuditionList's). */
  moreEl: Ref<HTMLElement | null>;
  /** Flies the map onto a lieu — along an arc when asked, for a hop from
   *  another lieu (the camera's spotlightPlace). */
  spotlightPlace: (unit: GeoUnit, arc?: boolean) => void;
  /** Frames every lieu of the results once the list has stopped changing (the
   *  camera's). */
  scheduleResultsFit: () => void;
}

export function usePanelAuditions(inputs: PanelAuditionsInputs) {
  const {
    nav,
    groups,
    sort,
    listMode,
    ownAuditions,
    selectedPlace,
    placeByCanonical,
    panelListEl,
    moreEl,
    spotlightPlace,
    scheduleResultsFit,
  } = inputs;
  const { selectedPlaceId, openAuditions, mapEngaged } = nav;

  /** The panel's line for an audition of a group, with its testimonies (all
   *  loaded with the page) once they are here. */
  function panelAudition(g: LocationGroup, a: LocationGroup["auditions"][number]): PanelAudition {
    return toPanelAudition(g, a, ownAuditions.value);
  }

  // The open lieu's auditions: listed at once from what the map already knows of
  // them (title, date, how many testimonies) — nothing is fetched to open a lieu.
  const placeAuditions = computed<PanelAudition[]>(() => {
    const canonical = selectedPlace.value?.canonical;
    if (!canonical) return [];
    const rows: PanelAudition[] = [];
    for (const g of groups.value) {
      if (g.canonicalName !== canonical) continue;
      for (const a of g.auditions) rows.push(panelAudition(g, a));
    }
    return rows.sort((a, b) => bySort(a, b, sort.value));
  });

  const resultAuditions = computed<PanelAudition[]>(() => {
    if (!listMode.value) return [];
    const out: PanelAudition[] = [];
    for (const g of groups.value) for (const a of g.auditions) out.push(panelAudition(g, a));
    return out.sort((a, b) => bySort(a, b, sort.value));
  });

  // Many auditions can match a wide filter: the list is filled a page at a time
  // as the reader scrolls down it.
  const shownCount = ref(RESULTS_PAGE);
  const moreResults = computed(() => resultAuditions.value.length > shownCount.value);
  function showMoreResults() {
    shownCount.value += RESULTS_PAGE;
  }
  let moreObserver: IntersectionObserver | null = null;
  watch(moreEl, (el) => {
    moreObserver?.disconnect();
    moreObserver = null;
    if (!el || typeof IntersectionObserver === "undefined") return;
    moreObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) showMoreResults();
      },
      { root: panelListEl.value, rootMargin: "200px" },
    );
    moreObserver.observe(el);
  });
  onBeforeUnmount(() => moreObserver?.disconnect());

  /** The auditions the panel shows: the results, or the open lieu's own. */
  const panelAuditions = computed<PanelAudition[]>(() =>
    listMode.value ? resultAuditions.value.slice(0, shownCount.value) : placeAuditions.value,
  );

  /** Date, and in the results the lieu too (a lieu's own detail has it as title). */
  function auditionMeta(a: PanelAudition): string {
    const place = listMode.value
      ? (placeByCanonical.value.get(a.canonical)?.label ?? a.canonical)
      : "";
    return [a.date ? formatDateShort(a.date) : "", place].filter(Boolean).join(" · ");
  }

  const resultsSig = computed(() =>
    listMode.value ? resultAuditions.value.map((a) => a.id).join("|") : "",
  );
  /** Which auditions match, whatever their order: sorting is not a new answer. */
  const resultSetSig = computed(() =>
    listMode.value
      ? resultAuditions.value
          .map((a) => a.id)
          .sort()
          .join("|")
      : "",
  );
  watch(listMode, (on) => {
    // The results replace whatever lieu was open: they are a list of their own.
    if (on) {
      openAuditions.value.clear();
      selectedPlaceId.value = null;
    }
  });
  watch(resultsSig, () => {
    if (!listMode.value) return;
    const open = [...openAuditions.value][0];
    const at = open ? resultAuditions.value.findIndex((a) => a.id === open) : -1;
    if (open && at === -1) {
      // The audition being read no longer matches the filters.
      openAuditions.value.clear();
      selectedPlaceId.value = null;
    }
    // Back to the first page — or as far as the audition being read.
    shownCount.value = Math.max(RESULTS_PAGE, at + 1);
    // A new list is read from its top; the audition being read stays in sight
    // wherever the new order has put it.
    if (at === -1) {
      if (panelListEl.value) panelListEl.value.scrollTop = 0;
    } else if (open) {
      void nextTick(() => audToTop(open, true));
    }
  });
  watch(resultSetSig, (sig) => {
    if (sig) scheduleResultsFit();
  });

  /**
   * Scroll the list so an audition's line sits at its top (the text opens in
   * view beneath it). `ifHidden`: only when that line is out of sight. Writes
   * the list's own scrollTop — scrollIntoView would also move the page under it.
   * Returns the resulting scroll position.
   */
  function audToTop(id: string, ifHidden = false): number | null {
    const scroller = panelListEl.value;
    const header = scroller?.querySelector<HTMLElement>(`[data-aud="${CSS.escape(id)}"]`);
    if (!scroller || !header) return null;
    const box = scroller.getBoundingClientRect();
    const line = header.getBoundingClientRect();
    if (!ifHidden || line.top < box.top || line.bottom > box.bottom)
      scroller.scrollTop += line.top - box.top;
    return scroller.scrollTop;
  }

  // ---- Place-detail accordion (single-open) ----
  function isAudOpen(id: string) {
    return openAuditions.value.has(id);
  }

  // True only while ANOTHER audition is being closed to open this one — that
  // collapse is incidental to the click, so it drops in one step instead of
  // tweening (see ExpandTransition's `instantLeave`). A plain close still animates.
  const audSwapping = ref(false);

  async function toggleAud(id: string) {
    const was = openAuditions.value.has(id);
    // Single-open: opening an audition closes the current one in the SAME tick.
    // When the one closing sits ABOVE the one clicked, its body collapsing removes
    // that height from above and drags the clicked header up with it — and these
    // bodies run to thousands of pixels, so the audition just opened does not
    // merely shift, it lands off the top of the panel entirely.
    //
    // So the outgoing body collapses in ONE step (`instantLeave`) rather than
    // tweening, and the scroll is then corrected once to leave the clicked header
    // exactly where the pointer found it. Nothing else moves it afterwards: the
    // content above is settled, and the body now opening grows BELOW it.
    audSwapping.value = !was && openAuditions.value.size > 0;

    const scroller = panelListEl.value;
    const header = scroller?.querySelector<HTMLElement>(`[data-aud="${CSS.escape(id)}"]`) ?? null;
    const keepTop =
      header && scroller
        ? header.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        : null;

    openAuditions.value.clear();
    if (!was) openAuditions.value.add(id);
    if (listMode.value) {
      // In the results each audition has a lieu of its own: opening one makes it
      // the open lieu (its dot, its text) and the map FLIES there — pulling back
      // and coming down again, so the eye follows from one lieu to the next.
      // Closing it leaves nothing open: the map is free again.
      const canonical = resultAuditions.value.find((a) => a.id === id)?.canonical;
      const unit = !was && canonical ? placeByCanonical.value.get(canonical) : undefined;
      selectedPlaceId.value = unit?.id ?? null;
      if (unit) {
        mapEngaged.value = false;
        nav.placeOpenedAt.value = performance.now();
        spotlightPlace(unit, true);
      }
    } else if (!was && selectedPlace.value) {
      // Choosing an audition to read is a selection in the panel: the map comes
      // back to its lieu, wherever it had been taken meanwhile.
      spotlightPlace(selectedPlace.value);
    }

    await nextTick();
    audSwapping.value = false;
    if (!scroller || !header || keepTop === null) return;
    const drift =
      header.getBoundingClientRect().top - scroller.getBoundingClientRect().top - keepTop;
    if (drift) scroller.scrollTop += drift;
  }

  /** What the reader taking the list in hand looks like. */
  const HANDS_ON = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

  /**
   * Keeps an audition's line at the top of the list while its text unfolds
   * beneath it: a line near the end of the list only has enough below it to be
   * scrolled up to the top once that text is there. Re-pinned each time the audition grows, until a
   * moment after its text is in. The reader taking the list in hand ends it at
   * once: the list is theirs. (Not "has its scroll position moved?": the browser
   * nudges it by itself as content grows at the bottom.)
   */
  function keepAtTop(audition: PanelAudition) {
    const scroller = panelListEl.value;
    const group = scroller?.querySelector(`[data-aud="${CSS.escape(audition.id)}"]`)?.parentElement;
    if (!scroller || !group || typeof ResizeObserver === "undefined") return;
    let timer = 0;
    const observer = new ResizeObserver(() => {
      if (isAudOpen(audition.id)) audToTop(audition.id);
    });
    const end = () => {
      observer.disconnect();
      stopWaiting();
      window.clearTimeout(timer);
      for (const type of HANDS_ON) scroller.removeEventListener(type, end);
    };
    // Its text is in (or it was closed): the unfold takes under half a second.
    const stopWaiting = watch(
      () => !isAudOpen(audition.id) || testimoniesOf(audition) !== null,
      (done) => {
        if (!done) return;
        window.clearTimeout(timer);
        timer = window.setTimeout(end, 1200);
      },
      { immediate: true },
    );
    for (const type of HANDS_ON) scroller.addEventListener(type, end, { passive: true });
    observer.observe(group);
  }

  return {
    resultAuditions,
    shownCount,
    moreResults,
    showMoreResults,
    panelAuditions,
    auditionMeta,
    isAudOpen,
    audSwapping,
    toggleAud,
    audToTop,
    keepAtTop,
  };
}
