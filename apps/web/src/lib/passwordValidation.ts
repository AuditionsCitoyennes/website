import { z } from "zod";

export const passwordSchema = z
  .string()
  .min(8, "Le mot de passe doit contenir au moins 8 caractères")
  .max(100, "Mot de passe trop long")
  .regex(/[a-z]/, "Le mot de passe doit contenir au moins une minuscule")
  .regex(/[A-Z]/, "Le mot de passe doit contenir au moins une majuscule")
  .regex(/[0-9]/, "Le mot de passe doit contenir au moins un chiffre");

export const PASSWORD_REQUIREMENTS = [
  { label: "Au moins 8 caractères", test: (p: string) => p.length >= 8 },
  { label: "Une lettre minuscule", test: (p: string) => /[a-z]/.test(p) },
  { label: "Une lettre majuscule", test: (p: string) => /[A-Z]/.test(p) },
  { label: "Un chiffre", test: (p: string) => /[0-9]/.test(p) },
];
