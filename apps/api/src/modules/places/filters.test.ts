import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  contentFiltersOf,
  escapeLike,
  likePattern,
  placeFilterKey,
  placeFilterParams,
  placeFilterQueryOf,
  placeFilterQueryParams,
  placeFilterQuerySchema,
  placeFiltersOf,
  rpcPlaceFilters,
  themeIndexesOf,
  themeMask,
} from "@ac/shared";

// The place reads' filters (packages/shared/src/placeFilters.ts): what the
// query may hold, the folded needle and the minimum length, the canonical
// key the API caches under and the web will key its queries by.

const parse = (q: Record<string, unknown>) => placeFilterQuerySchema.safeParse(q);
const message = (q: Record<string, unknown>) => {
  const r = parse(q);
  assert.equal(r.success, false, JSON.stringify(q));
  return r.success ? "" : r.error.issues[0].message;
};
const filtersOf = (q: Record<string, unknown>, minChars = 1) => {
  const r = parse(q);
  assert.ok(r.success, JSON.stringify(q));
  return placeFiltersOf(r.data, minChars);
};
const keyOf = (q: Record<string, unknown>, minChars = 1) => placeFilterKey(filtersOf(q, minChars));

test("refused: bad ids, themes, dates, lengths, repeated parameters", () => {
  assert.match(message({ u: "fr:dep:69,lyon" }), /Identifiant d'unité invalide/);
  assert.match(message({ u: "fr:arr:69381" }), /Identifiant d'unité invalide/);
  assert.match(message({ l: "l:XYZ" }), /Identifiant de lieu invalide/);
  assert.match(message({ l: "l:0123456789abcde" }), /Identifiant de lieu invalide/);
  const ids = Array.from({ length: 51 }, (_, i) => `fr:com:${String(10000 + i)}`).join(",");
  assert.match(message({ u: ids }), /50 unités au plus/);
  assert.match(message({ t: "16" }), /Thème inconnu/);
  assert.match(message({ t: "-1" }), /Thème inconnu/);
  assert.match(message({ t: "1.5" }), /Thème inconnu/);
  assert.match(message({ v: "yes" }), /Paramètre v invalide/);
  assert.match(message({ from: "2025-02-30" }), /Date de début invalide/);
  assert.match(message({ to: "25-01-01" }), /Date de fin invalide/);
  assert.match(message({ q: "x".repeat(201) }), /Texte trop long/);
  assert.match(message({ q: ["a", "b"] }), /un seul attendu/);
  // A NUL: Postgres text cannot hold it (22P05 from jsonb).
  assert.equal(message({ q: "a\u0000b" }), "Texte invalide.");
  assert.ok(parse({ q: "a\tb\u00e9\ud83d\ude00" }).success, "other characters pass");
  // What folds longer than it was typed (Hangul syllables into their letters).
  assert.match(message({ q: "한".repeat(150) }), /Texte trop long/);
});

test("accepted: every unit form, the 2A/2B départements, Overture ids", () => {
  const f = filtersOf({
    u: "FR,fr:reg:84,fr:dep:2A,fr:com:69123,0a1b2c3d-0000-4000-8000-00000000abcd",
    l: "l:0123456789abcdef",
  });
  assert.deepEqual(f.units, [
    "0a1b2c3d-0000-4000-8000-00000000abcd",
    "FR",
    "fr:com:69123",
    "fr:dep:2A",
    "fr:reg:84",
  ]);
  assert.deepEqual(f.lieux, ["l:0123456789abcdef"]);
});

test("the key: canonical across order and duplicates, empty without filters", () => {
  assert.equal(keyOf({}), "");
  assert.equal(keyOf({ v: "0", t: "", q: "  ", u: "", l: "" }), "");
  const a = keyOf({ u: "fr:dep:69,FR", t: "11,0", v: "1", q: " Écolé ", from: "2025-01-01" });
  const b = keyOf({ from: "2025-01-01", q: "ecole", v: "1", t: "0,11,11", u: "FR,fr:dep:69,FR" });
  assert.equal(a, b);
  assert.equal(a, `v1|m${(1 << 0) | (1 << 11)}|qecole|f2025-01-01|uFR,fr:dep:69`);
  // No text can pass for another filter.
  assert.notEqual(keyOf({ q: "x|f2025-01-01" }), keyOf({ q: "x", from: "2025-01-01" }));
  assert.equal(keyOf({ q: "x|f" }), "qx%7Cf");
});

test("the needle: today's fold of the trimmed text; below the minimum, ignored and said so", () => {
  assert.equal(filtersOf({ q: "  Démocratie  " }).needle, "democratie");
  const short = filtersOf({ q: "ét" }, 3);
  assert.equal(short.needle, "");
  assert.equal(short.textIgnored, true);
  assert.equal(placeFilterKey(short), "", "a short text shares the unfiltered key");
  const ok = filtersOf({ q: "éco" }, 3);
  assert.equal(ok.needle, "eco");
  assert.equal(ok.textIgnored, false);
  // Characters, not UTF-16 units.
  assert.equal(filtersOf({ q: "😀😀😀" }, 3).needle, "😀😀😀");
  assert.equal(filtersOf({ q: "a" }).textIgnored, false);
});

test("LIKE: \\, % and _ taken literally, found anywhere", () => {
  assert.equal(escapeLike("50%_off\\"), "50\\%\\_off\\\\");
  assert.equal(likePattern("a_b"), "%a\\_b%");
});

test("what the RPCs are sent: the active filters only", () => {
  assert.deepEqual(rpcPlaceFilters(filtersOf({})), {});
  assert.deepEqual(
    rpcPlaceFilters(
      filtersOf({ v: "1", t: "2", q: "Clim", from: "2025-01-01", to: "2025-12-31", u: "FR" }),
    ),
    {
      verified: true,
      mask: 4,
      like: "%clim%",
      from: "2025-01-01",
      to: "2025-12-31",
      units: ["FR"],
    },
  );
  const content = contentFiltersOf(
    filtersOf({ v: "1", from: "2025-01-01", l: "l:0123456789abcdef" }),
  );
  assert.deepEqual(rpcPlaceFilters(content), { verified: true });
});

test("the web's query: one spelling, which parses back to the same key", () => {
  const params = placeFilterParams({
    verified: true,
    themes: themeIndexesOf(["Logement", "Éducation", "Pas un thème"]),
    text: "  climat ",
    from: null,
    units: ["fr:dep:69", "FR"],
    lieux: [],
  });
  assert.deepEqual(params, { v: "1", t: "1,3", q: "climat", u: "FR,fr:dep:69" });
  assert.equal(keyOf(params), `v1|m${themeMask([1, 3])}|qclimat|uFR,fr:dep:69`);
  assert.deepEqual(placeFilterParams({}), {});
});

test("the web's zod-free query is the schema's, and keeps what is valid where the schema refuses", () => {
  const units = (n: number) => Array.from({ length: n }, (_, i) => `fr:com:${10000 + i}`);
  const lieux = (n: number) =>
    Array.from({ length: n }, (_, i) => `l:${(0xabc0000000000000n + BigInt(i)).toString(16)}`);
  const inputs = [
    {},
    { verified: true },
    { themes: [3, 1, 3, 15, 0] },
    { text: "  Écoles  " },
    { text: "é" },
    { text: "l'" },
    { text: "x".repeat(200) },
    { from: "2026-01-01", to: "2026-12-31" },
    { units: ["fr:dep:69", "FR", "fr:dep:69"], lieux: ["l:0123456789abcdef"] },
    { units: units(50), lieux: lieux(50) },
    {
      verified: true,
      themes: [2],
      text: "climat",
      from: "2025-06-01",
      units: ["fr:reg:84"],
      lieux: ["l:0123456789abcdef"],
    },
  ];
  for (const input of inputs) {
    const q = placeFilterQueryOf(input);
    const parsed = placeFilterQuerySchema.safeParse(placeFilterParams(input));
    assert.ok(parsed.success, JSON.stringify(input));
    assert.deepEqual(q, parsed.data, JSON.stringify(input));
    // Its parameters parse back to it: the API's key is the web's.
    const back = placeFilterQuerySchema.parse(placeFilterQueryParams(q));
    assert.deepEqual(back, q);
    assert.equal(placeFilterKey(placeFiltersOf(back, 2)), placeFilterKey(placeFiltersOf(q, 2)));
  }

  // Where the schema refuses the whole query, only what fails is left out.
  const refused = [
    { input: { verified: true, text: "a\u0000b" }, kept: { v: "1" } },
    { input: { from: "2025-02-30", to: "2026-01-01" }, kept: { to: "2026-01-01" } },
    { input: { themes: [16, -1, 1.5, 2] }, kept: { t: [2] } },
    { input: { units: ["lyon", "FR"], lieux: ["l:XYZ"] }, kept: { u: ["FR"] } },
    { input: { text: "x".repeat(201), verified: true }, kept: { v: "1" } },
  ] as const;
  for (const { input, kept } of refused) {
    assert.equal(placeFilterQuerySchema.safeParse(placeFilterParams(input)).success, false);
    assert.deepEqual(placeFilterQueryOf(input), kept, JSON.stringify(input));
  }
  // More than 50 places: the first 50 picked, the other filters kept.
  const many = placeFilterQueryOf({ verified: true, from: "2026-01-01", lieux: lieux(51) });
  assert.equal(
    placeFilterQuerySchema.safeParse(placeFilterParams({ lieux: lieux(51) })).success,
    false,
  );
  assert.deepEqual(many, { v: "1", from: "2026-01-01", l: lieux(50) });
  assert.ok(placeFilterQuerySchema.safeParse(placeFilterQueryParams(many)).success);
});
