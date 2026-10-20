import { AUDITION_THEMES, type AuditionTheme } from "./domain";

// The themes of a testimony, read in the 16-theme grid (AUDITION_THEMES).
//
// The AI tagging only ever answers in that grid, but most testimonies were
// tagged before it existed, with a vocabulary of their own ("démocratie",
// "écologie", "solidarité"…). They are converted here, on the client, and never
// in the database: the live database is shared with the old app, which still
// reads the old tags.

/** How a tag reached the grid: written in it, a plain synonym of one of its
 *  themes, or the closest theme to a tag that has no exact counterpart. */
export type ThemeMatch = "canonical" | "exact" | "approx";

/** A tag as compared: accents dropped, lower case, curly apostrophes made
 *  straight, spaces evened out. */
function themeKey(tag: string): string {
  return tag
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Old tags that mean one theme of the grid. */
const LEGACY_EXACT: Record<string, AuditionTheme> = {
  démocratie: "Démocratie et institutions",
  institutions: "Démocratie et institutions",
  écologie: "Environnement et écologie",
  climat: "Environnement et écologie",
  travail: "Emploi et conditions de travail",
  santé: "Santé et accès aux soins",
  inégalités: "Justice sociale et inégalités",
  fiscalité: "Fiscalité",
  "services publics": "Services publics",
  "pouvoir d'achat": "Pouvoir d'achat et inflation",
  retraites: "Retraites",
  éducation: "Éducation",
  logement: "Logement",
  immigration: "Immigration",
  sécurité: "Sécurité et police",
  médias: "Médias et information",
  culture: "Culture et loisirs",
  "loisirs et culture": "Culture et loisirs",
  géopolitique: "Guerre et géopolitique",
};

/** Old tags with no exact counterpart, filed under the theme their testimonies
 *  are mostly about (énergie sits with écologie far more often than with the
 *  pouvoir d'achat, the justice samples are about the judiciary…). */
const LEGACY_APPROX: Record<string, AuditionTheme> = {
  solidarité: "Justice sociale et inégalités",
  énergie: "Environnement et écologie",
  transports: "Services publics",
  jeunesse: "Éducation",
  justice: "Démocratie et institutions",
  handicap: "Santé et accès aux soins",
  covid: "Santé et accès aux soins",
  "sans-abrisme": "Logement",
  consommation: "Pouvoir d'achat et inflation",
};
// Left out of the grid on purpose: ruralité (a lens across services publics,
// écologie and santé), agriculture, économie, vie de quartier.

const GRID = new Set<string>(AUDITION_THEMES);
const ORDER = new Map<AuditionTheme, number>(AUDITION_THEMES.map((t, i) => [t, i]));

const BY_KEY = new Map<string, { theme: AuditionTheme; match: ThemeMatch }>();
for (const theme of AUDITION_THEMES) BY_KEY.set(themeKey(theme), { theme, match: "exact" });
for (const [tag, theme] of Object.entries(LEGACY_EXACT)) {
  BY_KEY.set(themeKey(tag), { theme, match: "exact" });
}
for (const [tag, theme] of Object.entries(LEGACY_APPROX)) {
  BY_KEY.set(themeKey(tag), { theme, match: "approx" });
}

const tagCache = new Map<string, { theme: AuditionTheme; match: ThemeMatch } | null>();

/** One raw tag → its place in the 16-theme grid (AUDITION_THEMES), or null ("hors grille"). */
export function normalizeTheme(tag: string): { theme: AuditionTheme; match: ThemeMatch } | null {
  // Written in the grid, exactly. Checked before the folded key: the old
  // "fiscalité", "retraites", "logement"… fold to the same key as the grid's
  // names, and must not be counted as written by the current tagging.
  if (GRID.has(tag)) return { theme: tag as AuditionTheme, match: "canonical" };
  let hit = tagCache.get(tag);
  if (hit === undefined) {
    hit = BY_KEY.get(themeKey(tag)) ?? null;
    tagCache.set(tag, hit);
  }
  return hit;
}

interface TopicThemes {
  themes: AuditionTheme[];
  approximate: boolean;
}

const EMPTY: TopicThemes = { themes: [], approximate: false };

// The topics arrays come from bulk payloads nobody mutates, so each is read once.
const topicsCache = new WeakMap<readonly string[], TopicThemes>();

function read(topics: readonly string[] | null | undefined): TopicThemes {
  if (!topics?.length) return EMPTY;
  let hit = topicsCache.get(topics);
  if (hit) return hit;
  const found = new Set<AuditionTheme>();
  let firm = false;
  for (const tag of topics) {
    const n = normalizeTheme(tag);
    if (!n) continue;
    found.add(n.theme);
    if (n.match !== "approx") firm = true;
  }
  const themes = [...found].sort((a, b) => ORDER.get(a)! - ORDER.get(b)!);
  hit = { themes, approximate: themes.length > 0 && !firm };
  topicsCache.set(topics, hit);
  return hit;
}

/** A testimony's grid themes: deduped, in AUDITION_THEMES order. Memoised per
 *  array, so the result is shared: read it, never change it. */
export function themesOf(topics: readonly string[] | null | undefined): AuditionTheme[] {
  return read(topics).themes;
}

/** True when every grid theme of these topics comes only from approximate conversions. */
export function themesApproximate(topics: readonly string[] | null | undefined): boolean {
  return read(topics).approximate;
}

// The grid's names cut to what fits one line of a map plate: the first word or
// two, the "et …" left out ("Santé et accès aux soins" → "Santé").
const SHORT_LABEL: Record<AuditionTheme, string> = {
  "Démocratie et institutions": "Démocratie",
  "Justice sociale et inégalités": "Justice sociale",
  "Environnement et écologie": "Environnement",
  "Services publics": "Services publics",
  "Emploi et conditions de travail": "Emploi",
  "Santé et accès aux soins": "Santé",
  Fiscalité: "Fiscalité",
  "Pouvoir d'achat et inflation": "Pouvoir d'achat",
  Éducation: "Éducation",
  Retraites: "Retraites",
  Logement: "Logement",
  Immigration: "Immigration",
  "Sécurité et police": "Sécurité",
  "Médias et information": "Médias",
  "Culture et loisirs": "Culture",
  "Guerre et géopolitique": "Géopolitique",
};

/** A grid theme in a word or two, for one line of a plate ("Pouvoir d'achat"). */
export function themeShortLabel(theme: AuditionTheme): string {
  return SHORT_LABEL[theme] ?? theme;
}
