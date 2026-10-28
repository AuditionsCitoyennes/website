// The analyses of the territory in scope, for GeoNav: what the association
// heard there (every unit's figures, gathered once per data load), the words'
// content boxes (measured with the site's fonts, again as each comes in),
// whether the words are on screen, the slabs GeoDrillMap stands on the raised
// territory and the room the camera leaves them. Explicit inputs: GeoNav's
// state comes in as refs and getters, nothing here reads its scope.
import {
  computed,
  markRaw,
  onBeforeUnmount,
  ref,
  type ComputedRef,
  type Ref,
  type ShallowRef,
} from "vue";
import type { LocationGroup } from "@ac/shared";
import type { GeoUnit } from "@/features/geo";
import type { SlabSpec } from "@/features/map/types";
import {
  analyseScope,
  buildUnitStats,
  type OwnAudition,
  type ScopeAnalysis,
  type UnitStatsIndex,
} from "../stats/scopeStats";
import { figuresHash } from "../stats/factsStats";
import { slabSizes, type SlabSizes } from "../content/slabSizes";
import { plateRoom, slabGap, type PlateRoom, type ScreenOpts } from "../content/plateRoom";
import {
  pendingAnalysesMode,
  RING_BANDS,
  ringBandMode,
  slabLidMode,
  slabTextMode,
  slabTextScale,
} from "../devSwitch";

export interface ScopeAnalysisInputs {
  /** The analyses are on (the page's toggle). */
  analyses: Ref<boolean>;
  /** The map is a card (the home page): nothing is analysed there. */
  preview: Ref<boolean | undefined>;
  groups: Ref<LocationGroup[]>;
  /** The association's own testimonies, grouped by audition (keyed by its id). */
  ownAuditions: ComputedRef<Map<string, OwnAudition>>;
  /** The unit the viewport is "inside". */
  currentScope: ShallowRef<GeoUnit>;
  /** A lieu's unit by its canonical name (its label, for the concentration). */
  placeByCanonical: ComputedRef<Map<string, GeoUnit>>;
  /** The boot curtain is up. */
  booting: Ref<boolean>;
  /** Deep among the lieux: nothing stands. */
  inMicroZone: Ref<boolean>;
  /** A lieu is open and the reader is on the panel. */
  readingPlace: () => boolean;
  isDesktop: Ref<boolean>;
  /** A phone's sheet is raised. */
  sheetOpen: Ref<boolean>;
  /** The screen the slabs stand on: the safe rect's width, the type scale's. */
  plateScreen: ComputedRef<ScreenOpts>;
  /** Filters are on. */
  listMode: ComputedRef<boolean>;
  /** The themes picked in Filtres (the one array the plates are handed too). */
  themeFilter: ComputedRef<string[]>;
  /** The last command that framed a unit: its slabs are sized for the camera
   *  it lands on. */
  framedFit: ShallowRef<{ key: number; unitId: string } | null>;
  /**
   * The server's tree is on screen (map phase 1): every unit's figures come
   * from the database (stats/factsStats), not from `groups` and
   * `ownAuditions` — the index for the key and store version on screen, and
   * how its lieux are named. Absent: the corpus' (buildUnitStats).
   */
  server?: {
    stats: () => UnitStatsIndex;
    placeLabel: (lieu: { key: string; city: string | null }) => string;
  };
}

export function useScopeAnalysis(inputs: ScopeAnalysisInputs) {
  const {
    analyses,
    preview,
    groups,
    ownAuditions,
    currentScope,
    placeByCanonical,
    booting,
    inMicroZone,
    readingPlace,
    isDesktop,
    sheetOpen,
    plateScreen,
    listMode,
    themeFilter,
    framedFit,
    server,
  } = inputs;

  // Every unit's figures, gathered once per data load. Keyed on the data itself,
  // not on the hierarchy, which is rebuilt each time commune contours arrive.
  // The server's: the index the caller builds once per key and store version.
  const unitStats = computed<UnitStatsIndex | null>(() => {
    if (!analyses.value || preview.value) return null;
    if (server) return server.stats();
    return markRaw(buildUnitStats(groups.value, ownAuditions.value));
  });

  // The scope is re-derived as the map moves and its unit object replaced at each
  // rebuild of the hierarchy: an analysis already made for the same territory is
  // handed back as it was, so the plates do not re-render.
  const analysisMemo = new Map<string, ScopeAnalysis | null>();
  let analysisMemoOf: UnitStatsIndex | null = null;
  // The server's tree: each answer merged is a new index, its units' figures
  // mostly unchanged — remembered by unit and figures, so a merge re-renders
  // no plate. The last analysis shown stands in while a unit's figures are on
  // their way, unless "Analyses en attente" says otherwise (DEV).
  let lastServerAnalysis: ScopeAnalysis | null = null;
  function serverAnalysis(stats: UnitStatsIndex, unit: GeoUnit): ScopeAnalysis | null {
    const figures = stats.figuresOf(unit.id);
    if (!figures) return pendingAnalysesMode.value === "garder" ? lastServerAnalysis : null;
    const key = `${unit.id}#${figuresHash(figures)}`;
    if (analysisMemo.size > 200) analysisMemo.clear();
    let analysis = analysisMemo.get(key);
    if (analysis === undefined) {
      analysis = analyseScope(unit, stats, { placeLabel: server!.placeLabel });
      analysisMemo.set(key, analysis);
    }
    lastServerAnalysis = analysis;
    return analysis;
  }
  const scopeAnalysis = computed<ScopeAnalysis | null>(() => {
    const stats = unitStats.value;
    const unit = currentScope.value;
    if (!stats) lastServerAnalysis = null;
    if (!stats || unit.levelKey === "world") return null;
    if (server) return serverAnalysis(stats, unit);
    if (stats !== analysisMemoOf || analysisMemo.size > 200) {
      analysisMemo.clear();
      analysisMemoOf = stats;
    }
    if (analysisMemo.has(unit.id)) return analysisMemo.get(unit.id) ?? null;
    const labels = placeByCanonical.value;
    const analysis = analyseScope(unit, stats, {
      placeLabel: (lieu) => labels.get(lieu.key)?.label ?? lieu.key,
    });
    analysisMemo.set(unit.id, analysis);
    return analysis;
  });

  // On screen only while the map is what is being looked at: not on the card,
  // not behind the boot curtain, not deep among the lieux (nothing stands
  // there), not while a lieu is being read, not under a raised sheet.
  const analysesVisible = computed(
    () =>
      Boolean(scopeAnalysis.value) &&
      !preview.value &&
      !booting.value &&
      !inMicroZone.value &&
      !readingPlace() &&
      (isDesktop.value || !sheetOpen.value),
  );

  // The slabs' content boxes are measured with the site's fonts: until they are
  // in, estimated — measured again as each comes in (a face loads when first
  // used: Bebas with the plaque's title).
  const fontsLoaded = ref(0);
  const onFontsLoaded = () => fontsLoaded.value++;
  document.fonts?.ready.then(onFontsLoaded).catch(() => {});
  document.fonts?.addEventListener?.("loadingdone", onFontsLoaded);
  onBeforeUnmount(() => document.fonts?.removeEventListener?.("loadingdone", onFontsLoaded));

  /** The slabs' content boxes for the territory in scope (analyses/content/slabSizes):
   *  what the overlay draws, the room the camera leaves, the size on the map. */
  const slabSizesNow = computed<SlabSizes | null>(() => {
    const a = scopeAnalysis.value;
    void fontsLoaded.value; // measured again once the fonts are in
    if (!a) return null;
    const screen = plateScreen.value;
    return markRaw(
      slabSizes(a, {
        compact: screen.compact,
        vw: screen.vw,
        rem: screen.rem,
        filtered: listMode.value,
        themeFilter: themeFilter.value,
        ringThick: RING_BANDS[ringBandMode.value],
        safeW: screen.safeW,
        textScale: slabTextScale.value,
      }),
    );
  });

  /** The slabs GeoDrillMap stands on the raised territory: only while the
   *  analyses are on screen (they go with them, and with the plateau), sized
   *  for the fit that framed the territory when there was one (`framedFit`);
   *  on the top one, the themes' row — its boxes, and the ring's parts it
   *  raises one by one. */
  const slabSpec = computed<SlabSpec | null>(() => {
    const a = scopeAnalysis.value;
    const z = slabSizesNow.value;
    if (!analysesVisible.value || !a || !z) return null;
    const fit = framedFit.value;
    const t = z.themes;
    return {
      scopeId: a.scopeId,
      top: t && {
        w: t.w,
        h: t.h,
        ringBox: t.ringBox,
        barBox: t.barBox,
        labelBox: t.labelBox,
        ring: {
          c: t.ring.c,
          R: t.ring.R,
          r: t.ring.r,
          pick: t.ring.pick,
          hover: t.ring.hover,
          parts: t.ring.parts.map((p) => ({
            theme: p.theme,
            a0: p.a0,
            a1: p.a1,
            color: p.color,
            pastel: p.pastel,
          })),
        },
      },
      bottom: { w: z.plaque.w, h: z.plaque.h },
      gapPx: slabGap(!isDesktop.value),
      framedBy: fit && fit.unitId === a.scopeId ? fit.key : null,
      anamorphic: slabTextMode.value === "redresse",
      textScale: slabTextScale.value,
      lid: slabLidMode.value,
    };
  });

  /** The room the slabs of the territory in scope need around the plateau
   *  (null: none raised), on the screen as it is now. */
  function roomNow(): PlateRoom | null {
    const z = slabSizesNow.value;
    if (!z) return null;
    return plateRoom(z, {
      ...plateScreen.value,
      anamorphic: slabTextMode.value === "redresse",
      textScale: slabTextScale.value,
    });
  }

  return { scopeAnalysis, analysesVisible, slabSizesNow, slabSpec, roomNow, fontsLoaded };
}
