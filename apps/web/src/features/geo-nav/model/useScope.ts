// The scope: the unit the viewport is "inside", read off the live view with
// hysteresis, held still while a lieu is read, pinned while a flight is in the
// air; the lieu zone's hysteresis at the bottom of the zoom range; the open
// lieu, the breadcrumb and the list of units the panel shows.
import { computed, watch, type ComputedRef, type Ref, type ShallowRef } from "vue";
import { ancestorsOf, scopeForView, type GeoUnit } from "@/features/geo";
import { perfOn, perfSpan } from "@/shared/perf/perf";
import type { Insets, MapView, NavState } from "../navState";
import type { CommuneGeo } from "../data/useCommuneGeo";

export interface ScopeInputs {
  nav: NavState;
  root: ComputedRef<GeoUnit>;
  index: ComputedRef<Map<string, GeoUnit>>;
  /** The commune contours: a derivation runs again when one arrives. */
  communeGeo: ShallowRef<Record<string, CommuneGeo>>;
  containsPoint: (u: GeoUnit, lat: number, lng: number) => boolean;
  isDesktop: Ref<boolean>;
  /** The layout a view must have been measured in to count: the view's
   *  padding when there is one, else the camera's (read when a view lands —
   *  the layout composables are set up after the scope). */
  mapInsets: () => Insets;
}

export function useScope(inputs: ScopeInputs) {
  const { nav, root, index, communeGeo, containsPoint, isDesktop, mapInsets } = inputs;
  const { currentScope, selectedPlaceId, mapEngaged, sheetOpen, inMicroZone, mapView } = nav;

  /** A lieu is open and the reader is on the panel: the map is not being used. */
  function readingPlace(): boolean {
    if (!selectedPlaceId.value) return false;
    return isDesktop.value ? !mapEngaged.value : sheetOpen.value;
  }
  function deriveScope() {
    if (nav.scopePinned.value) return;
    // While a lieu is being READ the map's scope holds still: the views that
    // arrive then are not the user's doing (the panel changing size, the sheet
    // rising over the map), and following them would raise and sink the plateau
    // behind the text. A view the user IS still making — the map gliding on after
    // a fling while they are already back on the text — is followed to its rest.
    // The panel and the breadcrumb, which show the lieu, do not depend on any of it.
    if (readingPlace() && !mapView.value?.byUser) return;
    if (!mapView.value) {
      currentScope.value = root.value;
      return;
    }
    // A view measured inside another layout than the one on screen now (the panel
    // has just folded or unfolded, the sheet has just moved) says nothing about
    // what is in sight: the map sends a fresh one right behind it.
    const want = mapInsets();
    const got = mapView.value.insets;
    if (
      got.top !== want.top ||
      got.bottom !== want.bottom ||
      got.left !== want.left ||
      got.right !== want.right
    ) {
      return;
    }
    // The current scope's ancestor chain (self included) = the incumbent branch,
    // held sticky in the walk (horizontal + vertical hysteresis — see scopeForView).
    const end = perfOn ? perfSpan("vue.deriveScope") : null;
    const prefer = new Set(ancestorsOf(index.value, currentScope.value.id).map((u) => u.id));
    currentScope.value = scopeForView(root.value, mapView.value.bounds, prefer, containsPoint);
    if (end) end();
  }
  // Re-derive when the map settles, the hierarchy reloads, OR a commune polygon
  // arrives (so the containment tie-break applies once the geometry is in).
  watch([mapView, root, communeGeo], deriveScope);

  // A NEW hierarchy (data reload, or the user changing a filter) leaves
  // `currentScope` / `selectedPlaceId` pointing at nodes from the PREVIOUS tree —
  // stale objects carrying stale counts. deriveScope alone cannot repair that: it
  // early-returns while the camera is pinned or a lieu is being read, so the panel
  // would keep rendering the old tree until the next map gesture. Re-resolve the same
  // ids against the fresh index instead (falling back to the nearest surviving
  // ancestor, then the root) so a filter takes effect immediately.
  watch(index, (idx) => {
    const place = selectedPlaceId.value;
    if (place && !idx.has(place)) selectedPlaceId.value = null;
    const cur = currentScope.value;
    const fresh = idx.get(cur.id);
    if (fresh) {
      if (fresh !== cur) currentScope.value = fresh;
      return;
    }
    // The scope itself vanished from the filtered tree — walk up its ancestors.
    for (let i = cur.ancestors.length - 1; i >= 0; i--) {
      const up = idx.get(cur.ancestors[i]);
      if (up) {
        currentScope.value = up;
        return;
      }
    }
    currentScope.value = root.value;
  });
  const selectedPlace = computed(() =>
    selectedPlaceId.value ? (index.value.get(selectedPlaceId.value) ?? null) : null,
  );
  // The trail ends at the OPEN lieu when there is one (Monde › … › Lyon 3e ›
  // Part-Dieu) — the micropin's location is part of the list of locations.
  const breadcrumb = computed(() =>
    ancestorsOf(index.value, (selectedPlace.value ?? currentScope.value).id),
  );

  // The list of units the panel shows = the scope's children.
  const panelUnits = computed<GeoUnit[]>(() => currentScope.value.children);

  // Lower bound of the micropin zone (see below). It used to be where unzooming
  // CLOSED the open lieu; nothing the map does closes it any more.
  const MICRO_ZONE_EXIT = 14.5;

  // Deep-zoom "micropin zone", ALSO reachable by just zooming in (no lieu click):
  // crossing ~15 inward sinks the plateau (animated teardown) and drops the
  // boundaries — the map flattens to lieu dots. It re-arms below MICRO_ZONE_EXIT;
  // the 14.5–15 gap is hysteresis so jitter at the line doesn't pump the
  // plateau up and down.
  const MICRO_ZONE_ENTER = 15;

  function onViewChange(view: MapView) {
    nav.scopePinned.value = false; // the flight landed (or the user moved) — the view is fresh
    // The zone tracks EVERY emit (pinned included — a spotlight landing inside
    // it must flatten the map exactly like a manual zoom would).
    if (view.zoom >= MICRO_ZONE_ENTER) inMicroZone.value = true;
    else if (view.zoom < MICRO_ZONE_EXIT) inMicroZone.value = false;
    mapView.value = view;
  }

  return { readingPlace, deriveScope, onViewChange, selectedPlace, breadcrumb, panelUnits };
}

export type Scope = ReturnType<typeof useScope>;
