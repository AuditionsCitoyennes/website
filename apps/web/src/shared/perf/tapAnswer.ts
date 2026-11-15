// The `tap-answer` probe on the page (testing tools only; the logic and its
// definitions are in tapAnswerCore.ts): from a tap's pointer event to the
// first frame painted after the app issued its answer. Each one is an
// interaction of the perf engine (perf.ts) under the kind "tap-answer" — so
// it has its long frames, its spans and its line in `__acPerf.dump()` like the
// others — with, in its detail, the target's kind (`target`), the pointer's
// type, the press's length (`pressMs`) and how long the app took to issue its
// answer (`answerMs`); the interaction's own `ms` runs to the painted frame.
// The taps seen and answered by kind are the dump's `probes["tap-answer"]`.
//
// The frame painted: a requestAnimationFrame callback, then a message task —
// the first task after that frame's rendering. One callback per answered tap,
// nothing kept running.
//
// A feature names its targets (`perfTapTargets`) and says when it has answered
// (`perfTapAnswered`), each call gated on `perfOn` like the engine's: a
// production build has none of this.

import { perfBegin, perfEnd, perfOn, perfProbe } from "./perf";
import { createTapAnswer, type TapRule } from "./tapAnswerCore";

const KIND = "tap-answer";

function nextPaint(done: () => void) {
  requestAnimationFrame(() => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      done();
    };
    channel.port2.postMessage(0);
  });
}

type Core = ReturnType<typeof createTapAnswer>;

function install(): Core {
  const w = window as unknown as { __acTapProbe?: Core };
  if (w.__acTapProbe) return w.__acTapProbe; // HMR re-evaluating the module
  const core = createTapAnswer({
    now: () => performance.now(),
    nextPaint,
    begin: (id, detail, t0) => perfBegin(KIND, id, detail, t0),
    end: (id) => perfEnd(KIND, id),
  });
  w.__acTapProbe = core;
  const opts = { capture: true, passive: true } as const;
  document.addEventListener("pointerdown", (e) => core.onPointerDown(e), opts);
  document.addEventListener("pointerup", (e) => core.onPointerUp(e), opts);
  document.addEventListener("pointercancel", () => core.onPointerCancel(), opts);
  document.addEventListener("click", (e) => core.onClick(e), opts);
  perfProbe(KIND, { read: core.read, reset: core.reset });
  return core;
}

const core = perfOn ? install() : null;

/** A feature's tap targets: a kind and the selector of its elements, in the
 *  order they are tried. */
export function perfTapTargets(rules: readonly TapRule[]) {
  core?.addRules(rules);
}

/** The app has issued its answer to the tap being handled (`what`: the
 *  answer's id, a unit's). Ignored when no tap is waiting for one: a
 *  selection the camera or the code made. */
export function perfTapAnswered(what: string, detail?: Record<string, unknown>) {
  core?.answered(what, detail);
}
