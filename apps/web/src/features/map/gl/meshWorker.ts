// The mesh worker's entry (ac:mesh=worker): wires meshCore.ts to the worker
// scope. Every reply goes with its mesh's buffers transferred (meshBuffers),
// so the worker keeps none of them. Imports only the pure core: nothing that
// touches `window` (no @/shared/perf) and no mapbox-gl (lib/corePurity.test.ts).

import { createMeshCore, type MeshMessage, type MeshReply } from "./meshCore";
import { meshBuffers } from "./meshFlat";

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<MeshMessage>) => void) | null;
  postMessage: (m: MeshReply, transfer: Transferable[]) => void;
};

const core = createMeshCore({
  post: (reply) => scope.postMessage(reply, reply.t === "mesh" ? meshBuffers(reply.mesh) : []),
  schedule: (fn, ms) => void setTimeout(fn, ms),
});
scope.onmessage = (e) => core.receive(e.data);
