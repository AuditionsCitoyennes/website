// The fake Auditions Citoyennes data for the local stack and staging, as SQL
// (cli.ts writes it to supabase/seed.sql). Pure fake data: invented texts
// (texts.ts), example.org addresses, no imported dataset, never a row of the
// real database.
//
//   npm run db:seed                      profile "france" (default): shaped like
//                                        the real corpus, plus edge cases
//   SEED_PROFILE=world npm run db:seed   every country but France
//   SEED_PROFILE=all npm run db:seed     both
//   SEED_PROFILE=france-abroad npm run db:seed
//                                        "france", plus about 500 testimonies
//                                        abroad that are on the map
//
// Where each audition is (map phase 1): French auditions and online buckets
// are placed as the API places them, from committed fixtures
// (fixtures/fr-places.json, fr-units.json: no network), but for a few the old
// app wrote (places.ts, `legacy`), never placed, so stale. The rows abroad
// of "world" and "all" are unplaced, as after an attempt (no point until the
// world gazetteer places them), so the placement job never looks them up in
// BAN, which would pin some in France (Grenade is also a commune of
// Haute-Garonne). Those of "france-abroad" are placed, as that gazetteer
// would place them: at a real public place of a city, under a country unit
// and a locality unit (fixtures/abroad.ts, written by hand: no network).
// SEED_SHAPE=legacy writes the same rows as they stood before phase 1 (no
// place column, no geo_units), for loading under the migrations before it
// (db:check:seeded).
//
// A fixed random seed per profile: the same profile always writes the same
// rows. Dates are relative to the day the file is loaded (current_date, now()),
// so pending verification links are fresh whenever it is.

import { createHash } from "node:crypto";
import { getCanonicalLocation } from "@ac/shared";
import {
  AUDITION_CONTENTS,
  CANONICAL,
  CLOSERS,
  FIRST_NAMES,
  FOREIGN,
  FOREIGN_FIRST_NAMES,
  LAST_NAMES,
  LINKS,
  OPENERS,
  PERSON_INFOS,
  SENTENCES,
  THEME_WEIGHTS,
  type Theme,
} from "./texts";
import { COUNTRIES, FRANCE_CLUSTERS, ONLINE_TOWN_HALLS } from "./places";
import {
  placeOutdated,
  readFrFixtures,
  RULES_HASH,
  type FrPlace,
  type FrPlaces,
  type FrUnit,
} from "./fixtures/fr";
import {
  abroadLieux,
  abroadPlaces,
  abroadUnits,
  type AbroadPlace,
  type AbroadUnit,
} from "./fixtures/abroad";
import { PLACES_FINGERPRINT } from "./fingerprint";

export type Profile = "france" | "world" | "all" | "france-abroad";
/** places: with the phase-1 place columns and geo_units; legacy: the rows as before them. */
export type Shape = "places" | "legacy";

// ---- Randomness -------------------------------------------------------------

/** mulberry32: small, fast, and the same sequence on every machine. */
function makeRandom(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
  const chance = (p: number) => next() < p;
  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const weighted = <K extends string>(weights: Partial<Record<K, number>>): K => {
    const entries = Object.entries(weights) as [K, number][];
    let r = next() * entries.reduce((sum, [, w]) => sum + w, 0);
    for (const [key, w] of entries) {
      r -= w;
      if (r <= 0) return key;
    }
    return entries[entries.length - 1][0];
  };
  /** Log-normal: the shape of the real testimony lengths. */
  const logNormal = (mu: number, sigma: number) => {
    const u = Math.max(next(), 1e-12);
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
    return Math.exp(mu + sigma * z);
  };
  const uuid = () => {
    const hex = Array.from({ length: 32 }, () => int(0, 15).toString(16));
    hex[12] = "4";
    hex[16] = ((int(0, 15) & 0x3) | 0x8).toString(16);
    const h = hex.join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };
  return { next, int, pick, chance, shuffle, weighted, logNormal, uuid };
}
type Random = ReturnType<typeof makeRandom>;

// ---- Rows -------------------------------------------------------------------

export interface Audition {
  id: string;
  title: string;
  /** date = current_date - daysAgo */
  daysAgo: number;
  location: string;
  content: string;
  status: "published" | "draft";
  /**
   * fixture: placed (or unplaced) by the API, as fixtures/fr-places.json says;
   * legacy: written by the old app, never placed (stale); abroad: unplaced;
   * placed-abroad: placed at a city abroad, as fixtures/abroad.ts says.
   */
  placement: "fixture" | "legacy" | "abroad" | "placed-abroad";
}

export interface Testimony {
  id: string;
  auditionId: string;
  personName: string;
  personInfo: string | null;
  content: string;
  /** null = no tags at all (a few real rows have none). */
  topics: string[] | null;
  email: string | null;
  verification: "pending" | "verified" | null;
  token: string | null;
  /** created_at = now() - minutesAgo */
  minutesAgo: number;
}

export interface OnlineAudition {
  id: string;
  hall: (typeof ONLINE_TOWN_HALLS)[number];
  monthsAgo: number;
}

export interface Submission {
  testimonyId: string;
  emailHash: string;
  minutesAgo: number;
}

export interface Dataset {
  auditions: Audition[];
  online: OnlineAudition[];
  testimonies: Testimony[];
  submissions: Submission[];
}

const DAY = 24 * 60;
let emailCounter = 0;

function slug(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** A fake address on example.org, a domain reserved so mail never reaches anyone. */
function fakeEmail(name: string): string {
  emailCounter += 1;
  const local = name === "Anonyme" ? "temoin" : slug(name).replace(/-/g, ".");
  return `${local}.${emailCounter}@example.org`;
}

// ---- Texts ------------------------------------------------------------------

/** A spoken testimony of about `target` characters on `themes` (more are
 *  drawn in when those run out); returns the themes really used. */
function composeText(
  r: Random,
  themes: Theme[],
  target: number,
  boost: Partial<Record<Theme, number>>,
): { text: string; used: Theme[] } {
  const used: Theme[] = [];
  const pool: string[] = [];
  const addTheme = (t: Theme) => {
    if (used.includes(t)) return;
    used.push(t);
    pool.push(...r.shuffle(SENTENCES[t]));
  };
  themes.forEach(addTheme);

  const paragraphs: string[][] = [[]];
  let length = 0;
  const say = (s: string) => {
    paragraphs[paragraphs.length - 1].push(s);
    length += s.length + 1;
  };
  if (target > 300 && r.chance(0.4)) say(r.pick(OPENERS));
  let inParagraph = 0;
  let perParagraph = r.int(2, 5);
  let refills = 0;
  while (length < target) {
    if (pool.length === 0) {
      const unused = (Object.keys(SENTENCES) as Theme[]).filter((t) => !used.includes(t));
      if (unused.length > 0 && used.length < 8) {
        addTheme(r.weighted(weightsWith(boost, unused)));
      } else {
        // Only the very long edge cases get here: say it all again.
        pool.push(...r.shuffle(used.flatMap((t) => SENTENCES[t])));
        refills += 1;
        if (refills > 40) break;
      }
      continue;
    }
    if (inParagraph >= perParagraph) {
      paragraphs.push([]);
      inParagraph = 0;
      perParagraph = r.int(2, 5);
      if (r.chance(0.3)) say(r.pick(LINKS));
    }
    say(pool.shift()!);
    inParagraph += 1;
  }
  if (target > 300 && r.chance(0.4)) say(r.pick(CLOSERS));
  return {
    text: paragraphs
      .filter((p) => p.length > 0)
      .map((p) => p.join(" "))
      .join("\n\n"),
    used,
  };
}

function weightsWith(boost: Partial<Record<Theme, number>>, among?: Theme[]) {
  const out: Partial<Record<Theme, number>> = {};
  for (const t of among ?? (Object.keys(THEME_WEIGHTS) as Theme[])) {
    out[t] = THEME_WEIGHTS[t] * (boost[t] ?? 1);
  }
  return out;
}

/**
 * Tags as stored: mostly the old lowercase vocabulary, some in the 16-theme
 * grid (testimonies tagged since the AI analysis), a few capitalized as the
 * oldest rows are. Counts follow the real corpus (4 to 8 mostly, median 6,
 * from none up to 12).
 */
function tagsFor(r: Random, used: Theme[], boost: Partial<Record<Theme, number>>): string[] {
  const x = r.next();
  const steps = [0.04, 0.05, 0.12, 0.21, 0.33, 0.47, 0.61, 0.78, 0.88, 0.95];
  const want = steps.findIndex((s) => x < s);
  if (want === 0) return [];
  const tags = [...used];
  while (tags.length < (want === -1 ? 12 : want)) {
    const t = r.weighted(weightsWith(boost));
    if (!tags.includes(t)) tags.push(t);
  }
  const chosen = tags.slice(0, want === -1 ? r.int(10, 12) : want);
  const style = r.next();
  if (style < 0.85) return chosen;
  if (style < 0.95) {
    return [...new Set(chosen.map((t) => CANONICAL[t]).filter((t): t is string => Boolean(t)))];
  }
  return chosen.map((t) => t.charAt(0).toUpperCase() + t.slice(1));
}

/** Three in four give a first name, most others a full name (real corpus). */
function personName(r: Random, firstNames: readonly string[], anonymous = 0.02): string {
  const x = r.next();
  if (x < anonymous) return "Anonyme";
  if (x < anonymous + (1 - anonymous) * 0.75) return r.pick(firstNames);
  if (x < anonymous + (1 - anonymous) * 0.99) return `${r.pick(firstNames)} ${r.pick(LAST_NAMES)}`;
  return `${r.pick(firstNames)} ${r.pick(LAST_NAMES).charAt(0)}.`;
}

/** Testimonies per audition: the real spread (median 3, rarely past 10). */
function testimonyCount(r: Random): number {
  const x = r.next();
  if (x < 0.25) return 1;
  if (x < 0.5) return r.int(2, 3);
  if (x < 0.75) return r.int(4, 6);
  if (x < 0.9) return r.int(7, 9);
  return r.int(10, 13);
}

/** How a testimony stands with its witness: three in four left no email
 *  (never asked); of the others, recent ones wait for the witness, older
 *  pending links have expired (14 days), and some were confirmed. */
function verificationFor(r: Random, daysAgo: number) {
  const x = r.next();
  if (daysAgo <= 10)
    return x < 0.3 ? ("pending" as const) : x < 0.35 ? ("verified" as const) : null;
  return x < 0.15 ? ("pending" as const) : x < 0.25 ? ("verified" as const) : null;
}

function makeTestimony(
  r: Random,
  auditionId: string,
  daysAgo: number,
  boost: Partial<Record<Theme, number>>,
  opts: { target?: number; firstNames?: readonly string[]; anonymous?: number } = {},
): Testimony {
  const primary: Theme[] = [r.weighted(weightsWith(boost))];
  const themeCount = r.int(1, 3);
  while (primary.length < themeCount) {
    const t = r.weighted(weightsWith(boost));
    if (!primary.includes(t)) primary.push(t);
  }
  const target = opts.target ?? Math.min(8000, Math.max(120, r.logNormal(7.2, 0.95)));
  const { text, used } = composeText(r, primary, target, boost);
  const name = personName(r, opts.firstNames ?? FIRST_NAMES, opts.anonymous);
  const verification = verificationFor(r, daysAgo);
  const offset = Math.min(r.int(30, 3 * DAY), Math.max(daysAgo * DAY - 30, 0));
  return {
    id: r.uuid(),
    auditionId,
    personName: name,
    personInfo: r.chance(0.37) ? r.pick(PERSON_INFOS) : null,
    content: text,
    topics: r.chance(0.02) ? null : tagsFor(r, used, boost),
    email: verification ? fakeEmail(name) : null,
    verification,
    token: verification ? r.uuid() : null,
    minutesAgo: Math.max(daysAgo * DAY - offset, 5),
  };
}

// ---- Profiles ---------------------------------------------------------------

function franceProfile(): Dataset {
  const r = makeRandom(20261021);
  const auditions: Audition[] = [];
  const testimonies: Testimony[] = [];
  const boosts = new Map<string, Partial<Record<Theme, number>>>();

  // Dates that must exist whatever the draw: two auditions of the last ten
  // days (live verification links), two older ones (expired links).
  const forcedDays = [3, 8, 25, 40];
  let draftsLeft = 3;

  for (const cluster of FRANCE_CLUSTERS) {
    for (const place of cluster.places) {
      for (let n = 0; n < place.times; n++) {
        const daysAgo =
          cluster.name === "lyon" && forcedDays.length > 0
            ? forcedDays.shift()!
            : r.int(cluster.daysAgo[0], cluster.daysAgo[1]);
        const draft = cluster.name === "elsewhere" && draftsLeft > 0 && r.chance(0.45);
        if (draft) draftsLeft -= 1;
        const audition: Audition = {
          id: r.uuid(),
          title: `Audition citoyenne - ${place.location}`,
          daysAgo,
          location: place.location,
          content: r.pick(AUDITION_CONTENTS),
          status: draft ? "draft" : "published",
          placement: n < place.times - (place.legacy ?? 0) ? "fixture" : "legacy",
        };
        auditions.push(audition);
        boosts.set(audition.id, cluster.boost);
        const count = daysAgo <= 40 ? Math.max(testimonyCount(r), 6) : testimonyCount(r);
        for (let i = 0; i < count; i++) {
          testimonies.push(makeTestimony(r, audition.id, daysAgo, cluster.boost));
        }
      }
    }
  }

  testimonies.push(...edgeCases(r, auditions[0], auditions[1]));
  const { online, testimonies: onlineTestimonies, submissions } = onlineAuditions(r);
  return {
    auditions,
    online,
    testimonies: [...testimonies, ...onlineTestimonies],
    submissions,
  };
}

/** Rows that check how the site copes with what people really type. */
function edgeCases(r: Random, recent: Audition, other: Audition): Testimony[] {
  const base = (auditionId: string, daysAgo: number) => ({
    id: r.uuid(),
    auditionId,
    personInfo: null,
    email: null,
    verification: null,
    token: null,
    minutesAgo: daysAgo * DAY - r.int(30, 600),
  });
  const huge = composeText(r, ["démocratie", "services publics", "ruralité"], 25000, {});
  return [
    {
      ...base(recent.id, recent.daysAgo),
      personName: "Yasmine",
      content:
        "Merci 🙏 pour cette initiative ! Ici c'est « la galère » — vraiment… 😅\n\nLes prix ↑, les salaires →, et nous on fait comment ? 🤷‍♀️",
      topics: ["pouvoir d'achat"],
    },
    {
      ...base(recent.id, recent.daysAgo),
      personName: "Anonyme",
      content:
        "<b>Important</b> : <script>alert('test')</script> & \"guillemets\" — ce texte doit s'afficher tel quel, sans être interprété.",
      topics: ["médias"],
    },
    {
      ...base(recent.id, recent.daysAgo),
      personName: "Marie-Christine de La Roche-Aymon d'Auvergne-Lauraguais",
      personInfo:
        "Retraitée de la fonction publique hospitalière, ancienne conseillère municipale, présidente d'une association de quartier depuis 2004, mère de quatre enfants et grand-mère de neuf petits-enfants dont deux vivent à l'étranger",
      content: composeText(r, ["santé", "retraites"], 900, {}).text,
      topics: ["santé", "retraites", "solidarité"],
    },
    {
      ...base(recent.id, recent.daysAgo),
      personName: "  Anonyme  ",
      content:
        "Trois choses :\n- les bus le soir\n- les loyers\n- l'éclairage de la rue\n\n\nVoilà.\n\n\n",
      topics: ["transports", "logement", "sécurité"],
    },
    {
      ...base(recent.id, recent.daysAgo),
      personName: "Karim",
      personInfo: "Habitant du quartier",
      content:
        "الأسعار ترتفع كل شهر والرواتب لا تتغير. نريد أن يستمع المسؤولون إلينا قبل اتخاذ القرارات.",
      topics: ["pouvoir d'achat", "démocratie"],
    },
    {
      ...base(other.id, other.daysAgo),
      personName: "Anonyme",
      content: huge.text,
      topics: huge.used,
    },
    {
      ...base(other.id, other.daysAgo),
      personName: "Anonyme",
      content: composeText(r, ["économie"], 400, {}).text,
      topics: [],
    },
    {
      ...base(other.id, other.daysAgo),
      personName: "Anonyme",
      content: composeText(r, ["démocratie", "écologie", "travail"], 2500, {}).text,
      topics: [
        "démocratie",
        "écologie",
        "travail",
        "santé",
        "logement",
        "transports",
        "fiscalité",
        "retraites",
        "éducation",
        "culture",
        "jeunesse",
        "énergie",
      ],
    },
    {
      ...base(other.id, other.daysAgo),
      personName: "Anonyme",
      content: composeText(r, ["pouvoir d'achat"], 600, {}).text,
      topics: ["consommation", "pouvoir d'achat"],
    },
  ];
}

/**
 * Online auditions as the API creates them (one per town hall and month,
 * testimonies without email, one submission row each). Villeurbanne is
 * public (verified testimonies); Grenoble holds only a pending one, so the
 * public never sees it; Gap keeps an expired pending link.
 */
function onlineAuditions(r: Random) {
  const plan = [
    { hall: 0, monthsAgo: 0, states: ["verified", "verified", "verified", "pending", "pending"] },
    { hall: 1, monthsAgo: 1, states: ["verified", "verified"] },
    { hall: 2, monthsAgo: 0, states: ["pending"] },
    { hall: 3, monthsAgo: 2, states: ["verified", "pending"] },
  ] as const;
  const online: OnlineAudition[] = [];
  const testimonies: Testimony[] = [];
  const submissions: Submission[] = [];
  for (const p of plan) {
    const audition: OnlineAudition = {
      id: r.uuid(),
      hall: ONLINE_TOWN_HALLS[p.hall],
      monthsAgo: p.monthsAgo,
    };
    online.push(audition);
    p.states.forEach((state, i) => {
      const minutesAgo =
        p.monthsAgo === 0
          ? r.int(60, 2 * DAY) + i * 90
          : p.monthsAgo * 30 * DAY + r.int(-10 * DAY, 10 * DAY);
      const name = r.pick(FIRST_NAMES);
      const t: Testimony = {
        ...makeTestimony(r, audition.id, 0, {}, { target: r.int(300, 1500), anonymous: 0 }),
        personName: name,
        email: null,
        verification: state,
        token: r.uuid(),
        minutesAgo,
      };
      testimonies.push(t);
      submissions.push({
        testimonyId: t.id,
        emailHash: createHash("sha256").update(fakeEmail(name)).digest("hex"),
        minutesAgo,
      });
    });
  }
  return { online, testimonies, submissions };
}

const FRENCH_SPEAKING_NORTH = new Set(["Belgique", "Suisse", "Canada", "Luxembourg", "Monaco"]);

function worldProfile(): Dataset {
  const r = makeRandom(20261022);
  const auditions: Audition[] = [];
  const testimonies: Testimony[] = [];
  for (const { country, lang, cities } of COUNTRIES) {
    const firstNames =
      lang === "fr" && FRENCH_SPEAKING_NORTH.has(country)
        ? FIRST_NAMES
        : (FOREIGN_FIRST_NAMES[lang] ?? FIRST_NAMES);
    for (const city of cities) {
      const location = `${city}, ${country}`;
      for (let a = r.int(2, 3); a > 0; a--) {
        const daysAgo = r.int(5, 700);
        const audition: Audition = {
          id: r.uuid(),
          title: `Audition citoyenne - ${location}`,
          daysAgo,
          location,
          content: r.pick(AUDITION_CONTENTS),
          status: "published",
          // Placed once the world gazetteer is there.
          placement: "abroad",
        };
        auditions.push(audition);
        for (let t = r.int(3, 4); t > 0; t--) {
          const foreign = lang !== "fr" && r.chance(0.4) ? r.pick(FOREIGN[lang]) : null;
          const testimony = makeTestimony(
            r,
            audition.id,
            daysAgo,
            {},
            {
              target: Math.min(6000, Math.max(80, r.logNormal(6.4, 0.9))),
              firstNames,
              anonymous: 0.1,
            },
          );
          if (foreign) {
            testimony.content = foreign.text;
            testimony.topics = tagsFor(r, foreign.themes, {});
          }
          testimonies.push(testimony);
        }
      }
    }
  }
  return { auditions, online: [], testimonies, submissions: [] };
}

/**
 * Auditions abroad that are on the map: one or two at every lieu of
 * fixtures/abroad.ts (so each of its units is named by a path), with
 * testimonies as worldProfile writes them, some in the country's language.
 */
function abroadProfile(): Dataset {
  const r = makeRandom(20261111);
  const auditions: Audition[] = [];
  const testimonies: Testimony[] = [];
  for (const { country, location } of abroadLieux()) {
    const { name, lang } = country;
    const firstNames =
      lang === "fr" && FRENCH_SPEAKING_NORTH.has(name)
        ? FIRST_NAMES
        : (FOREIGN_FIRST_NAMES[lang] ?? FIRST_NAMES);
    for (let a = r.chance(0.37) ? 2 : 1; a > 0; a--) {
      const daysAgo = r.int(5, 700);
      const audition: Audition = {
        id: r.uuid(),
        title: `Audition citoyenne - ${location}`,
        daysAgo,
        location,
        content: r.pick(AUDITION_CONTENTS),
        status: "published",
        placement: "placed-abroad",
      };
      auditions.push(audition);
      for (let t = r.int(3, 4); t > 0; t--) {
        const foreign = lang !== "fr" && r.chance(0.4) ? r.pick(FOREIGN[lang]) : null;
        const testimony = makeTestimony(
          r,
          audition.id,
          daysAgo,
          {},
          {
            target: Math.min(6000, Math.max(80, r.logNormal(6.4, 0.9))),
            firstNames,
            anonymous: 0.1,
          },
        );
        if (foreign) {
          testimony.content = foreign.text;
          testimony.topics = tagsFor(r, foreign.themes, {});
        }
        testimonies.push(testimony);
      }
    }
  }
  return { auditions, online: [], testimonies, submissions: [] };
}

// ---- SQL --------------------------------------------------------------------

function str(s: string | null): string {
  return s === null ? "null" : `'${s.replace(/'/g, "''")}'`;
}

function tags(t: string[] | null): string {
  if (t === null) return "null";
  if (t.length === 0) return "'{}'::text[]";
  return `array[${t.map(str).join(", ")}]`;
}

function num(n: number | null): string {
  return n === null ? "null" : String(n);
}

function textArray(xs: string[] | null): string {
  return xs === null ? "null" : `array[${xs.map(str).join(", ")}]::text[]`;
}

function jsonb(v: unknown): string {
  return v === null ? "null" : `${str(JSON.stringify(v))}::jsonb`;
}

function batches<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

const MONTHS =
  "array['de janvier', 'de février', 'de mars', 'd''avril', 'de mai', 'de juin', 'de juillet', 'd''août', 'de septembre', 'd''octobre', 'de novembre', 'de décembre']";
const MONTH_NAMES =
  "array['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']";

/** The place columns, after the columns every audition has. */
const PLACE_COLUMNS =
  "place_unit, place_path, locality_id, lieu_key, lat, lng, place_precision, place_candidates, placed_location, placed_rules, geo_release";
const NEVER_PLACED = PLACE_COLUMNS.split(", ")
  .map(() => "null")
  .join(", ");
/** An online bucket's place columns, as submit_online_testimony sets them: under its own label, no rules hash. */
const ONLINE_PLACE = {
  columns:
    "place_unit, place_path, locality_id, lieu_key, lat, lng, place_precision, placed_location, geo_release",
  select:
    "v.place_unit, v.place_path, v.locality_id, v.location, v.lat, v.lng, v.place_precision, v.location, v.geo_release",
  values: "place_unit, place_path, locality_id, lat, lng, place_precision, geo_release",
};

/**
 * The fixtures' places for this dataset, and the units they reference, root
 * first. Refused when they no longer fit the seed's lieux, or a lieu that
 * LOCATION_RULES now name or point elsewhere (as the placement job's rules
 * pass would place it again); under any other rules change they hold, and
 * the rows are stamped with the current rules, as that pass stamps them.
 * `lieux`: the in-person lieux too (the legacy shape needs only the town halls).
 */
function frenchPlaces(data: Dataset, lieux: boolean): { places: FrPlaces; units: FrUnit[] } {
  const { units, places } = readFrFixtures();
  const rebuild = "build them again: npx tsx scripts/seed/fixtures/build-fixtures.ts";
  const used = new Set<string>();
  const outdated = new Set<string>();
  for (const a of lieux ? data.auditions.filter((a) => a.placement === "fixture") : []) {
    const p = places.lieux[a.location];
    if (!p) throw new Error(`No fixture place for "${a.location}": ${rebuild}`);
    const why = placeOutdated(a.location, p);
    if (why) outdated.add(`"${a.location}": ${why}`);
    p.place_path?.forEach((id) => used.add(id));
  }
  if (outdated.size > 0) {
    throw new Error(
      `LOCATION_RULES moved seed lieux since the place fixtures were built (${places.rules}, now ${RULES_HASH}):\n` +
        `  ${[...outdated].join("\n  ")}\n${rebuild}`,
    );
  }
  for (const { hall } of data.online) {
    const p = places.online[hall.citycode];
    if (p?.location !== hall.location) {
      throw new Error(`No fixture place for ${hall.citycode} "${hall.location}": ${rebuild}`);
    }
    p.place_path.forEach((id) => used.add(id));
  }
  const known = new Set(units.map((u) => u.id));
  for (const id of used) {
    if (!known.has(id)) throw new Error(`Unit ${id} is missing from fr-units.json: ${rebuild}`);
  }
  return { places, units: units.filter((u) => used.has(u.id)) };
}

/**
 * The abroad fixture's places for this dataset, and the units they reference:
 * the countries, then their localities. Null when no row is placed abroad.
 */
function placedAbroad(
  data: Dataset,
): { places: Record<string, AbroadPlace>; units: AbroadUnit[] } | null {
  const rows = data.auditions.filter((a) => a.placement === "placed-abroad");
  if (rows.length === 0) return null;
  const places = abroadPlaces();
  const used = new Set<string>();
  for (const a of rows) {
    const p = places[a.location];
    if (!p) throw new Error(`No abroad fixture place for "${a.location}" (fixtures/abroad.ts)`);
    p.place_path.forEach((id) => used.add(id));
  }
  return { places, units: abroadUnits().filter((u) => used.has(u.id)) };
}

/** Auditions on a point or an area, unplaced after an attempt, never placed (stale). */
interface Counts {
  placed: number;
  unplaced: number;
  stale: number;
}

function toSql(
  profile: Profile,
  shape: Shape,
  data: Dataset,
): { sql: string; counts: Counts | null } {
  const withPlaces = shape === "places";
  // The town halls' `place` comes from the fixtures in either shape.
  const fr =
    data.online.length > 0 || (withPlaces && data.auditions.some((a) => a.placement === "fixture"))
      ? frenchPlaces(data, withPlaces)
      : null;
  const abroad = withPlaces ? placedAbroad(data) : null;
  const out: string[] = [
    `-- Generated by scripts/seed/generate.ts (profile: ${profile}${shape === "legacy" ? ", shape: legacy" : ""}). Do not edit:`,
    "-- run `npm run db:seed` instead. Fake Auditions Citoyennes data only.",
    "",
    "begin;",
    "",
    "-- Never on a database with real data: only a blank one, or one this seed",
    "-- already filled (it leaves a fake_seed_loaded entry in audit_log).",
    "do $$",
    "begin",
    "  if exists (select 1 from public.auditions)",
    "     and not exists (select 1 from public.audit_log where action = 'fake_seed_loaded') then",
    "    raise exception 'This database holds auditions this seed did not write: refusing to load fake data into it.';",
    "  end if;",
    "end $$;",
    "",
    "-- Loading again replaces the previous fake data (accounts and roles stay).",
    withPlaces
      ? "truncate public.online_testimony_submissions, public.testimonies, public.auditions, public.geo_units;"
      : "truncate public.online_testimony_submissions, public.testimonies, public.auditions;",
    "",
  ];

  if (withPlaces && fr && fr.units.length > 0) {
    out.push(
      "-- The units the placed rows reference, root first (fixtures/fr-units.json).",
      "insert into public.geo_units (id, parent_id, level, country, name, code, lat, lng, source, geo_release) values",
      fr.units
        .map(
          (u) =>
            `  (${str(u.id)}, ${str(u.parent_id)}, ${str(u.level)}, ${str(u.country)}, ${str(u.name)}, ${str(u.code)}, ${num(u.lat)}, ${num(u.lng)}, ${str(u.source)}, ${str(u.geo_release)})`,
        )
        .join(",\n") + ";",
      "",
    );
  }

  if (abroad) {
    out.push(
      "-- The units the rows placed abroad reference, countries first (fixtures/abroad.ts).",
      "insert into public.geo_units (id, parent_id, level, country, name, code, lat, lng, source, geo_release) values",
      abroad.units
        .map(
          (u) =>
            `  (${str(u.id)}, ${str(u.parent_id)}, ${str(u.level)}, ${str(u.country)}, ${str(u.name)}, ${str(u.code)}, ${num(u.lat)}, ${num(u.lng)}, ${str(u.source)}, ${str(u.geo_release)})`,
        )
        .join(",\n") + ";",
      "",
    );
  }

  // A row placed, or unplaced after an attempt, holds what the API stores
  // (placed_location = its location, placed_rules = the rules it stands
  // under); one the old app wrote, nothing: stale.
  const placeOf = (a: Audition): FrPlace | AbroadPlace | null =>
    a.placement === "fixture"
      ? fr!.places.lieux[a.location]
      : a.placement === "placed-abroad"
        ? abroad!.places[a.location]
        : a.placement === "abroad"
          ? unplacedAbroad(a.location)
          : null;
  const placeValues = (a: Audition) => {
    const p = placeOf(a);
    if (!p) return NEVER_PLACED;
    return [
      str(p.place_unit),
      textArray(p.place_path),
      str(p.locality_id),
      str(p.lieu_key),
      num(p.lat),
      num(p.lng),
      str(p.place_precision),
      jsonb(p.place_candidates),
      str(a.location),
      str(RULES_HASH),
      str(p.geo_release),
    ].join(", ");
  };
  for (const rows of batches(data.auditions, 200)) {
    out.push(
      withPlaces
        ? `insert into public.auditions (id, title, date, location, content, status, created_at, ${PLACE_COLUMNS}) values`
        : "insert into public.auditions (id, title, date, location, content, status, created_at) values",
      rows
        .map(
          (a) =>
            `  (${str(a.id)}, ${str(a.title)}, current_date - ${a.daysAgo}, ${str(a.location)}, ${str(a.content)}, ${str(a.status)}, now() - interval '${a.daysAgo} days'` +
            (withPlaces ? `, ${placeValues(a)})` : ")"),
        )
        .join(",\n") + ";",
      "",
    );
  }

  if (fr && data.online.length > 0) {
    // Titles and texts depend on the month the seed is loaded in, as the API's
    // do. A bucket is placed at its town hall's units and point (its `place`).
    const more = (s: string) => (withPlaces ? `, ${s}` : "");
    out.push(
      `insert into public.auditions (id, title, date, location, content, status, audition_en_ligne, citycode, place, created_at${more(ONLINE_PLACE.columns)})`,
      "select v.id::uuid,",
      `       'Audition en ligne ' || (${MONTHS})[extract(month from m.d)::int],`,
      "       m.d, v.location,",
      `       'Témoignages déposés en ligne sur le site en ' || (${MONTH_NAMES})[extract(month from m.d)::int] || ' ' || extract(year from m.d) || ', rattachés à la ' || v.location || '.',`,
      `       'published', true, v.citycode, v.place::jsonb, m.d::timestamptz${more(ONLINE_PLACE.select)}`,
      "from (values",
      data.online
        .map(({ id, monthsAgo, hall }) => {
          const p = fr.places.online[hall.citycode];
          const place = [
            str(p.place_unit),
            textArray(p.place_path),
            str(p.locality_id),
            num(p.place.lat),
            num(p.place.lng),
            str(p.place_precision),
            str(p.geo_release),
          ].join(", ");
          return `  (${str(id)}, ${monthsAgo}, ${str(hall.location)}, ${str(hall.citycode)}, ${str(JSON.stringify(p.place))}${more(place)})`;
        })
        .join(",\n"),
      `) as v(id, months_ago, location, citycode, place${more(ONLINE_PLACE.values)})`,
      "cross join lateral (select date_trunc('month', current_date - make_interval(months => v.months_ago))::date as d) as m;",
      "",
    );
  }

  for (const rows of batches(data.testimonies, 200)) {
    out.push(
      "insert into public.testimonies (id, audition_id, person_name, person_info, content, topics, email, verification_status, verification_token, created_at) values",
      rows
        .map(
          (t) =>
            `  (${str(t.id)}, ${str(t.auditionId)}, ${str(t.personName)}, ${str(t.personInfo)}, ${str(t.content)}, ${tags(t.topics)}, ${str(t.email)}, ${str(t.verification)}, ${str(t.token)}, now() - interval '${t.minutesAgo} minutes')`,
        )
        .join(",\n") + ";",
      "",
    );
  }

  if (data.submissions.length > 0) {
    out.push(
      "insert into public.online_testimony_submissions (testimony_id, email_hash, created_at) values",
      data.submissions
        .map(
          (s) =>
            `  (${str(s.testimonyId)}, ${str(s.emailHash)}, now() - interval '${s.minutesAgo} minutes')`,
        )
        .join(",\n") + ";",
      "",
    );
  }

  const counts: Counts | null = withPlaces
    ? {
        placed: data.auditions.filter((a) => placeOf(a)?.place_path).length + data.online.length,
        unplaced: data.auditions.filter((a) => placeOf(a) && !placeOf(a)?.place_path).length,
        stale: data.auditions.filter((a) => !placeOf(a)).length,
      }
    : null;
  // The marker the guard above looks for; with what the seed placed, the
  // fingerprint of its place data as loaded and the LOCATION_RULES its rows
  // are stamped with, which db:check compares with the database and its own
  // (scripts/db-checks/seedGate.ts).
  out.push(
    "insert into public.audit_log (action, target_type, metadata)",
    counts
      ? `values ('fake_seed_loaded', 'database', jsonb_build_object('profile', ${str(profile)}, 'shape', ${str(shape)}, ` +
          `'auditions', ${data.auditions.length + data.online.length}, 'placed', ${counts.placed}, 'unplaced', ${counts.unplaced}, 'stale', ${counts.stale},\n` +
          `  'rules', ${str(RULES_HASH)}, 'places', ${PLACES_FINGERPRINT}));`
      : `values ('fake_seed_loaded', 'database', jsonb_build_object('profile', ${str(profile)}));`,
    "",
    "commit;",
    "",
  );
  return { sql: out.join("\n"), counts };
}

/** A lieu abroad, as the API leaves one it cannot place: on no point, under its lieu name. */
function unplacedAbroad(location: string): FrPlace {
  return {
    place_unit: null,
    place_path: null,
    locality_id: null,
    lieu_key: getCanonicalLocation(location),
    lat: null,
    lng: null,
    place_precision: "unplaced",
    place_candidates: null,
    geo_release: null,
  };
}

// ---- Main -------------------------------------------------------------------

export const PROFILES: Profile[] = ["france", "world", "all", "france-abroad"];
export const SHAPES: Shape[] = ["places", "legacy"];

/** What each profile is made of, in the order its rows are generated and written. */
const PARTS: Record<Profile, (() => Dataset)[]> = {
  france: [franceProfile],
  world: [worldProfile],
  all: [franceProfile, worldProfile],
  "france-abroad": [franceProfile, abroadProfile],
};

/** The rows of a profile, the same on every call. */
export function seedData(profile: Profile): Dataset {
  emailCounter = 0;
  const parts = PARTS[profile].map((part) => part());
  return {
    auditions: parts.flatMap((p) => p.auditions),
    online: parts.flatMap((p) => p.online),
    testimonies: parts.flatMap((p) => p.testimonies),
    submissions: parts.flatMap((p) => p.submissions),
  };
}

/** The seed of a profile, in a shape: the SQL, and a line saying what it holds. */
export function seedSql(
  profile: Profile,
  shape: Shape = "places",
): { sql: string; summary: string } {
  const data = seedData(profile);
  const { sql, counts } = toSql(profile, shape, data);
  const by = (k: Testimony["verification"]) =>
    data.testimonies.filter((t) => t.verification === k).length;
  const summary =
    `seed.sql (${profile}${shape === "legacy" ? ", legacy" : ""}): ${data.auditions.length + data.online.length} auditions ` +
    `(${data.online.length} online, ${data.auditions.filter((a) => a.status === "draft").length} drafts` +
    (counts
      ? `; ${counts.placed} placed, ${counts.unplaced} unplaced, ${counts.stale} never placed`
      : "") +
    `), ${data.testimonies.length} testimonies (${by("pending")} pending, ${by("verified")} verified), ` +
    `${(sql.length / 1024 / 1024).toFixed(1)} MB`;
  return { sql, summary };
}
