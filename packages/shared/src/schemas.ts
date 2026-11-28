import { z } from "zod";
import { AUDITION_QUESTIONS, ONLINE_ANSWER_MAX } from "./answers";
import { BAN_PICK_TYPES } from "./auditions";
import {
  cleanLine,
  cleanText,
  isStorableText,
  personInfoIssue,
  personNameIssue,
  TEXT_NOT_STORABLE,
} from "./text";

export const auditionStatusSchema = z.enum(["published", "draft"]);

// Ceilings for what an admin types: the same 20 000 characters the witness
// may verify (routes/verify), and a bound on one audition's inline list — a
// body no longer carries a megabyte of testimonies to insert and email in one
// request.
export const TESTIMONY_CONTENT_MAX = 20000;
export const AUDITION_TESTIMONIES_MAX = 200;
/** An audition's own text (its account, beside the testimonies). */
export const AUDITION_CONTENT_MAX = 100_000;

// Every text field starts from one of these two (the text policy, text.ts): a
// text the database cannot hold is refused, any other is cleaned before its
// length is measured. What a schema gives back is what gets stored.

/** A text of several lines: a testimony, an answer, an audition's account. */
export const storedText = () =>
  z.string().refine(isStorableText, TEXT_NOT_STORABLE).overwrite(cleanText);

/** A text of one line: a name, an information, a title, a place, a theme. */
export const storedLine = () =>
  z.string().refine(isStorableText, TEXT_NOT_STORABLE).overwrite(cleanLine);

/** A rule of text.ts as a zod check: its sentence becomes the issue. */
const ruled = (issueOf: (text: string) => string | null) => (ctx: z.core.ParsePayload<string>) => {
  const message = issueOf(ctx.value);
  if (message) ctx.issues.push({ code: "custom", message, input: ctx.value });
};

/** A witness's name as it is first written (its characters: personNameIssue). */
const personName = (max: number) =>
  storedLine()
    .max(max, `Le nom est trop long (${max} caractères au plus)`)
    .check(ruled(personNameIssue));

/** The line of information beside it (its characters: personInfoIssue). */
const personInfo = (max: number) =>
  storedLine()
    .max(max, `Les informations sont trop longues (${max} caractères au plus)`)
    .check(ruled(personInfoIssue));

// A testimony as entered by an admin (inline in the audition builder or standalone).
export const testimonyInputSchema = z.object({
  person_name: personName(200).min(1, "Le nom est requis"),
  person_info: personInfo(500).optional().nullable(),
  content: storedText()
    .min(1, "Le témoignage est requis")
    .max(
      TESTIMONY_CONTENT_MAX,
      `Le témoignage est trop long (${TESTIMONY_CONTENT_MAX} caractères au plus)`,
    ),
  email: z.string().trim().email("Email invalide").optional().nullable().or(z.literal("")),
  topics: z.array(storedLine()).optional().nullable(),
});

/**
 * What a volunteer is told when sending testimonies without certifying that
 * every witness agreed to be published (the box of WitnessConsentCheck).
 */
export const CONSENT_CERTIFIED_REQUIRED =
  "Cochez la case : chaque personne doit avoir accepté que son témoignage soit publié";

/** The volunteer's word, one per submission, that every witness agreed. */
const consentCertified = z.literal(true, { error: CONSENT_CERTIFIED_REQUIRED });

export const createTestimonySchema = testimonyInputSchema.extend({
  audition_id: z.string().uuid(),
  consent_certified: consentCertified,
});

// An edit sends the whole form back, the name and the information as they are
// stored when untouched: their characters are judged where the stored row is
// known, and only when they change (editedText, then personNameIssue).
export const updateTestimonySchema = z.object({
  person_name: storedLine().min(1).max(200).optional(),
  person_info: storedLine().max(500).nullable().optional(),
  content: storedText().min(1).max(TESTIMONY_CONTENT_MAX).optional(),
  email: z.string().trim().email().nullable().optional().or(z.literal("")),
  topics: z.array(storedLine()).nullable().optional(),
});

/** An INSEE commune (or arrondissement) code: 69387, 2A004. */
const INSEE_COMMUNE = /^(\d{5}|2[AB]\d{3})$/;

/** What a volunteer is told when an in-person audition has no precise address picked from the suggestions. */
export const PRECISE_ADDRESS_REQUIRED = "Choisissez une adresse précise dans les suggestions.";

/**
 * The address an admin picked from the suggestions, beside the lieu's text:
 * the place an in-person audition needs. The audition is placed there (the
 * server checks it against the commune). Picks from the world gazetteer arrive
 * with the places picker.
 */
export const placePickSchema = z.object(
  {
    kind: z.literal("ban"),
    citycode: z.string().regex(INSEE_COMMUNE, "Lieu invalide : choisissez-le dans la liste"),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    type: z.enum(BAN_PICK_TYPES, { error: PRECISE_ADDRESS_REQUIRED }),
  },
  { error: PRECISE_ADDRESS_REQUIRED },
);

const AUDITION_CONTENT_TOO_LONG = `Le contexte de l'audition est trop long (${AUDITION_CONTENT_MAX} caractères au plus)`;

export const createAuditionSchema = z
  .object({
    title: storedLine().min(1, "Le titre est requis").max(300),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date au format AAAA-MM-JJ"),
    location: storedLine()
      .min(1, "Le lieu est requis")
      .max(300, "Le lieu est trop long (300 caractères au plus)"),
    // An in-person audition needs a precise address (the only kind created
    // here: online ones come from submit_online_testimony).
    place: placePickSchema,
    content: storedText().max(AUDITION_CONTENT_MAX, AUDITION_CONTENT_TOO_LONG).default(""),
    status: auditionStatusSchema.default("published"),
    testimonies: z
      .array(testimonyInputSchema)
      .max(AUDITION_TESTIMONIES_MAX, `${AUDITION_TESTIMONIES_MAX} témoignages au plus par audition`)
      .optional()
      .default([]),
    // One certification for all the testimonies sent with the audition; none
    // needed for an audition sent without any.
    consent_certified: consentCertified.optional(),
  })
  .refine((a) => a.testimonies.length === 0 || a.consent_certified === true, {
    message: CONSENT_CERTIFIED_REQUIRED,
    path: ["consent_certified"],
  });

export const updateAuditionSchema = z.object({
  title: storedLine().min(1).max(300).optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  location: storedLine()
    .min(1)
    .max(300, "Le lieu est trop long (300 caractères au plus)")
    .optional(),
  place: placePickSchema.optional(),
  content: storedText().max(AUDITION_CONTENT_MAX, AUDITION_CONTENT_TOO_LONG).optional(),
  status: auditionStatusSchema.optional(),
});

// A testimony sent by a visitor through the site's "Témoigner" form. The place
// is only an INSEE code — `place: {country: "FR", commune_code}`, or the bare
// `commune_code` of the forms before it: the server resolves everything else
// itself.
export const ONLINE_TESTIMONY_MAX = 5000;
const onlineCommuneCode = z
  .string({ error: "Choisissez votre commune dans la liste" })
  .regex(INSEE_COMMUNE, "Choisissez votre commune dans la liste");
export const onlineTestimonySchema = z
  .object({
    commune_code: onlineCommuneCode.optional(),
    place: z.object({ country: z.literal("FR"), commune_code: onlineCommuneCode }).optional(),
    email: z
      .string({ error: "L'email est requis" })
      .trim()
      .toLowerCase()
      .min(1, "L'email est requis")
      .max(254, "Email invalide")
      .email("Email invalide"),
    person_name: personName(80).default(""),
    person_info: personInfo(300).default(""),
    // One answer per question (AUDITION_QUESTIONS), in order; at least one.
    answers: z
      .array(
        storedText().max(
          ONLINE_ANSWER_MAX,
          `Une réponse est trop longue (${ONLINE_ANSWER_MAX} caractères au plus)`,
        ),
        { error: "Répondez à au moins une des questions" },
      )
      .length(AUDITION_QUESTIONS.length, "Répondez à au moins une des questions")
      .refine((answers) => answers.some((a) => a.length > 0), {
        message: "Répondez à au moins une des questions",
      }),
    consent: z.literal(true, { error: "Votre accord est nécessaire" }),
    // Anti-robot: a field people never see, and the time taken to fill the form.
    website: z.string().max(200).optional().default(""),
    elapsed_ms: z.number().int().nonnegative().optional(),
  })
  .refine((v) => v.place !== undefined || v.commune_code !== undefined, {
    message: "Choisissez votre commune dans la liste",
    path: ["commune_code"],
  });

/** The commune an online testimony is sent from: its place's, else the bare code's. */
export function onlineCommuneOf(input: OnlineTestimonyInput): string {
  return input.place?.commune_code ?? input.commune_code ?? "";
}

export type OnlineTestimonyInput = z.infer<typeof onlineTestimonySchema>;
export type TestimonyInput = z.infer<typeof testimonyInputSchema>;
export type CreateAuditionInput = z.infer<typeof createAuditionSchema>;
export type UpdateAuditionInput = z.infer<typeof updateAuditionSchema>;
export type UpdateTestimonyInput = z.infer<typeof updateTestimonySchema>;
