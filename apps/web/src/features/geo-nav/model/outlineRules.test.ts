// The explorer's rules over the outline files (outlineRules.ts), against a
// scripted view of the store. Run with `node --import tsx --test` (root
// "test:scripts"). Pure: no Vue; its one app import (the geo barrel) is
// mapped here.

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import type { BundleState, OutlineView, RuleUnit } from "./outlineRules";

const SRC = new URL("../../../", import.meta.url);
registerHooks({
  resolve: (specifier, context, next) =>
    next(
      specifier === "@/features/geo" ? new URL("features/geo/index.ts", SRC).href : specifier,
      context,
    ),
});
const rules = await import("./outlineRules");

const { bundlesFor, geometryFor, raisedGeometryFor, raisedOutlineDue, refinementBatch } = rules;
const DEPTH = { world: 0, country: 1, region: 2, dep: 3, city: 4, arr: 5, place: 6 };
/** A unit centred at (lat, lng), its box `r` degrees each way. */
const unit = (
  id: string,
  parentId: string | null,
  levelKey: RuleUnit["levelKey"],
  lat = 0,
  lng = 0,
  r = 1,
) => ({
  id,
  parentId,
  levelKey,
  depth: DEPTH[levelKey],
  center: [lat, lng] as [number, number],
  bounds: { minLat: lat - r, maxLat: lat + r, minLng: lng - r, maxLng: lng + r },
});

/** A scripted store: rows, selves, loaded bundles' entries, failures. */
function view(mode = "fichiers") {
  const rows = new Map<string, { st: string; k: 0 | 1; u: 0 | 1 }>();
  const selves = new Map<string, object>();
  const bundles = new Map<string, Map<string, object>>();
  const failed = new Set<string>();
  const gaveUp = new Set<string>();
  const v: OutlineView = {
    mode,
    rowOf: (id) => rows.get(id),
    selfOf: (id) => selves.get(id),
    unitsOf: (id) => bundles.get(id),
    bundleState: (id): BundleState =>
      bundles.has(id) ? "loaded" : failed.has(id) ? "failed" : rows.get(id)?.k ? "loading" : "none",
    failed: (id) => failed.has(id),
    gaveUp: (id) => gaveUp.has(id),
  };
  const row = (id: string, st = "e50", k: 0 | 1 = 1, u: 0 | 1 = 1) =>
    void rows.set(id, { st, k, u });
  /** k/<id> lands: its self and its entries (an entry's row unless known). */
  const land = (id: string, entries: [string, object][], self: object = {}) => {
    selves.set(id, self);
    bundles.set(id, new Map(entries));
    for (const [e] of entries) if (!rows.has(e)) row(e, rows.get(id)?.st ?? "e50", 0, 0);
  };
  return { v, selves, bundles, failed, gaveUp, row, land };
}

const WORLD = unit("world", null, "world");
const FR = unit("FR", "world", "country", 46.6, 2.5, 5);
const ARA = unit("fr:reg:84", "FR", "region", 45.5, 4.5, 2);
const BFC = unit("fr:reg:27", "FR", "region", 47.2, 4.8, 1.5);
const PACA = unit("fr:reg:93", "FR", "region", 43.9, 6.1, 1.5);
const OCC = unit("fr:reg:76", "FR", "region", 43.7, 2.1, 2);
const NAQ = unit("fr:reg:75", "FR", "region", 45.2, 0.8, 2);
const BRE = unit("fr:reg:53", "FR", "region", 48.2, -2.9, 1);
const REGIONS = [ARA, BFC, PACA, OCC, NAQ, BRE];
const RHONE = unit("fr:dep:69", ARA.id, "dep", 45.9, 4.6, 0.4);
const LYON = unit("fr:com:69123", RHONE.id, "city", 45.76, 4.84, 0.06);
const LYON_7 = unit("fr:com:69387", LYON.id, "arr", 45.74, 4.84, 0.02);
const VILLEURBANNE = unit("fr:com:69266", RHONE.id, "city", 45.77, 4.89, 0.03);
const pending = (v: OutlineView, ...chain: RuleUnit[]) => rules.scopePendingFiles(v, chain, false);

/** France booted (root.json + k/FR): the régions' rows and fr1000 entries. */
function booted() {
  const t = view();
  t.row("FR", "fr1000", 1, 0);
  for (const r of REGIONS) t.row(r.id);
  t.row(RHONE.id);
  t.land(
    "FR",
    REGIONS.map((r) => [r.id, { fr1000: r.id }]),
  );
  return t;
}

test("FR is drawn with its k/FR self; the world and a lieu with nothing", () => {
  const t = booted();
  assert.equal(geometryFor(t.v, FR), t.selves.get("FR"));
  assert.equal(geometryFor(t.v, WORLD), undefined);
  assert.equal(geometryFor(t.v, unit("l:1", LYON_7.id, "place")), undefined);
  assert.equal(pending(t.v, WORLD), false);
});

test("a région from France holds for its self, rises on its entry once given up", () => {
  const t = booted();
  const c = [WORLD, FR, ARA];
  assert.equal(raisedOutlineDue(t.v, ARA), true);
  assert.equal(pending(t.v, ...c), true);
  assert.equal(raisedGeometryFor(t.v, ARA), t.bundles.get("FR")!.get(ARA.id));
  t.gaveUp.add(ARA.id); // OUTLINE_WAIT_MS passed (useOutlineFiles.holdSelf)
  assert.equal(pending(t.v, ...c), false);
  assert.equal(rules.outlineReadyFiles(t.v, c, false), false); // k/fr_reg_84 on its way
  t.land(ARA.id, [[RHONE.id, {}]]);
  assert.notEqual(raisedGeometryFor(t.v, ARA), t.bundles.get("FR")!.get(ARA.id));
  assert.equal(rules.outlineReadyFiles(t.v, c, false), true);
  assert.equal(rules.scopePendingFiles(t.v, c, true), false); // the lieu zone holds nothing
});

test("a département and a commune reached from their parent never hold", () => {
  const t = booted();
  const rhone = {};
  t.land(ARA.id, [[RHONE.id, rhone]]);
  t.selves.set(RHONE.id, rhone); // the store: one object per id@tier
  assert.equal(pending(t.v, WORLD, FR, ARA, RHONE), false);
  assert.equal(raisedGeometryFor(t.v, RHONE), geometryFor(t.v, RHONE));
  t.land(RHONE.id, [[LYON.id, {}]], rhone);
  t.row(LYON.id, "e50", 1, 0); // Lyon has a bundle (its arrondissements)
  t.selves.set(LYON.id, t.bundles.get(RHONE.id)!.get(LYON.id)!);
  assert.equal(pending(t.v, WORLD, FR, ARA, RHONE, LYON), false);
});

test("a failed file, or a chain settled without a row: known absent, nothing held", () => {
  const t = booted();
  t.failed.add(RHONE.id);
  assert.equal(rules.geometryKnownAbsent(t.v, [WORLD, FR, ARA, RHONE]), true);
  assert.equal(pending(t.v, WORLD, FR, ARA, RHONE), false);
  // A commune absent from the build: pending until its département's bundle is in.
  const u = booted();
  const ghost = unit("fr:com:69999", RHONE.id, "city");
  assert.equal(pending(u.v, WORLD, FR, ARA, RHONE, ghost), true);
  u.land(RHONE.id, [[LYON.id, {}]]);
  assert.equal(rules.geometryKnownAbsent(u.v, [WORLD, FR, ARA, RHONE, ghost]), true);
  assert.equal(pending(u.v, WORLD, FR, ARA, RHONE, ghost), false);
});

test("a country: drawn on its g/, raised on its u/, held for it; c3000 and absent rows unheld", () => {
  const t = booted();
  const globes = new Map<string, object>();
  const v: OutlineView = { ...t.v, globeOf: (id) => globes.get(id) };
  const ES = unit("ES", "world", "country", 40, -3, 10);
  const CA = unit("CA", "world", "country", 60, -100, 30);
  const AQ = unit("AQ", "world", "country", -77, 0, 10);
  t.row("ES", "c300", 0, 1);
  t.row("CA", "c3000", 0, 1);
  t.row("AQ", "c3000", 0, 1);
  for (const id of ["ES", "CA", "AQ"]) t.v.rowOf(id)!.g = 1;
  t.v.rowOf("AQ")!.bounds = { minLat: -85, maxLat: -60, minLng: -180, maxLng: 180 };
  const g = { g: "ES" };
  globes.set("ES", g);
  assert.equal(geometryFor(v, ES), g);
  assert.equal(raisedGeometryFor(v, ES), g); // its u/ not in: the g/ stands in
  assert.equal(raisedOutlineDue(v, ES), true);
  assert.equal(pending(v, WORLD, ES), true);
  assert.equal(rules.geometryKnownAbsent(v, [WORLD, ES]), false);
  const u = { u: "ES" };
  t.selves.set("ES", u);
  assert.deepEqual([geometryFor(v, ES), raisedGeometryFor(v, ES)], [g, u]);
  assert.equal(raisedOutlineDue(v, ES), false);
  // Given up: rises on its g/; without one either, known absent (a box fit).
  t.selves.delete("ES");
  t.gaveUp.add("ES");
  assert.equal(raisedOutlineDue(v, ES), false);
  globes.delete("ES");
  assert.equal(rules.geometryKnownAbsent(v, [WORLD, ES]), true);
  assert.equal(pending(v, WORLD, ES), false);
  // c3000: its g/ is its self, nothing is held for it.
  assert.equal(raisedOutlineDue(v, CA), false);
  assert.equal(rules.geometryKnownAbsent(v, [WORLD, CA]), true);
  globes.set("CA", { g: "CA" });
  assert.equal(raisedGeometryFor(v, CA), globes.get("CA"));
  // A 360° row: nothing, ever.
  globes.set("AQ", {});
  t.selves.set("AQ", {});
  assert.equal(raisedGeometryFor(v, AQ), undefined);
  assert.equal(raisedOutlineDue(v, AQ), false);
  assert.equal(rules.geometryKnownAbsent(v, [WORLD, AQ]), true);
  // France is unchanged: its k/ self, whatever g/ is held for it.
  globes.set("FR", {});
  assert.equal(geometryFor(v, FR), t.selves.get("FR"));
  assert.equal(raisedGeometryFor(v, FR), t.selves.get("FR"));
});

test("the session's fallback: every unit known absent, nothing held", () => {
  // Rows and France's bundle in, then the fallback (a later release skew).
  const t = booted();
  t.row(LYON.id);
  const v: OutlineView = { ...t.v, mode: "fallback" };
  const LIEU = unit("l:1", LYON_7.id, "place");
  const chains = [
    [WORLD, FR, ARA],
    [WORLD, FR, ARA, RHONE],
    [WORLD, FR, ARA, RHONE, LYON],
    [WORLD],
    [WORLD, FR, ARA, RHONE, LYON, LYON_7, LIEU],
  ];
  const parents = new Map(chains.map((c) => [c.at(-1)!.id, c]));
  const r = rules.outlineRules(v, (u: RuleUnit) => parents.get(u.id)!);
  for (const chain of chains) {
    const u = chain.at(-1)!;
    assert.equal(r.geometryFor(u), undefined, u.id);
    assert.equal(r.raisedGeometryFor(u), undefined, u.id);
    assert.equal(r.geometryKnownAbsent(u), true, u.id);
    assert.equal(r.raisedOutlineDue(u), false, u.id);
    assert.equal(rules.scopePendingFiles(v, chain, false), false, u.id);
    assert.equal(rules.outlineReadyFiles(v, chain, false), true, u.id);
  }
  // The same view read as "fichiers" still holds ARA for its self.
  assert.equal(
    rules.outlineRules(t.v, (u: RuleUnit) => parents.get(u.id)!).raisedOutlineDue(ARA),
    true,
  );
});

test("no files read (the corpus, the comparer): the same answers", () => {
  const { NO_FILES } = rules;
  for (const u of [WORLD, FR, ARA, RHONE, LYON, LYON_7]) {
    assert.equal(NO_FILES.geometryFor(u), undefined, u.id);
    assert.equal(NO_FILES.raisedGeometryFor(u), undefined, u.id);
    assert.equal(NO_FILES.raisedOutlineDue(u), false, u.id);
    assert.equal(NO_FILES.geometryKnownAbsent(u), true, u.id);
  }
});

test("bundlesFor: root first, ancestors from the département down, k:0 left out", () => {
  const t = booted();
  assert.deepEqual(bundlesFor(t.v, [WORLD, FR]), ["FR"]);
  assert.deepEqual(bundlesFor(t.v, [WORLD, FR, ARA]), ["FR", ARA.id]);
  assert.deepEqual(bundlesFor(t.v, [WORLD, FR, ARA, RHONE]), [ARA.id, RHONE.id]);
  // Lyon 7e reached cold: the rows below the département are not known yet.
  const lyon7 = [WORLD, FR, ARA, RHONE, LYON, LYON_7];
  assert.deepEqual(bundlesFor(t.v, lyon7), [RHONE.id, LYON.id, LYON_7.id]);
  t.land(RHONE.id, [[VILLEURBANNE.id, {}]]);
  t.row(LYON.id, "e50", 1, 0);
  t.row(LYON_7.id, "e50", 0, 0);
  assert.deepEqual(bundlesFor(t.v, lyon7), [RHONE.id, LYON.id]);
  assert.deepEqual(bundlesFor(t.v, [WORLD, FR, ARA, RHONE, VILLEURBANNE]), [RHONE.id]);
});

test("rule 3: a child's object from another file is no line before its parent's bundle", () => {
  const t = booted();
  t.selves.set(RHONE.id, {}); // came with a u/ batch
  assert.equal(geometryFor(t.v, RHONE), undefined); // k/fr_reg_84 not in: no focus line
  assert.equal(raisedGeometryFor(t.v, RHONE), t.selves.get(RHONE.id)); // it may rise on it
});

test("refinement: tier-differing siblings meeting the scope, nearest first, capped", () => {
  const t = booted();
  const caps = { region: 3, dep: 8 };
  // Bretagne's box does not meet ARA's; the four others do.
  assert.deepEqual(refinementBatch(t.v, ARA, REGIONS, [], caps), [BFC.id, PACA.id, OCC.id]);
  assert.deepEqual(refinementBatch(t.v, ARA, REGIONS, []), []); // REFINE_CAPS: none for a région
  t.selves.set(BFC.id, {}); // already in
  t.failed.add(PACA.id);
  assert.deepEqual(refinementBatch(t.v, ARA, REGIONS, [], caps), [OCC.id, NAQ.id]);
  // A département: its siblings are drawn at their own tier; the other
  // régions' départements on screen are taken, nearest first, at most 8.
  const sl = unit("fr:dep:71", BFC.id, "dep", 46.6, 4.5, 0.4);
  const far = Array.from({ length: 9 }, (_, i) =>
    unit(`fr:dep:x${i}`, BFC.id, "dep", 47 + i / 5, 5),
  );
  const ain = unit("fr:dep:01", ARA.id, "dep", 46.1, 5.3, 0.4);
  for (const d of [sl, ain, ...far]) t.row(d.id);
  const got = refinementBatch(t.v, RHONE, [ain], [...far, sl]);
  assert.deepEqual([got.length, got[0], got.includes(ain.id)], [8, sl.id, false]);
  assert.deepEqual(refinementBatch(t.v, LYON, [VILLEURBANNE], []), []);
});

test("finestAtIn + containsPointIn: Saint-Mandé stays in Val-de-Marne, whatever a coarse Paris holds", () => {
  type Sq = { lat: number; lng: number; r: number };
  const holds = (g: unknown, lat: number, lng: number) => {
    const s = g as Sq;
    return Math.abs(lat - s.lat) <= s.r && Math.abs(lng - s.lng) <= s.r;
  };
  const withAncestors = (u: ReturnType<typeof unit>, ...ancestors: string[]) => ({
    ...u,
    ancestors,
  });
  const paris = withAncestors(unit("fr:dep:75", "fr:reg:11", "dep", 48.86, 2.35, 0.1), "fr:reg:11");
  const vdm = withAncestors(unit("fr:dep:94", "fr:reg:11", "dep", 48.78, 2.47, 0.12), "fr:reg:11");
  const saintMande = withAncestors(
    unit("fr:com:94067", vdm.id, "city", 48.842, 2.419, 0.01),
    "fr:reg:11",
    vdm.id,
  );
  const paris12 = withAncestors(
    unit("fr:com:75112", "fr:com:75056", "arr", 48.835, 2.4, 0.015),
    "fr:reg:11",
    paris.id,
    "fr:com:75056",
  );
  const geometry = new Map<string, Sq>([
    // Coarse départements: Paris' square reaches over Saint-Mandé, Val-de-Marne's stops short of it.
    [paris.id, { lat: 48.86, lng: 2.35, r: 0.08 }],
    [vdm.id, { lat: 48.76, lng: 2.47, r: 0.07 }],
    [saintMande.id, { lat: 48.842, lng: 2.419, r: 0.008 }],
    [paris12.id, { lat: 48.835, lng: 2.395, r: 0.012 }],
  ]);
  const finest = (lat: number, lng: number) =>
    rules.finestAtIn(
      [paris12, saintMande],
      (u) => geometry.get(u.id),
      (u) => u.bounds,
      holds,
      lat,
      lng,
    );
  const inside = (u: typeof paris, lat: number, lng: number) =>
    rules.containsPointIn(u, finest, (d) => geometry.get(d.id), holds, lat, lng);
  const [lat, lng] = [48.842, 2.419];
  assert.ok(holds(geometry.get(paris.id), lat, lng) && !holds(geometry.get(vdm.id), lat, lng));
  assert.deepEqual(
    [finest(lat, lng)?.id, inside(vdm, lat, lng), inside(paris, lat, lng)],
    [saintMande.id, true, false],
  );
  // Paris 12e holds its own point: Paris, not Val-de-Marne.
  assert.deepEqual([inside(paris, 48.835, 2.395), inside(vdm, 48.835, 2.395)], [true, false]);
  geometry.delete(saintMande.id); // not loaded: no hit, the départements' own outlines answer
  assert.deepEqual([finest(lat, lng), inside(paris, lat, lng)], [null, true]);
});
