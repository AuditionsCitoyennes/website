// The PENDING state of a tapped territory, apart from the page (useTapPending
// wires it): from the tap that selects a unit until its plateau commits, the
// unit is "pending" — the map marks it (GeoDrillMap.markPending: a stroke
// along its boundary, a flat fill on a touch screen, its pill), the panel's
// list is busy, and one sentence is said when it is ready. This is the rule
// of when that state begins and ends, and of the frame the mark may get to
// itself. No import: loadable under node (tapPendingCore.test.ts).
//
// It ends:
// - "risen": the unit's plateau has committed (the pipeline's verdict "rise",
//   or "same" / "quiet" when it was standing already) — the mark fades as the
//   plateau rises, and the sentence is said;
// - "moved": the scope went to another unit without a tap (a pan or a zoom
//   that changed it, a crumb) — a pan that leaves the scope alone ends nothing;
// - "none": the pipeline's verdict for this unit is that nothing rises
//   ("cleared": a unit with no outline of its own; "failed") — not while the
//   map is deep among the lieux, where a clear says nothing of the unit yet;
// - "replaced": a newer tap — the last tap wins, its mark replaces this one
//   in its own frame;
// - "timeout": nothing above came within PENDING_CAP_MS — a safety, so that
//   no mark outlives a run that never reports.
// A verdict or a scope move is read only once the scope has been written to
// the pending unit: with the mark in a frame of its own (`ac:tap-frame=own`)
// the scope follows a frame later, and what the map says meanwhile is about
// the unit being left.
//
// The sign of a long wait (`slowSign`, the page's ac:slow-sign). While a unit
// is pending, once its flight has landed (`landed()`: the first view the map
// reports after the selection was written; LANDING_CAP_MS after the tap when
// none comes) and SLOW_SIGN_FLOOR_MS at least after the tap, the wait is
// "moving": the page shows its small moving sign. SLOW_WAIT_MS after the tap
// with no verdict the wait is "late": the mark drains from the map, the
// list is no longer busy, and the page says LATE_SENTENCE with a
// « Réessayer ». The state lives on: a plateau that commits after all is
// still said, and a scope move, a newer tap or a verdict that nothing rises
// still end it. `retry()` (the button) starts the wait over: the unit marked
// again, the sign moving at once, `reask` asked for the one missing piece,
// late again SLOW_WAIT_MS later. With the sign on, no state ends on "timeout".

/** The unit a pending state is about: what the sentence needs of it. */
export interface PendingUnit {
  id: string;
  label: string;
  /** Its testimonies. */
  count: number;
}

/** How a pending state ended. */
export type PendingEnd = "risen" | "moved" | "none" | "replaced" | "timeout";

/** The plateau pipeline's verdicts (the map's PlateauSettle). */
export type SettleHow = "rise" | "same" | "quiet" | "cleared" | "failed";

/** After this long with no verdict the mark goes, ms: past the outline's
 *  1.2 s wait and the slowest measured transition (about 3 s) with room. */
export const PENDING_CAP_MS = 8000;

/** The long wait's sign: none, the moving sign, or the sentence and its
 *  « Réessayer » (the mark gone). */
export type WaitStage = "none" | "moving" | "late";

/** No sign sooner than this after the tap, ms: under a second a moving sign
 *  only flickers. */
export const SLOW_SIGN_FLOOR_MS = 800;
/** After this long with no verdict the wait is "late", ms. The sign has then
 *  moved for 4.2 s at most (WCAG 2.2.2: no motion past five seconds). */
export const SLOW_WAIT_MS = 5000;
/** A flight whose landing was never reported counts as landed this long
 *  after the tap, ms (the longest camera flight, with room). */
export const LANDING_CAP_MS = 2500;
/** What the panel says once the wait is late. */
export const LATE_SENTENCE = "La carte met plus de temps que prévu.";

/** What is said, politely, once the tapped territory stands: its name and
 *  its testimonies. French typography: a no-break space before the colon. */
export function readySentence(unit: PendingUnit): string {
  const n = Math.max(0, Math.round(unit.count));
  const what = n === 0 ? "aucun témoignage" : n === 1 ? "1 témoignage" : `${n} témoignages`;
  return `${unit.label} affiché sur la carte : ${what}.`;
}

export interface TapPendingDeps {
  /** Show the mark on the map for `unit` (replacing any other); false: the
   *  switch is off, there is no pending state at all. */
  mark(unit: PendingUnit): boolean;
  /** End the mark on the map: fading as the plateau rises ("rise"), at once
   *  ("off"), or fading where it stands, no plateau having come ("drain"). */
  unmark(how: "rise" | "off" | "drain"): void;
  /** The scope's unit now. */
  scopeId(): string;
  /** The map is deep among the lieux (no plateau stands there). */
  inMicroZone(): boolean;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  /** The pending unit changed (null: none): the list's busy state. */
  onChange(unit: PendingUnit | null): void;
  /** The polite live region's text ("" clears it). */
  say(text: string): void;
  /** The testing tools' count of how each state ended. */
  onEnd?(unit: PendingUnit, end: PendingEnd, heldMs: number): void;
  now(): number;
  /** The long wait's sign is on (read at each tap); absent: off. */
  slowSign?(): boolean;
  /** The long wait's stage changed, for `unit` (null with "none"). */
  onWait?(stage: WaitStage, unit: PendingUnit | null): void;
  /** « Réessayer »: ask again the one piece `unit`'s plateau still misses. */
  reask?(unit: PendingUnit): void;
}

interface Pending {
  unit: PendingUnit;
  scoped: boolean;
  t0: number;
  /** The cap's timer or, with the sign on, the one that turns the wait late. */
  timer: unknown;
  /** The long wait's sign is on for this state. */
  slow: boolean;
  stage: WaitStage;
  /** SLOW_SIGN_FLOOR_MS have passed; the flight has landed. */
  floor: boolean;
  landed: boolean;
  floorTimer: unknown;
  landTimer: unknown;
}

export function createTapPending(deps: TapPendingDeps) {
  let current: Pending | null = null;

  function clearTimers(c: Pending) {
    deps.clearTimer(c.timer);
    if (c.floorTimer !== null) deps.clearTimer(c.floorTimer);
    if (c.landTimer !== null) deps.clearTimer(c.landTimer);
    c.floorTimer = c.landTimer = null;
  }

  function end(how: PendingEnd) {
    const was = current;
    if (!was) return;
    current = null;
    clearTimers(was);
    deps.onEnd?.(was.unit, how, deps.now() - was.t0);
    if (was.stage !== "none") deps.onWait?.("none", null);
    if (how === "replaced") return; // the newer mark has taken its place
    // A late wait's mark went when it turned late.
    if (was.stage !== "late") deps.unmark(how === "risen" ? "rise" : "off");
    deps.onChange(null);
    if (how === "risen") deps.say(readySentence(was.unit));
    else if (was.stage === "late") deps.say(""); // the late sentence holds no more
  }

  /** The moving sign, once the flight has landed and the floor has passed. */
  function showSign(c: Pending) {
    if (current !== c || c.stage !== "none" || !c.floor || !c.landed) return;
    c.stage = "moving";
    deps.onWait?.("moving", c.unit);
  }

  /** SLOW_WAIT_MS with no verdict: the mark goes, the sentence is said. */
  function turnLate(c: Pending) {
    if (current !== c) return;
    clearTimers(c);
    c.stage = "late";
    deps.unmark("drain");
    deps.onChange(null);
    deps.onWait?.("late", c.unit);
    deps.say(LATE_SENTENCE);
  }

  /** A tap has selected `unit`: it is pending from now. Call it BEFORE the
   *  scope is written. False: no pending state (the switch is off). */
  function begin(unit: PendingUnit): boolean {
    const had = current !== null;
    if (current) end("replaced");
    // The same sentence twice in a row is not said twice: cleared first.
    deps.say("");
    if (!deps.mark(unit)) {
      // Switched off since the last tap: that tap's mark goes too.
      if (had) deps.unmark("off");
      deps.onChange(null);
      return false;
    }
    const slow = deps.slowSign?.() ?? false;
    const c: Pending = {
      unit,
      scoped: deps.scopeId() === unit.id,
      t0: deps.now(),
      timer: null,
      slow,
      stage: "none",
      floor: false,
      landed: false,
      floorTimer: null,
      landTimer: null,
    };
    if (slow) {
      c.timer = deps.setTimer(() => turnLate(c), SLOW_WAIT_MS);
      c.floorTimer = deps.setTimer(() => {
        c.floorTimer = null;
        c.floor = true;
        showSign(c);
      }, SLOW_SIGN_FLOOR_MS);
      c.landTimer = deps.setTimer(() => {
        c.landTimer = null;
        c.landed = true;
        showSign(c);
      }, LANDING_CAP_MS);
    } else c.timer = deps.setTimer(() => end("timeout"), PENDING_CAP_MS);
    current = c;
    deps.onChange(unit);
    return true;
  }

  /** The scope is `id` now (every write of it). */
  function scopeChanged(id: string) {
    if (!current) return;
    if (id === current.unit.id) current.scoped = true;
    else if (current.scoped) end("moved");
  }

  /** The plateau pipeline's verdict for unit `scopeId` ("" for a clear). */
  function settled(scopeId: string, how: SettleHow) {
    if (!current || !current.scoped) return;
    if (how === "rise" || how === "same" || how === "quiet") {
      // Another unit's plateau: its run was the one being left.
      if (scopeId === current.unit.id) end("risen");
      return;
    }
    if (how === "cleared" && deps.inMicroZone()) return;
    if (how === "failed" && scopeId !== current.unit.id) return;
    end("none");
  }

  /** The map has reported a view: the pending unit's flight has landed (or
   *  the user took the camera). Read only once the scope has been written
   *  to the unit: a view before that is of the unit being left. */
  function landed() {
    const c = current;
    if (!c || !c.slow || !c.scoped || c.landed) return;
    c.landed = true;
    if (c.landTimer !== null) deps.clearTimer(c.landTimer);
    c.landTimer = null;
    showSign(c);
  }

  /** « Réessayer », while the wait is late: the unit is marked again, the
   *  sign moves at once, `reask` asks for the missing piece, and the wait
   *  turns late again SLOW_WAIT_MS from now. False: nothing to try again (no
   *  late wait; or no mark to be had: its plateau stands after all, the
   *  switch went off — the state then ends). */
  function retry(): boolean {
    const c = current;
    if (!c || c.stage !== "late") return false;
    deps.say("");
    if (!deps.mark(c.unit)) {
      end("none");
      return false;
    }
    c.stage = "moving";
    c.timer = deps.setTimer(() => turnLate(c), SLOW_WAIT_MS);
    deps.onChange(c.unit);
    deps.onWait?.("moving", c.unit);
    deps.reask?.(c.unit);
    return true;
  }

  /** The selection this state was for will not be written (another action
   *  took over while it waited for its frame): the mark goes at once. */
  function abandon() {
    end("moved");
  }

  /** The page is going: no mark, nothing said. */
  function dispose() {
    if (!current) return;
    clearTimers(current);
    current = null;
  }

  return {
    begin,
    scopeChanged,
    settled,
    landed,
    retry,
    abandon,
    dispose,
    /** The unit tapped whose plateau is awaited (a late one too). */
    pending: () => current?.unit ?? null,
    wait: (): WaitStage => current?.stage ?? "none",
  };
}

export interface TapFrameDeps {
  /** Calls back once the next frame has been painted (a requestAnimationFrame
   *  callback, then a task). */
  afterPaint(fn: () => void): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

/** If no frame is painted within this (a hidden tab), the selection is
 *  written anyway, ms. */
export const OWN_FRAME_CAP_MS = 120;

/**
 * The frame the mark gets to itself (`ac:tap-frame=own`): `after(write)` runs
 * `write` — the selection: the scope, the pins, the grey, the camera — once
 * the frame that shows the mark has been painted, or after OWN_FRAME_CAP_MS
 * if none is. One selection waits at a time: a newer one replaces it (the
 * last tap wins), `cancel()` drops it (another action took over).
 */
export function createTapFrame(deps: TapFrameDeps) {
  let waiting: { write: () => void; timer: unknown } | null = null;

  function cancel() {
    if (!waiting) return;
    deps.clearTimer(waiting.timer);
    waiting = null;
  }

  function after(write: () => void) {
    cancel();
    const mine = { write, timer: null as unknown };
    const run = () => {
      if (waiting !== mine) return; // replaced, cancelled, or already run
      deps.clearTimer(mine.timer);
      waiting = null;
      write();
    };
    mine.timer = deps.setTimer(run, OWN_FRAME_CAP_MS);
    waiting = mine;
    deps.afterPaint(run);
  }

  return { after, cancel, waiting: () => waiting !== null };
}
