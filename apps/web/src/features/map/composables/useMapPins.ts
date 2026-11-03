// The pins: a marker per unit, diffed across updates; the hit rings the hover
// and the click test against; the hovered unit (the pointer's, or the panel's
// through `hoveredId`); the macro pills anchored on their unit's visible
// territory (updateSticky) and shown while hovered; the pins hidden under the
// analyses' slabs. Hot paths (onMapHover, updateSticky) allocate nothing.

import mapboxgl from "mapbox-gl";
import { lngNear, type Bounds } from "@/features/geo";
import { perfEnd, perfOn, perfSpan } from "@/shared/perf/perf";
import {
  boundsIntersect,
  buildHitRings,
  hitTest,
  interiorInView,
  toLngLat,
  type HitRing,
  type InteriorHit,
} from "../lib/polygon";
import type { PlateauWallLayer } from "../gl/PlateauWallLayer";
import type { MapUnit } from "../types";
import type { useSlabOcclusion } from "./useSlabOcclusion";

export interface MapPinsInputs {
  getMap: () => mapboxgl.Map | null;
  /** The units to plot (the `units` prop). */
  units: () => MapUnit[];
  /** Unit hovered OUTSIDE the map, a panel row (`hoveredId`): it owns the hover. */
  hoveredId: () => string | null | undefined;
  /** The lieu being read (`activeId`): its pin wears the pulsing halo. */
  activeId: () => string | null | undefined;
  /** The plateau's layer: the hovered unit's GL sweep. */
  wall: PlateauWallLayer;
  /** Whether a plateau is standing (the draped hover fill is the fallback without one). */
  plateauActive: () => boolean;
  /** `screenBounds` pulled in by a margin (useMapView): where the pills may stand. */
  screenBoundsInset: (margin: number) => Bounds | null;
  /** What the slabs hide (useSlabOcclusion). */
  occlusion: ReturnType<typeof useSlabOcclusion>;
  /** A unit was clicked (its pin, or inside its boundary): the `unitClick` emit. */
  onUnitClick: (id: string) => void;
  /** Of two units holding a point, the smaller box is hit (the outline files:
   *  their coarse France covers Monaco); otherwise the first in `units`. */
  smallerWins?: () => boolean;
}

export function useMapPins({
  getMap,
  units,
  hoveredId,
  activeId,
  wall: plateauWall,
  plateauActive,
  screenBoundsInset,
  occlusion,
  onUnitClick,
  smallerWins,
}: MapPinsInputs) {
  const { slabsOnScreen, onSlab, slabDotBoxes, mayBeUnderSlab } = occlusion;

  // Markers are keyed by unit id and DIFFED across updates. The view is emitted
  // ~4×/s while a gesture is in flight, and a pan usually changes only a handful
  // of units at the edges — tearing every pin's DOM down and rebuilding it on each
  // emit is what made panning crawl once the imported lieux landed.
  interface MarkerEntry {
    marker: mapboxgl.Marker;
    el: HTMLElement;
    sig: string; // what makePin baked in — rebuild only when this changes
    lng: number;
    lat: number;
    // A pill's half size as laid out, read once needed (hidePinsUnderSlabs): 0
    // until then, while it can't be (not laid out) and after a resize — its
    // label's size follows the viewport's width (the type scale).
    halfW: number;
    halfH: number;
  }
  let markerById = new Map<string, MarkerEntry>();
  // Hit rings cost a pass over every polygon ring, so cache them per unit and
  // rebuild only when the geometry object itself changes.
  const hitById = new Map<string, { geometry: unknown; hit: HitRing[] }>();
  let sticky: {
    marker: mapboxgl.Marker;
    el: HTMLElement;
    lngLat: [number, number];
    bounds?: Bounds;
    geometry?: unknown;
    hit?: HitRing[];
    id: string;
    onScreen: boolean; // cached by updateSticky — hover toggles reuse it
  }[] = [];
  // The macro pin under the cursor's unit (hover reveals pins hidden for lack of
  // room; clicking inside a unit's boundaries selects it). `pinHoveredId` tracks
  // the cursor sitting on a pin ELEMENT — DOM-wise that's outside the canvas, so
  // the map fires mouseout and would otherwise clear the hover and hide the pin
  // under the cursor (a flicker loop).
  let hoveredUnitId = "";
  let pinHoveredId = "";
  // The pin currently wearing `.geo-pin-active` (props.activeId, once applied).
  let activePinId = "";

  function makePin(unit: MapUnit): HTMLElement {
    const root = document.createElement("button");
    root.type = "button";
    root.addEventListener("click", (e) => {
      e.stopPropagation();
      onUnitClick(unit.id);
    });
    // A double-click on a pin is the same selection twice — not the map's
    // double-click zoom, which would also count as the user taking the camera.
    root.addEventListener("dblclick", (e) => e.stopPropagation());

    // Lieu (leaf): the original flat ground dot (.marker-dot "point au sol"), no label.
    if (unit.isLeaf) {
      root.className = "geo-pin geo-pin-leaf";
      return root;
    }

    // Aggregated unit: a uniform outlined pill with just the name (no count).
    root.className = "geo-pin";
    const bubble = document.createElement("span");
    bubble.className = "geo-pin-bubble";
    const lab = document.createElement("span");
    lab.className = "geo-pin-name";
    lab.textContent = unit.label;
    bubble.appendChild(lab);
    root.appendChild(bubble);
    return root;
  }

  function clearMarkers() {
    for (const e of markerById.values()) e.marker.remove();
    markerById.clear();
    hitById.clear();
    wholeShapeInterior.clear();
    sticky = [];
  }

  /** What makePin renders — a pin is reusable as long as this is unchanged. */
  function pinSignature(unit: MapUnit): string {
    return unit.isLeaf ? "leaf" : `pill:${unit.label}`;
  }

  /** Hit rings for a macro unit, reusing the cached pass when geometry is same. */
  function hitRingsFor(unit: MapUnit): HitRing[] | undefined {
    if (!unit.geometry) return undefined;
    const cached = hitById.get(unit.id);
    if (cached && cached.geometry === unit.geometry) return cached.hit;
    const hit = buildHitRings(unit.geometry);
    hitById.set(unit.id, { geometry: unit.geometry, hit });
    return hit;
  }

  function buildMarkers() {
    const map = getMap();
    if (!map) return;
    const end = perfOn ? perfSpan("pins.buildMarkers") : null;
    // Anything still in `stale` once we've walked the new units has left the view.
    const stale = markerById;
    const next = new Map<string, MarkerEntry>();
    const wasOnScreen = new Map(sticky.map((s) => [s.id, s.onScreen]));
    const nextSticky: typeof sticky = [];

    for (const unit of units()) {
      const [lng, lat] = toLngLat(unit.center);
      const sig = pinSignature(unit);
      let entry = stale.get(unit.id);

      if (entry && entry.sig === sig) {
        // Survivor: keep its DOM node and listeners, just move it if it shifted.
        stale.delete(unit.id);
        if (entry.lng !== lng || entry.lat !== lat) {
          entry.marker.setLngLat([lng, lat]);
          entry.lng = lng;
          entry.lat = lat;
        }
      } else {
        if (entry) {
          entry.marker.remove();
          stale.delete(unit.id);
        }
        // Lieu dots lie flat on the ground (tilt with the map), centred on the
        // point; aggregated pills stay billboard (face the camera) like UI chips.
        const el = makePin(unit);
        const opts: mapboxgl.MarkerOptions = unit.isLeaf
          ? { element: el, pitchAlignment: "map", rotationAlignment: "map" }
          : { element: el };
        const marker = new mapboxgl.Marker(opts).setLngLat([lng, lat]).addTo(map);
        entry = { marker, el, sig, lng, lat, halfW: 0, halfH: 0 };
        if (!unit.isLeaf) {
          // The pin element sits ABOVE the canvas: hovering it fires the canvas
          // mouseout, which must not clear the hover that revealed this very pin.
          el.addEventListener("mouseenter", () => {
            pinHoveredId = unit.id;
            setHover(unit.id);
          });
          el.addEventListener("mouseleave", (e) => {
            pinHoveredId = "";
            // Back onto the map → the next mousemove takes over seamlessly; out of
            // the map entirely → clear now.
            const to = (e as MouseEvent).relatedTarget as Node | null;
            const m = getMap();
            if (!m || !to || !m.getContainer().contains(to)) setHover("");
          });
        }
      }

      next.set(unit.id, entry);
      // Macro pins (pills) follow their unit's visible territory; they show only
      // when their boundary has clear room for the pill (or on hover — see
      // updateSticky), and clicking anywhere inside the boundary selects the unit.
      if (!unit.isLeaf) {
        nextSticky.push({
          marker: entry.marker,
          el: entry.el,
          lngLat: [lng, lat],
          bounds: unit.bounds,
          geometry: unit.geometry,
          hit: hitRingsFor(unit),
          id: unit.id,
          // Keep the cached visibility so a surviving pill doesn't flicker.
          onScreen: wasOnScreen.get(unit.id) ?? false,
        });
      }
    }

    for (const e of stale.values()) e.marker.remove();
    for (const id of hitById.keys()) if (!next.has(id)) hitById.delete(id);
    for (const id of wholeShapeInterior.keys()) if (!next.has(id)) wholeShapeInterior.delete(id);
    markerById = next;
    sticky = nextSticky;
    updateSticky();
    applyActivePin(); // a rebuilt pin is a fresh element — re-mark it
    if (end) {
      const all = units();
      const leaves = all.filter((u) => u.isLeaf).length;
      end({ pins: all.length, leaves });
      // Every pin a dot: the lieux around an open one, placed (the micro zone).
      if (leaves && leaves === all.length) perfEnd("lieu-pins", undefined, { pins: all.length });
    }
  }

  /** Move `.geo-pin-active` (the pulsing halo, styled in features/map/geo-pins.css) onto the pin
   *  of the lieu being read. */
  function applyActivePin() {
    const id = activeId() ?? "";
    if (id !== activePinId) markerById.get(activePinId)?.el.classList.remove("geo-pin-active");
    activePinId = id;
    if (id) markerById.get(id)?.el.classList.add("geo-pin-active");
  }

  const STICKY_MARGIN = 28; // keep pins this far inside the visible edge

  // Re-centre each macro pin on the centre of its unit's VISIBLE part, so the pin
  // follows the on-screen territory as you pan. A pin shows only when its unit's
  // visible interior has clear ROOM for the pill (so labels never sprawl over
  // neighbours), or while the cursor hovers inside the unit's boundary — clicking
  // inside the boundary selects the unit, pin or no pin. Throttled to one run per
  // animation frame (move can fire several times a frame) to stay smooth.
  // When a unit is entirely inside the view, clamping does nothing, so its
  // interior point is a property of the SHAPE alone — constant while it stays
  // fully visible. Cache it per unit instead of re-scanning every polygon vertex.
  const wholeShapeInterior = new Map<string, { geometry: unknown; hit: InteriorHit }>();

  function interiorWhenFullyVisible(s: (typeof sticky)[number]): InteriorHit | null {
    const cached = wholeShapeInterior.get(s.id);
    if (cached && cached.geometry === s.geometry) return cached.hit;
    const hit = interiorInView(s.geometry, s.bounds!, s.bounds!);
    if (hit) wholeShapeInterior.set(s.id, { geometry: s.geometry, hit });
    return hit;
  }

  function updateSticky() {
    if (!getMap()) return;
    const view = sticky.length ? screenBoundsInset(STICKY_MARGIN) : null;
    if (view) {
      for (const s of sticky) {
        let hit: InteriorHit | null = null;
        // applyPinVisibility only ever shows the HOVERED pill, so recomputing an
        // interior point (a scanline pass over the unit's polygon) + setLngLat for
        // every other sticky entry moved markers nobody can see — pure cost on every
        // sticky pass, growing with the number of units on screen.
        const couldBeVisible = s.id === hoveredUnitId;
        if (couldBeVisible && s.geometry && s.bounds && boundsIntersect(s.bounds, view)) {
          const b = s.bounds;
          const fullyVisible =
            b.minLat >= view.minLat &&
            b.maxLat <= view.maxLat &&
            b.minLng >= view.minLng &&
            b.maxLng <= view.maxLng;
          hit = fullyVisible ? interiorWhenFullyVisible(s) : interiorInView(s.geometry, b, view);
        }
        s.onScreen = !!hit;
        applyPinVisibility(s);
        if (hit) s.marker.setLngLat(hit.pt);
      }
    }
    // The lieu dots too, which no sticky entry holds.
    hidePinsUnderSlabs();
  }

  // Visibility from CACHED state — hover enter/leave calls this for the two
  // affected pins only. Macro pins are HOVER-ONLY: the territory is the visible
  // UI (boundaries + highlight), the pill appears as its label while pointed at.
  function applyPinVisibility(s: (typeof sticky)[number]) {
    s.el.style.visibility =
      s.onScreen && hoveredUnitId === s.id && !pinsUnderSlab.has(s.id) ? "" : "hidden";
  }

  // ---- Pins under the analyses' slabs -------------------------------------------
  // A pin is HTML over the canvas: one drawn on a slab's piece (see
  // slabsOnScreen) would show over it, and a click on it would pick its unit
  // through the piece — nothing is picked there (unitAt). Such a pin is hidden
  // (`visibility`, which the pointer passes through too; mapbox writes its fade
  // into `opacity` and `pointer-events`), each time the pins or the slabs
  // change: every sticky pass, a hover, the slabs built or gone.
  let pinsUnderSlab = new Set<string>();
  /** How far above its point a hovered pill is drawn: geo-pins.css,
   *  `.geo-pin-hover .geo-pin-bubble { transform: translateY(-32px) }` — keep
   *  the two in step. */
  const PILL_LIFT_PX = 32;
  /** A lieu dot's radius: geo-pins.css, `.geo-pin-leaf` (16 px, border-box). */
  const DOT_RADIUS_PX = 8;
  /** Around a pin's centre, the points looked at too (× its half-size): a
   *  pill's corners, a dot's rim across and along. */
  const PILL_CORNERS = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const;
  const DOT_RIM = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const;

  /** Whether a pin drawn around (x, y) is on a piece slabsOnScreen found: its
   *  centre, or any of `pts` (× `hw`, `hh`) off it. */
  function pinOnSlab(
    x: number,
    y: number,
    hw: number,
    hh: number,
    pts: typeof PILL_CORNERS | typeof DOT_RIM,
  ): boolean {
    if (onSlab(x, y)) return true;
    for (const [u, v] of pts) if (onSlab(x + u * hw, y + v * hh)) return true;
    return false;
  }

  /** Hide the pins drawn on a slab now, and show again those no longer there.
   *  Their points are where mapbox places them (map.project). A pill shows only
   *  while hovered (applyPinVisibility): only that one is looked at, its boxes
   *  as drawn — the bubble's, lifted, and the marker's own at its point. The
   *  dots may be many: only those standing where a slab can be drawn over them
   *  (slabDotBoxes) are projected at all. */
  function hidePinsUnderSlabs() {
    const map = getMap();
    if (!map) return;
    const was = pinsUnderSlab;
    const now = new Set<string>();
    if (slabsOnScreen()) {
      const boxes = slabDotBoxes(DOT_RADIUS_PX);
      for (const [id, e] of markerById) {
        const dot = e.sig === "leaf";
        if (dot ? !mayBeUnderSlab(boxes, e.lng, e.lat) : id !== hoveredUnitId) continue;
        const p = map.project(e.marker.getLngLat());
        let on: boolean;
        if (dot) on = pinOnSlab(p.x, p.y, DOT_RADIUS_PX, DOT_RADIUS_PX, DOT_RIM);
        else {
          e.halfW ||= e.el.offsetWidth / 2;
          e.halfH ||= e.el.offsetHeight / 2;
          // The marker's own box is transparent, but takes the pointer too.
          on =
            pinOnSlab(p.x, p.y - PILL_LIFT_PX, e.halfW, e.halfH, PILL_CORNERS) ||
            pinOnSlab(p.x, p.y, e.halfW, e.halfH, PILL_CORNERS);
        }
        if (on) now.add(id);
      }
    }
    if (!now.size && !was.size) return;
    pinsUnderSlab = now;
    // Every pin either side, not only the changed ones: a pin rebuilt since
    // (buildMarkers) is a fresh element, shown.
    for (const id of was) applyPinCover(id);
    for (const id of now) if (!was.has(id)) applyPinCover(id);
  }

  function applyPinCover(id: string) {
    const e = markerById.get(id);
    if (!e) return;
    if (e.sig === "leaf") {
      e.el.style.visibility = pinsUnderSlab.has(id) ? "hidden" : "";
      return;
    }
    const s = sticky.find((x) => x.id === id);
    if (s) applyPinVisibility(s);
  }

  /** The macro unit whose boundary contains [lng, lat] (bbox pre-filter, then flat
   *  precompiled-ring containment) — the hover/click target. Nothing on a
   *  piece of the analyses' slabs, its screen point `at` on one as drawn (see
   *  slabsOnScreen): it is not a unit, and what lies under it is hidden. Of
   *  two holding it, the first — or, with `smallerWins`, the smaller box: an
   *  enclave a coarse neighbour's outline covers (Monaco in France's 1 km
   *  one) is hit, not that neighbour. */
  function unitAt(lng: number, lat: number, at?: { x: number; y: number }): string {
    if (at && slabsOnScreen() && onSlab(at.x, at.y)) return "";
    const smaller = !!smallerWins?.();
    let id = "";
    let size = Infinity;
    for (const s of sticky) {
      if (!s.hit || !s.bounds) continue;
      const b = s.bounds;
      const x = lngNear(lng, b); // a country past ±180 (geo's wrap)
      if (lat < b.minLat || lat > b.maxLat || x < b.minLng || x > b.maxLng) continue;
      if (!smaller) {
        if (hitTest(s.hit, x, lat)) return s.id;
        continue;
      }
      const area = (b.maxLat - b.minLat) * (b.maxLng - b.minLng);
      if (area < size && hitTest(s.hit, x, lat)) {
        id = s.id;
        size = area;
      }
    }
    return id;
  }

  // Central hover switch: updates the cursor, lifts the hovered pin, highlights
  // the zone (GL fill on the plateau, or the draped fill on the ground when no
  // plateau stands or is coming — its source is empty otherwise), and toggles
  // only the two affected pins from cached room/visibility state.
  function setHover(id: string) {
    if (id === hoveredUnitId) return;
    const map = getMap();
    const prev = hoveredUnitId;
    hoveredUnitId = id;
    // The newly hovered pill is the only one that will be shown, and updateSticky
    // now positions only the hovered entry — so place this one right away instead
    // of waiting for the next sticky pass (which would show it at a stale point).
    if (id) {
      const s = sticky.find((x) => x.id === id);
      const view = screenBoundsInset(STICKY_MARGIN);
      if (s?.geometry && s.bounds && view && boundsIntersect(s.bounds, view)) {
        const hit = interiorInView(s.geometry, s.bounds, view);
        s.onScreen = !!hit;
        if (hit) s.marker.setLngLat(hit.pt);
      }
      // …and not over a slab (a row of the panel hovered: its pill may land there).
      hidePinsUnderSlabs();
    }
    if (map) map.getCanvas().style.cursor = id ? "pointer" : "";
    for (const s of sticky) {
      if (s.id === prev || s.id === id) {
        s.el.classList.toggle("geo-pin-hover", s.id === id);
        applyPinVisibility(s);
      }
    }
    plateauWall.setHovered(id);
    // Draped fallback only when no plateau is up (the world scope, or a scope
    // with no boundary of its own) — with a plateau, the GL sweep covers focus
    // AND context, and doubling would break the sweep.
    if (map?.getLayer("scope-hover-fill")) {
      const drapedId = plateauActive() ? "__none__" : id || "__none__";
      map.setFilter("scope-hover-fill", [
        "all",
        ["!=", ["get", "kind"], "scope"],
        ["==", ["get", "id"], drapedId],
      ]);
    }
  }

  let hoverRaf = 0;
  let lastHoverPt: { x: number; y: number } | null = null;
  let pendingHoverLngLat: { lng: number; lat: number } | null = null;
  let pendingHoverPt: { x: number; y: number } | undefined;
  function onMapHover(lngLat: { lng: number; lat: number }, point?: { x: number; y: number }) {
    // Mousemove floods; only re-test once the cursor actually travelled a few px.
    if (point && lastHoverPt) {
      const dx = point.x - lastHoverPt.x;
      const dy = point.y - lastHoverPt.y;
      if (dx * dx + dy * dy < 9) return;
    }
    if (point) lastHoverPt = point;
    // Always keep the LATEST position for the pending frame — a mouseout landing
    // while a mousemove's rAF is queued must not be swallowed by stale coords.
    pendingHoverLngLat = lngLat;
    pendingHoverPt = point;
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      // A panel row grabbed the hover while this frame was pending. Moving the
      // pointer off the canvas ONTO the panel fires the canvas mouseout, which
      // queues a clear here, and the row's mouseenter then runs synchronously
      // before this frame — so without this the panel's highlight would appear
      // and be wiped one frame later. While the panel owns the hover, the
      // pointer-derived one stands down.
      if (hoveredId()) return;
      const ll = pendingHoverLngLat;
      if (ll) setHover(unitAt(ll.lng, ll.lat, pendingHoverPt));
    });
  }

  let stickyRaf = 0;
  let lastStickyAt = 0;
  // A pill nudging along its shape does not need 60 Hz — recomputing every macro
  // pin's interior point per frame meant ~15 scanlines × every polygon vertex ×
  // every visible pin, every frame. ~14 Hz is visually identical while doing a
  // quarter of the work; `moveend` always runs a final exact pass.
  const STICKY_MIN_MS = 70;

  function scheduleSticky(force = false) {
    if (stickyRaf) return;
    stickyRaf = requestAnimationFrame(() => {
      stickyRaf = 0;
      const now = performance.now();
      if (!force && now - lastStickyAt < STICKY_MIN_MS) return;
      lastStickyAt = now;
      updateSticky();
    });
  }

  /** The canvas `mouseout`: moving onto one of our pin ELEMENTS also fires it —
   *  the pin's own mouseenter keeps the hover; don't clear it out from under it.
   *  (pinHoveredId additionally guards stray mouseouts while ON a pin.) */
  function onMouseOut(e: mapboxgl.MapMouseEvent) {
    const to = (e.originalEvent as MouseEvent | undefined)?.relatedTarget as Element | null;
    if (pinHoveredId || to?.closest?.(".geo-pin")) return;
    onMapHover({ lng: -999, lat: -999 });
  }

  /** The canvas `click`: inside a unit's boundary SELECTS the unit — the whole
   *  territory is the click target, the pin is just its label. */
  function onClick(e: mapboxgl.MapMouseEvent) {
    const id = unitAt(e.lngLat.lng, e.lngLat.lat, e.point);
    if (id) onUnitClick(id);
  }

  /** The container was resized: a pill's size follows the viewport's width
   *  (the type scale), measured anew when next needed. */
  function onResize() {
    for (const e of markerById.values()) e.halfW = e.halfH = 0;
  }

  /** Unmount: the pending frames. */
  function dispose() {
    if (stickyRaf) cancelAnimationFrame(stickyRaf);
    if (hoverRaf) cancelAnimationFrame(hoverRaf);
  }

  return {
    buildMarkers,
    /** Every marker gone (unmount, the map declared unavailable). */
    clear: clearMarkers,
    applyActivePin,
    /** The hover, from the panel (`hoveredId`) — the same switch the pointer uses. */
    setHover,
    /** The canvas `mousemove`. */
    onHover: onMapHover,
    onMouseOut,
    onClick,
    scheduleSticky,
    /** The pins drawn on a slab, hidden; those no longer there, shown again. */
    hidePinsUnderSlabs,
    onResize,
    dispose,
  };
}
