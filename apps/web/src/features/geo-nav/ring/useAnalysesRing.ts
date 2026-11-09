// The analyses' ring: the room the camera leaves around the raised territory
// for its plates, as a narrowing of the LOGICAL view (never of the camera's
// padding), brought in line with the analyses only together with a camera
// command — the hook registered on useCamera — and the fit that must go with a
// change of it. The map's own size and the header's tiles are measured here.
//
// The analyses are slabs of the raised territory (the themes over the middle
// of its top edge, the plaque under the middle of its bottom edge: GeoDrillMap
// draws them, ScopeAnalysisOverlay lays their words on them), so while they
// are on, the territory is framed with room around it for them: a band above
// it (the themes), one below it (the plaque). Right after a camera command
// both stand on screen; moved by the user, the map takes them along — they
// are pieces of it. Not by zooming out — the unit would then
// measure right on the scope's ascend threshold and pop to its parent at a
// nudge — and not by changing the camera's padding, which would slide the
// globe: the ring narrows the LOGICAL view instead (on a phone, widens it
// beside the territory: PHONE_SIDE; above it, it keeps the slabs' margin, not
// the camera's padding: withRing), like the wide panel does.
// The fit sizes the unit to the inner rectangle and aims at its centre, the
// scope is read off that rectangle (the framed unit still fills it as usual),
// and free navigation keeps the same thresholds.
//
// How wide each band is depends on what the slabs hold: their content boxes
// say it (slabSizes, plateRoom). Read for the territory being framed at each
// camera command, and kept until the next one (`ringRoom`): the slabs' text
// changing under a still camera (a filter, the data reloading) must not move
// the ring. The bands come from CSS px alone; the fit then gives a zoom, and
// that zoom the slabs' size on the map — nothing goes round in a circle.
//
// The ring changes what the scope is measured against, so it may only change
// TOGETHER with a fit of the scope in the same tick: alone, turning it on
// would descend into the biggest child and turning it off would climb to the
// parent. `ringOn` is the ring applied; setCamera brings it in line with
// `ringWanted` on every command.
//
// It stays on at the world level too: dropping it there would take a fit at
// every crossing of the country's threshold, so the camera would move by
// itself whenever the user zoomed out of France or back in.
//
// On a desktop it stays on with a lieu open as well. The slabs stand beside
// the panel there, and the map turned back to the territory around the lieu
// (turning the analyses on from it, or a click on the map) must leave them
// room — framed edge to edge, the slabs would stand off the map. Opening or
// closing a lieu then changes nothing about the ring. A phone's sheet, raised
// over a lieu, leaves only a strip of map above it: no ring there. Lowered
// again (the analyses turned on from the lieu lower it), the map is the
// phone's whole screen once more, slabs included: the ring is back.
import { computed, onBeforeUnmount, ref, shallowRef, watch, type ComputedRef, type Ref } from "vue";
import { headerTilesBottomPx } from "@/shared/dom/header";
import type { GeoUnit } from "@/features/geo";
import {
  edgeMargin,
  FRAME_MIN_COMPACT,
  FRAME_MIN_WIDE,
  frameFill,
  slabTextMode,
  slabTextScale,
  type PlateRoom,
  type ScreenOpts,
} from "@/features/analyses";
import type { Insets, NavState } from "../navState";
import { PANEL_BASE_PX } from "../panel/usePanelLayout";
import type { MapHandle } from "../model/useCamera";

export interface AnalysesRingInputs {
  nav: NavState;
  /** The analyses are on (the page's toggle). */
  analyses: Ref<boolean>;
  /** The map is a card (the home page). */
  preview: Ref<boolean | undefined>;
  isDesktop: Ref<boolean>;
  viewportW: Ref<number>;
  viewportH: Ref<number>;
  /** The page the map fills (`.geo-page`). */
  pageEl: Ref<HTMLElement | null>;
  /** The height the phone's lowered sheet leaves showing (useBottomSheet). */
  sheetPeekPx: Ref<number>;
  layout: {
    mapPadding: ComputedRef<Insets>;
    widePanelView: ComputedRef<Insets | undefined>;
    panelPx: ComputedRef<number>;
  };
  listMode: ComputedRef<boolean>;
  /** A lieu is open and the reader is on the panel. */
  readingPlace: () => boolean;
  mapCmp: Ref<MapHandle | null>;
  camera: {
    onBeforeCommand: (hook: () => void) => void;
    flyToUnit: (unit: GeoUnit, animate: boolean, fresh?: boolean) => void;
    scheduleFilterFrame: (owed?: boolean) => void;
  };
}

export function useAnalysesRing(inputs: AnalysesRingInputs) {
  const {
    nav,
    analyses,
    preview,
    isDesktop,
    viewportW,
    viewportH,
    pageEl,
    sheetPeekPx,
    layout,
    listMode,
    readingPlace,
    mapCmp,
    camera,
  } = inputs;
  const { currentScope, selectedPlaceId, sheetOpen, inMicroZone } = nav;
  const { mapPadding, widePanelView, panelPx } = layout;

  // The map's own size (the page it fills), for the ring below and the room the
  // analyses' plates have. Until measured, the window stands in for it.
  const pageW = ref(0);
  const pageH = ref(0);
  // Phones: how far down the header's floating tiles reach over the map — the
  // tiles themselves, not the header's box: the padding under them is the map's
  // (12 px of it, which the plates' band above the territory need not clear).
  const headerClearPx = ref(0);
  function measureHeaderClear() {
    const page = pageEl.value;
    const bottom = headerTilesBottomPx();
    if (!page || bottom === null) return;
    headerClearPx.value = Math.max(0, Math.round(bottom - page.getBoundingClientRect().top));
  }
  let pageRO: ResizeObserver | null = null;
  watch(pageEl, (el) => {
    pageRO?.disconnect();
    pageRO = null;
    if (el && typeof ResizeObserver !== "undefined") {
      pageRO = new ResizeObserver(([entry]) => {
        pageW.value = Math.round(entry.contentRect.width);
        pageH.value = Math.round(entry.contentRect.height);
        measureHeaderClear();
      });
      pageRO.observe(el);
    }
  });
  onBeforeUnmount(() => pageRO?.disconnect());

  const ringWanted = computed(
    () =>
      analyses.value &&
      !preview.value &&
      (isDesktop.value || !selectedPlaceId.value || !sheetOpen.value),
  );
  const ringOn = ref(false);
  let ringTimer = 0;
  onBeforeUnmount(() => window.clearTimeout(ringTimer));

  // Until a territory's own slabs are known: slabs of a usual size (a
  // département's — the Rhône's plateRoom, 1440 × 900 / 375 × 812, offline, at
  // TEXT_SCALE, its ring twice its label's height (RING_OVER_LABEL; its band
  // takes no room): the themes above; the plaque below, on a phone over
  // mapbox's logo's strip; nothing beside).
  const ROOM_WIDE: PlateRoom = { top: 114, bottom: 87, left: 0, right: 0 };
  const ROOM_COMPACT: PlateRoom = { top: 104, bottom: 107, left: 0, right: 0 };

  // A phone's frame keeps only the slabs' own margin from the screen's sides
  // while the analyses are on, where the camera's padding keeps 36: the slabs
  // stand above and below the territory, never beside it, so the width is all
  // the territory's (mapbox's fit leaves France some 20 px more either side).
  const PHONE_SIDE = edgeMargin(true);

  /** The room the slabs of the territory in scope need (null: none raised). */
  const ringRoom = shallowRef<PlateRoom | null>(null);

  let rootRemPx = 0;
  function rootRem(): number {
    if (!rootRemPx) {
      rootRemPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    }
    return rootRemPx;
  }

  // The safe rect: the map clear of the panel — on a phone, below the header's
  // floating tiles and above the lowered sheet. Right after a camera command
  // the slabs stand inside it, their own margin from its edges, clear of
  // mapbox's logo (analyses/content/plateRoom): the ring leaves them room.
  const overlayInsets = computed<Insets>(() => {
    if (isDesktop.value) {
      return {
        top: 0,
        right: widePanelView.value ? panelPx.value : PANEL_BASE_PX,
        bottom: 0,
        left: 0,
      };
    }
    return { top: headerClearPx.value, right: 0, bottom: sheetPeekPx.value, left: 0 };
  });

  /** The screen the slabs stand on: the safe rect's width, the type scale's. */
  const plateScreen = computed<ScreenOpts>(() => {
    const safe = overlayInsets.value;
    return {
      compact: !isDesktop.value,
      safeW: Math.max(0, (pageW.value || viewportW.value) - safe.left - safe.right),
      vw: viewportW.value,
      rem: rootRem(),
    };
  });

  // A new width (the window resized, the phone turned — a desktop's slabs are
  // not a phone's) reshapes the rectangle the scope is read from anyway: there
  // the room kept is measured afresh, both bands, for the slabs now standing
  // (the map frames the last command again at a resize until it is moved).
  // Between commands otherwise it stays as framed: a ring that only appears
  // under a still camera (filters giving a unit enough testimonies) stands
  // above the box with no band of its own until the next command — a band
  // grown under a still camera would shrink the rectangle the scope is read
  // from, and the scope could descend. Not while the map is a card: its size
  // is the card's.
  let bandW = NaN;
  watch([plateScreen, preview], ([screen, card]) => {
    if (card || screen.safeW === bandW) return;
    bandW = screen.safeW;
    if (ringRoom.value) ringRoom.value = nav.roomNow.value() ?? ringRoom.value;
  });

  /** Two opposite insets brought within `room`: first what the ring adds to its
   *  floor (the camera's padding; PHONE_SIDE beside a phone's territory; `head`
   *  above it) gives way, then (too little map even for that) both, in
   *  proportion. The slabs, pieces of the map, then reach past the safe rect's
   *  edges (under the header's tiles, the sheet). */
  function giveWay(a: number, b: number, padA: number, padB: number, room: number) {
    if (a + b <= room) return [a, b];
    const extra = Math.max(0, a - padA) + Math.max(0, b - padB);
    const over = a + b - room;
    if (extra > 0) {
      const k = Math.max(0, 1 - over / extra);
      a = Math.min(a, padA + Math.max(0, a - padA) * k);
      b = Math.min(b, padB + Math.max(0, b - padB) * k);
    }
    if (a + b > room) {
      const k = room / (a + b);
      a *= k;
      b *= k;
    }
    return [a, b];
  }

  /** The rectangle the territory is framed in while the analyses are on: the
   *  safe rect less the room its plates need on each side, and the camera's
   *  padding (`p`) at least — beside the territory on a phone, PHONE_SIDE
   *  instead; above it, the slabs' own margin (see `head`). */
  function withRing(p: Insets): Insets {
    const w = pageW.value || viewportW.value;
    const h = pageH.value || viewportH.value;
    const safe = overlayInsets.value;
    const wide = isDesktop.value;
    const room = ringRoom.value ?? (wide ? ROOM_WIDE : ROOM_COMPACT);
    // The least rectangle the territory is framed in (see FRAME_MIN_WIDE).
    const min = wide ? FRAME_MIN_WIDE : FRAME_MIN_COMPACT;
    const sideL = wide ? p.left : safe.left + PHONE_SIDE;
    const sideR = wide ? p.right : safe.right + PHONE_SIDE;
    const [left, right] = giveWay(
      Math.max(sideL, safe.left + room.left),
      Math.max(sideR, safe.right + room.right),
      sideL,
      sideR,
      Math.max(0, w - min.w),
    );
    // The territory heads a group the plaque closes, at the slabs' margin from
    // the safe rect's bottom edge (on a phone, over mapbox's logo, its strip's:
    // the group stands that much higher). The group's head — the themes, else
    // the territory itself — keeps the same margin from the top edge rather
    // than the camera's padding (48 px lower on a desktop): the group centred.
    const head = safe.top + edgeMargin(!wide);
    const [top, bottom] = giveWay(
      Math.max(head, safe.top + room.top),
      Math.max(p.bottom, safe.bottom + room.bottom),
      head,
      p.bottom,
      Math.max(0, h - min.h),
    );
    return {
      top: Math.round(top),
      bottom: Math.round(bottom),
      left: Math.round(left),
      right: Math.round(right),
    };
  }

  const mapViewPadding = computed<Insets | undefined>(
    () =>
      widePanelView.value ??
      (ringOn.value && !preview.value ? withRing(mapPadding.value) : undefined),
  );

  /** Brings the ring in line with the analyses, with the fit that must go with it. */
  function applyRing() {
    window.clearTimeout(ringTimer);
    ringTimer = 0;
    if (ringOn.value === ringWanted.value) return;
    // Deep in the lieu zone nothing is raised or framed: the ring just follows,
    // and so does the scope, at the user's next move. So it does under a phone's
    // sheet raised over a lieu: the scope holds still while the lieu is read
    // (deriveScope), and the sheet lowered again brings the ring back with a fit.
    if (inMicroZone.value || (!isDesktop.value && readingPlace())) {
      ringOn.value = ringWanted.value;
      return;
    }
    // While filters are on the map frames the visitor's country (at the world,
    // the world itself): framed again, inside the ring now. This call owes a
    // command, so the ring flips with it (that fit waits for the map to be let
    // go itself).
    if (listMode.value) {
      camera.scheduleFilterFrame(true);
      return;
    }
    // Not from under a hand on the map (a camera command ends the gesture): it
    // comes once the map is let go.
    if (mapCmp.value?.inUserHands()) {
      ringTimer = window.setTimeout(applyRing, 250);
      return;
    }
    camera.flyToUnit(currentScope.value, true); // setCamera flips the ring with it
  }
  // The analyses toggled need the fit here — and on a phone, a lieu closed with
  // no flight of its own (opening one turns the ring off and frames the lieu in
  // the same tick: setCamera has settled it then), or the sheet lowered over a
  // lieu (raised, it only drops the ring: see applyRing). The card becoming the page
  // (or a card again) is framed anew by GeoNav's preview watch, ring included.
  watch([ringWanted, preview], ([, card], [, was]) => {
    if (card !== was) return;
    applyRing();
  });

  // DEV: the words drawn long or flat, or at another size, take another room,
  // and another framing frames otherwise: framed again, the ring with it
  // (setCamera reads it afresh), the slabs sized for the new fit.
  watch([slabTextMode, slabTextScale, frameFill], () => {
    if (!ringOn.value || preview.value) return;
    if (listMode.value) camera.scheduleFilterFrame(true);
    else if (!inMicroZone.value) camera.flyToUnit(currentScope.value, true);
  });

  // Every command frames against the analyses' ring as it should be now, so
  // the ring never changes without a camera command in the same tick (see
  // `ringOn`). A flip still waiting for the map to be let go is taken along,
  // and so is the room the plates of the territory now framed need on the
  // screen as it is now (`ringRoom`, through navState's roomNow box).
  camera.onBeforeCommand(() => {
    window.clearTimeout(ringTimer);
    ringTimer = 0;
    ringOn.value = ringWanted.value;
    if (ringOn.value) ringRoom.value = nav.roomNow.value();
  });

  return {
    measureHeaderClear,
    ringWanted,
    ringOn,
    ringRoom,
    overlayInsets,
    plateScreen,
    mapViewPadding,
  };
}
