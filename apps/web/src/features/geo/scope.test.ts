// The scope read off the view (scope.ts) and its hold: how much of a zone is
// in view and how much of the view it covers, the keep rule's two tests, and
// the walk with a held zone — kept through a pan while it is in view,
// released once it is not, depth following the view as without a hold. Run
// with `node --import tsx --test` (root "test:scripts"). Pure: no Vue, no
// alias.

import assert from "node:assert/strict";
import { test } from "node:test";
import { inViewShares, KEEP_VIEW_SHARE, KEEP_ZONE_SHARE, keptInView, scopeForView } from "./scope";
import type { Bounds, GeoUnit, LevelKey } from "./types";

const box = (minLng: number, minLat: number, maxLng: number, maxLat: number): Bounds => ({
  minLat,
  maxLat,
  minLng,
  maxLng,
});

/** A unit over `bounds`, its children wired to it (parent, ancestors). */
function unit(id: string, levelKey: LevelKey, bounds: Bounds, children: GeoUnit[] = []): GeoUnit {
  const u: GeoUnit = {
    id,
    depth: 0,
    levelKey,
    label: id,
    parentId: null,
    ancestors: [],
    heightClass: "country" as GeoUnit["heightClass"],
    count: 1,
    center: [(bounds.minLat + bounds.maxLat) / 2, (bounds.minLng + bounds.maxLng) / 2],
    bounds,
    children,
  };
  const adopt = (parent: GeoUnit, chain: readonly string[]) => {
    for (const c of parent.children) {
      c.parentId = parent.id;
      c.ancestors = [...chain, parent.id];
      c.depth = c.ancestors.length;
      adopt(c, c.ancestors);
    }
  };
  adopt(u, []);
  return u;
}

// Three countries side by side, 10° square each (lat 0…10); A, the middle
// one, has two régions, each a quarter of it.
//   C: lng −10…0   A: lng 0…10 (A1: its south-west, A2: its north-east)   B: lng 10…20
function world() {
  const a1 = unit("A1", "region", box(0, 0, 5, 5));
  const a2 = unit("A2", "region", box(5, 5, 10, 10));
  const a = unit("A", "country", box(0, 0, 10, 10), [a1, a2]);
  const b = unit("B", "country", box(10, 0, 20, 10));
  const c = unit("C", "country", box(-10, 0, 0, 10));
  const root = unit("world", "world", box(-180, -85, 180, 85), [c, a, b]);
  return { root, a, a1, a2, b, c };
}
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9);
const chain = (...ids: string[]) => new Set(["world", ...ids]);
/** A view `w` × `h` degrees centred on (lng, lat). */
const viewAt = (lng: number, lat: number, w: number, h = w): Bounds =>
  box(lng - w / 2, lat - h / 2, lng + w / 2, lat + h / 2);

test("inViewShares: the zone's share in view and the view's share covered", () => {
  // Whole in a view four times its area.
  assert.deepEqual(inViewShares(box(0, 0, 10, 10), box(-5, -5, 15, 15)), { zone: 1, view: 0.25 });
  // Half of it past the view's edge.
  const half = inViewShares(box(0, 0, 10, 10), box(5, -5, 25, 15));
  assert.equal(half.zone, 0.5);
  assert.equal(half.view, 0.125);
  // Out of view, and just touching it.
  assert.deepEqual(inViewShares(box(0, 0, 10, 10), box(11, 0, 21, 10)), { zone: 0, view: 0 });
  assert.deepEqual(inViewShares(box(0, 0, 10, 10), box(10, 0, 20, 10)), { zone: 0, view: 0 });
  // Larger than the screen: little of it is in view, and it is all that is seen.
  const large = inViewShares(box(0, 0, 100, 100), box(40, 40, 50, 50));
  near(large.zone, 0.01);
  assert.equal(large.view, 1);
});

test("inViewShares: a zone of one point, a view of no size, a box past ±180", () => {
  // A point counts as whole when the view holds it, as nothing when not.
  assert.equal(inViewShares(box(5, 5, 5, 5), box(0, 0, 10, 10)).zone, 1);
  assert.equal(inViewShares(box(5, 5, 5, 5), box(6, 0, 10, 10)).zone, 0);
  // A segment counts along its length.
  assert.equal(inViewShares(box(0, 5, 10, 5), box(5, 0, 20, 10)).zone, 0.5);
  assert.deepEqual(inViewShares(box(0, 0, 10, 10), box(5, 5, 5, 9)), { zone: 0, view: 0 });
  // Russia's box runs to 191° east: a view over Chukotka at −175 meets it.
  const ru = box(19.6387, 41.1851, 190.99232, 81.85905);
  const chukotka = inViewShares(ru, box(-180, 60, -170, 70));
  assert.equal(chukotka.view, 1);
  assert.ok(chukotka.zone > 0);
  // And a view over Alaska at −150 does not.
  assert.deepEqual(inViewShares(ru, box(-155, 60, -145, 70)), { zone: 0, view: 0 });
});

test("keptInView: a tenth of the zone in view, or a tenth of the view covered", () => {
  assert.equal(KEEP_ZONE_SHARE, 0.1);
  assert.equal(KEEP_VIEW_SHARE, 0.1);
  const zone = box(0, 0, 10, 10);
  // A view as large as the zone, slid east: 20 %, 10 % and 5 % of it left.
  assert.equal(keptInView(zone, box(8, 0, 18, 10)), true);
  assert.equal(keptInView(zone, box(9, 0, 19, 10)), true);
  assert.equal(keptInView(zone, box(9.5, 0, 19.5, 10)), false);
  assert.equal(keptInView(zone, box(30, 0, 40, 10)), false);
  // A zone ten times the view each way: never a tenth of it in view, kept
  // while it covers a tenth of the view.
  const large = box(0, 0, 100, 100);
  assert.equal(keptInView(large, box(96, 40, 106, 50)), true); // 40 % of the view
  assert.equal(keptInView(large, box(99.5, 40, 109.5, 50)), false); // 5 %
  // A small zone in a large view: all of it in view, a speck of the view.
  assert.equal(keptInView(box(0, 0, 1, 1), box(-50, -50, 50, 50)), true);
});

test("without a hold: the centre rule, a neighbour's box takes the branch", () => {
  const { root } = world();
  // A framed (it spans 0.8 of the view), the scope A.
  assert.equal(scopeForView(root, viewAt(5, 5, 12.5), chain("A")).id, "A");
  // Slid east until the centre is in B's box: 30 % of A still in view.
  const slid = viewAt(13.25, 5, 12.5);
  near(inViewShares(box(0, 0, 10, 10), slid).zone, 0.3);
  assert.equal(scopeForView(root, slid, chain("A")).id, "B");
  // The same with no zone held.
  assert.equal(scopeForView(root, slid, chain("A"), undefined, null).id, "B");
});

test("a held zone survives a pan while it is in view, and is released past it", () => {
  const { root, a } = world();
  const prefer = chain("A");
  // 30 %, then 12 % of A in view, the centre well inside B: A is kept.
  assert.equal(scopeForView(root, viewAt(13.25, 5, 12.5), prefer, undefined, a).id, "A");
  assert.equal(scopeForView(root, viewAt(15.05, 5, 12.5), prefer, undefined, a).id, "A");
  // 6 % of it left: released, the walk is the one without a hold.
  const gone = viewAt(15.65, 5, 12.5);
  assert.equal(keptInView(a.bounds, gone), false);
  assert.equal(scopeForView(root, gone, prefer, undefined, a).id, "B");
  assert.equal(scopeForView(root, gone, prefer).id, "B");
  // Out of view altogether: the walk without a hold, again.
  const far = viewAt(40, 5, 12.5);
  assert.equal(
    scopeForView(root, far, prefer, undefined, a).id,
    scopeForView(root, far, prefer).id,
  );
});

test("the way back restores the held zone: a scope the view arrived at is not held", () => {
  const { root, a, b } = world();
  // Released onto B (the view's doing): B is the scope, A the zone once held.
  // The caller holds nothing then (the scope is not the held zone): sliding
  // back onto A, the centre rule gives A again.
  assert.equal(scopeForView(root, viewAt(5, 5, 12.5), chain("B"), undefined, null).id, "A");
  // Had B been held, it would have stayed while a tenth of it is in view.
  assert.equal(scopeForView(root, viewAt(5, 5, 12.5), chain("B"), undefined, b).id, "B");
  assert.equal(scopeForView(root, viewAt(5, 5, 12.5), chain("A"), undefined, a).id, "A");
});

test("depth is not held: zooming out past the zone, zooming in onto a child", () => {
  const { root, a } = world();
  const prefer = chain("A");
  // Out: A spans 0.4 of the view, under the hold's 0.5 — the world.
  assert.equal(scopeForView(root, viewAt(5, 5, 25), prefer, undefined, a).id, "world");
  assert.equal(scopeForView(root, viewAt(5, 5, 25), prefer).id, "world");
  // In, over A1: it fills the view — entered, as without a hold.
  assert.equal(scopeForView(root, viewAt(2.5, 2.5, 6), prefer, undefined, a).id, "A1");
  assert.equal(scopeForView(root, viewAt(2.5, 2.5, 6), prefer).id, "A1");
});

test("under a held zone, only a child that holds the centre is entered", () => {
  const { root, a } = world();
  // The centre in B, A's edge in view (16 % of it) and A2 wide enough to
  // fill the view (0.625 of it): A is kept, and A2, which does not hold the
  // centre, is not entered for being the nearest.
  const view = viewAt(12, 5, 8);
  near(inViewShares(a.bounds, view).zone, 0.16);
  assert.equal(scopeForView(root, view, chain("A"), undefined, a).id, "A");
  // The centre back inside A, between no child's box: the nearest child, as
  // without a hold.
  const sparse = unit("S", "country", box(0, 0, 10, 10), [unit("S1", "region", box(0, 0, 4, 10))]);
  const w = unit("world", "world", box(-180, -85, 180, 85), [sparse]);
  const inside = viewAt(6, 5, 6);
  assert.equal(scopeForView(w, inside, chain("S")).id, "S1");
  assert.equal(scopeForView(w, inside, chain("S"), undefined, sparse).id, "S1");
});

test("a held zone deep in the tree keeps its whole branch", () => {
  const { root, a1 } = world();
  // A1 (lng 0…5) framed, then slid west until the centre has left A1 and A
  // for C's box: 20 % of A1 still in view.
  const prefer = chain("A", "A1");
  const framed = viewAt(2.5, 2.5, 6.25, 12.5);
  assert.equal(scopeForView(root, framed, prefer, undefined, a1).id, "A1");
  const slid = viewAt(-2.125, 2.5, 6.25, 12.5);
  near(inViewShares(a1.bounds, slid).zone, 0.2);
  assert.equal(scopeForView(root, slid, prefer, undefined, a1).id, "A1");
  // Without the hold the walk leaves the branch for the neighbour country.
  assert.equal(scopeForView(root, slid, prefer).id, "C");
});

test("a zone larger than the screen is kept by the share of the view it covers", () => {
  const big = unit("BIG", "country", box(0, 0, 100, 100));
  const far = unit("FAR", "country", box(100, 0, 200, 100));
  const root = unit("world", "world", box(-180, -85, 180, 85), [big, far]);
  // Zoomed in on BIG's eastern border: under a hundredth of BIG in view,
  // 40 % of the view covered, the centre past the border.
  const view = box(96, 40, 106, 50);
  assert.ok(inViewShares(big.bounds, view).zone < KEEP_ZONE_SHARE);
  assert.equal(scopeForView(root, view, chain("BIG")).id, "FAR");
  assert.equal(scopeForView(root, view, chain("BIG"), undefined, big).id, "BIG");
  // 5 % of the view: released.
  assert.equal(
    scopeForView(root, box(99.5, 40, 109.5, 50), chain("BIG"), undefined, big).id,
    "FAR",
  );
});

// Two départements whose BOXES overlap, as the French ones do (Vienne, in
// Isère, lies inside the box of Rhône): D1's box is lng 0…10 but its contour
// stops at lng 6, where D2 (lng 6…16) begins. `nearBox` is how far east the
// box of c2, D1's commune by the border, runs (its contour stops at lng 6).
//   D1: c1 (lng 0…3), c2 (lng 4…nearBox)      D2: e1 (lng 6.2…8.2)
function overlapping(nearBox = 6) {
  const c1 = unit("c1", "city", box(0, 0, 3, 10));
  const c2 = unit("c2", "city", box(4, 4, nearBox, 6));
  const d1 = unit("D1", "dep", box(0, 0, 10, 10), [c1, c2]);
  const e1 = unit("e1", "city", box(6.2, 4, 8.2, 6));
  const d2 = unit("D2", "dep", box(6, 0, 16, 10), [e1]);
  const root = unit("world", "world", box(-180, -85, 180, 85), [d1, d2]);
  const inBox = (u: GeoUnit, lat: number, lng: number) =>
    lat >= u.bounds.minLat &&
    lat <= u.bounds.maxLat &&
    lng >= u.bounds.minLng &&
    lng <= u.bounds.maxLng;
  // The contours: D1 and its communes west of lng 6, D2 and e1 east of it.
  const contour = (u: GeoUnit, lat: number, lng: number) =>
    inBox(u, lat, lng) && (u.id === "D2" || u.id === "e1" ? lng >= 6 : lng < 6);
  return { root, d1, contour };
}

test("under a held zone, ground a neighbour's contour holds enters none of its children", () => {
  const { root, d1, contour } = overlapping();
  const prefer = chain("D1");
  // Zoomed in on e1, across the border: inside D1's box (which covers all of
  // the view, so D1 is kept), outside its contour.
  const view = viewAt(7.2, 5, 2);
  assert.equal(inViewShares(d1.bounds, view).view, 1);
  // Without a hold the contours hand the branch to D2, then to its commune.
  assert.equal(scopeForView(root, view, prefer, contour).id, "e1");
  // Held: D1 itself — not c2, its commune nearest the centre, which does not
  // hold it.
  assert.equal(scopeForView(root, view, prefer, contour, d1).id, "D1");
  // The same when c2's BOX runs over the centre: a box is no proof against
  // the neighbour's contour.
  const wide = overlapping(7.5);
  assert.equal(scopeForView(wide.root, view, prefer, wide.contour, wide.d1).id, "D1");
  // The centre back inside D1's contour, over c2: entered, as without a hold.
  const over = viewAt(5, 5, 2);
  assert.equal(scopeForView(root, over, prefer, contour, d1).id, "c2");
  assert.equal(scopeForView(root, over, prefer, contour).id, "c2");
});

test("under a held zone with no contour to say where the centre is, the walk is the one without a hold", () => {
  const { root, d1 } = overlapping();
  const prefer = chain("D1");
  // No contour is loaded: D1's box holds the centre and D1 is the incumbent,
  // so its nearest commune is entered — held or not.
  const view = viewAt(7.2, 5, 2);
  assert.equal(scopeForView(root, view, prefer).id, "c2");
  assert.equal(scopeForView(root, view, prefer, undefined, d1).id, "c2");
  const none = () => false; // contours asked for, none loaded yet
  assert.equal(scopeForView(root, view, prefer, none).id, "c2");
  assert.equal(scopeForView(root, view, prefer, none, d1).id, "c2");
});
