// A département as it is RAISED: the union of its communes' contours.
// The france-geojson départements are simplified to ~3 km segments, and one of
// their chords can cut a commune off its own département: Saint-Mandé stood 99%
// outside the raised Val-de-Marne (a third of Vincennes too), inside Paris's
// outline. So the outline a département rises with, is framed by and holds the
// view's centre with comes from the same source as the communes drawn on its
// lid (the API merges their Géo API contours). Seen from its région (focus) it
// keeps the france-geojson outline, which agrees with the région's; beside a
// raised département (context) it takes its own once loaded, which agrees with
// that one's raised edge — drawn and hit there alike. Fetched when the
// département is framed or becomes the scope, or borders the scope (once the
// scope's own is in), and kept.
import { computed, markRaw, ref, shallowRef } from "vue";
import { api } from "@/shared/api/client";
import type { UnitGeo } from "@/features/geo";
import type { BoundaryFeature } from "./useBoundaryQueries";
import type { CommuneGeo } from "./useCommuneGeo";

export function useDepFine() {
  const depFine = shallowRef<Record<string, CommuneGeo>>({});
  const pendingDep = new Set<string>();
  // The plateau waits this long for a département's outline (the old one stands
  // meanwhile — see scopePending), then rises with the france-geojson outline and
  // takes the fine one when it lands (the map reshapes in place). Only a cold
  // server, fetching the communes upstream, takes that long.
  const DEP_WAIT_MS = 1200;
  /** Codes not waited for any more: the fetch failed or is slow. */
  const depGaveUp = ref(new Set<string>());
  function giveUpDep(code: string) {
    if (depGaveUp.value.has(code)) return;
    depGaveUp.value = new Set(depGaveUp.value).add(code);
  }
  /** One département's outline, fetched (null: had, on its way, or failed). */
  async function fetchDepFine(code: string | undefined): Promise<[string, CommuneGeo] | null> {
    if (!code || depFine.value[code] || pendingDep.has(code)) return null;
    pendingDep.add(code);
    const timer = window.setTimeout(() => giveUpDep(code), DEP_WAIT_MS);
    try {
      const f = await api.get<BoundaryFeature>(
        `/api/boundaries/departement/${encodeURIComponent(code)}`,
      );
      // markRaw: geometry must stay a plain object — see communeGeo's note.
      return [
        code,
        markRaw({ center: f.properties.center, bounds: f.properties.bounds, geometry: f.geometry }),
      ];
    } catch {
      giveUpDep(code);
      return null;
    } finally {
      window.clearTimeout(timer);
      pendingDep.delete(code);
    }
  }
  /** Outlines in, in ONE write: each write rebuilds the hierarchy and the map's
   *  outline (and the plateau with it) — the neighbours come in together. */
  function addDepFine(got: ([string, CommuneGeo] | null)[]) {
    const add = got.filter((e): e is [string, CommuneGeo] => e !== null);
    if (add.length) depFine.value = { ...depFine.value, ...Object.fromEntries(add) };
  }
  async function ensureDepFine(code: string | undefined) {
    addDepFine([await fetchDepFine(code)]);
  }
  const depFineGeo = computed(() => {
    const m = new Map<string, UnitGeo>();
    for (const [code, g] of Object.entries(depFine.value)) {
      m.set(code, { center: g.center, bounds: g.bounds });
    }
    return m;
  });

  return { depFine, depGaveUp, fetchDepFine, addDepFine, ensureDepFine, depFineGeo };
}

export type DepFineStore = ReturnType<typeof useDepFine>;
