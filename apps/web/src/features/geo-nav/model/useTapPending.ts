// The pending state of a tapped territory, on the page (the rule is
// tapPendingCore.ts): the map's mark through GeoDrillMap (`markPending`,
// `endPending`), the unit pending as a ref (the panel list's aria-busy), the
// polite sentence said once its plateau stands, the type of the pointer that
// tapped (a touch gets the flat fill: tapAnswerSwitch), and the frame the
// mark may get to itself before the selection is written (`ac:tap-frame`).
import { onScopeDispose, ref, watch, type Ref } from "vue";
import { tapAnswerMode, tapFrameMode, tapIsTouch, tapMarkFor, type TapMark } from "@/features/map";
import type { GeoUnit } from "@/features/geo";
import { perfNote, perfOn, perfProbe } from "@/shared/perf/perf";
import type { NavState } from "../navState";
import {
  createTapFrame,
  createTapPending,
  type PendingEnd,
  type PendingUnit,
  type SettleHow,
} from "./tapPendingCore";

export interface TapPendingInputs {
  nav: NavState;
  /** GeoDrillMap, once mounted: its pending mark. */
  mapCmp: Ref<{
    markPending: (id: string, mark: TapMark) => "shown" | "none" | "standing" | "unavailable";
    endPending: (how: "rise" | "off") => void;
  } | null>;
}

export function useTapPending({ nav, mapCmp }: TapPendingInputs) {
  /** The unit tapped whose plateau is on its way, null when none. */
  const pendingUnit = ref<PendingUnit | null>(null);
  /** The polite live region's sentence. */
  const live = ref("");
  /** The type of the pointer last seen going down on the page. */
  let lastPointer: string | undefined;

  // The testing tools: how each pending state ended, and how long it was held.
  const ends: Record<string, number> = {};
  let last: { id: string; end: PendingEnd; heldMs: number } | null = null;
  if (perfOn) {
    perfProbe("tap-pending", {
      read: () => ({ pending: pendingUnit.value?.id ?? null, ends: { ...ends }, last }),
      reset: () => {
        for (const k of Object.keys(ends)) delete ends[k];
        last = null;
      },
    });
  }

  const core = createTapPending({
    mark: (unit) => {
      const hover = window.matchMedia?.("(hover: hover)").matches ?? true;
      const mark = tapMarkFor(tapAnswerMode.value, tapIsTouch(lastPointer, hover));
      if (!mark.stroke && !mark.fill && !mark.pill) return false;
      // Pending whether or not the map could draw it (a row of a unit with no
      // outline in memory): the list is busy and the sentence is said alike.
      // Not when no verdict would end it: the unit's plateau stands, or
      // there is no map.
      const shown = mapCmp.value?.markPending(unit.id, mark) ?? "unavailable";
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
      if (!perfOn) return;
      ends[end] = (ends[end] ?? 0) + 1;
      last = { id: unit.id, end, heldMs: Math.round(heldMs) };
      perfNote("tap.pending", heldMs, { id: unit.id, end });
    },
    now: () => performance.now(),
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
    select,
    /** Another action took over (a crumb, a lieu): a selection still waiting
     *  for its frame is dropped, and its mark with it. */
    cancelWaiting: () => {
      if (!frame.waiting()) return;
      frame.cancel();
      core.abandon();
    },
    /** GeoDrillMap's `plateauSettled`. */
    settled: (scopeId: string, how: SettleHow) => core.settled(scopeId, how),
    /** The page's pointerdown (capture): which pointer taps. */
    onPointerDown: (e: PointerEvent) => {
      lastPointer = e.pointerType;
    },
  };
}

export type TapPending = ReturnType<typeof useTapPending>;
