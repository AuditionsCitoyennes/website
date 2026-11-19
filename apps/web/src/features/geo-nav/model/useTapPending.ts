// The pending state of a tapped territory, on the page (the rule is
// tapPendingCore.ts): the map's mark through GeoDrillMap (`markPending`,
// `endPending`, `pendingEnded`: a flat fill and a loading line, the same
// whatever tapped), the unit pending as a ref (the panel list's aria-busy),
// the polite sentence said once its plateau stands, the frame the mark may
// get to itself before the selection is written (`ac:tap-frame`), and the
// sign of a long wait (`ac:slow-sign`, slowSignSwitch.ts): its stage as a
// ref (the breadcrumb's dots, the panel's sentence and its « Réessayer »),
// and the landing the sign waits for.
import { onScopeDispose, ref, watch, type Ref } from "vue";
import { tapAnswerMode, tapFrameMode, tapMarkFor, type TapMark } from "@/features/map";
import type { GeoUnit } from "@/features/geo";
import { perfNote, perfOn, perfProbe } from "@/shared/perf/perf";
import type { NavState } from "../navState";
import { slowSignMode } from "./slowSignSwitch";
import {
  createTapFrame,
  createTapPending,
  type PendingEnd,
  type PendingUnit,
  type SettleHow,
  type WaitStage,
} from "./tapPendingCore";

export interface TapPendingInputs {
  nav: NavState;
  /** GeoDrillMap, once mounted: its pending mark. */
  mapCmp: Ref<{
    markPending: (
      id: string,
      mark: TapMark,
      again?: boolean,
    ) => "shown" | "none" | "standing" | "unavailable";
    endPending: (how: "rise" | "off" | "drain") => void;
    pendingEnded: (id: string) => void;
  } | null>;
  /** « Réessayer »: ask again the one piece `unit`'s plateau still misses
   *  (GeoNav: its outline's file, else the plateau's own run). */
  reask: (unit: PendingUnit) => void;
}

export function useTapPending({ nav, mapCmp, reask }: TapPendingInputs) {
  /** The unit tapped whose plateau is on its way, null when none. */
  const pendingUnit = ref<PendingUnit | null>(null);
  /** The long wait's stage: "moving", the sign shows; "late", the sentence. */
  const waitStage = ref<WaitStage>("none");
  /** The polite live region's sentence. */
  const live = ref("");

  // The testing tools: how each pending state ended, and how long it was held.
  const ends: Record<string, number> = {};
  let last: { id: string; end: PendingEnd; heldMs: number } | null = null;
  // …how often the long wait reached each stage, and the pieces asked again.
  const waits: Record<string, number> = {};
  let reasked = 0;
  if (perfOn) {
    perfProbe("tap-pending", {
      read: () => ({
        pending: pendingUnit.value?.id ?? null,
        wait: waitStage.value,
        waits: { ...waits },
        reasked,
        ends: { ...ends },
        last,
      }),
      reset: () => {
        for (const k of Object.keys(ends)) delete ends[k];
        for (const k of Object.keys(waits)) delete waits[k];
        reasked = 0;
        last = null;
      },
    });
  }

  const core = createTapPending({
    mark: (unit, again) => {
      // The same mark whatever tapped: a mouse, a finger, a pen, a key.
      const mark = tapMarkFor(tapAnswerMode.value);
      if (!mark.line && !mark.fill) return false;
      // Pending whether or not the map could draw it (a row of a unit with no
      // outline in memory): the list is busy and the sentence is said alike.
      // Not when no verdict would end it: the unit's plateau stands, or
      // there is no map.
      const shown = mapCmp.value?.markPending(unit.id, mark, again) ?? "unavailable";
      return shown === "shown" || shown === "none";
    },
    unmark: (how) => mapCmp.value?.endPending(how),
    scopeId: () => nav.currentScope.value.id,
    inMicroZone: () => nav.inMicroZone.value,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (timer) => window.clearTimeout(timer as number),
    onChange: (unit) => (pendingUnit.value = unit),
    say: (text) => (live.value = text),
    onEnd: (unit, end, heldMs) => {
      // The map lets go of what it kept for the unit (how far its data had
      // come) — not when a newer tap replaced the state: that tap has
      // already marked its own unit, the same one included.
      if (end !== "replaced") mapCmp.value?.pendingEnded(unit.id);
      if (!perfOn) return;
      ends[end] = (ends[end] ?? 0) + 1;
      last = { id: unit.id, end, heldMs: Math.round(heldMs) };
      perfNote("tap.pending", heldMs, { id: unit.id, end });
    },
    now: () => performance.now(),
    slowSign: () => slowSignMode.value === "on",
    onWait: (stage) => {
      waitStage.value = stage;
      if (perfOn && stage !== "none") waits[stage] = (waits[stage] ?? 0) + 1;
    },
    reask: (unit) => {
      if (perfOn) reasked++;
      reask(unit);
    },
  });

  const frame = createTapFrame({
    afterPaint: (fn) =>
      requestAnimationFrame(() => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          channel.port1.close();
          fn();
        };
        channel.port2.postMessage(0);
      }),
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (timer) => window.clearTimeout(timer as number),
  });

  // Every write of the scope, at the write itself: a verdict of the map's is
  // read against the scope as it is when it comes.
  watch(
    () => nav.currentScope.value.id,
    (id) => core.scopeChanged(id),
    { flush: "sync" },
  );
  onScopeDispose(() => {
    frame.cancel();
    core.dispose();
  });

  /**
   * A tap selects `unit`: it is marked pending now, then `write` (the
   * selection itself: the scope, the camera) runs — in this same task, or,
   * with `ac:tap-frame=own`, right after the frame that shows the mark. The
   * last tap wins: a selection still waiting for its frame is dropped.
   */
  function select(unit: GeoUnit, write: () => void) {
    frame.cancel();
    const marked = core.begin({ id: unit.id, label: unit.label, count: unit.count });
    if (marked && tapFrameMode.value === "own") frame.after(write);
    else write();
  }

  return {
    pendingUnit,
    live,
    waitStage,
    select,
    /** The map has reported a view (GeoDrillMap's `viewChange`): the pending
     *  unit's flight has landed, which the long wait's sign waits for. */
    landed: () => core.landed(),
    /** « Réessayer », under the late sentence: the wait starts over and the
     *  missing piece is asked again. False: there was nothing to try again. */
    retry: () => core.retry(),
    /** Another action took over (a crumb, a lieu): a selection still waiting
     *  for its frame is dropped, and its mark with it. */
    cancelWaiting: () => {
      if (!frame.waiting()) return;
      frame.cancel();
      core.abandon();
    },
    /** GeoDrillMap's `plateauSettled`. */
    settled: (scopeId: string, how: SettleHow) => core.settled(scopeId, how),
  };
}

export type TapPending = ReturnType<typeof useTapPending>;
