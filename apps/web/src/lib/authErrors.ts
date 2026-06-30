export function mapAuthError(error: unknown, context: "login" | "signup"): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/rate limit|too many requests|over_request_rate_limit/i.test(message)) {
    return "Trop de tentatives, veuillez réessayer plus tard.";
  }

  if (context === "login") {
    return "Email ou mot de passe incorrect.";
  }

  return "Une erreur est survenue, veuillez réessayer.";
}
