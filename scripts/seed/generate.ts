// Writes supabase/seed.sql: fake Auditions Citoyennes data for the local stack
// and staging. Pure fake data: invented texts (texts.ts), example.org
// addresses, no imported dataset (imported_auditions stays empty), never a
// row of the real database.
//
//   npm run db:seed                      profile "france" (default): shaped like
//                                        the real corpus, plus edge cases
//   SEED_PROFILE=world npm run db:seed   every country but France
//   SEED_PROFILE=all npm run db:seed     both
//
// A fixed random seed per profile: the same profile always writes the same
// rows. Dates are relative to the day the file is loaded (current_date, now()),
// so pending verification links are fresh whenever it is.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
import { CATCH_ALL, COUNTRIES, FRANCE_CLUSTERS, ONLINE_TOWN_HALLS } from "./places";

type Profile = "france" | "world" | "all";

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

interface Audition {
  id: string;
  title: string;
  /** date = current_date - daysAgo */
  daysAgo: number;
  location: string;
  content: string;
  status: "published" | "draft";
}

interface Testimony {
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

interface OnlineAudition {
  id: string;
  hall: (typeof ONLINE_TOWN_HALLS)[number];
  monthsAgo: number;
}

interface Submission {
  testimonyId: string;
  emailHash: string;
  minutesAgo: number;
}

interface Dataset {
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
 * oldest rows are. Counts follow the real corpus (2 to 5, a tail up to 12).
 */
function tagsFor(r: Random, used: Theme[], boost: Partial<Record<Theme, number>>): string[] {
  const x = r.next();
  const want =
    x < 0.02 ? 1 : x < 0.14 ? 2 : x < 0.37 ? 3 : x < 0.65 ? 4 : x < 0.92 ? 5 : r.int(6, 12);
  const tags = [...used];
  while (tags.length < want) {
    const t = r.weighted(weightsWith(boost));
    if (!tags.includes(t)) tags.push(t);
  }
  const chosen = tags.slice(0, want);
  const style = r.next();
  if (style < 0.85) return chosen;
  if (style < 0.95) {
    return [...new Set(chosen.map((t) => CANONICAL[t]).filter((t): t is string => Boolean(t)))];
  }
  return chosen.map((t) => t.charAt(0).toUpperCase() + t.slice(1));
}

function personName(r: Random, firstNames: readonly string[], anonymous = 0.75): string {
  const x = r.next();
  if (x < anonymous) return "Anonyme";
  if (x < anonymous + (1 - anonymous) * 0.84) return r.pick(firstNames);
  if (x < anonymous + (1 - anonymous) * 0.96) return `${r.pick(firstNames)} ${r.pick(LAST_NAMES)}`;
  return `${r.pick(firstNames)} ${r.pick(LAST_NAMES).charAt(0)}.`;
}

/** Testimonies per audition: the real spread (median 4, a long tail). */
function testimonyCount(r: Random): number {
  const x = r.next();
  if (x < 0.25) return 1;
  if (x < 0.5) return r.int(2, 4);
  if (x < 0.75) return r.int(5, 6);
  if (x < 0.9) return r.int(7, 13);
  return r.int(14, 30);
}

/** How a testimony stands with its witness, given how old its audition is:
 *  most have no email (never asked), recent ones wait for the witness,
 *  older pending links have expired (14 days), a few were confirmed. */
function verificationFor(r: Random, daysAgo: number) {
  if (daysAgo <= 10 && r.chance(0.3)) return "pending" as const;
  if (daysAgo >= 15 && daysAgo <= 60 && r.chance(0.12)) return "pending" as const;
  if (daysAgo <= 730 && r.chance(0.02)) return "verified" as const;
  return null;
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
  const target = opts.target ?? Math.min(16000, Math.max(80, r.logNormal(6.96, 1.12)));
  const { text, used } = composeText(r, primary, target, boost);
  const name = personName(r, opts.firstNames ?? FIRST_NAMES, opts.anonymous);
  const verification = verificationFor(r, daysAgo);
  const offset = Math.min(r.int(30, 3 * DAY), Math.max(daysAgo * DAY - 30, 0));
  return {
    id: r.uuid(),
    auditionId,
    personName: name,
    personInfo: r.chance(0.46) ? r.pick(PERSON_INFOS) : null,
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
        const draft = cluster.name === "elsewhere" && draftsLeft > 0 && r.chance(0.2);
        if (draft) draftsLeft -= 1;
        const audition: Audition = {
          id: r.uuid(),
          title: `Audition citoyenne - ${place.location}`,
          daysAgo,
          location: place.location,
          content: r.pick(AUDITION_CONTENTS),
          status: draft ? "draft" : "published",
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

  // The catch-all bucket of old testimonies, as on the real site.
  const catchAll: Audition = {
    id: r.uuid(),
    title: `Audition citoyenne - ${CATCH_ALL.location}`,
    daysAgo: CATCH_ALL.daysAgo,
    location: CATCH_ALL.location,
    content: "Témoignages recueillis avant la mise en ligne du site, sans lieu précis.",
    status: "published",
  };
  auditions.push(catchAll);
  for (let i = 0; i < CATCH_ALL.testimonies; i++) {
    testimonies.push(makeTestimony(r, catchAll.id, CATCH_ALL.daysAgo + r.int(-150, 150), {}));
  }

  testimonies.push(...edgeCases(r, auditions[0], catchAll));
  const { online, testimonies: onlineTestimonies, submissions } = onlineAuditions(r);
  return {
    auditions,
    online,
    testimonies: [...testimonies, ...onlineTestimonies],
    submissions,
  };
}

/** Rows that check how the site copes with what people really type. */
function edgeCases(r: Random, recent: Audition, catchAll: Audition): Testimony[] {
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
      ...base(catchAll.id, catchAll.daysAgo),
      personName: "Anonyme",
      content: huge.text,
      topics: huge.used,
    },
    {
      ...base(catchAll.id, catchAll.daysAgo),
      personName: "Anonyme",
      content: composeText(r, ["économie"], 400, {}).text,
      topics: [],
    },
    {
      ...base(catchAll.id, catchAll.daysAgo),
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
      ...base(catchAll.id, catchAll.daysAgo),
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
              anonymous: 0.6,
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

// ---- SQL --------------------------------------------------------------------

function str(s: string | null): string {
  return s === null ? "null" : `'${s.replace(/'/g, "''")}'`;
}

function tags(t: string[] | null): string {
  if (t === null) return "null";
  if (t.length === 0) return "'{}'::text[]";
  return `array[${t.map(str).join(", ")}]`;
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

function toSql(profile: Profile, data: Dataset): string {
  const out: string[] = [
    `-- Generated by scripts/seed/generate.ts (profile: ${profile}). Do not edit:`,
    "-- run `npm run db:seed` instead. Fake Auditions Citoyennes data only.",
    "",
    "begin;",
    "",
  ];

  for (const rows of batches(data.auditions, 200)) {
    out.push(
      "insert into public.auditions (id, title, date, location, content, status, created_at) values",
      rows
        .map(
          (a) =>
            `  (${str(a.id)}, ${str(a.title)}, current_date - ${a.daysAgo}, ${str(a.location)}, ${str(a.content)}, ${str(a.status)}, now() - interval '${a.daysAgo} days')`,
        )
        .join(",\n") + ";",
      "",
    );
  }

  if (data.online.length > 0) {
    // Titles and texts depend on the month the seed is loaded in, as the API's do.
    out.push(
      "insert into public.auditions (id, title, date, location, content, status, audition_en_ligne, citycode, place, created_at)",
      "select v.id::uuid,",
      `       'Audition en ligne ' || (${MONTHS})[extract(month from m.d)::int],`,
      "       m.d, v.location,",
      `       'Témoignages déposés en ligne sur le site en ' || (${MONTH_NAMES})[extract(month from m.d)::int] || ' ' || extract(year from m.d) || ', rattachés à la ' || v.location || '.',`,
      "       'published', true, v.citycode, v.place::jsonb, m.d::timestamptz",
      "from (values",
      data.online
        .map(
          (o) =>
            `  (${str(o.id)}, ${o.monthsAgo}, ${str(o.hall.location)}, ${str(o.hall.citycode)}, ${str(JSON.stringify(o.hall.place))})`,
        )
        .join(",\n"),
      ") as v(id, months_ago, location, citycode, place)",
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

  out.push("commit;", "");
  return out.join("\n");
}

// ---- Main -------------------------------------------------------------------

const profile = (process.env.SEED_PROFILE ?? "france") as Profile;
if (!["france", "world", "all"].includes(profile)) {
  console.error(`SEED_PROFILE must be france, world or all (got "${profile}")`);
  process.exit(1);
}

const parts: Dataset[] = [];
if (profile !== "world") parts.push(franceProfile());
if (profile !== "france") parts.push(worldProfile());
const data: Dataset = {
  auditions: parts.flatMap((p) => p.auditions),
  online: parts.flatMap((p) => p.online),
  testimonies: parts.flatMap((p) => p.testimonies),
  submissions: parts.flatMap((p) => p.submissions),
};

const target = fileURLToPath(new URL("../../supabase/seed.sql", import.meta.url));
const sql = toSql(profile, data);
writeFileSync(target, sql);

const by = (k: Testimony["verification"]) =>
  data.testimonies.filter((t) => t.verification === k).length;
console.log(
  `seed.sql (${profile}): ${data.auditions.length + data.online.length} auditions ` +
    `(${data.online.length} online, ${data.auditions.filter((a) => a.status === "draft").length} drafts), ` +
    `${data.testimonies.length} testimonies (${by("pending")} pending, ${by("verified")} verified), ` +
    `${(sql.length / 1024 / 1024).toFixed(1)} MB`,
);
