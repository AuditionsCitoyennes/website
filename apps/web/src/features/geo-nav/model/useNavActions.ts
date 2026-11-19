// Actions (pins, rows, breadcrumb all fly the map; the scope follows): a unit
// activated from the panel, a click on the map, a crumb, a lieu opened, a
// result's lieu asked for from its dot.
import { nextTick, type ComputedRef, type Ref } from "vue";
import type { GeoUnit } from "@/features/geo";
import { perfBegin, perfOn } from "@/shared/perf/perf";
import { perfTapAnswered, perfTapTargets } from "@/shared/perf/tapAnswer";
import type { NavState } from "../navState";
import type { PanelAudition } from "./auditions";
import { auditionToOpen, type LieuAuditionsKnown } from "./lieuSingle";
import { lieuSingleMode } from "./lieuSingleSwitch";
import type { TapPending } from "./useTapPending";

export interface NavActionsInputs {
  nav: NavState;
  index: ComputedRef<Map<string, GeoUnit>>;
  listMode: ComputedRef<boolean>;
  camera: {
    flyToUnit: (unit: GeoUnit, animate: boolean, fresh?: boolean) => void;
    spotlightPlace: (unit: GeoUnit, arc?: boolean) => void;
  };
  panel: {
    resultAuditions: ComputedRef<PanelAudition[]>;
    shownCount: Ref<number>;
    toggleAud: (id: string, aim?: boolean) => Promise<void>;
    isAudOpen: (id: string) => boolean;
    audToTop: (id: string, ifHidden?: boolean) => number | null;
    keepAtTop: (audition: PanelAudition) => void;
    /** The server's lists: where a lieu's first result sits when the pages
     *  loaded do not hold it (-1: not there); null with the corpus'. */
    findResultFurther: ((unit: GeoUnit) => Promise<number>) | null;
    /** What is known of a lieu's auditions the moment it is opened. */
    lieuAuditionsOf: (unit: GeoUnit) => LieuAuditionsKnown | null;
    /** The panel's list back at its top. */
    listToTop: () => void;
    /** The keys to an audition's line once it is listed, if still `wanted`. */
    focusAudWhenListed: (id: string, wanted: () => boolean) => void;
  };
  /** The user has started moving the map (usePanelLayout's). */
  engageMap: () => void;
  /** The pending state of a tapped territory (useTapPending): a selection is
   *  marked on the map first, then written — at once, or a frame later. */
  tap: Pick<TapPending, "select" | "cancelWaiting">;
}

export function useNavActions(inputs: NavActionsInputs) {
  const { nav, index, listMode, camera, panel, engageMap, tap } = inputs;
  const { currentScope, selectedPlaceId, mapEngaged, sheetOpen, openAuditions, hoveredPanelId } =
    nav;
  const { flyToUnit, spotlightPlace } = camera;
  const { resultAuditions, shownCount, toggleAud, isAudOpen, audToTop, keepAtTop } = panel;
  const { findResultFurther, lieuAuditionsOf, listToTop, focusAudWhenListed } = panel;

  /** The element the keys are on, when it was reached with them (Tab):
   *  a click or a tap focuses no :focus-visible element — the panel's own
   *  rule (usePanelLayout's onPanelFocusIn). */
  function keyFocused(): HTMLElement | null {
    const at = document.activeElement;
    if (!(at instanceof HTMLElement)) return null;
    try {
      return at.matches(":focus-visible") ? at : null;
    } catch {
      return null; // a browser without :focus-visible
    }
  }

  // The perf probes' tap-answer: a panel row is a tap target of its own.
  if (perfOn) perfTapTargets([{ kind: "row", selector: ".unit-row" }]);

  /** The perf probes (shared/perf): a unit selected — its plateau and its
   *  boundaries are timed from here, and the tap that asked for it has its
   *  answer (tap-answer). */
  function selectTimed(unit: GeoUnit, via: string) {
    if (!perfOn) return;
    perfTapAnswered(unit.id, { via, level: unit.levelKey });
    perfBegin("select-plateau", unit.id, { via, level: unit.levelKey });
    perfBegin("drill-boundaries", unit.id, { via, level: unit.levelKey });
  }

  function activate(unit: GeoUnit) {
    if (unit.levelKey === "place") {
      openPlace(unit);
      return;
    }
    selectTimed(unit, "activate");
    // The tapped territory is marked pending first (useTapPending), then the
    // selection is written.
    tap.select(unit, () => {
      selectedPlaceId.value = null;
      // Optimistic scope: don't wait for the camera fit to settle (~700 ms) — set the
      // scope now so the plateau transition runs DURING the flight. The moveend
      // derivation confirms it (hysteresis holds the same unit).
      currentScope.value = unit;
      flyToUnit(unit, true);
    });
  }

  // A click on the MAP: a pin, or anywhere inside a unit's boundary.
  function onUnitClick(id: string) {
    const u = index.value.get(id);
    if (!u) return;
    // With a lieu open only another lieu's dot replaces what the panel shows. A
    // territory is the whole of its surface — clicking it is moving around the
    // map, like a drag: the map goes there, the text stays.
    if (selectedPlaceId.value && u.levelKey !== "place") {
      selectTimed(u, "map");
      tap.select(u, () => {
        engageMap();
        currentScope.value = u; // optimistic — see activate()
        flyToUnit(u, true);
      });
      return;
    }
    activate(u);
  }

  function drillToCrumb(id: string) {
    const u = index.value.get(id);
    if (!u) return;
    // The LAST crumb can be the open lieu itself — a place can never become the
    // scope; re-centre its spotlight instead (useful after panning away).
    if (u.levelKey === "place") {
      openPlace(u);
      return;
    }
    tap.cancelWaiting(); // a tapped territory still waiting for its frame is left
    selectTimed(u, "crumb");
    selectedPlaceId.value = null;
    currentScope.value = u; // optimistic — see activate()
    flyToUnit(u, true);
  }

  // The results are listed and a lieu's dot is clicked on the map: that is asking
  // for its audition — the first of the list held there.
  /** The latest click's: a click whose lookup a later one overtook is dropped. */
  let resultClicks = 0;
  async function openResultAt(unit: GeoUnit) {
    tap.cancelWaiting();
    if (perfOn) perfTapAnswered(unit.id, { via: "result" }); // answered from here (tap-answer)
    hoveredPanelId.value = null;
    // The dot of the lieu whose audition is being read: only bring the map (and
    // the panel) back — whichever of its auditions is open stays unfolded.
    if (selectedPlaceId.value === unit.id && openAuditions.value.size > 0) {
      sheetOpen.value = true;
      mapEngaged.value = false;
      spotlightPlace(unit);
      return;
    }
    const click = ++resultClicks;
    // The corpus' results are all in memory (by the lieu's name); the server's
    // pages loaded may not reach the lieu's (by its id): the server says where.
    let at = findResultFurther
      ? resultAuditions.value.findIndex((a) => a.placeId === unit.id)
      : resultAuditions.value.findIndex((a) => a.canonical === unit.canonical);
    if (at === -1 && findResultFurther) {
      at = await findResultFurther(unit);
      // Another click took over meanwhile; or this audition was opened since
      // (its line pressed): opened, not closed again.
      if (click !== resultClicks) return;
      if (at !== -1 && isAudOpen(resultAuditions.value[at].id)) {
        sheetOpen.value = true;
        mapEngaged.value = false;
        spotlightPlace(unit);
        return;
      }
    }
    if (at === -1 || !listMode.value) return;
    const audition = resultAuditions.value[at];
    if (at >= shownCount.value) shownCount.value = at + 1; // its line may not be listed yet
    sheetOpen.value = true;
    await nextTick();
    await toggleAud(audition.id);
    // Its line goes to the top of the list, the text opening in view beneath it,
    // and stays there while that text unfolds.
    audToTop(audition.id);
    keepAtTop(audition);
  }

  function openPlace(unit: GeoUnit) {
    if (listMode.value) {
      void openResultAt(unit);
      return;
    }
    tap.cancelWaiting();
    // Re-opening the lieu already open (its crumb, its own dot on the map) only
    // brings the map back to it: the audition being read stays unfolded.
    if (perfOn) {
      perfTapAnswered(unit.id, { via: "place" }); // the tap that asked for it has its answer
      perfBegin("lieu-pins", unit.id); // the dots around it placed, timed from here
    }
    const newLieu = selectedPlaceId.value !== unit.id;
    if (newLieu) openAuditions.value.clear();
    selectedPlaceId.value = unit.id;
    // The reader is on the panel — said here too, because the watcher that says
    // it does not run when the lieu was already the open one.
    mapEngaged.value = false;
    sheetOpen.value = true;
    nav.placeOpenedAt.value = performance.now();
    // The row just clicked leaves the panel without a mouseleave; left set, the
    // map would keep deferring to a hover that no longer exists.
    hoveredPanelId.value = null;
    // A lieu of one audition opens with it open (ac:lieu-single, model/lieuSingle):
    // its list would be one line to press. Opened as that line's press opens
    // it, in the same tick — so the camera's one command below aims with the
    // panel as wide as an open audition makes it, and the press's own return
    // to the lieu is that command.
    // The list is read from the lieu's title: the scroll of the list before it
    // (a long text, a long list of lieux) would otherwise carry over, the new
    // content as tall when the audition's testimonies are already in.
    const only = auditionToOpen({
      mode: lieuSingleMode.value,
      newLieu,
      known: newLieu ? lieuAuditionsOf(unit) : null,
    });
    if (only) {
      // Opened from the keys (its dot or its row reached with Tab, then Enter
      // or Space), the keys go on in the panel, on the audition's line — as
      // after a press on that line: the screen reader reads it, open
      // (aria-expanded), and the next Tab stays in the panel instead of
      // landing on dots the wide panel covers. A click or a tap leaves the
      // focus where it is.
      const from = keyFocused();
      listToTop();
      void toggleAud(only, false).then(() => {
        listToTop();
        if (!from) return;
        focusAudWhenListed(only, () => {
          const at = document.activeElement;
          return (
            selectedPlaceId.value === unit.id &&
            isAudOpen(only) &&
            (at === from || at === document.body || at === null)
          );
        });
      });
    }
    spotlightPlace(unit);
  }

  return { activate, onUnitClick, drillToCrumb, openResultAt, openPlace };
}
