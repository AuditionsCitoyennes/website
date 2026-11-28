// Supabase Auth's refusals, in French. Read from the error's CODE where Auth
// gives one (several codes share one English message); no import of the
// client, so that this loads under node (authErrors.test.ts).

const fieldsOf = (error: unknown) =>
  (error ?? {}) as { code?: unknown; status?: unknown; message?: unknown; reasons?: unknown };

/** Auth's error code (`weak_password`, `mfa_verification_failed`…), if any. */
export function authCode(error: unknown): string | null {
  const { code } = fieldsOf(error);
  return typeof code === "string" ? code : null;
}

function isRateLimited(error: unknown): boolean {
  const { status, message } = fieldsOf(error);
  return (
    status === 429 ||
    /rate limit|too many requests|over_\w+_rate_limit/i.test(
      `${authCode(error) ?? ""} ${typeof message === "string" ? message : String(error)}`,
    )
  );
}

const RATE_LIMITED = "Trop de tentatives, veuillez réessayer plus tard.";
const CAPTCHA_FAILED = "La vérification anti-robot a échoué, veuillez réessayer.";
const GENERIC = "Une erreur est survenue, veuillez réessayer.";

/** Why Auth finds a password too weak (its `weak_password` refusal names the
 *  reasons: length, characters, pwned). */
function weakPasswordMessage(error: unknown): string {
  const { reasons } = fieldsOf(error);
  const why = Array.isArray(reasons) ? reasons : [];
  if (why.includes("pwned")) {
    return "Ce mot de passe figure dans des fuites de données connues : choisissez-en un autre.";
  }
  if (why.includes("length")) return "Ce mot de passe est trop court : choisissez-en un plus long.";
  if (why.includes("characters")) {
    return "Ce mot de passe doit mêler minuscules, majuscules et chiffres.";
  }
  return "Ce mot de passe est trop faible, choisissez-en un autre.";
}

/** A refused sign-in or sign-up. A sign-in never says which of the address
 *  and the password was wrong. */
export function mapAuthError(error: unknown, context: "login" | "signup"): string {
  if (isRateLimited(error)) return RATE_LIMITED;
  const code = authCode(error);
  if (code === "captcha_failed") return CAPTCHA_FAILED;
  if (context === "login") return "Email ou mot de passe incorrect.";
  if (code === "weak_password") return weakPasswordMessage(error);
  return GENERIC;
}

/** A refused email (a confirmation sent again, a recovery asked). */
export function emailRequestError(error: unknown): string {
  if (isRateLimited(error)) return RATE_LIMITED;
  if (authCode(error) === "captcha_failed") return CAPTCHA_FAILED;
  return GENERIC;
}

/** A refused new password, on the page a recovery link opens. */
export function newPasswordError(error: unknown): string {
  if (isRateLimited(error)) return RATE_LIMITED;
  switch (authCode(error)) {
    case "weak_password":
      return weakPasswordMessage(error);
    case "same_password":
      return "Le nouveau mot de passe doit être différent de l'actuel.";
    case "insufficient_aal":
      return "Saisissez d'abord votre code de double authentification.";
    case "validation_failed":
      return "Mot de passe trop long (72 caractères au plus, les lettres accentuées comptent double).";
    default:
      return fieldsOf(error).status === 401 || authCode(error) === "session_not_found"
        ? "Ce lien a expiré : demandez-en un nouveau."
        : "Le mot de passe n'a pas pu être modifié, veuillez réessayer.";
  }
}

/** A refused step of the second factor: enrolling one, giving its code,
 *  removing it. */
export function secondFactorError(error: unknown): string {
  if (isRateLimited(error)) return RATE_LIMITED;
  switch (authCode(error)) {
    case "mfa_verification_failed":
    case "mfa_verification_rejected":
      return "Code incorrect. Saisissez le code à 6 chiffres affiché en ce moment par votre application.";
    case "mfa_challenge_expired":
      return "Le délai est dépassé, saisissez un nouveau code.";
    case "mfa_totp_enroll_not_enabled":
    case "mfa_totp_verify_not_enabled":
      return "La double authentification n'est pas disponible sur ce site pour le moment.";
    case "too_many_enrolled_mfa_factors":
      return "Ce compte a déjà trop de seconds facteurs enregistrés.";
    case "insufficient_aal":
      return "Saisissez d'abord le code de votre application pour confirmer cette action.";
    case "mfa_factor_not_found":
      return "Ce second facteur n'existe plus. Rechargez la page.";
    default:
      return GENERIC;
  }
}
