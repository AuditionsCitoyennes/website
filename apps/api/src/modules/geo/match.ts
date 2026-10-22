import { FR_DEPARTMENTS, FR_REGIONS, departementFromPostcode } from "./frDepartments";

// Where a lieu goes on the map, from what BAN answers about it. No I/O here:
// geocode.ts runs the searches (throttled, cached), this decides what they
// mean. The rule is NO SILENT WRONG PIN: a lieu is placed only as precisely as
// the text and BAN agree on, and left off the map rather than guessed.
//   - A bare name is a commune only if a commune has that exact name (BAN's
//     fuzzy best match for "Lima" is Limas, for "Berlin" Berling).
//   - A département or région name is placed at that level, at its centre.
//   - Overseas (DROM-COM) is France: BAN covers it, so does the map.
//   - "X, Commune": a point found by BAN inside that commune, else the
//     commune itself. A hit in another commune, or a weak one, is no point.
//   - "X, Département" / "X (05)": the commune X of that département, else
//     the département.
//   - Same-named communes ("Saint-Denis": 93, 974, Aude, Gard) are kept as
//     candidates and settled against the rest of the lieux (settleHomonyms).

type Coords = [number, number];

/** How precisely a lieu is placed: a point in a commune, the commune, or only an area. */
export type GeoLevel = "address" | "commune" | "departement" | "region";

/** A resolved location: coordinates + administrative area. */
export interface GeoEntry {
  coords: Coords;
  /** Commune / city name (BAN `city`, e.g. "Lyon" — arrondissements collapsed); null above the commune. */
  city: string | null;
  /**
   * INSEE code (BAN `citycode`) of the finest unit — the commune, or the
   * arrondissement municipal for Paris/Lyon/Marseille (e.g. "69387" = Lyon 7e).
   * The join key for fetching that unit's boundary geometry.
   */
  citycode: string | null;
  /**
   * Arrondissement label for the big three cities (e.g. "Lyon 7e", "Paris 11e",
   * "Marseille 1er"), decoded from `citycode`. Null elsewhere — most communes
   * have no arrondissements.
   */
  arrondissement: string | null;
  depCode: string | null;
  depName: string | null;
  region: string | null;
  level: GeoLevel;
}

/** One of several same-named communes (or a point found in it). */
export interface Homonym extends GeoEntry {
  population: number | null;
}

/** A name several communes answer to, none of them obviously the one meant. */
export interface Homonyms {
  homonyms: Homonym[];
}

/** What a lookup leaves in the cache: a place, candidates, or null (no place). */
export type Located = GeoEntry | Homonyms | null;

export function isHomonyms(v: Located | undefined): v is Homonyms {
  return !!v && "homonyms" in v;
}

/** One BAN search result, flattened. */
export interface BanFeature {
  /** [lat, lon] (BAN gives [lon, lat]). */
  coords: Coords;
  score: number;
  /** housenumber | street | locality | municipality */
  type: string;
  name: string;
  city: string | null;
  citycode: string | null;
  postcode: string | null;
  /** "<depCode>, <depName>, <region>" — overseas only "<depCode>, <depName>". */
  context: string | null;
  population: number | null;
}

export interface BanQuery {
  /** `type=municipality`: communes (and arrondissements municipaux) only. */
  municipality?: boolean;
  postcode?: string;
  limit?: number;
}

export type BanSearch = (q: string, opts?: BanQuery) => Promise<BanFeature[]>;

// ---- Thresholds -------------------------------------------------------------

/** Below this, BAN's point for "X, Commune" is a guess (a street sharing one word). */
const ADDRESS_MIN_SCORE = 0.5;
/** A lieu with no commune named ("Place Bellecour") needs a near-certain match. */
const BARE_ADDRESS_MIN_SCORE = 0.8;
/** A name that is both a commune and a département/région means the commune only if it is a town. */
const TOWN_POPULATION = 10_000;
/** Lieux already placed in a homonym's département for it to be the one meant. */
const MIN_SUPPORT = 3;
/** How much bigger than every namesake a commune must be to be the one meant. */
const POPULATION_LEAD = 5;

// ---- Names ------------------------------------------------------------------

/** A name as compared: no case, accents, hyphens or apostrophes; "St" → "Saint". */
export function nameKey(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[-‐–—'’`_./]+/g, " ")
    .replace(/\bste\b/g, "sainte")
    .replace(/\bst\b/g, "saint")
    .replace(/\s+/g, " ")
    .trim();
}

const SPLIT = {
  paris: { name: "Paris", base: 75100, max: 20 },
  lyon: { name: "Lyon", base: 69380, max: 9 },
  marseille: { name: "Marseille", base: 13200, max: 16 },
} as const;

/** "Lyon 7", "Lyon 7e", "Lyon 7e Arrondissement" → Lyon's 7th; null for anything else. */
function arrondissementOf(text: string): { city: string; n: number; citycode: string } | null {
  const m =
    /^(paris|lyon|marseille) (\d{1,2}) ?(?:e|er|eme|ieme|em)?(?: arr(?:ondissement)?)?$/.exec(
      nameKey(text),
    );
  if (!m) return null;
  const split = SPLIT[m[1] as keyof typeof SPLIT];
  const n = Number(m[2]);
  if (n < 1 || n > split.max) return null;
  return { city: split.name, n, citycode: String(split.base + n) };
}

/** A commune's name as compared, arrondissements spelled one way ("lyon 7"). */
function communeKey(text: string): string {
  const arr = arrondissementOf(text);
  return arr ? `${nameKey(arr.city)} ${arr.n}` : nameKey(text);
}

// French ordinal for an arrondissement number: 1 → "1er", n → "ne".
function ordinalFr(n: number): string {
  return n === 1 ? "1er" : `${n}e`;
}

// Decode an arrondissement label from BAN's `citycode` (the 5-digit INSEE code).
// Only Paris (751xx), Lyon (693xx) and Marseille (132xx) split their commune into
// arrondissements; the code's last two digits give the number. Everywhere else
// the commune *is* the smallest unit, so there's no arrondissement.
export function arrondissementFromCitycode(citycode: string | null): string | null {
  if (!citycode || !/^\d{5}$/.test(citycode)) return null;
  const n = Number(citycode);
  if (n >= 75101 && n <= 75120) return `Paris ${ordinalFr(n - 75100)}`;
  if (n >= 69381 && n <= 69389) return `Lyon ${ordinalFr(n - 69380)}`;
  if (n >= 13201 && n <= 13216) return `Marseille ${ordinalFr(n - 13200)}`;
  return null;
}

/** The whole commune's INSEE code of a Paris/Lyon/Marseille arrondissement. */
const SPLIT_COMMUNE: Record<string, string> = { Paris: "75056", Lyon: "69123", Marseille: "13055" };

// ---- Areas ------------------------------------------------------------------

export type Area = { kind: "departement"; code: string } | { kind: "region"; name: string };

const AREA_INDEX = new Map<string, Area>();
for (const [code, d] of Object.entries(FR_DEPARTMENTS)) {
  AREA_INDEX.set(nameKey(d.name), { kind: "departement", code });
}
for (const name of Object.keys(FR_REGIONS)) {
  // Overseas, the région is the département: keep the finer one.
  if (!AREA_INDEX.has(nameKey(name))) AREA_INDEX.set(nameKey(name), { kind: "region", name });
}
for (const [alias, key] of [
  ["reunion", "la reunion"],
  ["ile de la reunion", "la reunion"],
  ["guyane francaise", "guyane"],
  ["paca", "provence alpes cote d azur"],
  ["aura", "auvergne rhone alpes"],
  ["idf", "ile de france"],
]) {
  AREA_INDEX.set(alias, AREA_INDEX.get(key)!);
}

const AREA_PREFIX = /^(?:departement|dept|region)(?: (?:de la|de l|des|du|de|d))? /;

/** A département or région named by `text` ("Hautes-Alpes", "Département de l'Ardèche", "PACA"); codes ("05") only when `codes`. */
export function matchArea(text: string, codes = false): Area | null {
  const t = text.trim().toUpperCase();
  if (codes && FR_DEPARTMENTS[t]) return { kind: "departement", code: t };
  const key = nameKey(text);
  return AREA_INDEX.get(key) ?? AREA_INDEX.get(key.replace(AREA_PREFIX, "")) ?? null;
}

/** A lieu placed at the level of the area it names. */
export function areaEntry(area: Area): GeoEntry {
  const none = { city: null, citycode: null, arrondissement: null };
  if (area.kind === "departement") {
    const d = FR_DEPARTMENTS[area.code];
    return {
      coords: [d.centre[0], d.centre[1]],
      ...none,
      depCode: area.code,
      depName: d.name,
      region: d.region,
      level: "departement",
    };
  }
  const c = FR_REGIONS[area.name];
  return {
    coords: [c[0], c[1]],
    ...none,
    depCode: null,
    depName: null,
    region: area.name,
    level: "region",
  };
}

// BAN `context` is "<depCode>, <depName>, <region>" e.g. "69, Rhône, Auvergne-Rhône-Alpes";
// overseas it stops at the département ("974, La Réunion"), whose région is itself.
export function parseContext(
  context: string | null,
): Pick<GeoEntry, "depCode" | "depName" | "region"> {
  if (!context) return { depCode: null, depName: null, region: null };
  const parts = context.split(",").map((s) => s.trim());
  const known = FR_DEPARTMENTS[parts[0]];
  return {
    depCode: parts[0] || null,
    depName: parts[1] || known?.name || null,
    region: parts[2] || known?.region || null,
  };
}

function inArea(f: BanFeature, area: Area | null): boolean {
  if (!area) return true;
  const ctx = parseContext(f.context);
  return area.kind === "departement" ? ctx.depCode === area.code : ctx.region === area.name;
}

/** Whether BAN's hit lies in commune `c` (an arrondissement lies in its city). */
function inCommune(hit: BanFeature, c: BanFeature): boolean {
  if (!hit.citycode || !c.citycode) return false;
  return hit.citycode === c.citycode || communeCodeOf(hit) === c.citycode;
}

// ---- Entries ----------------------------------------------------------------

// BAN names an arrondissement's commune "Lyon 7e Arrondissement"; the map's
// ville is "Lyon", the arrondissement a level below it.
function cityOf(citycode: string | null, city: string | null): string | null {
  return arrondissementFromCitycode(citycode)?.split(" ")[0] ?? city;
}

function communeEntry(c: BanFeature): Homonym {
  return {
    coords: c.coords,
    city: cityOf(c.citycode, c.city ?? c.name),
    citycode: c.citycode,
    arrondissement: arrondissementFromCitycode(c.citycode),
    ...parseContext(c.context),
    level: "commune",
    population: c.population,
  };
}

function addressEntry(hit: BanFeature, c: BanFeature | null): Homonym {
  return {
    coords: hit.coords,
    city: cityOf(hit.citycode, hit.city ?? c?.city ?? null),
    citycode: hit.citycode,
    arrondissement: arrondissementFromCitycode(hit.citycode),
    ...parseContext(hit.context ?? c?.context ?? null),
    level: "address",
    population: c?.population ?? null,
  };
}

/** One candidate is the place; several are homonyms; none, no place. */
function oneOrHomonyms(candidates: Homonym[]): Located {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return withoutPopulation(candidates[0]);
  return { homonyms: candidates };
}

function withoutPopulation(h: Homonym): GeoEntry {
  const entry: GeoEntry & { population?: number | null } = { ...h };
  delete entry.population;
  return entry;
}

// ---- Lookup -----------------------------------------------------------------

/** What BAN accepts as `q`: 3 to 200 characters, starting with a letter or a digit. */
const BAN_QUERY = /^[\p{L}\p{N}].{2,199}$/su;

/** "Gap, France": BAN knows only France, the country adds nothing. */
const COUNTRY = /^(france|france metropolitaine)$/;

/** Resolve a canonical lieu through BAN. */
export async function locate(name: string, search: BanSearch): Promise<Located> {
  const parts = name
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  while (parts.length > 1 && COUNTRY.test(nameKey(parts[parts.length - 1]))) parts.pop();
  if (parts.length === 0) return null;
  // BAN refuses (400) a query it cannot take, and a refusal is cached as final:
  // a part it could never search ("05" in "Gap, 05") must not sink the lieu.
  const searchable: BanSearch = (q, opts) =>
    BAN_QUERY.test(q.trim()) ? search(q.trim(), opts) : Promise.resolve([]);
  return locateParts(parts, null, searchable);
}

async function locateParts(
  parts: string[],
  outer: Area | null,
  search: BanSearch,
): Promise<Located> {
  const head = parts.slice(0, -1);
  let last = parts[parts.length - 1];
  let area = outer;

  // "Châteauvieux (05)", "Vienne (Isère)": the parenthesis narrows the area.
  const paren = /^(.*\S)\s*\(([^)]+)\)$/.exec(last);
  if (paren) {
    const a = matchArea(paren[2], true);
    if (a) {
      last = paren[1];
      area = a;
    }
  }
  // "69007 Lyon", "Lyon 69007": the postcode gives the département, and filters the address search.
  let postcode: string | undefined;
  const lead = /^(\d{5}) (.+)$/.exec(last);
  const trail = /^(.+) (\d{5})$/.exec(last);
  const [code, rest] = lead ? [lead[1], lead[2]] : trail ? [trail[2], trail[1]] : [];
  const dep = departementFromPostcode(code);
  if (code && rest && dep && FR_DEPARTMENTS[dep]) {
    postcode = code;
    last = rest;
    area ??= { kind: "departement", code: dep };
  }

  const communes = await communesNamed(last, area, search);
  // Only the last part may be a bare département code ("Gap, 05").
  const named = matchArea(last, head.length > 0 || outer !== null);
  // "Vienne": the town (Isère, 31,000 people), not the département (86) —
  // but "Corrèze" is the département, not its village, and "La Réunion" the
  // island, not the hamlet of Lot-et-Garonne.
  const isArea =
    named !== null &&
    (communes.length === 0 || communes.every((c) => (c.population ?? 0) < TOWN_POPULATION));

  if (isArea) {
    if (head.length === 0) return areaEntry(named);
    return (await locateParts(head, named, search)) ?? areaEntry(named);
  }

  if (communes.length > 0) {
    if (head.length === 0) return oneOrHomonyms(communes.map(communeEntry));
    // A point inside the commune, found by the whole text, or the commune.
    const hits = (await search([...head, last].join(", "), { postcode, limit: 10 })).filter(
      (h) => h.type !== "municipality" && h.score >= ADDRESS_MIN_SCORE,
    );
    const placed = communes.map((c) => {
      const hit = hits.find((h) => inCommune(h, c));
      return { hit, entry: hit ? addressEntry(hit, c) : communeEntry(c) };
    });
    // Several "Saint-Denis" but the street is in only one: that one.
    const withHit = placed.filter((p) => p.hit);
    if (placed.length > 1 && withHit.length === 1) return withoutPopulation(withHit[0].entry);
    return oneOrHomonyms(placed.map((p) => p.entry));
  }

  // Neither a commune nor an area: a lieu named on its own ("Place Bellecour")
  // stands only if it reads as an address, BAN is near-certain, and every
  // strong match is in one commune. Never a bare word: "Berlin" is also a
  // lieu-dit of Ariège.
  if (head.length === 0 && PLACE_PREFIX.test(last))
    return bareAddress(last, area, postcode, search);
  return null;
}

/** The communes (or arrondissements) named exactly `text`, within `area`. */
async function communesNamed(
  text: string,
  area: Area | null,
  search: BanSearch,
): Promise<BanFeature[]> {
  const arr = arrondissementOf(text);
  const q = arr
    ? `${arr.city} ${ordinalFr(arr.n)} Arrondissement`
    : text.replace(/\bSte?\b\.?/gi, (m) => (/e/i.test(m) ? "Sainte" : "Saint"));
  const key = communeKey(text);
  // No proximity bias: unbiased, BAN ranks exact names first, and twenty
  // results hold every same-named commune (Saint-Pierre has nine).
  const found = await search(q, { municipality: true, limit: 20 });
  return found.filter((f) => communeKey(f.name) === key && inArea(f, area));
}

// A place within a commune ("Place Carnot", "Marché de la Croix-Rousse"), not a commune's name.
const PLACE_PREFIX =
  /^(place|march[ée]|avenue|av|quai|parc|rue|cours|boulevard|bd|manif|maison|parvis|m[ée]diath[èe]que|gare|pont|esplanade|all[ée]e|square|jardin|halles?)\b/i;

/** Every word of `text` is a word of BAN's name for the hit. */
function namesAll(hit: BanFeature, text: string): boolean {
  const words = new Set(nameKey(hit.name).split(" "));
  return nameKey(text)
    .split(" ")
    .every((w) => words.has(w));
}

/** The commune a hit lies in (Paris, Lyon, Marseille whole, not the arrondissement). */
function communeCodeOf(h: BanFeature): string | null {
  const arr = arrondissementFromCitycode(h.citycode);
  return arr ? SPLIT_COMMUNE[arr.split(" ")[0]] : h.citycode;
}

async function bareAddress(
  text: string,
  area: Area | null,
  postcode: string | undefined,
  search: BanSearch,
): Promise<Located> {
  const strong = (await search(text, { postcode, limit: 10 })).filter(
    (h) =>
      h.type !== "municipality" &&
      h.score >= BARE_ADDRESS_MIN_SCORE &&
      namesAll(h, text) &&
      inArea(h, area),
  );
  if (strong.length === 0) return null;
  if (strong.some((h) => communeCodeOf(h) !== communeCodeOf(strong[0]))) return null;
  return withoutPopulation(addressEntry(strong[0], null));
}

// ---- Homonyms -----------------------------------------------------------------

/**
 * Where each lieu goes, homonyms settled against the others: a same-named
 * commune is the one meant if the association already holds lieux in its
 * département (MIN_SUPPORT, more than any namesake's), else if it is far
 * bigger than every namesake; else the lieu stays off the map.
 */
export function settleHomonyms(located: Map<string, Located>): Map<string, GeoEntry | null> {
  const support = new Map<string, number>();
  for (const v of located.values()) {
    if (v && !isHomonyms(v) && v.depCode) support.set(v.depCode, (support.get(v.depCode) ?? 0) + 1);
  }
  const out = new Map<string, GeoEntry | null>();
  for (const [name, v] of located) out.set(name, isHomonyms(v) ? pickHomonym(v, support) : v);
  return out;
}

export function pickHomonym(v: Homonyms, support: Map<string, number>): GeoEntry | null {
  const held = (h: Homonym) => support.get(h.depCode ?? "") ?? 0;
  const bySupport = [...v.homonyms].sort((a, b) => held(b) - held(a));
  if (held(bySupport[0]) >= MIN_SUPPORT && held(bySupport[0]) > held(bySupport[1])) {
    return withoutPopulation(bySupport[0]);
  }
  const pop = (h: Homonym) => h.population ?? 0;
  const byPopulation = [...v.homonyms].sort((a, b) => pop(b) - pop(a));
  if (pop(byPopulation[0]) > 0 && pop(byPopulation[0]) >= POPULATION_LEAD * pop(byPopulation[1])) {
    return withoutPopulation(byPopulation[0]);
  }
  return null;
}
