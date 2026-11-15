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
  /** End the mark on the map: fading as the plateau rises, or at once. */
  unmark(how: "rise" | "off"): void;
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
}

export function createTapPending(deps: TapPendingDeps) {
  let current: { unit: PendingUnit; scoped: boolean; t0: number; timer: unknown } | null = null;

  function end(how: PendingEnd) {
    const was = current;
    if (!was) return;
    current = null;
    deps.clearTimer(was.timer);
    deps.onEnd?.(was.unit, how, deps.now() - was.t0);
    if (how === "replaced") return; // the newer mark has taken its place
    deps.unmark(how === "risen" ? "rise" : "off");
    deps.onChange(null);
    if (how === "risen") deps.say(readySentence(was.unit));
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
    current = {
      unit,
      scoped: deps.scopeId() === unit.id,
      t0: deps.now(),
      timer: deps.setTimer(() => end("timeout"), PENDING_CAP_MS),
    };
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

  /** The selection this state was for will not be written (another action
   *  took over while it waited for its frame): the mark goes at once. */
  function abandon() {
    end("moved");
  }

  /** The page is going: no mark, nothing said. */
  function dispose() {
    if (!current) return;
    deps.clearTimer(current.timer);
    current = null;
  }

  return {
    begin,
    scopeChanged,
    settled,
    abandon,
    dispose,
    pending: () => current?.unit ?? null,
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
