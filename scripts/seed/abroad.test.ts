import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { GENERIC_LOCATION, getCanonicalLocation, normalizeLocation } from "@ac/shared";
import { METRO_FRANCE } from "../../apps/web/src/features/geo/bounds";
import {
  ABROAD,
  ABROAD_GEO_RELEASE,
  abroadLieux,
  abroadPlaces,
  abroadUnits,
  localityId,
  OUTLINE_BOXES,
} from "./fixtures/abroad";
import { readFrFixtures } from "./fixtures/fr";
import { PROFILES, seedData, seedSql, SHAPES } from "./generate";
import { COUNTRIES, ONLINE_TOWN_HALLS } from "./places";
import { FOREIGN, FOREIGN_FIRST_NAMES } from "./texts";

const fr = readFrFixtures().places;
const lieux = abroadLieux();
const units = abroadUnits();
const countries = units.filter((u) => u.level === "country");
const localities = units.filter((u) => u.level === "locality");

const km = (a: [number, number], b: [number, number]) => {
  const rad = Math.PI / 180;
  const h =
    Math.sin(((b[0] - a[0]) * rad) / 2) ** 2 +
    Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(((b[1] - a[1]) * rad) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

test("every country has an outline in the map's index, and none is France's or awkward to frame", () => {
  // France and its overseas codes are the French fixture's; the others cross
  // the antimeridian or have no outline to frame.
  const refused = "FR GP MQ GF RE YT PM BL MF WF PF NC TF CP AQ RU US FJ NZ KI".split(" ");
  assert.deepEqual(Object.keys(OUTLINE_BOXES).sort(), ABROAD.map((c) => c.iso).sort());
  for (const { iso } of ABROAD) {
    assert.ok(!refused.includes(iso), iso);
    const [w, s, e, n] = OUTLINE_BOXES[iso];
    assert.ok(-180 <= w && w < e && e <= 180 && -90 <= s && s < n && n <= 90, `${iso}: its box`);
  }
  // Its world outline is the heaviest of the index, fetched whenever the map shows France.
  assert.ok(!ABROAD.some((c) => c.iso === "CA"));
});

test("the fixture has the size the profile is meant to have, in the words of the world profile", () => {
  assert.ok(ABROAD.length >= 22 && ABROAD.length <= 28, `${ABROAD.length} countries`);
  assert.ok(localities.length >= 45 && localities.length <= 55, `${localities.length} cities`);
  // A code's outline carries its country's name: the name is the code's French
  // name (ICU writes the apostrophe curly), and no two countries share one.
  const french = new Intl.DisplayNames(["fr"], { type: "region" });
  assert.equal(new Set(ABROAD.map((c) => c.name)).size, ABROAD.length);
  for (const c of ABROAD) {
    assert.equal(french.of(c.iso)?.replaceAll("’", "'"), c.name, c.iso);
    const known = COUNTRIES.find((k) => k.country === c.name);
    assert.ok(known, `"${c.name}": not a country of places.ts`);
    assert.equal(c.lang, known.lang, c.name);
    assert.ok(c.lang === "fr" || (FOREIGN[c.lang] && FOREIGN_FIRST_NAMES[c.lang]), c.name);
    for (const city of c.cities) {
      assert.ok(city.spots.length >= 2 && city.spots.length <= 3, `${city.name}: its places`);
    }
  }
});

test("the units are countries, then their localities, under ids that never change", () => {
  assert.equal(units.length, countries.length + localities.length);
  assert.deepEqual(units.slice(0, countries.length), countries);
  for (const u of countries) {
    assert.match(u.id, /^[A-Z]{2}$/);
    assert.deepEqual(
      { ...u, name: null },
      {
        id: u.id,
        parent_id: null,
        level: "country",
        country: u.id,
        name: null,
        code: null,
        lat: null,
        lng: null,
        source: "overture",
        geo_release: ABROAD_GEO_RELEASE,
      },
    );
    assert.ok(u.name.length > 0);
  }
  for (const u of localities) {
    assert.match(u.id, /^[0-9a-f-]{32,36}$/);
    assert.ok(
      countries.some((c) => c.id === u.parent_id && c.id === u.country),
      u.name,
    );
    assert.equal(u.source, "overture");
    assert.equal(u.geo_release, ABROAD_GEO_RELEASE);
    assert.equal(u.code, null);
    assert.ok(u.lat !== null && u.lng !== null, u.name);
  }
  assert.equal(new Set(units.map((u) => u.id)).size, units.length);
  assert.equal(ABROAD_GEO_RELEASE, "2026-10-21.0");
  assert.equal(localityId("BE", "Bruxelles"), "894debc1-3494-a1a9-1c7b-f959bb4fdf9a");
  assert.equal(
    localities.find((u) => u.name === "Bruxelles")?.id,
    "894debc1-3494-a1a9-1c7b-f959bb4fdf9a",
  );
});

test("each place is at a locality, under its country", () => {
  assert.deepEqual(abroadPlaces(), Object.fromEntries(lieux.map((l) => [l.location, l.place])));
  for (const { country, city, location, place } of lieux) {
    const id = localityId(country.iso, city.name);
    assert.ok(
      localities.some((u) => u.id === id && u.name === city.name),
      location,
    );
    assert.deepEqual(place.place_path, [country.iso, id], location);
    assert.equal(place.place_unit, id, location);
    assert.equal(place.locality_id, id, location);
    assert.equal(place.place_precision, "locality", location);
    assert.equal(place.place_candidates, null, location);
    assert.equal(place.geo_release, ABROAD_GEO_RELEASE, location);
  }
});

test("each location is its own lieu: no rule claims it, and no other row of the seed shares its name", () => {
  const frenchKeys = new Set(Object.values(fr.lieux).map((p) => p.lieu_key));
  const onlineLabels = new Set([
    ...Object.values(fr.online).map((o) => o.location),
    ...ONLINE_TOWN_HALLS.map((h) => h.location),
  ]);
  const backfill = JSON.parse(
    readFileSync(
      new URL("../../supabase/tests/backfill_places_fr.expected.json", import.meta.url),
      "utf8",
    ),
  ) as { offline: Record<string, unknown> };
  const world = new Set(COUNTRIES.flatMap((c) => c.cities.map((city) => `${city}, ${c.country}`)));
  assert.equal(new Set(lieux.map((l) => l.location)).size, lieux.length);
  assert.equal(new Set(lieux.map((l) => l.place.lieu_key)).size, lieux.length);
  for (const { city, location, place } of lieux) {
    const key = place.lieu_key;
    assert.equal(key, normalizeLocation(location), location);
    // No LOCATION_RULES keyword (they match substrings: "bron" in "Hébron").
    assert.equal(key, getCanonicalLocation(location), location);
    assert.doesNotMatch(location, GENERIC_LOCATION);
    assert.doesNotMatch(key, GENERIC_LOCATION);
    // The pin label drops the city when the location ends with the locality's name.
    assert.ok(location.endsWith(`, ${city.name}`), location);
    for (const name of [location, key]) {
      assert.ok(!frenchKeys.has(name), `"${name}": a French lieu`);
      assert.ok(!onlineLabels.has(name), `"${name}": an online town hall`);
      assert.ok(!Object.hasOwn(fr.lieux, name), `"${name}": a French fixture location`);
      // The seeded-migration check looks a row up there by its location.
      assert.ok(!Object.hasOwn(backfill.offline, name), `"${name}": listed by the backfill`);
      assert.ok(!world.has(name), `"${name}": a location of the world profile`);
    }
  }
});

test("every point is in its country, and every place in its city", () => {
  const decimals = (n: number) => (String(n).split(".")[1] ?? "").length;
  for (const { iso, cities } of ABROAD) {
    const [w, s, e, n] = OUTLINE_BOXES[iso];
    for (const city of cities) {
      for (const p of [city, ...city.spots]) {
        const label = `${p.name} (${city.name}, ${iso})`;
        assert.ok(w <= p.lng && p.lng <= e && s <= p.lat && p.lat <= n, `${label}: outside ${iso}`);
        assert.ok(decimals(p.lat) <= 5 && decimals(p.lng) <= 5, `${label}: too many decimals`);
        const far = km([city.lat, city.lng], [p.lat, p.lng]);
        assert.ok(far <= 15, `${label}: ${far.toFixed(1)} km from the city centre`);
      }
    }
  }
});

test("only Belgium's and Switzerland's lieux lie in the box of metropolitan France", () => {
  // The map fetches a neighbour's full outline when the box of its lieux
  // meets France's (each lieu's box is its point, padded by 0.012°).
  const pad = 0.012;
  const meets = ABROAD.filter(({ cities }) => {
    const spots = cities.flatMap((c) => c.spots);
    const lats = spots.map((p) => p.lat);
    const lngs = spots.map((p) => p.lng);
    return (
      Math.min(...lats) - pad <= METRO_FRANCE.maxLat &&
      Math.max(...lats) + pad >= METRO_FRANCE.minLat &&
      Math.min(...lngs) - pad <= METRO_FRANCE.maxLng &&
      Math.max(...lngs) + pad >= METRO_FRANCE.minLng
    );
  }).map((c) => c.iso);
  assert.deepEqual(meets.sort(), ["BE", "CH"]);
});

const data = seedData("france-abroad");
const abroadAuditions = data.auditions.filter((a) => a.placement === "placed-abroad");
const abroadIds = new Set(abroadAuditions.map((a) => a.id));
const abroadTestimonies = data.testimonies.filter((t) => abroadIds.has(t.auditionId));
const lieuOf = new Map(lieux.map((l) => [l.location, l]));

test("france-abroad is the france profile, plus about 500 testimonies abroad", () => {
  const france = seedData("france");
  assert.deepEqual(
    data.auditions.filter((a) => !abroadIds.has(a.id)),
    france.auditions,
  );
  assert.deepEqual(
    data.testimonies.filter((t) => !abroadIds.has(t.auditionId)),
    france.testimonies,
  );
  assert.deepEqual(data.online, france.online);
  assert.deepEqual(data.submissions, france.submissions);
  // The same rows on every call.
  assert.deepEqual(seedData("france-abroad"), data);

  assert.ok(
    abroadTestimonies.length >= 480 && abroadTestimonies.length <= 540,
    `${abroadTestimonies.length} testimonies abroad`,
  );
  const perAudition = new Map<string, number>();
  for (const t of data.testimonies) {
    perAudition.set(t.auditionId, (perAudition.get(t.auditionId) ?? 0) + 1);
  }
  for (const a of abroadAuditions) {
    assert.ok(lieuOf.has(a.location), `"${a.location}": not a fixture lieu`);
    assert.ok((perAudition.get(a.id) ?? 0) >= 1, `"${a.location}": no testimony`);
    assert.equal(a.status, "published");
  }
  // Every fixture lieu holds an audition, so every unit is named by a path.
  const used = new Set(abroadAuditions.map((a) => a.location));
  for (const { location } of lieux) assert.ok(used.has(location), `"${location}": no audition`);
  assert.equal(
    new Set(abroadAuditions.map((a) => lieuOf.get(a.location)!.country.iso)).size,
    ABROAD.length,
  );
  assert.equal(
    new Set(abroadAuditions.map((a) => lieuOf.get(a.location)!.place.place_unit)).size,
    localities.length,
  );

  // France stays the country with the most testimonies.
  const perCountry = new Map<string, number>();
  for (const a of abroadAuditions) {
    const iso = lieuOf.get(a.location)!.country.iso;
    perCountry.set(iso, (perCountry.get(iso) ?? 0) + (perAudition.get(a.id) ?? 0));
  }
  assert.ok(Math.max(...perCountry.values()) < france.testimonies.length);
});

// The map loads a subtree whole while it holds at most 600 units plus lieux
// (useUnitTree.ts): the profile stays under it, with room to spare.
test("the whole profile holds at most 500 units and lieux", () => {
  const unitIds = new Set<string>();
  const lieuIds = new Set<string>();
  const hold = (path: string[] | null, unit: string | null, key: string) => {
    path?.forEach((id) => unitIds.add(id));
    lieuIds.add(`${unit}|${key}`);
  };
  for (const a of data.auditions) {
    if (a.placement === "placed-abroad") {
      const p = lieuOf.get(a.location)!.place;
      hold(p.place_path, p.place_unit, p.lieu_key);
    } else {
      // A row the old app wrote is placed at its lieu's fixture place once the job runs.
      const p = fr.lieux[a.location];
      assert.ok(p, `"${a.location}": no fixture`);
      hold(p.place_path, p.place_unit, p.lieu_key);
    }
  }
  for (const { hall } of data.online) {
    const p = fr.online[hall.citycode];
    hold(p.place_path, p.place_unit, p.location);
  }
  assert.ok(unitIds.size + lieuIds.size <= 500, `${unitIds.size} units + ${lieuIds.size} lieux`);
});

test("some testimonies abroad are in the country's language", () => {
  const langs = new Set(ABROAD.map((c) => c.lang).filter((lang) => lang !== "fr"));
  assert.ok(langs.size > 0);
  const langOf = new Map(abroadAuditions.map((a) => [a.id, lieuOf.get(a.location)!.country.lang]));
  for (const lang of langs) {
    const texts = new Set(FOREIGN[lang].map((f) => f.text));
    const inLang = abroadTestimonies.filter(
      (t) => langOf.get(t.auditionId) === lang && texts.has(t.content),
    );
    assert.ok(inLang.length >= 1, `no testimony in "${lang}"`);
  }
  // And none where French is spoken.
  const foreign = new Set(Object.values(FOREIGN).flatMap((list) => list.map((f) => f.text)));
  for (const t of abroadTestimonies) {
    if (langOf.get(t.auditionId) === "fr") assert.ok(!foreign.has(t.content));
  }
});

test("the SQL holds the abroad units before the rows, and none of it in the legacy shape", () => {
  const legacy = seedSql("france-abroad", "legacy").sql;
  assert.ok(!legacy.includes("geo_units"));
  assert.ok(!legacy.includes("place_unit"));
  for (const a of abroadAuditions) assert.ok(legacy.includes(`'${a.id}'`));

  const { sql } = seedSql("france-abroad");
  const start = sql.indexOf("(fixtures/abroad.ts)");
  const firstAudition = sql.indexOf("insert into public.auditions");
  assert.ok(start > 0 && firstAudition > start);
  // After the French units' insert, which stays as the france profile writes it.
  assert.ok(sql.indexOf("(fixtures/fr-units.json)") < start);
  const statement = sql.slice(start, sql.indexOf(";", start));
  assert.ok(statement.includes("insert into public.geo_units ("));
  const rows = statement.split("\n").filter((line) => line.startsWith("  ("));
  assert.deepEqual(
    rows.map((line) => line.slice(4, line.indexOf("',"))),
    units.map((u) => u.id),
  );
  assert.ok(
    rows[0].includes("'BE', null, 'country', 'BE', 'Belgique', null, null, null, 'overture'"),
  );
  // The generated columns are the database's to fill.
  assert.ok(!sql.includes("place_stale") && !sql.includes("lieu_id"));
  // No profile but this one places a row abroad.
  for (const profile of ["france", "world", "all"] as const) {
    assert.ok(!seedSql(profile).sql.includes("(fixtures/abroad.ts)"), profile);
  }
});

test("every profile writes its seed, in either shape", () => {
  assert.deepEqual(PROFILES, ["france", "world", "all", "france-abroad"]);
  for (const profile of PROFILES) {
    for (const shape of SHAPES) {
      const { sql, summary } = seedSql(profile, shape);
      assert.ok(sql.endsWith("commit;\n"), `${profile} ${shape}`);
      assert.ok(summary.startsWith(`seed.sql (${profile}`), summary);
    }
  }
});
