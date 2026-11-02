// The relief worker's entry: wires demWorkerCore.ts to the worker scope and
// says it is alive. Imports only the renderer's modules: nothing that touches
// `window` (no @/shared/perf), which a worker has not.

import { createDemWorkerCore, type DemJob, type DemReply } from "./demWorkerCore";

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<DemJob>) => void) | null;
  postMessage: (m: DemReply | { t: "ready" }) => void;
};

const core = createDemWorkerCore((reply) => scope.postMessage(reply));
scope.onmessage = (e) => core.receive(e.data);
scope.postMessage({ t: "ready" });
