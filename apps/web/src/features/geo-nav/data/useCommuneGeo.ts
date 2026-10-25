// Commune / arrondissement geometry, fetched on demand by INSEE code (the Géo API
// serves precise contours one unit at a time; the API batches them) and cached
// for the session, with the codes still on their way and the ones that will
// never arrive.
import { computed, markRaw, ref, shallowRef } from "vue";
import { api } from "@/shared/api/client";
import type { Bounds, UnitGeo } from "@/features/geo";
import type { BoundaryFC } from "./useBoundaryQueries";

export interface CommuneGeo {
  center: [number, number];
  bounds: Bounds;
  geometry: unknown;
}

export function useCommuneGeo() {
  // shallowRef + markRaw: a deep ref would wrap every polygon coordinate array in
  // a reactive Proxy, and the hot paths (scanlineCentroid, geometryContains,
  // setGeometry's mesh rebuild) iterate MILLIONS of coords — each access paying a
  // Proxy `get` trap. Profiled at ~15% of total scripting during a pan. The
  // record is only ever replaced wholesale, so shallow reactivity is sufficient.
  const communeGeo = shallowRef<Record<string, CommuneGeo>>({});
  const pendingInsee = new Set<string>();
  // Codes whose fetch terminally failed — scopePending must resolve (not hold the
  // old plateau forever) when the scope's contour will never arrive. Cleared on
  // retry so a later visit gets another attempt.
  const failedInsee = ref(new Set<string>());

  async function ensureGeo(codes: string[]) {
    const missing = codes.filter((c) => c && !communeGeo.value[c] && !pendingInsee.has(c));
    if (!missing.length) return;
    missing.forEach((c) => pendingInsee.add(c));
    const fetched: Record<string, CommuneGeo> = {};
    const failed: string[] = [];
    // ONE request for the whole batch. Per-commune requests cost ~80 ms each and
    // a pan brings dozens of new communes into view, so they serialised into
    // seconds of stall — this was the dominant source of map lag.
    const CHUNK = 200; // server caps a batch at 200 codes
    try {
      for (let i = 0; i < missing.length; i += CHUNK) {
        const slice = missing.slice(i, i + CHUNK);
        const fc = await api.get<BoundaryFC>(
          `/api/boundaries/communes?codes=${encodeURIComponent(slice.join(","))}`,
        );
        for (const f of fc.features ?? []) {
          const code = f.properties.code;
          if (!code) continue;
          // markRaw: geometry must stay a plain object — see communeGeo's note.
          fetched[code] = markRaw({
            center: f.properties.center,
            bounds: f.properties.bounds,
            geometry: f.geometry,
          });
        }
      }
      // Anything the batch didn't return is terminal (dead/merged INSEE code) —
      // the unit keeps its data-derived centre and the pending hold lifts.
      for (const c of missing) if (!fetched[c]) failed.push(c);
    } catch {
      failed.push(...missing);
    } finally {
      missing.forEach((c) => pendingInsee.delete(c));
    }
    // ONE reactive update for the whole batch: a per-contour write re-fired the
    // outline watcher (→ plateau geometry rebuild + rise restart) for EVERY
    // arriving commune — ~20× on a dense département like the Hautes-Alpes.
    const okCodes = Object.keys(fetched);
    if (okCodes.length) communeGeo.value = { ...communeGeo.value, ...fetched };
    if (failed.length || okCodes.some((c) => failedInsee.value.has(c))) {
      const next = new Set(failedInsee.value);
      for (const c of okCodes) next.delete(c);
      for (const c of failed) next.add(c);
      failedInsee.value = next;
    }
  }

  const inseeGeo = computed(() => {
    const m = new Map<string, UnitGeo>();
    for (const [code, g] of Object.entries(communeGeo.value)) {
      m.set(code, { center: g.center, bounds: g.bounds });
    }
    return m;
  });

  return { communeGeo, failedInsee, ensureGeo, inseeGeo };
}

export type CommuneGeoStore = ReturnType<typeof useCommuneGeo>;
