// The admin list's content filters judged from the server's counts (design
// A22) against the list's own judgement before them, over every combination
// of verified, themes and texts found in titles, places, contexts and
// testimonies. The server's answer is made here as admin_audition_filter
// makes it (its SQL over the derived columns, which @ac/shared's functions
// generate). Run with `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answersText,
  AUDITION_THEMES,
  fold,
  passesContent,
  themesOf,
  type AdminAuditionFilter,
  type TestimonyContent,
} from "@ac/shared";
import {
  contentAskOf,
  contentOn,
  passesContentMatches,
  themeCountsOf,
  type AuditionText,
  type ContentAsk,
} from "./contentMatches";

interface Testimony extends TestimonyContent {
  audition_id: string;
}

const T = AUDITION_THEMES;

const auditions: AuditionText[] = [
  { id: "a1", title: "Audition du marché", location: "Place Bellecour, Lyon", content: "" },
  { id: "a2", title: "Rencontre", location: "Médiathèque, Bron", content: "Écoles et crèches" },
  { id: "a3", title: "Cahier de doléances", location: "Mairie", content: "" },
  { id: "a4", title: "Sans témoignage", location: "Gare", content: "climat" },
  { id: "a5", title: "Ateliers ÉTÉ", location: "Parc", content: "" },
];

const testimonies: Testimony[] = [
  t("a1", "Anne", "retraitée", "Le prix du pain monte", [T[4]], "verified"),
  t("a1", "Bob", null, "Les écoles ferment", [T[1], T[13]], null),
  t("a1", "Chloé", "étudiante", "Le climat d'abord", [T[11]], "pending"),
  t("a2", "Dan", null, "Hôpital trop loin", [T[0], "démocratie"], "verified"),
  t("a2", "Eve", null, "Rien à dire", null, "verified"),
  t("a3", "Fanny", "marché", "Les impôts", [T[14]], null),
  t("a5", "Gus", null, '[{"q":"Votre avis ?","a":"Été trop chaud"}]', [T[11], T[15]], "verified"),
  // A testimony whose audition the list does not hold (another admin's, say).
  t("zz", "Hugo", null, "climat et écoles", [T[11], T[1]], "verified"),
];

function t(
  audition_id: string,
  person_name: string,
  person_info: string | null,
  content: string,
  topics: string[] | null,
  verification_status: string | null,
): Testimony {
  return { audition_id, person_name, person_info, content, topics, verification_status };
}

/** The list's judgement before the server: useAuditionFilters' `passes`
 *  over /api/testimonies/admin/filterable, as it was (content filters only). */
function passesBefore(
  a: AuditionText,
  f: { verified: boolean; topics: string[]; needle: string },
  all: Testimony[],
): boolean {
  const onTestimonies = f.verified || f.topics.length > 0;
  if (!onTestimonies && !f.needle) return true;
  const textInAudition =
    Boolean(f.needle) && fold(`${a.title} ${a.location} ${a.content}`).includes(f.needle);
  const textIn = (hay: string) => !f.needle || textInAudition || hay.includes(f.needle);
  const own = all
    .filter((x) => x.audition_id === a.id)
    .map((x) => ({
      t: x,
      hay: fold(`${x.person_name} ${x.person_info ?? ""} ${answersText(x.content)}`),
    }));
  if (!onTestimonies) return textInAudition || own.some((e) => textIn(e.hay));
  const others = { verified: f.verified, topics: f.topics, needle: "" };
  return own.some((e) => passesContent(e.t, others) && textIn(e.hay));
}

/** admin_audition_filter's matches, as its SQL counts them. */
function serverMatches(ask: ContentAsk, all: Testimony[]): AdminAuditionFilter["matches"] {
  const topics = ask.themes.map((i) => T[i]);
  const like = ask.textUnsent ? "" : ask.needle;
  const out: AdminAuditionFilter["matches"] = {};
  for (const id of new Set(all.map((x) => x.audition_id))) {
    const own = all.filter((x) => x.audition_id === id);
    const noText = own.filter((x) =>
      passesContent(x, { verified: ask.verified, topics, needle: "" }),
    ).length;
    const allN = own.filter((x) =>
      passesContent(x, { verified: ask.verified, topics, needle: like }),
    ).length;
    if (noText > 0) out[id] = [allN, noText];
  }
  return out;
}

/** The theme counts over the testimonies of `reachable` auditions. */
function serverThemes(all: Testimony[], reachable: Set<string>): number[] {
  return T.map(
    (theme) =>
      all.filter((x) => reachable.has(x.audition_id) && themesOf(x.topics).includes(theme)).length,
  );
}

const NEEDLES = [
  "",
  "marché", // title and a testimony's details
  "MARCHE", // the same, folded
  "bellecour", // a location only
  "crèches", // a context only
  "doléances", // a title only
  "climat", // testimonies and a context
  "écoles", // testimonies and a context (accented)
  "été", // an online testimony's answer, and a title
  "votre avis", // an online testimony's question: never searched
  "x", // one character
  "introuvable",
];
const THEME_SETS: string[][] = [
  [],
  ...T.map((theme) => [theme]),
  [T[11], T[1]],
  [T[0], T[7]],
  [...T],
];

test("every content filter combination passes the auditions it passed before", () => {
  let checked = 0;
  for (const verified of [false, true]) {
    for (const topics of THEME_SETS) {
      for (const text of NEEDLES) {
        const ask = contentAskOf({ verified, topics, text });
        const matches = serverMatches(ask, testimonies);
        const f = { verified, topics, needle: fold(text.trim()) };
        for (const a of auditions) {
          assert.equal(
            passesContentMatches(a, ask, matches),
            passesBefore(a, f, testimonies),
            `${a.id} with ${JSON.stringify({ verified, topics, text })}`,
          );
          checked++;
        }
      }
    }
  }
  assert.equal(checked, 2 * THEME_SETS.length * NEEDLES.length * auditions.length);
});

test("no answer (it failed): only the text in the audition itself passes", () => {
  const ask = contentAskOf({ verified: false, topics: [], text: "doléances" });
  assert.equal(passesContentMatches(auditions[2], ask, null), true);
  assert.equal(passesContentMatches(auditions[0], ask, null), false);
  const themed = contentAskOf({ verified: true, topics: [], text: "doléances" });
  assert.equal(passesContentMatches(auditions[2], themed, null), false);
  assert.equal(
    passesContentMatches(
      auditions[3],
      contentAskOf({ verified: false, topics: [], text: "" }),
      null,
    ),
    true,
  );
});

test("the theme options' counts are buildTopicOptions' over the reachable auditions", () => {
  const reachable = new Set(["a1", "a2", "a5"]);
  const counts = themeCountsOf(serverThemes(testimonies, reachable));
  const before = new Map<string, number>();
  for (const x of testimonies.filter((x) => reachable.has(x.audition_id))) {
    for (const theme of themesOf(x.topics)) before.set(theme, (before.get(theme) ?? 0) + 1);
  }
  for (const theme of T) assert.equal(counts.get(theme), before.get(theme) ?? 0, theme);
  assert.equal(counts.size, 16);
});

test("the query is the API's: any text however short, folded; themes as indexes", () => {
  const ask = contentAskOf({ verified: true, topics: [T[3], T[0], "inconnu"], text: "  É " });
  assert.deepEqual(ask.params, { v: "1", t: "0,3", q: "É" });
  assert.equal(ask.key, "v1|m9|qe");
  assert.equal(ask.needle, "e");
  assert.equal(ask.textUnsent, false);
  assert.equal(contentOn(ask), true);

  const none = contentAskOf({ verified: false, topics: [], text: "   " });
  assert.deepEqual(none.params, {});
  assert.equal(none.key, "");
  assert.equal(contentOn(none), false);
});

test("a text the API would refuse is asked without, and found in no testimony", () => {
  const long = "a".repeat(201);
  const ask = contentAskOf({ verified: false, topics: [], text: long });
  assert.equal(ask.textUnsent, true);
  assert.deepEqual(ask.params, {});
  assert.notEqual(ask.key, "");
  const withNul = contentAskOf({ verified: true, topics: [], text: "a\u0000b" });
  assert.equal(withNul.textUnsent, true);
  assert.deepEqual(withNul.params, { v: "1" });
  const a = { id: "a9", title: long, location: "", content: "" };
  // In the audition itself: found, as before.
  assert.equal(passesContentMatches(a, ask, { a9: [3, 3] }), true);
  assert.equal(passesContentMatches({ ...a, title: "" }, ask, { a9: [3, 3] }), false);
});
