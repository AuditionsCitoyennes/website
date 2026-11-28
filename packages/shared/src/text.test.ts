// The text policy (text.ts), the masking that follows it (sanitize.ts) and the
// schemas that attach both (schemas.ts). Run with `node --import tsx --test`
// (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import { composeAnswers, parseAnswers } from "./answers";
import { editedText, sanitizeLine, sanitizeText } from "./sanitize";
import {
  AUDITION_CONTENT_MAX,
  createAuditionSchema,
  onlineTestimonySchema,
  testimonyInputSchema,
  updateAuditionSchema,
  updateTestimonySchema,
} from "./schemas";
import {
  cleanLine,
  cleanText,
  isStorableText,
  personInfoIssue,
  personNameIssue,
  TEXT_NOT_STORABLE,
} from "./text";

// Characters named by their code point: none of them shows in an editor.
const NUL = "\u0000";
const BELL = "\u0007";
const ESCAPE = "\u001B";
const NEXT_LINE = "\u0085";
const SOFT_HYPHEN = "\u{00AD}";
const ARABIC_LETTER_MARK = "\u{061C}";
const ZERO_WIDTH_SPACE = "\u{200B}";
const ZERO_WIDTH_NON_JOINER = "\u{200C}";
const ZERO_WIDTH_JOINER = "\u{200D}";
const LEFT_TO_RIGHT_MARK = "\u{200E}";
const RIGHT_TO_LEFT_MARK = "\u{200F}";
const LINE_SEPARATOR = "\u{2028}";
const PARAGRAPH_SEPARATOR = "\u{2029}";
const EMBEDDINGS_AND_OVERRIDES = ["\u{202A}", "\u{202B}", "\u{202C}", "\u{202D}", "\u{202E}"];
const RIGHT_TO_LEFT_OVERRIDE = "\u{202E}";
const POP_DIRECTIONAL_FORMATTING = "\u{202C}";
const WORD_JOINER = "\u{2060}";
const ISOLATES = ["\u{2066}", "\u{2067}", "\u{2068}", "\u{2069}"];
const BYTE_ORDER_MARK = "\u{FEFF}";
const TAG_LETTER_A = "\u{E0041}";
const NO_BREAK_SPACE = "\u{00A0}";
const NARROW_NO_BREAK_SPACE = "\u{202F}";
const BRAILLE_BLANK = "\u{2800}";
const HANGUL_FILLER = "\u{3164}";
const HIGH_SURROGATE = "\uD800";
const LOW_SURROGATE = "\uDC00";
const EMOJI_SELECTOR = "\u{FE0F}";
const ENCLOSING_KEYCAP = "\u{20E3}";
const ACUTE = "\u{0301}";
const CIRCUMFLEX = "\u{0302}";
const TILDE = "\u{0303}";
const FIRE = "\u{1F525}";

// ---- cleanText --------------------------------------------------------------

test("an ordinary French text is left as typed", () => {
  const text =
    "Bonjour, je m'appelle Zoé — j'habite « là-bas » depuis 2019.\n\nÇa va : 1 250 € de loyer, c'est trop !";
  assert.equal(cleanText(text), text);
  // The spaces French typography uses stay.
  const spaced = `Vraiment${NARROW_NO_BREAK_SPACE}? Oui${NO_BREAK_SPACE}: 100${NO_BREAK_SPACE}%`;
  assert.equal(cleanText(spaced), spaced);
});

test("a text is stored composed (NFC)", () => {
  assert.equal(cleanText(`e${ACUTE}te${ACUTE}`), "été");
  assert.equal(cleanText("été"), "été");
});

test("control characters go, the line break stays", () => {
  assert.equal(cleanText(`a${NUL}b${BELL}c${ESCAPE}[31md`), "abc[31md");
  assert.equal(cleanText("a\u007Fb\u009Fc"), "abc");
  assert.equal(cleanText("un\ndeux"), "un\ndeux");
});

test("every kind of line break is one line break, a tab is a space", () => {
  assert.equal(cleanText("a\r\nb\rc"), "a\nb\nc");
  assert.equal(cleanText(`a${NEXT_LINE}b${LINE_SEPARATOR}c${PARAGRAPH_SEPARATOR}d`), "a\nb\nc\nd");
  assert.equal(cleanText("a\u000Bb\u000Cc"), "a\nb\nc");
  assert.equal(cleanText("a\tb"), "a b");
});

test("bidirectional controls and the other invisible format characters go", () => {
  const invisible = [
    ...EMBEDDINGS_AND_OVERRIDES,
    ...ISOLATES,
    LEFT_TO_RIGHT_MARK,
    RIGHT_TO_LEFT_MARK,
    ARABIC_LETTER_MARK,
    ZERO_WIDTH_SPACE,
    WORD_JOINER,
    BYTE_ORDER_MARK,
    SOFT_HYPHEN,
    TAG_LETTER_A,
  ];
  for (const ch of invisible) {
    assert.equal(
      cleanText(`avant${ch}après`),
      "avantaprès",
      `U+${ch.codePointAt(0)?.toString(16)}`,
    );
  }
  assert.equal(
    cleanText(`abc ${RIGHT_TO_LEFT_OVERRIDE}tsetorp${POP_DIRECTIONAL_FORMATTING} def`),
    "abc tsetorp def",
  );
});

test("the joiners scripts and emoji are written with stay", () => {
  const persian = `می${ZERO_WIDTH_NON_JOINER}خواهم`;
  assert.equal(cleanText(persian), persian);
  const family = `\u{1F468}${ZERO_WIDTH_JOINER}\u{1F469}${ZERO_WIDTH_JOINER}\u{1F467}`;
  assert.equal(cleanText(family), family);
});

test("half a surrogate pair goes, a whole pair stays", () => {
  assert.equal(cleanText(`a${HIGH_SURROGATE}b${LOW_SURROGATE}c`), "abc");
  assert.equal(cleanText(`a${FIRE}b`), `a${FIRE}b`);
});

test("at most four combining marks stay on a letter", () => {
  const stack = (ACUTE + CIRCUMFLEX + TILDE).repeat(20);
  const cleaned = cleanText(`Z${stack}o${stack}`);
  assert.equal([...cleaned].length, 2 * (1 + 4));
  // One base letter under a whole answer of marks: five characters.
  assert.equal([...cleanText(`Z${stack.repeat(8)}`)].length, 5);
  // A joiner between the marks starts no new count.
  const joined = cleanText(`Z${(TILDE.repeat(4) + ZERO_WIDTH_JOINER).repeat(30)}`);
  assert.equal([...joined].filter((ch) => ch === TILDE).length, 4);
});

test("vocalised Arabic, pointed Hebrew and Vietnamese keep every mark", () => {
  const arabic = "بِسْمِ ٱللَّٰهِ ٱلرَّحْمَٰنِ ٱلرَّحِيمِ".normalize("NFC");
  assert.equal(cleanText(arabic), arabic);
  assert.equal(sanitizeText(arabic), arabic);
  // As typed (the doubling sign before its vowel): the same marks, in the
  // composed order.
  const typed = "ٱللَّٰهِ";
  assert.equal(cleanText(typed), typed.normalize("NFC"));
  assert.equal([...cleanText(typed)].length, [...typed].length);
  const hebrew = "בְּרֵאשִׁ֖ית בָּרָ֣א אֱלֹהִ֑ים".normalize("NFC");
  assert.equal(cleanText(hebrew), hebrew);
  const vietnamese = "Nguyễn Thị Hồng Nhung";
  assert.equal(cleanText(vietnamese.normalize("NFD")), vietnamese);
});

test("at most one empty line in a row, nothing at the end of a line", () => {
  assert.equal(cleanText(`a${"\n".repeat(1480)}b`), "a\n\nb");
  assert.equal(cleanText("a  \n \n\t\n\nb   "), "a\n\nb");
  // Lines of characters that draw nothing are empty lines too.
  assert.equal(cleanText(`a\n${BRAILLE_BLANK}\n${HANGUL_FILLER}\n${NO_BREAK_SPACE}\nb`), "a\n\nb");
  const unseen = [ZERO_WIDTH_JOINER, ZERO_WIDTH_NON_JOINER, EMOJI_SELECTOR, ` ${ACUTE}`];
  for (const ch of unseen) {
    assert.equal(cleanText(`a${`\n${ch}`.repeat(700)}\nb`), "a\n\nb", JSON.stringify(ch));
  }
  assert.equal(cleanText("  a\n  b  "), "a\n  b");
});

test("a text in which nothing is drawn is empty", () => {
  for (const blank of [
    " \n\t ",
    ZERO_WIDTH_JOINER.repeat(40),
    `${ZERO_WIDTH_NON_JOINER} ${ZERO_WIDTH_JOINER}`,
    EMOJI_SELECTOR.repeat(3),
    `${NO_BREAK_SPACE}${ACUTE}${BRAILLE_BLANK}`,
    `${RIGHT_TO_LEFT_OVERRIDE}${ZERO_WIDTH_SPACE}\n${BYTE_ORDER_MARK}`,
  ]) {
    assert.equal(cleanText(blank), "", JSON.stringify(blank));
    assert.equal(cleanLine(blank), "", JSON.stringify(blank));
  }
  assert.equal(cleanText(`${ZERO_WIDTH_JOINER}.`), `${ZERO_WIDTH_JOINER}.`);
});

test("cleaning twice changes nothing more", () => {
  const samples = [
    `a${NUL}b${RIGHT_TO_LEFT_OVERRIDE}c\r\n\r\n\r\n${ZERO_WIDTH_SPACE} d\t`,
    `e${ZERO_WIDTH_SPACE}${ACUTE}${CIRCUMFLEX.repeat(9)}`,
    `${BRAILLE_BLANK}\n${HIGH_SURROGATE}x${SOFT_HYPHEN}\n\n\n${BYTE_ORDER_MARK}`,
    "ٱللَّٰهِ",
    `06${ZERO_WIDTH_SPACE}12 34 56 78 ${FIRE}${EMOJI_SELECTOR}`,
    `Z${(TILDE.repeat(3) + ZERO_WIDTH_JOINER + ACUTE.repeat(3)).repeat(5)} fin`,
    `a \r\n${ZERO_WIDTH_SPACE}\n \n b${NO_BREAK_SPACE}${NO_BREAK_SPACE}c`,
  ];
  for (const sample of samples) {
    const once = cleanText(sample);
    assert.equal(cleanText(once), once);
    assert.equal(cleanLine(cleanLine(sample)), cleanLine(sample));
    assert.equal(sanitizeText(sanitizeText(sample)), sanitizeText(sample));
    assert.equal(sanitizeLine(sanitizeLine(sample)), sanitizeLine(sample));
  }
});

test("a line folds its breaks and its runs of spaces into one space", () => {
  assert.equal(cleanLine(" Jean\n  Dupont  "), "Jean Dupont");
  assert.equal(cleanLine(`Élu${NO_BREAK_SPACE}: adjoint`), `Élu${NO_BREAK_SPACE}: adjoint`);
  assert.equal(cleanLine(`a${LINE_SEPARATOR}b\r\nc`), "a b c");
  assert.equal(cleanLine(`vr${RIGHT_TO_LEFT_OVERRIDE}ctl${BELL}${ZERO_WIDTH_SPACE}\nx`), "vrctl x");
});

test("the database's text takes neither U+0000 nor half a surrogate pair", () => {
  assert.equal(isStorableText(`Zoé ${FIRE}`), true);
  assert.equal(isStorableText(`a${NUL}b`), false);
  assert.equal(isStorableText(`a${HIGH_SURROGATE}`), false);
  assert.equal(isStorableText(`${LOW_SURROGATE}a`), false);
  // The six characters of an escape typed out are a text like any other.
  assert.equal(isStorableText("\\u0000"), true);
});

test("a long run of spaces, marks, digits or letters costs its length", () => {
  const n = 200_000;
  const runs = [
    `${" ".repeat(n)}x`,
    `x${NO_BREAK_SPACE.repeat(n)}x`,
    `a${" \n".repeat(n / 2)}b`,
    `e${ACUTE.repeat(n)}`,
    `e${(ACUTE.repeat(4) + ZERO_WIDTH_JOINER.repeat(40)).repeat(n / 44)}`,
    `+${"1".repeat(40)}`.repeat(n / 41),
    `001${"1".repeat(40)} `.repeat(n / 44),
    `+1${" 12".repeat(n / 3)}`,
    "06 12 34 56 7 ".repeat(n / 14),
    `+1${"(1)".repeat(12)}`.repeat(n / 38),
    `${"a".repeat(n)}@`,
  ];
  // Read once, each takes a few milliseconds; read again from every position,
  // the first alone took several seconds at half this length.
  const started = performance.now();
  for (const run of runs) {
    cleanLine(run);
    sanitizeText(run);
  }
  assert.ok(performance.now() - started < 3000);
});

// ---- Names and information lines ---------------------------------------------

test("names people write are taken", () => {
  for (const name of [
    "Habitant·e du quartier",
    "Marie « Mimi » D.",
    "Élu (2020-2026) : adjoint",
    "Jean-Pierre O’Neil",
    "D'Artagnan",
    'Marie "Mimi" D.',
    "Marie “Mimi” D.",
    "Zoé, 34 ans & Léo",
    "Anne-Laure / Paul",
    "Anne\u{2011}Laure",
    "N° 12 !",
    "Bac+5 ?",
    "Marie D***",
    "محمد",
    "Nguyễn Thị",
    "Ève Noël-Şahin",
    "田中 太郎",
    "Anonyme",
  ]) {
    assert.equal(personNameIssue(cleanLine(name)), null, name);
  }
});

test("a name takes no symbol, no en or em dash, nothing that draws an emoji", () => {
  for (const [name, ch] of [
    ["Camille ✓ Vérifié par la rédaction", "✓"],
    ["Camille ✔", "✔"],
    ["Camille ✅", "✅"],
    ["Camille — Signaler ce témoignage", "—"],
    ["Camille – modératrice", "–"],
    ["Camille → ici", "→"],
    [`Camille ${FIRE}`, FIRE],
    ["Camille ★", "★"],
    ["Camille = admin", "="],
    ["Camille_69", "_"],
    ["Camille [officiel]", "["],
    ["Camille™", "™"],
    ["Camille ①", "①"],
    ["camille@example.org", "@"],
  ] as const) {
    const issue = personNameIssue(cleanLine(name));
    assert.ok(issue?.startsWith(`Le nom contient un caractère non accepté (« ${ch} »).`), name);
  }
  // A digit made a keycap, a letter made an emoji: refused, with nothing to show.
  for (const name of [`1${EMOJI_SELECTOR}${ENCLOSING_KEYCAP}`, `ℹ${EMOJI_SELECTOR}`]) {
    assert.ok(
      personNameIssue(name)?.startsWith("Le nom contient un caractère non accepté. "),
      name,
    );
  }
});

test("a name the masking has written over is still a name", () => {
  for (const name of ["Zoé 06 12 34 56 78", "Léo +33 6 12 34 56 78"]) {
    assert.equal(personNameIssue(cleanLine(name)), null, name);
    assert.equal(personNameIssue(sanitizeLine(name)), null, name);
  }
  assert.equal(sanitizeLine("Zoé 06 12 34 56 78"), "Zoé ***");
});

test("an information line takes punctuation and dashes, not pictographs", () => {
  for (const info of [
    "Retraité — ancien élu, ~67 ans",
    "N° 5, 20 €, 50 %, a+b=c, 30 m², ±2",
    "Habitant·e du quartier depuis 1998 (rue Pasteur)",
    "معلم",
  ]) {
    assert.equal(personInfoIssue(cleanLine(info)), null, info);
  }
  for (const [info, ch] of [
    ["✅ Vérifié par la rédaction · Compte officiel", "✅"],
    ["✓ Vérifié", "✓"],
    ["→ voir plus", "→"],
    [`${FIRE}${FIRE}`, FIRE],
    ["modérateur ★", "★"],
  ] as const) {
    assert.equal(
      personInfoIssue(cleanLine(info)),
      `Les informations contiennent un symbole non accepté (« ${ch} »).`,
      info,
    );
  }
  assert.ok(personInfoIssue(`1${EMOJI_SELECTOR}${ENCLOSING_KEYCAP}`));
});

// ---- Masking (sanitizeText) ---------------------------------------------------

test("phone numbers become ***", () => {
  for (const phone of [
    "06 12 34 56 78",
    "06.12.34.56.78",
    "06-12-34-56-78",
    "0612345678",
    `06${NO_BREAK_SPACE}12${NO_BREAK_SPACE}34${NO_BREAK_SPACE}56${NO_BREAK_SPACE}78`,
    "+33 6 12 34 56 78",
    "+33612345678",
    "+33 (0)6 12 34 56 78",
    "+33(0)612345678",
    "0033 6 12 34 56 78",
    "+1 (555) 123-4567",
    "+44 20 7946 0958",
    "+32 470 12 34 56",
    "+48 123 456 789",
  ]) {
    assert.equal(sanitizeText(phone), "***", phone);
    assert.equal(
      sanitizeText(`Appelez-moi au ${phone}, merci.`),
      "Appelez-moi au ***, merci.",
      phone,
    );
  }
  assert.equal(sanitizeText("06 12 34 56 78/07 98 76 54 32"), "***/***");
  assert.equal(sanitizeText("tél:0612345678."), "tél:***.");
  assert.equal(sanitizeText("06 12 34 56 78 24 h sur 24"), "*** 24 h sur 24");
});

test("a number with its country code stays masked whatever numbers follow it", () => {
  assert.equal(sanitizeText("+33 6 12 34 56 78 2024 2025"), "***");
  assert.equal(
    sanitizeText("+33 6 12 34 56 78 1 2 3 4 5 6 7 8 9"),
    // Ten runs of digits at most are one number.
    "*** 5 6 7 8 9",
  );
});

test("email addresses become ***", () => {
  assert.equal(sanitizeText("Écrivez à jean.dupont@example.org !"), "Écrivez à *** !");
});

test("a number or an address cut by invisible characters is masked whole", () => {
  assert.equal(sanitizeText(["06", "12", "34", "56", "78"].join(ZERO_WIDTH_SPACE)), "***");
  assert.equal(sanitizeText(`jean.dupont@${ZERO_WIDTH_SPACE}example.org`), "***");
  assert.equal(sanitizeText(`06 12 34${SOFT_HYPHEN} 56 78`), "***");
});

test("years, dates, law numbers and amounts are not phone numbers", () => {
  const text =
    "En 2023-2024 le loyer est passé à 1 250 euros, puis le 12.10.2025 la mairie a voté 3 500 000 euros. Loi 2021-1104 du 22 août 2021. Mon avis : 100 000 000 fois non.";
  assert.equal(sanitizeText(text), text);
  for (const kept of [
    "2025-10-12",
    "du 01.02.2025 au 10.03.2025",
    "le 01.02.2025 10 personnes sont venues",
    "2019-2020-2021",
    "12 345 678 habitants",
    "1 000 000 000 d'euros",
    "+2 000 emplois",
    "+15 % en 2024",
    "article L. 2121-29",
    "à 08 h 30, salle 12",
    "75011 Paris, 12 bis rue de la Paix",
  ]) {
    assert.equal(sanitizeText(kept), kept, kept);
  }
});

test("sanitizeText applies the clean-up first", () => {
  assert.equal(sanitizeText(` a${NUL}b${RIGHT_TO_LEFT_OVERRIDE}c\r\n\n\n\nd `), "abc\n\nd");
  assert.equal(sanitizeLine(" Jean\n  Dupont 0612345678 "), "Jean Dupont ***");
});

// ---- Edits over a stored text ---------------------------------------------------

test("an edit that sends a field as it is stored keeps the stored text", () => {
  // Stored before the policy: a symbol in the name, spaces and empty lines in
  // the text that the clean-up would remove.
  const name = `Camille${ZERO_WIDTH_SPACE}  ✓`;
  const content = `Première ligne. \n\n\n\nDeuxième${RIGHT_TO_LEFT_OVERRIDE} ligne.`;
  assert.equal(editedText(name, name, sanitizeLine), name);
  assert.equal(editedText(content, content), content);
  // Sent back as a form that went through the schema gives it (cleaned).
  assert.equal(editedText(cleanLine(name), name, sanitizeLine), name);
  assert.equal(editedText(cleanText(content), content), content);
  // Changed: the sent text, as it is stored from now on.
  assert.equal(editedText("Camille R.", name, sanitizeLine), "Camille R.");
  assert.equal(editedText("Camille ✓✓", name, sanitizeLine), "Camille ✓✓");
  assert.equal(
    editedText(`${content} Appelez le 06 12 34 56 78.`, content),
    "Première ligne.\n\nDeuxième ligne. Appelez le ***.",
  );
  // Nothing stored: the sent text.
  assert.equal(editedText(" boulangère\nà Lyon ", null, sanitizeLine), "boulangère à Lyon");
});

// ---- The schemas ---------------------------------------------------------------

const firstIssue = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
  result.success ? null : (result.error?.issues[0]?.message ?? "?");

const online = (over: object) =>
  onlineTestimonySchema.safeParse({
    place: { country: "FR", commune_code: "69266" },
    email: "zoe@example.org",
    person_name: "Zoé",
    person_info: "",
    answers: ["Ça va.", "", ""],
    consent: true,
    ...over,
  });

const place = { kind: "ban", citycode: "69266", lat: 45.7667, lng: 4.8799, type: "housenumber" };
const audition = (over: object) =>
  createAuditionSchema.safeParse({
    title: "Audition du marché",
    date: "2026-11-27",
    location: "12 rue de la Paix, Villeurbanne",
    place,
    ...over,
  });

test("the online form refuses a text the database cannot hold, in every field", () => {
  for (const bad of [NUL, HIGH_SURROGATE, LOW_SURROGATE]) {
    assert.equal(firstIssue(online({ person_name: `Zoé${bad}` })), TEXT_NOT_STORABLE);
    assert.equal(firstIssue(online({ person_info: `ici${bad}` })), TEXT_NOT_STORABLE);
    assert.equal(firstIssue(online({ answers: [`Ça${bad} va.`, "", ""] })), TEXT_NOT_STORABLE);
  }
  assert.equal(online({ answers: ["le texte \\u0000, tapé tel quel", "", ""] }).success, true);
});

test("the online form gives back the cleaned text", () => {
  const parsed = online({
    person_name: `  Zoé${RIGHT_TO_LEFT_OVERRIDE}\n${BELL}Martin `,
    person_info: `boulangère${ZERO_WIDTH_SPACE}\r\nà Lyon`,
    answers: [`Ça va.${"\n".repeat(40)}Vraiment.\t`, "", `${ZERO_WIDTH_SPACE}`],
  });
  assert.equal(parsed.success, true);
  assert.equal(parsed.data?.person_name, "Zoé Martin");
  assert.equal(parsed.data?.person_info, "boulangère à Lyon");
  assert.deepEqual(parsed.data?.answers, ["Ça va.\n\nVraiment.", "", ""]);
});

test("the online form refuses a name or an information that imitates a label", () => {
  assert.match(
    firstIssue(online({ person_name: "Zoé ✓ Vérifié par la rédaction — Signaler" })) ?? "",
    /^Le nom contient un caractère non accepté \(« ✓ »\)\./,
  );
  assert.match(
    firstIssue(online({ person_name: "Zoé — Signaler ce témoignage" })) ?? "",
    /^Le nom contient un caractère non accepté \(« — »\)\./,
  );
  assert.equal(
    firstIssue(online({ person_info: "✅ Vérifié par la rédaction · Compte officiel" })),
    "Les informations contiennent un symbole non accepté (« ✅ »).",
  );
  assert.equal(online({ person_name: "", person_info: "" }).success, true);
  assert.equal(online({}).success, true);
  for (const person_name of ["Habitant·e du quartier", "Marie « Mimi » D.", "Jean-Pierre O’Neil"]) {
    assert.equal(online({ person_name, person_info: "Élu (2020-2026) : adjoint" }).success, true);
  }
});

test("the online form measures lengths on the cleaned text and wants one real answer", () => {
  assert.equal(
    firstIssue(online({ person_name: "a".repeat(81) })),
    "Le nom est trop long (80 caractères au plus)",
  );
  assert.equal(online({ person_name: "a".repeat(80) + ZERO_WIDTH_SPACE.repeat(10) }).success, true);
  for (const answers of [
    [ZERO_WIDTH_SPACE, `${RIGHT_TO_LEFT_OVERRIDE}\n`, " "],
    [ZERO_WIDTH_JOINER.repeat(20), EMOJI_SELECTOR, BRAILLE_BLANK],
  ]) {
    assert.equal(firstIssue(online({ answers })), "Répondez à au moins une des questions");
  }
});

test("answers composed from cleaned text are read back as answers", () => {
  const parsed = online({
    answers: [`Bien.${"\n".repeat(9)}Merci.`, `Bof${RIGHT_TO_LEFT_OVERRIDE}.`, ""],
  });
  const composed = composeAnswers((parsed.data?.answers ?? []).map(sanitizeText));
  assert.deepEqual(
    parseAnswers(sanitizeText(composed))?.map((a) => a.answer),
    ["Bien.\n\nMerci.", "Bof."],
  );
});

test("a testimony typed by a volunteer follows the same rules", () => {
  const typed = (over: object) =>
    testimonyInputSchema.safeParse({
      person_name: "Camille",
      content: "Ce que j'ai dit.",
      ...over,
    });
  assert.equal(typed({}).success, true);
  assert.equal(firstIssue(typed({ person_name: `Camille${NUL}` })), TEXT_NOT_STORABLE);
  assert.equal(firstIssue(typed({ content: `probe ${HIGH_SURROGATE}` })), TEXT_NOT_STORABLE);
  assert.equal(firstIssue(typed({ topics: [`a${NUL}b`] })), TEXT_NOT_STORABLE);
  assert.equal(firstIssue(typed({ person_name: ZERO_WIDTH_SPACE })), "Le nom est requis");
  assert.equal(firstIssue(typed({ content: `${ZERO_WIDTH_SPACE}\n` })), "Le témoignage est requis");
  assert.match(
    firstIssue(typed({ person_name: "Camille ✔" })) ?? "",
    /^Le nom contient un caractère non accepté/,
  );
  assert.equal(
    firstIssue(typed({ person_name: "a".repeat(201) })),
    "Le nom est trop long (200 caractères au plus)",
  );
  assert.equal(
    firstIssue(typed({ person_info: "i".repeat(501) })),
    "Les informations sont trop longues (500 caractères au plus)",
  );
  assert.equal(typed({ person_name: "Camille\nRoux" }).data?.person_name, "Camille Roux");
});

test("an edit cleans and bounds, and leaves the name's characters to the stored row", () => {
  const edit = updateTestimonySchema.safeParse({
    person_name: "Camille ✓",
    person_info: "★ fidèle",
    content: `Texte${RIGHT_TO_LEFT_OVERRIDE} corrigé.`,
  });
  assert.equal(edit.success, true);
  assert.equal(edit.data?.content, "Texte corrigé.");
  assert.equal(
    firstIssue(updateTestimonySchema.safeParse({ content: `x${NUL}` })),
    TEXT_NOT_STORABLE,
  );
  assert.equal(
    firstIssue(updateTestimonySchema.safeParse({ person_name: `x${LOW_SURROGATE}` })),
    TEXT_NOT_STORABLE,
  );
});

test("an audition's fields are cleaned, bounded and storable", () => {
  assert.equal(audition({}).success, true);
  assert.equal(firstIssue(audition({ title: `Audition${NUL}` })), TEXT_NOT_STORABLE);
  assert.equal(firstIssue(audition({ location: `Lyon${NUL}` })), TEXT_NOT_STORABLE);
  assert.equal(firstIssue(audition({ content: `x${NUL}y` })), TEXT_NOT_STORABLE);
  assert.equal(
    firstIssue(
      audition({
        consent_certified: true,
        testimonies: [{ person_name: `Camille${NUL}`, content: "probe" }],
      }),
    ),
    TEXT_NOT_STORABLE,
  );
  assert.equal(audition({ title: "Audition\ndu marché" }).data?.title, "Audition du marché");
  assert.equal(audition({ content: "c".repeat(AUDITION_CONTENT_MAX) }).success, true);
  assert.equal(
    firstIssue(audition({ content: "c".repeat(AUDITION_CONTENT_MAX + 1) })),
    "Le contexte de l'audition est trop long (100000 caractères au plus)",
  );
  assert.equal(
    firstIssue(updateAuditionSchema.safeParse({ content: "c".repeat(AUDITION_CONTENT_MAX + 1) })),
    "Le contexte de l'audition est trop long (100000 caractères au plus)",
  );
  assert.equal(firstIssue(updateAuditionSchema.safeParse({ title: `x${NUL}` })), TEXT_NOT_STORABLE);
  assert.equal(
    updateAuditionSchema.safeParse({ content: "c".repeat(AUDITION_CONTENT_MAX) }).success,
    true,
  );
});
