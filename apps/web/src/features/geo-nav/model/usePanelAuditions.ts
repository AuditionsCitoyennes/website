// The auditions the panel lists and how they are read: the open lieu's own, or
// — filters on — every audition that matches, a page at a time as the reader
// scrolls; the single-open accordion; the list's scroll kept where the
// reader's eye is while an audition opens or the results change. From the
// server's lists (map phase 1, PR K: data/useServerLists).
import { computed, nextTick, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from "vue";
import { formatDateShort } from "@/shared/format/dates";
import { placeLabel, type GeoUnit } from "@/features/geo";
import type { NavState } from "../navState";
import type { ServerLists } from "../data/useServerLists";
import {
  lieuListOrder,
  serverPanelAudition,
  testimoniesOf,
  type AuditionSort,
  type PanelAudition,
} from "./auditions";
import type { LieuAuditionsKnown } from "./lieuSingle";

/** How long a lieu opened from its pin waits for its list before its top
 *  opens (openTopWhenListed): past it, the list shows as it is. */
const LIST_WAIT_MS = 3000;

export interface PanelAuditionsInputs {
  nav: NavState;
  sort: Ref<AuditionSort | undefined>;
  /** Filters are on: the panel lists EVERY audition that matches, in one list. */
  listMode: ComputedRef<boolean>;
  selectedPlace: ComputedRef<GeoUnit | null>;
  /** Every unit by id: an audition's lieu is found by its id (placeId). */
  index: ComputedRef<Map<string, GeoUnit>>;
  /** The list's scroller (`.panel-list`, GeoPanel's). */
  panelListEl: Ref<HTMLElement | null>;
  /** The "more results" sentinel at the end of the list (AuditionList's). */
  moreEl: Ref<HTMLElement | null>;
  /** Flies the map onto a lieu — along an arc when asked, for a hop from
   *  another lieu (the camera's spotlightPlace). */
  spotlightPlace: (unit: GeoUnit, arc?: boolean) => void;
  /** Frames the visitor's country once the filters' answer has stopped
   *  changing (the camera's). */
  scheduleFilterFrame: () => void;
  /** The end of the open audition's testimonies (AuditionList's): the next
   *  page comes as it nears the bottom. */
  moreTestimoniesEl?: Ref<HTMLElement | null>;
  /** The server's lists: the panel lists from them (map phase 1, PR K). */
  server: ServerLists;
}

export function usePanelAuditions(inputs: PanelAuditionsInputs) {
  const {
    nav,
    sort,
    listMode,
    selectedPlace,
    index,
    panelListEl,
    moreEl,
    spotlightPlace,
    scheduleFilterFrame,
    server,
  } = inputs;
  const { selectedPlaceId, openAuditions, mapEngaged } = nav;

  // The open lieu's auditions: listed at once from what the map already knows of
  // them (title, date, how many testimonies) — its row's own list, embedded; on
  // the lazy path, asked for.
  const placeAuditions = computed<PanelAudition[]>(() => {
    const place = selectedPlace.value;
    if (!place) return [];
    const lieu = { id: place.id, canonical: place.canonical ?? place.label };
    return lieuListOrder(
      server.placeList.value.rows.map((a) =>
        serverPanelAudition(a, lieu, server.testimoniesFor(a.id)),
      ),
      sort.value,
    );
  });

  /** What is known of a lieu's auditions the moment it is opened, before its
   *  list is on screen (model/lieuSingle): the server's tree row. */
  function lieuAuditionsOf(unit: GeoUnit): LieuAuditionsKnown | null {
    return server.lieuAuditionsKnown(unit.id);
  }

  // The server's, in its order: the pages loaded.
  const resultAuditions = computed<PanelAudition[]>(() => {
    if (!listMode.value) return [];
    return server.resultRows.value.map((a) =>
      serverPanelAudition(
        a,
        { id: a.lieu.id, canonical: a.lieu.key, lieu: a.lieu },
        server.testimoniesFor(a.id),
      ),
    );
  });

  // Many auditions can match a wide filter: the list is filled a page at a time
  // as the reader scrolls down it, a page asked for at a time.
  const moreResults = computed(() => server.moreResults.value);
  function showMoreResults() {
    server.loadMoreResults();
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
  /** Looked at again once a page is in: still in sight (a tall panel, a short
   *  page), the sentinel asks for the next — an observer says nothing while
   *  what it watches stays in sight (the server's pages: they come later). */
  function lookAgain(observer: IntersectionObserver | null, el: HTMLElement | null) {
    if (!observer || !el) return;
    observer.unobserve(el);
    observer.observe(el);
  }
  watch(
    () => server.resultRows.value.length,
    () => void nextTick(() => lookAgain(moreObserver, moreEl.value)),
  );

  /** The auditions the panel shows: the results, or the open lieu's own. */
  const panelAuditions = computed<PanelAudition[]>(() =>
    listMode.value ? resultAuditions.value : placeAuditions.value,
  );

  /** How many auditions match (the results' heading): the server's total. */
  const resultCount = computed(() => server.resultsTotal.value?.auditions ?? 0);

  /** An audition's lieu in the tree on screen, by its id. A result's lieu the
   *  tree does not hold yet (the server's lazy path) is put in it then. */
  function lieuUnitOf(a: PanelAudition): GeoUnit | undefined {
    const known = a.placeId ? index.value.get(a.placeId) : undefined;
    if (known || !a.lieu) return known;
    return server.addStub(a.lieu) ? index.value.get(a.lieu.id) : undefined;
  }

  /** Date, and in the results the lieu too (a lieu's own detail has it as title). */
  function auditionMeta(a: PanelAudition): string {
    let place = "";
    if (listMode.value) {
      const unit = a.placeId ? index.value.get(a.placeId) : undefined;
      place = unit?.label ?? (a.lieu ? placeLabel(a.lieu.key, a.lieu.city) : a.canonical);
    }
    return [a.date ? formatDateShort(a.date) : "", place].filter(Boolean).join(" · ");
  }

  // A new list of results (a new key, order or first page — never a page
  // appended) is read from its top; a new SET of results frames the visitor's
  // country again.
  const resultsSig = computed(() => (listMode.value ? server.resultsSig.value : ""));
  /** Which auditions match, whatever their order: sorting is not a new answer. */
  const resultSetSig = computed(() => (listMode.value ? server.resultSetSig.value : ""));
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
    if (open && at !== -1) {
      // Still read (the server's answer was read as far as it before it came
      // on screen), its lieu stays the open one: the lazy path's new tree may
      // not hold it yet.
      const unit = lieuUnitOf(resultAuditions.value[at]);
      if (unit && selectedPlaceId.value !== unit.id) selectedPlaceId.value = unit.id;
    }
    // The audition being read no longer matches the filters — unless the
    // server could not say (its read failed): it stays open, rather than
    // closed on a guess.
    if (open && at === -1 && server.unknownOpen() !== open) {
      openAuditions.value.clear();
      selectedPlaceId.value = null;
    }
    // A new list is read from its top; the audition being read stays in sight
    // wherever the new order has put it.
    if (at === -1) {
      if (panelListEl.value) panelListEl.value.scrollTop = 0;
    } else if (open) {
      void nextTick(() => audToTop(open, true));
    }
  });
  watch(resultSetSig, (sig) => {
    if (sig) scheduleFilterFrame();
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

  /** `aim`: the map comes back to the lieu (below) — false from a lieu being
   *  opened with its audition (useNavActions' openPlace), whose own camera
   *  command follows. */
  async function toggleAud(id: string, aim = true) {
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
      const listed = resultAuditions.value.find((a) => a.id === id);
      const unit = !was && listed ? lieuUnitOf(listed) : undefined;
      selectedPlaceId.value = unit?.id ?? null;
      if (unit) {
        mapEngaged.value = false;
        nav.placeOpenedAt.value = performance.now();
        spotlightPlace(unit, true);
      }
    } else if (!was && aim && selectedPlace.value) {
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

  /** The list back at its top: a lieu newly opened with its audition open
   *  (useNavActions' openPlace) is read from its title, wherever the list
   *  before it had been scrolled to. */
  function listToTop() {
    if (panelListEl.value) panelListEl.value.scrollTop = 0;
  }

  /**
   * The keys to an audition's line (its button) once it is listed — the
   * server's list of a lieu may still be on its way: a lieu opened from the
   * keys with its one audition open (useNavActions' openPlace). `wanted`: the
   * move still makes sense when the line shows (the same lieu, the audition
   * open, the keys not taken elsewhere meanwhile); not wanted, nothing moves
   * and nothing waits any longer.
   */
  function focusAudWhenListed(id: string, wanted: () => boolean) {
    const tryFocus = () => {
      if (!wanted()) return true;
      const header = panelListEl.value?.querySelector<HTMLElement>(
        `[data-aud="${CSS.escape(id)}"]`,
      );
      if (!header) return false;
      header.focus({ preventScroll: true });
      return true;
    };
    if (tryFocus()) return;
    const stop = watch(
      panelAuditions,
      () => {
        if (tryFocus()) stop();
      },
      { flush: "post" },
    );
  }

  /**
   * The top of the open lieu's list opened once the server has listed it — a
   * lieu of several auditions opened from its pin while its list is not in
   * the tree (the server's lazy path: useNavActions' openPlace). Opened as a
   * press on that line opens it: the map comes back to the lieu. `wanted`: the
   * move still makes sense (the same lieu, nothing opened meanwhile, the map
   * not taken in hand); not wanted, the list failed or slow (LIST_WAIT_MS),
   * the lieu's list stays as it is and nothing waits any longer. Never one
   * audition and then another: nothing is open before.
   */
  function openTopWhenListed(lieuId: string, wanted: () => boolean, opened?: (id: string) => void) {
    let over = false;
    let stop: (() => void) | null = null;
    const end = () => {
      over = true;
      window.clearTimeout(timer);
      stop?.();
    };
    const timer = window.setTimeout(end, LIST_WAIT_MS);
    stop = watch(
      () => ({
        ok: selectedPlaceId.value === lieuId && wanted() && !placeFailed.value,
        top: placeAuditions.value[0]?.id ?? null,
      }),
      ({ ok, top }) => {
        if (over) return;
        if (!ok) return end();
        if (!top) return;
        end();
        listToTop();
        void toggleAud(top).then(() => opened?.(top));
      },
      { flush: "post" },
    );
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
    // Read off the line listed now: the server's testimonies come after it opens.
    const stopWaiting = watch(
      () =>
        !isAudOpen(audition.id) ||
        testimoniesOf(panelAuditions.value.find((a) => a.id === audition.id) ?? audition) !== null,
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

  // The open audition's next testimonies, as the end of its text nears the
  // bottom of the panel.
  const moreTestimoniesEl = inputs.moreTestimoniesEl;
  if (moreTestimoniesEl) {
    let observer: IntersectionObserver | null = null;
    watch(moreTestimoniesEl, (el) => {
      observer?.disconnect();
      observer = null;
      if (!el || typeof IntersectionObserver === "undefined") return;
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) server.loadMoreTestimonies();
        },
        { root: panelListEl.value, rootMargin: "200px" },
      );
      observer.observe(el);
    });
    watch(
      () => server.openTestimonies.value,
      () => void nextTick(() => lookAgain(observer, moreTestimoniesEl.value)),
    );
    onBeforeUnmount(() => observer?.disconnect());
  }
  function showMoreTestimonies() {
    server.loadMoreTestimonies();
  }

  /** The open lieu's auditions are on their way (the server's lazy path). */
  const placeLoading = computed(() => !listMode.value && server.placeList.value.loading);
  /** The open lieu's auditions could not be had (the same). */
  const placeFailed = computed(() => !listMode.value && server.placeList.value.failed);

  /**
   * Where a lieu's first audition sits in the results, asked of the server
   * when the pages loaded do not hold it (its first, by /api/places/lieu, then
   * the results as far as it, results?through=); -1: not there, the server
   * could not say, or the results changed meanwhile.
   */
  async function findResultFurther(unit: GeoUnit): Promise<number> {
    const sig = server.resultsSig.value;
    const first = await server.firstAuditionAt(unit.id);
    if (!first || !listMode.value || server.resultsSig.value !== sig) return -1;
    const found = await server.loadThrough(first);
    if (found !== "found" || !listMode.value || server.resultsSig.value !== sig) return -1;
    return resultAuditions.value.findIndex((a) => a.id === first);
  }

  return {
    resultAuditions,
    resultCount,
    moreResults,
    showMoreResults,
    showMoreTestimonies,
    placeLoading,
    placeFailed,
    findResultFurther,
    panelAuditions,
    auditionMeta,
    isAudOpen,
    audSwapping,
    toggleAud,
    audToTop,
    keepAtTop,
    listToTop,
    focusAudWhenListed,
    openTopWhenListed,
    lieuAuditionsOf,
  };
}
