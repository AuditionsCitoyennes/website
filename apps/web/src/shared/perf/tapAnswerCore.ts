// The `tap-answer` probe's logic, apart from the page (tapAnswer.ts installs
// it): how long a tap waits for the app's answer to show.
//
//   start   the pointer event's own timeStamp — the `pointerup` that ends the
//           tap (the browser's clock, before any of our code ran); for a
//           click no pointer made (the keyboard), the click's
//   answer  the app says it has issued its answer to the tap
//           (`answered(what)`: the selection written, the camera commanded)
//   end     the first frame painted after that
//
// A tap is a press and a release less than TAP_SLOP_PX apart (a drag is not
// one). Its target is named by the rules the features register (a kind and a
// CSS selector, the first that matches an ancestor: the map's canvas, a pin, a
// pill, a list row), "other" without a match. The first answer within
// ANSWER_WINDOW_MS of a tap is its answer; a tap is answered once. Taps and
// answers are counted by kind, so the taps nothing answered show (a tap on
// the sea).
//
// No import: loadable under node (tapAnswer.test.ts).

/** A press and a release further apart than this (px) are a drag, not a tap
 *  (mapbox-gl's own click tolerance). */
export const TAP_SLOP_PX = 3;
/** An answer later than this after its tap (ms) is not that tap's. */
export const ANSWER_WINDOW_MS = 5000;

export interface TapRule {
  /** The target's name in the reports: "canvas", "pin", "pill", "row". */
  kind: string;
  /** Matches the target or one of its ancestors. */
  selector: string;
}

/** What the probe reads of a pointer or click event. */
export interface TapEvent {
  timeStamp: number;
  target: unknown;
  clientX?: number;
  clientY?: number;
  pointerId?: number;
  pointerType?: string;
}

/** The kind of a target: the first rule matching it or an ancestor; null: none. */
export function tapKind(target: unknown, rules: readonly TapRule[]): string | null {
  const el = target as { closest?: (selector: string) => unknown } | null;
  if (!el || typeof el.closest !== "function") return null;
  for (const r of rules) if (el.closest(r.selector)) return r.kind;
  return null;
}

export interface TapAnswerDeps {
  now(): number;
  /** Calls back once the next frame has been painted. */
  nextPaint(done: () => void): void;
  /** The interaction begun at `t0` (shared/perf's perfBegin under "tap-answer")… */
  begin(id: string, detail: Record<string, unknown>, t0: number): void;
  /** …and ended now. */
  end(id: string): void;
}

interface Tap {
  t0: number;
  kind: string;
  pointer: string;
  /** The press's length (ms); null for a click no pointer made. */
  pressMs: number | null;
  answered: boolean;
  counted: boolean;
}

export function createTapAnswer(deps: TapAnswerDeps) {
  const rules: TapRule[] = [];
  let down: { x: number; y: number; t: number; id: number | undefined } | null = null;
  let tap: Tap | null = null;
  /** The release ended a drag: the click the browser still sends is not a tap. */
  let dragged = false;
  let taps: Record<string, number> = {};
  let answers: Record<string, number> = {};

  const count = (into: Record<string, number>, kind: string) => {
    into[kind] = (into[kind] ?? 0) + 1;
  };
  /** The event's own time; the handler's where the browser's is not on the
   *  page's clock (an old WebKit: an epoch time). */
  const stamp = (e: TapEvent) => {
    const t = deps.now();
    return e.timeStamp > 0 && e.timeStamp <= t + 1 && t - e.timeStamp < 10_000 ? e.timeStamp : t;
  };

  /** More rules (a feature's); a kind already named keeps its first selector. */
  function addRules(more: readonly TapRule[]) {
    for (const r of more) if (!rules.some((x) => x.kind === r.kind)) rules.push(r);
  }

  function onPointerDown(e: TapEvent) {
    down = { x: e.clientX ?? 0, y: e.clientY ?? 0, t: stamp(e), id: e.pointerId };
    tap = null; // a new press: the tap before it can no longer be answered
    dragged = false;
  }

  /** The browser took the gesture over (a scroll): no tap. */
  function onPointerCancel() {
    down = null;
    tap = null;
  }

  function onPointerUp(e: TapEvent) {
    const d = down;
    down = null;
    tap = null;
    if (!d || d.id !== e.pointerId) return;
    const moved = Math.hypot((e.clientX ?? 0) - d.x, (e.clientY ?? 0) - d.y);
    if (moved > TAP_SLOP_PX) {
      dragged = true;
      return;
    }
    const t0 = stamp(e);
    tap = {
      t0,
      kind: tapKind(e.target, rules) ?? "other",
      pointer: e.pointerType || "unknown",
      pressMs: Math.max(0, Math.round(t0 - d.t)),
      answered: false,
      counted: false,
    };
  }

  /** The click that follows a tap's release counts it; a click no pointer
   *  made (the keyboard on a row) is a tap of its own, from the click's time. */
  function onClick(e: TapEvent) {
    if (dragged) {
      dragged = false;
      return;
    }
    if (!tap || tap.counted) {
      tap = {
        t0: stamp(e),
        kind: tapKind(e.target, rules) ?? "other",
        pointer: "none",
        pressMs: null,
        answered: false,
        counted: false,
      };
    }
    tap.counted = true;
    if (tap.kind !== "other") count(taps, tap.kind);
  }

  /** The app has issued its answer to the last tap. `what`: the answer's id
   *  (the unit selected). False when no tap is waiting for one. */
  function answered(what: string, detail: Record<string, unknown> = {}): boolean {
    const t = tap;
    if (!t || t.answered) return false;
    const at = deps.now();
    if (at - t.t0 > ANSWER_WINDOW_MS) {
      tap = null;
      return false;
    }
    t.answered = true;
    count(answers, t.kind);
    deps.begin(
      what,
      {
        ...detail,
        target: t.kind,
        pointer: t.pointer,
        ...(t.pressMs === null ? {} : { pressMs: t.pressMs }),
        answerMs: Math.round((at - t.t0) * 10) / 10,
      },
      t.t0,
    );
    deps.nextPaint(() => deps.end(what));
    return true;
  }

  return {
    addRules,
    onPointerDown,
    onPointerUp,
    onPointerCancel,
    onClick,
    answered,
    /** The taps seen and answered, by kind ("other" is only counted answered). */
    read: () => ({ taps: { ...taps }, answered: { ...answers } }),
    reset() {
      taps = {};
      answers = {};
    },
  };
}
