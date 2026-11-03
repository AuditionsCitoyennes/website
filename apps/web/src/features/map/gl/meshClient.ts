// The page's mesh worker (ac:mesh=worker, plateau/meshSwitch.ts): the client
// core (meshClientCore.ts) over a module Worker running meshWorker.ts, the
// same builder (meshBuild.ts) as its fallback here. One per map: created at
// the map's load, so the worker's first build does not pay its start-up,
// disposed with the map. A Worker that cannot be made leaves the session
// building here from the start.
//
// Testing tools: `window.__acMesh` = {mode, stats(), reset()} of the last
// client made, and the knobs read at every request — `__acMeshCap` (the
// token cap, vertices), `__acMeshDelay` (ms the worker waits before
// replying), `__acMeshSlow` (k: the worker builds k times), `__acMeshFail`
// ("throw": an error reply; "hang": no reply).

import { buildPlateauMesh } from "./meshBuild";
import {
  MESH_TOKEN_CAP_VERTICES,
  createMeshClient,
  type MeshClient,
  type MeshTransport,
} from "./meshClientCore";
import type { MeshReply } from "./meshCore";

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
    capVertices: () => (__TEST_TOOLS__ ? num(w.__acMeshCap) : undefined) ?? MESH_TOKEN_CAP_VERTICES,
    knobs: __TEST_TOOLS__
      ? () => ({
          delayMs: num(w.__acMeshDelay),
          slow: num(w.__acMeshSlow),
          fail:
            w.__acMeshFail === "throw" || w.__acMeshFail === "hang" ? w.__acMeshFail : undefined,
        })
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
