// The band above a short phone sheet (useSheetBand) against a fake camera:
// the band applied changes only inside a command's hook or, when no command
// may come, alone as the sheet is lowered after a hand moved the map; a
// refit under the tolerance moves nothing; a list that comes in after the
// flight has landed makes one move under « Rester » (a tap from a full list
// too, when the plateau already clears the sheet's new top) and a second,
// single one under « Recentrer »; a sheet lowered while something loads takes
// the band off at once; raised again after a hand moved the map, nothing
// changes until the next command; a late list's « Rester » steers only that
// list, not a later raise by hand; the filters' dialog holds everything
// until it closes.
// Run with `node --import tsx --test` (root "test:scripts"): the one app
// import with code (shared/device/motion) is mapped to a stub, the page's
// globals are the least the composable reads.

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { effectScope, nextTick, ref, shallowRef, watch } from "vue";

const MOTION_STUB = `data:text/javascript,${encodeURIComponent(
  `export const motionNow = () => globalThis.__motion ?? "full";`,
)}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@/shared/device/motion") return { url: MOTION_STUB, shortCircuit: true };
    return next(specifier, context);
  },
});
const g = globalThis as unknown as Record<string, unknown>;
g.window = globalThis;
g.document = { documentElement: {} };
g.getComputedStyle = () => ({ fontSize: "16px" });

const { useSheetBand } = await import("./useSheetBand");
type Inputs = Parameters<typeof useSheetBand>[0];
type Insets = { top: number; bottom: number; left: number; right: number };

/** A 360×740 phone under « Ajusté, centré », the sheet lowered, the map at
 *  rest; `cmds` counts the camera's commands, `inHook` is on while one runs
 *  its hooks (the only place the band may change with a command). */
function setup(late: "rester" | "recentrer" = "rester") {
  const sheetOpen = ref(false);
  const scopePinned = ref(false);
  const shownPx = ref(316);
  const hold = ref(false);
  const dialog = ref(false);
  const moved = ref(false);
  const fitted = ref(true);
  const box = shallowRef<{
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    w: number;
    h: number;
  } | null>(null);
  const hooks: (() => void)[] = [];
  const cmds: string[] = [];
  let inHook = false;
  const applied = shallowRef<Insets | null>(null);
  const byMap = ref(false);
  const changes: { inHook: boolean; to: Insets | null }[] = [];
  const command = (what: string) => {
    cmds.push(what);
    scopePinned.value = true; // useCamera's setCamera: pinned until it lands
    moved.value = false;
    inHook = true;
    for (const h of hooks) h();
    inHook = false;
  };
  const scope = effectScope();
  const band = scope.run(() => {
    const nav = {
      currentScope: ref({ id: "fr:reg:84" }),
      selectedPlaceId: ref<string | null>(null),
      sheetOpen,
      inMicroZone: ref(false),
      scopePinned,
    } as unknown as Inputs["nav"];
    const b = useSheetBand({
      nav,
      mode: () => "centre",
      late: () => late,
      dialogOpen: () => dialog.value,
      isDesktop: ref(false),
      preview: ref(false),
      fitted,
      shownPx,
      viewportH: ref(740),
      headerClearPx: ref(51),
      sidePx: () => 36,
      hold: () => hold.value,
      readingPlace: () => false,
      plateauBox: () => box.value,
      listMode: ref(false),
      mapCmp: ref({ inUserHands: () => false }) as unknown as Inputs["mapCmp"],
      applied,
      loweredByMap: byMap,
      camera: {
        onBeforeCommand: (h) => hooks.push(h),
        flyToUnit: (_u, animate) => command(animate ? "fit" : "instant"),
        scheduleFilterFrame: () => command("filter"),
        movedSinceCommand: () => moved.value,
      },
    });
    return b;
  })!;
  // Every change of the band applied, and whether a command's hook made it.
  scope.run(() => watch(applied, (to) => changes.push({ inHook, to }), { flush: "sync" }));
  const land = () => (scopePinned.value = false);
  const settle = async () => {
    await nextTick();
    await nextTick();
  };
  const done = () => scope.stop();
  return {
    band,
    applied,
    byMap,
    sheetOpen,
    shownPx,
    hold,
    dialog,
    moved,
    fitted,
    box,
    cmds,
    changes,
    command,
    land,
    settle,
    done,
  };
}

/** Raised over the scope, framed once in the band and landed. */
async function raised(t: ReturnType<typeof setup>) {
  t.sheetOpen.value = true;
  await t.settle();
  assert.deepEqual(t.cmds, ["fit"]);
  assert.deepEqual(t.applied.value, { top: 63, bottom: 328, left: 36, right: 36 });
  t.land();
  t.cmds.length = 0;
}

test("the band applied changes only inside a command's hook; under the tolerance nothing moves", async () => {
  const t = setup();
  // Built with no band applied and none asked for: nothing.
  await t.settle();
  assert.deepEqual(t.cmds, []);
  await raised(t);
  // A refit of 10 px: no move, no band.
  t.shownPx.value = 326;
  await t.settle();
  assert.deepEqual(t.cmds, []);
  assert.equal(t.applied.value!.bottom, 328);
  // A new list in flight: the flight retargeted, the band with it.
  t.command("tap");
  t.shownPx.value = 200;
  await t.settle();
  assert.deepEqual(t.cmds, ["tap", "fit"]);
  assert.equal(t.applied.value!.bottom, 212);
  // The sheet lowered over a map at rest: framed again, the band gone with it.
  t.land();
  t.sheetOpen.value = false;
  await t.settle();
  assert.deepEqual(t.cmds, ["tap", "fit", "fit"]);
  assert.equal(t.applied.value, null);
  // The raise, the tap, its retarget, the lowering: each inside its command.
  assert.equal(t.changes.length, 4);
  assert.ok(t.changes.every((c) => c.inHook));
  t.done();
});

test("a list that comes in after the landing: one move under « Rester »", async () => {
  const t = setup("rester");
  await raised(t);
  // A row tap whose children are on their way: the sheet is held.
  t.hold.value = true;
  t.command("tap");
  await t.settle();
  t.land();
  await t.settle();
  // They come in: the sheet comes down, more map above it.
  t.hold.value = false;
  t.shownPx.value = 200;
  await t.settle();
  assert.deepEqual(t.cmds, ["tap"]);
  assert.equal(t.band.last.value, "stay");
  // Asked again with nothing new (another hold coming and going): it stays.
  t.hold.value = true;
  await t.settle();
  t.hold.value = false;
  await t.settle();
  assert.deepEqual(t.cmds, ["tap"]);
  assert.equal(t.applied.value!.bottom, 328);
  // The next command takes the band of its moment.
  t.command("tap");
  assert.equal(t.applied.value!.bottom, 212);
  t.done();
});

test("a list that comes in after the landing: exactly one more move under « Recentrer »", async () => {
  const t = setup("recentrer");
  await raised(t);
  t.hold.value = true;
  t.command("tap");
  await t.settle();
  t.land();
  await t.settle();
  t.hold.value = false;
  t.shownPx.value = 200;
  await t.settle();
  assert.deepEqual(t.cmds, ["tap", "fit"]);
  t.land();
  t.hold.value = true;
  await t.settle();
  t.hold.value = false;
  await t.settle();
  assert.deepEqual(t.cmds, ["tap", "fit"]);
  t.done();
});

test("a late list that makes the sheet taller frames again whatever the switch", async () => {
  for (const late of ["rester", "recentrer"] as const) {
    const t = setup(late);
    await raised(t);
    t.hold.value = true;
    t.command("tap");
    t.land();
    await t.settle();
    t.hold.value = false;
    t.shownPx.value = 420;
    await t.settle();
    assert.deepEqual(t.cmds, ["tap", "fit"], late);
    t.done();
  }
});

test("lowered after a hand moved the map: the band goes alone, with no command", async () => {
  const t = setup();
  await raised(t);
  t.moved.value = true;
  t.sheetOpen.value = false;
  await t.settle();
  assert.deepEqual(t.cmds, []);
  assert.equal(t.applied.value, null);
  assert.equal(t.band.last.value, "drop");
  assert.deepEqual(t.changes.at(-1), { inHook: false, to: null });
  const changed = t.changes.length;
  // Raised again, the map still where the hand left it: no command, and the
  // camera's padding stays the lowered frame's (a band alone would shrink
  // the rectangle the scope is read off: the scope could descend at rest).
  t.sheetOpen.value = true;
  await t.settle();
  assert.deepEqual(t.cmds, []);
  assert.equal(t.applied.value, null);
  assert.equal(t.band.last.value, "keep");
  // A refit after that, the map still the visitor's: nothing.
  t.shownPx.value = 200;
  await t.settle();
  assert.deepEqual(t.cmds, []);
  assert.equal(t.band.last.value, "keep");
  assert.equal(t.changes.length, changed);
  // The next command takes the band of its moment.
  t.command("tap");
  assert.equal((t.applied.value as Insets | null)?.bottom, 212);
  t.done();
});

test("lowered by the visitor's use of the map: the band stays, nothing moves until a command", async () => {
  for (const moved of [false, true]) {
    const t = setup();
    await raised(t);
    // A drag (the map moved) or a tap on an empty spot (it did not): the
    // sheet comes down for the map (usePanelLayout's lowering).
    t.moved.value = moved;
    t.byMap.value = true;
    t.sheetOpen.value = false;
    await t.settle();
    assert.deepEqual(t.cmds, []);
    assert.equal(t.band.last.value, "keep");
    assert.deepEqual(t.applied.value, { top: 63, bottom: 328, left: 36, right: 36 });
    const changed = t.changes.length;
    // Asked again with nothing new (a hold coming and going): still nothing.
    t.hold.value = true;
    await t.settle();
    t.hold.value = false;
    await t.settle();
    assert.deepEqual(t.cmds, []);
    assert.equal(t.changes.length, changed);
    // The next command (a tapped territory's flight) takes the band of its
    // moment, none under the lowered sheet, and the mark with it.
    t.command("tap");
    assert.equal(t.applied.value, null);
    assert.equal(t.byMap.value, false);
    assert.ok(t.changes.at(-1)!.inHook);
    t.done();
  }
});

test("a territory tapped: lowered for the map in the same tick as its flight, one move", async () => {
  const t = setup();
  await raised(t);
  t.byMap.value = true;
  t.sheetOpen.value = false;
  t.command("tap");
  await t.settle();
  assert.deepEqual(t.cmds, ["tap"]);
  assert.equal(t.applied.value, null);
  assert.ok(t.changes.every((c) => c.inHook));
  t.done();
});

test("lowered while something is still on its way: the band goes at once, nothing moves later", async () => {
  const t = setup();
  await raised(t);
  t.hold.value = true;
  t.command("tap");
  await t.settle();
  t.land();
  await t.settle();
  t.sheetOpen.value = false;
  t.fitted.value = false;
  await t.settle();
  assert.deepEqual(t.cmds, ["tap", "fit"]);
  assert.equal(t.applied.value, null);
  // What was on its way comes in: no move by itself.
  t.hold.value = false;
  await t.settle();
  assert.deepEqual(t.cmds, ["tap", "fit"]);
  t.done();
});

/** Raised over a full list (no band), a row tapped whose list is on its way,
 *  the flight landed; then the short list comes in and the sheet comes down. */
async function fromFull(t: ReturnType<typeof setup>) {
  t.fitted.value = false;
  t.shownPx.value = 675;
  t.sheetOpen.value = true;
  await t.settle();
  assert.equal(t.applied.value, null);
  t.cmds.length = 0;
  t.hold.value = true;
  t.command("tap");
  await t.settle();
  t.land();
  await t.settle();
  t.hold.value = false;
  t.fitted.value = true;
  t.shownPx.value = 250;
  await t.settle();
}

test("a late list after a tap from a full list: framed again unless the plateau already clears the sheet", async () => {
  // The plateau framed in the lowered frame reaches under the new sheet's
  // top (a tall country, say): one more move, whatever the switch.
  for (const late of ["rester", "recentrer"] as const) {
    const t = setup(late);
    t.box.value = { minX: 80, minY: 60, maxX: 280, maxY: 640, w: 360, h: 740 };
    await fromFull(t);
    assert.deepEqual(t.cmds, ["tap", "fit"], late);
    assert.deepEqual(t.applied.value, { top: 63, bottom: 262, left: 36, right: 36 });
    t.done();
  }
  // None in sight (not raised yet): framed again.
  {
    const t = setup();
    await fromFull(t);
    assert.deepEqual(t.cmds, ["tap", "fit"]);
    t.done();
  }
  // Already clear of it (a wide, flat one): left where it is under « Rester »…
  {
    const t = setup();
    t.box.value = { minX: 40, minY: 120, maxX: 320, maxY: 400, w: 360, h: 740 };
    await fromFull(t);
    assert.deepEqual(t.cmds, ["tap"]);
    assert.equal(t.band.last.value, "stay");
    assert.equal(t.applied.value, null);
    t.done();
  }
  // …centred under « Recentrer ».
  {
    const t = setup("recentrer");
    t.box.value = { minX: 40, minY: 120, maxX: 320, maxY: 400, w: 360, h: 740 };
    await fromFull(t);
    assert.deepEqual(t.cmds, ["tap", "fit"]);
    t.done();
  }
});

test("a late list left by « Rester » steers nothing after the sheet is lowered and raised by hand", async () => {
  const t = setup();
  t.box.value = { minX: 40, minY: 120, maxX: 320, maxY: 400, w: 360, h: 740 };
  await fromFull(t);
  assert.deepEqual(t.cmds, ["tap"]);
  assert.equal(t.band.last.value, "stay");
  // Lowered by hand: no band was applied, nothing to take off.
  t.sheetOpen.value = false;
  await t.settle();
  assert.deepEqual(t.cmds, ["tap"]);
  assert.equal(t.applied.value, null);
  // Raised short again, the map not moved: the plateau is framed in the band.
  t.sheetOpen.value = true;
  await t.settle();
  assert.deepEqual(t.cmds, ["tap", "fit"]);
  assert.equal(t.band.last.value, "fit");
  assert.deepEqual(t.applied.value, { top: 63, bottom: 262, left: 36, right: 36 });
  assert.ok(t.changes.every((c) => c.inHook));
  t.done();
});

test("the filters' dialog: nothing while it is open, one fit once it closes", async () => {
  const t = setup();
  await raised(t);
  t.dialog.value = true;
  await t.settle();
  // A chip typed in grows the sheet's head behind the dialog.
  t.shownPx.value = 352;
  await t.settle();
  assert.deepEqual(t.cmds, []);
  assert.equal(t.band.last.value, "dialog");
  t.dialog.value = false;
  await t.settle();
  assert.deepEqual(t.cmds, ["fit"]);
  t.done();
});
