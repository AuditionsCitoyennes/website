// What a session's access token says of itself: its claims (how the session
// was opened, the level it reached), read without checking the signature. The
// site only reads them to choose what to show; the API and Auth check the
// token. Pure: loadable under node.

/** The claims of an access token; null for anything that is not one. */
export function tokenClaims(
  accessToken: string | null | undefined,
): Record<string, unknown> | null {
  try {
    const payload = accessToken?.split(".")[1];
    if (!payload) return null;
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const claims: unknown = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
    return claims && typeof claims === "object" && !Array.isArray(claims)
      ? (claims as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
