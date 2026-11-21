// The mesh worker's entry: wires meshCore.ts to the worker
// scope. Every reply goes with its mesh's buffers transferred (meshBuffers),
// a grey sheet's with its triangles', a pending mark's with its line and its
// fill, so the worker keeps none of them. Imports only the pure core: nothing that
// touches `window` (no @/shared/perf) and no mapbox-gl (lib/corePurity.test.ts).

import { createMeshCore, type MeshMessage, type MeshReply } from "./meshCore";
import { meshBuffers } from "./meshFlat";

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<MeshMessage>) => void) | null;
  postMessage: (m: MeshReply, transfer: Transferable[]) => void;
};

const core = createMeshCore({
  post: (reply) =>
    scope.postMessage(
      reply,
      reply.t === "mesh"
        ? meshBuffers(reply.mesh)
        : reply.t === "tint"
          ? [reply.positions.buffer]
          : reply.t === "mark" && reply.built
            ? [reply.built.line.segs.buffer, reply.built.fill.fill.buffer]
            : [],
    ),
  schedule: (fn, ms) => void setTimeout(fn, ms),
});
scope.onmessage = (e) => core.receive(e.data);
