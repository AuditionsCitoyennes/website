import { z } from "zod";

/** The shortest password a form accepts for a NEW password (sign-up, reset,
 *  change). Signing in asks for no length: older passwords stay valid. */
export const PASSWORD_MIN_LENGTH = 12;

export const passwordSchema = z
  .string()
  .min(
    PASSWORD_MIN_LENGTH,
    `Le mot de passe doit contenir au moins ${PASSWORD_MIN_LENGTH} caractères`,
  )
  .regex(/[a-z]/, "Le mot de passe doit contenir au moins une minuscule")
  .regex(/[A-Z]/, "Le mot de passe doit contenir au moins une majuscule")
  .regex(/[0-9]/, "Le mot de passe doit contenir au moins un chiffre")
  // Supabase refuses anything over 72 BYTES — and an accented letter is two.
  .refine(
    (p) => new TextEncoder().encode(p).length <= 72,
    "Mot de passe trop long (72 caractères au plus, les lettres accentuées comptent double)",
  );

export const PASSWORD_REQUIREMENTS = [
  {
    label: `Au moins ${PASSWORD_MIN_LENGTH} caractères`,
    test: (p: string) => p.length >= PASSWORD_MIN_LENGTH,
  },
  { label: "Une lettre minuscule", test: (p: string) => /[a-z]/.test(p) },
  { label: "Une lettre majuscule", test: (p: string) => /[A-Z]/.test(p) },
  { label: "Un chiffre", test: (p: string) => /[0-9]/.test(p) },
];
