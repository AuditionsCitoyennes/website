// The page's mesh worker (ac:mesh=worker, plateau/meshSwitch.ts): the client
// core (meshClientCore.ts) over a module Worker running meshWorker.ts, the
// same builder (meshBuild.ts) as its fallback here. One per map: created with
// the map object (or at its load: ac:boot-workers, bootWorkersSwitch.ts), so
// the worker's first build does not pay its start-up,
// disposed with the map. It also cuts the flat view's grey sheet
// (tintCutterOf, ac:tint-cut). A Worker that cannot be made leaves the session
// building here from the start.
//
// Testing tools: `window.__acMesh` = {mode, stats(), reset()} of the last
// client made, and the knobs read at every request — `__acMeshCap` (the
// token cap, vertices), `__acMeshDelay` (ms the worker waits before
// replying), `__acMeshSlow` (k: the worker builds k times), `__acMeshFail`
// ("throw": an error reply; "hang": no reply).

import { perfNote, perfOn } from "@/shared/perf/perf";
import { buildPlateauMesh } from "./meshBuild";
import { createMeshClient, type MeshClient, type MeshTransport } from "./meshClientCore";
import type { MeshReply } from "./meshCore";
import type { GlobeProvider } from "./PlateauWallLayer";
import type { TintCutter } from "./ScopeTintLayer";
import { cacheBudgetNow } from "../cacheBudget";

type Knobs = {
  __acMeshCap?: unknown;
  __acMeshDelay?: unknown;
  __acMeshSlow?: unknown;
  __acMeshFail?: unknown;
  __acMesh?: unknown;
};

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** A new client, its worker started now. */
export function warmMeshWorker(): MeshClient {
  const w = window as unknown as Knobs;
  const client = createMeshClient({
    transport({ reply, fail }): MeshTransport {
      const worker = new Worker(new URL("./meshWorker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (e: MessageEvent<MeshReply>) => reply(e.data);
      worker.onerror = () => fail("error");
      worker.onmessageerror = () => fail("messageerror");
      return {
        post: (msg, transfer) => worker.postMessage(msg, transfer),
        terminate: () => worker.terminate(),
      };
    },
    now: () => performance.now(),
    schedule(fn, ms) {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
    fallbackBuild: (i, want) =>
      buildPlateauMesh(i.features, i.heightM, i.focus, i.context, { ...want, concat: true }),
    // MESH_TOKEN_CAP_VERTICES on a device of the "full" tier, fewer on a
    // weak one (../cacheBudget.ts), read at each apply.
    capVertices: () =>
      (__TEST_TOOLS__ ? num(w.__acMeshCap) : undefined) ?? cacheBudgetNow().meshVertices,
    knobs: __TEST_TOOLS__
      ? () => ({
          delayMs: num(w.__acMeshDelay),
          slow: num(w.__acMeshSlow),
          fail:
            w.__acMeshFail === "throw" || w.__acMeshFail === "hang" ? w.__acMeshFail : undefined,
        })
      : undefined,
    // Posted → received, here (mesh.roundTrip); the worker's own build time,
    // noted on reception (plateau.meshBuild).
    trace: perfOn
      ? {
          roundTrip: (ms, detail) => perfNote("mesh.roundTrip", ms, detail),
          tintRoundTrip: (ms, detail) => perfNote("tint.roundTrip", ms, detail),
          meshBuild: (ms, detail) => perfNote("plateau.meshBuild", ms, detail),
        }
      : undefined,
  });
  if (__TEST_TOOLS__) {
    w.__acMesh = {
      get mode() {
        return client.mode;
      },
      stats: () => client.stats(),
      reset: () => client.reset(),
    };
  }
  return client;
}

/** The layer's deferred globe set, asked of `client` (setGlobeProvider) while
 *  its worker lives; lost, the layer builds it as merc does. */
export function globeProviderOf(client: MeshClient): GlobeProvider {
  return {
    live: () => client.mode === "worker",
    build: (inputs) =>
      client.buildGlobe(inputs).then((r) => {
        if (!r) return null;
        const { gWallPositions, gLidPositions, gLinePositions, gHaloPositions } = r.mesh;
        if (!gWallPositions || !gLidPositions || !gLinePositions || !gHaloPositions) return null;
        return { gWallPositions, gLidPositions, gLinePositions, gHaloPositions, ms: r.ms };
      }),
  };
}

/** The flat view's grey sheet, cut by `client`'s worker while it lives
 *  (ScopeTintLayer.setCutter, ac:tint-cut); lost, the layer cuts it. */
export function tintCutterOf(client: MeshClient): TintCutter {
  return {
    live: () => client.mode === "worker",
    cut: (geoms) => client.cutTint(geoms),
  };
}
