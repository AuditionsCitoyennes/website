// The edge corpus of the derived-columns parity check: tags and texts the seed
// does not hold, built from @ac/shared so it follows the grid and the questions.

import { AUDITION_QUESTIONS, AUDITION_THEMES, composeAnswers, THEME_KEY_TABLE } from "@ac/shared";

export interface FixtureRow {
  person_name: string;
  person_info: string | null;
  content: string;
  topics: string[] | null;
}

const ch = (cp: number) => String.fromCodePoint(cp);
const NBSP = String.fromCharCode(0xa0);
const NNBSP = String.fromCharCode(0x202f);
const BOM = String.fromCharCode(0xfeff);
const ZWSP = String.fromCharCode(0x200b);
const KELVIN = String.fromCharCode(0x212a);
const LSQUO = String.fromCharCode(0x2018);
const RSQUO = String.fromCharCode(0x2019);
const ACUTE = String.fromCharCode(0x301);
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);

/** Ways a tag may have been typed: case, accents, odd spaces, curly quotes. */
function tagVariants(tag: string): string[] {
  const accented = tag.replace(/e/g, "é").replace(/a/g, "à").replace(/i/g, "î");
  return [
    tag,
    tag.toUpperCase(),
    tag.charAt(0).toUpperCase() + tag.slice(1),
    tag.toLowerCase(),
    tag.normalize("NFD"),
    accented,
    accented.toUpperCase(),
    tag.replace(/ /g, NBSP),
    tag.replace(/ /g, NNBSP),
    tag.replace(/ /g, `  ${IDEOGRAPHIC_SPACE}\t`),
    `${BOM}${tag}`,
    `  ${tag}${NBSP}\n`,
    tag.replace(/'/g, RSQUO),
    tag.replace(/'/g, LSQUO),
    tag.replace(/ /g, ZWSP),
    `${tag}${ZWSP}`,
    tag.replace(/k/gi, KELVIN),
    tag.replace(/e/, `e${ACUTE}`),
    tag.replace(/ /g, ""),
  ];
}

const TAG_LISTS: (string[] | null)[] = [
  null,
  [],
  ["énergie", "écologie"],
  ["énergie", "santé"],
  ["énergie", "ruralité"],
  ["ruralité", "agriculture", "économie", "vie de quartier"],
  ["Logement", "logement", "LOGEMENT"],
  ["transports", "jeunesse", "covid"],
  ["covid", "Covid", "COVID"],
  ["Fiscalité", "fiscalité", "Fiscalite"],
  [""],
  [" "],
  [BOM],
  ["Œcologie", "cœur", "pouvoir dʼachat", "transports" + ZWSP],
  ["Démocratie et institutions", "justice"],
  ["justice", "solidarité"],
  AUDITION_THEMES.slice(),
  THEME_KEY_TABLE.map((k) => k.key),
];

const [Q0, Q1, Q2] = AUDITION_QUESTIONS;

const TEXTS: string[] = [
  "",
  " ",
  `${NBSP}\n${BOM}`,
  "Un texte noté pendant une audition, sans question.",
  composeAnswers(["Bien, merci.", "Pas très bien.", "Je changerais tout."]),
  composeAnswers(["", "Seulement la deuxième.", ""]),
  composeAnswers(["Une ligne\n\n\nPuis une autre après des blancs", "", "  espaces autour  "]),
  // a witness quoting a question: composeAnswers puts it in quotation marks
  composeAnswers([`Je me demande : ${Q1}\n${Q1}\nVoilà.`, "Bof.", ""]),
  // quoted question lines written by hand
  `${Q0}\n« ${Q0} »\nRéponse\n${Q1}\n"${Q1}"`,
  // questions out of order: the earlier one stays inside the answer
  `${Q1}\nRéponse un\n${Q0}\nToujours la réponse un\n${Q2}\nRéponse trois`,
  `${Q2}\nSeule la dernière`,
  `${Q0}\n${Q0}\nRépété`,
  // text before the first question: not a composed text
  `Préambule\n${Q0}\nRéponse`,
  `\n  \n${NBSP}\n${Q0}\nAprès des lignes blanches`,
  // empty answers only
  `${Q0}\n\n${Q1}\n   \n${Q2}\n${NBSP}`,
  `${Q0}\n${Q1}\n${Q2}`,
  // CRLF, lone CR, CR CR LF
  `${Q0}\r\nAvec CRLF\r\n\r\n${Q1}\r\nEncore\r\n`,
  `${Q0}\rRéponse sur la même ligne`,
  `${Q0}\r\r\nDeux CR`,
  `Avant\r${Q0}\nAprès`,
  // the French space before "?": none, NBSP, narrow NBSP, several
  `${Q0.replace(" ?", "?")}\nSans espace`,
  `${Q0.replace(" ?", `${NBSP}?`)}\nInsécable`,
  `${Q0.replace(" ?", `${NNBSP}?`)}\nFine insécable`,
  `${Q0.replace(" ?", "   ?")}\nPlusieurs espaces`,
  `  ${Q0.replace(/ /g, "\t")}  \nTabulations`,
  `${Q0.toLowerCase()}\nMinuscules : pas une question`,
  `${Q0} ?\nDeux points d'interrogation`,
  // letters whose lower case differs between engines if done wrong
  `ŒUVRE ÆTHER STRAẞE İSTANBUL ΟΔΟΣ ΑΣ ΑΣΑ Σ ${KELVIN}ELVIN ǄEMAL ǅ Ǆ ÅNGSTRÖM`,
  "ПРИВЕТ, ЁЛКА И ЇЖАК. Добрый день.",
  "مرحبا بكم في الاستماع المواطني، شكراً جزيلاً",
  "Émojis 😀👍🏽 👩‍👩‍👧 🇫🇷 et ❤️",
  // decomposed letters (e + U+0301…) and a dotless i with a dot above
  "Combinaisons : " +
    [0x301, 0x300, 0x302, 0x327, 0x303].map((m, i) => "eaocn"[i] + ch(m)).join(" ") +
    ` ı${ch(0x307)}`,
  // zero width space, soft hyphen and NEL: not white space for JavaScript
  `Zéro largeur${ZWSP}ici, soft${ch(0xad)}hyphen, NEL${ch(0x85)}fin`,
  "Ｆｕｌｌｗｉｄｔｈ ＡＢＣ ｡ ﬁ ﬂ ﬃ",
  "Georgian ႠႡႢ, Cherokee ᏣᎳᎩ, Deseret 𐐀𐐁",
  composeAnswers(["é".repeat(1500), "Ü".repeat(1500), "ß".repeat(1500)]),
  "Long texte. ".repeat(1700),
  `${Q0}\n${"Réponse très longue, ".repeat(1000)}`,
];

const INFOS: (string | null)[] = [
  null,
  "",
  "42 ans, Lyon",
  `${NBSP}Retraitée${NBSP}`,
  "ÉTUDIANT·E",
];

export function fixtureRows(): FixtureRow[] {
  const rows: FixtureRow[] = [];
  const tags = [...AUDITION_THEMES, ...THEME_KEY_TABLE.map((k) => k.key)];
  for (const tag of tags) {
    for (const variant of tagVariants(tag)) {
      rows.push({ person_name: "Tag", person_info: null, content: variant, topics: [variant] });
    }
  }
  for (const [i, topics] of TAG_LISTS.entries()) {
    rows.push({ person_name: `Liste ${i}`, person_info: null, content: "Tags", topics });
  }
  for (const [i, content] of TEXTS.entries()) {
    rows.push({
      person_name: i % 3 === 0 ? "ÉLODIE Œhler" : `Témoin ${i}`,
      person_info: INFOS[i % INFOS.length],
      content,
      topics: i % 2 ? ["santé"] : null,
    });
  }
  return rows;
}
