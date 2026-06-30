import { z } from "zod";

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

export type TestimonyInput = z.infer<typeof testimonyInputSchema>;
export type CreateAuditionInput = z.infer<typeof createAuditionSchema>;
export type UpdateAuditionInput = z.infer<typeof updateAuditionSchema>;
export type UpdateTestimonyInput = z.infer<typeof updateTestimonySchema>;
export type VerifyTestimonyInput = z.infer<typeof verifyTestimonySchema>;
export type RegistrationActionInput = z.infer<typeof registrationActionSchema>;
