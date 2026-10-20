import { z } from "zod";
import { AUDITION_QUESTIONS, ONLINE_ANSWER_MAX } from "./answers";

export const auditionStatusSchema = z.enum(["published", "draft"]);

// A testimony as entered by an admin (inline in the audition builder or standalone).
export const testimonyInputSchema = z.object({
  person_name: z.string().trim().min(1, "Le nom est requis").max(200),
  person_info: z.string().trim().max(500).optional().nullable(),
  content: z.string().trim().min(1, "Le témoignage est requis"),
  email: z.string().trim().email("Email invalide").optional().nullable().or(z.literal("")),
  topics: z.array(z.string()).optional().nullable(),
});

export const createTestimonySchema = testimonyInputSchema.extend({
  audition_id: z.string().uuid(),
});

export const updateTestimonySchema = z.object({
  person_name: z.string().trim().min(1).max(200).optional(),
  person_info: z.string().trim().max(500).nullable().optional(),
  content: z.string().trim().min(1).optional(),
  email: z.string().trim().email().nullable().optional().or(z.literal("")),
  topics: z.array(z.string()).nullable().optional(),
});

export const createAuditionSchema = z.object({
  title: z.string().trim().min(1, "Le titre est requis").max(300),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date au format AAAA-MM-JJ"),
  location: z.string().trim().min(1, "Le lieu est requis"),
  content: z.string().trim().default(""),
  status: auditionStatusSchema.default("published"),
  testimonies: z.array(testimonyInputSchema).optional().default([]),
});

export const updateAuditionSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  location: z.string().trim().min(1).optional(),
  content: z.string().trim().optional(),
  status: auditionStatusSchema.optional(),
});

export const analyzeTestimonySchema = z.object({
  content: z.string().trim().min(1),
});

export const verifyTestimonySchema = z.object({
  action: z.enum(["verify", "reject"]),
  // Optional edits applied at verification time.
  person_name: z.string().trim().min(1).max(200).optional(),
  person_info: z.string().trim().max(500).nullable().optional(),
  content: z.string().trim().min(1).optional(),
});

export const registrationActionSchema = z.object({
  action: z.enum(["approve", "decline"]),
  userId: z.string().uuid(),
  email: z.string().email(),
  username: z.string().optional().nullable(),
});

// A testimony sent by a visitor through the site's "Témoigner" form. The place
// is only an INSEE code: the server resolves everything else itself.
export const ONLINE_TESTIMONY_MAX = 5000;
export const onlineTestimonySchema = z.object({
  commune_code: z
    .string({ required_error: "Choisissez votre commune dans la liste" })
    .regex(/^(\d{5}|2[AB]\d{3})$/, "Choisissez votre commune dans la liste"),
  email: z
    .string({ required_error: "L'email est requis" })
    .trim()
    .toLowerCase()
    .min(1, "L'email est requis")
    .max(254, "Email invalide")
    .email("Email invalide"),
  person_name: z
    .string()
    .trim()
    .max(80, "Le nom est trop long (80 caractères au plus)")
    .default(""),
  person_info: z
    .string()
    .trim()
    .max(300, "Les informations sont trop longues (300 caractères au plus)")
    .default(""),
  // One answer per question (AUDITION_QUESTIONS), in order; at least one.
  answers: z
    .array(
      z
        .string()
        .trim()
        .max(
          ONLINE_ANSWER_MAX,
          `Une réponse est trop longue (${ONLINE_ANSWER_MAX} caractères au plus)`,
        ),
      { required_error: "Répondez à au moins une des questions" },
    )
    .length(AUDITION_QUESTIONS.length, "Répondez à au moins une des questions")
    .refine((answers) => answers.some((a) => a.length > 0), {
      message: "Répondez à au moins une des questions",
    }),
  consent: z.literal(true, { errorMap: () => ({ message: "Votre accord est nécessaire" }) }),
  // Anti-robot: a field people never see, and the time taken to fill the form.
  website: z.string().max(200).optional().default(""),
  elapsed_ms: z.number().int().nonnegative().optional(),
});

export type OnlineTestimonyInput = z.infer<typeof onlineTestimonySchema>;
export type TestimonyInput = z.infer<typeof testimonyInputSchema>;
export type CreateAuditionInput = z.infer<typeof createAuditionSchema>;
export type UpdateAuditionInput = z.infer<typeof updateAuditionSchema>;
export type UpdateTestimonyInput = z.infer<typeof updateTestimonySchema>;
export type VerifyTestimonyInput = z.infer<typeof verifyTestimonySchema>;
export type RegistrationActionInput = z.infer<typeof registrationActionSchema>;
