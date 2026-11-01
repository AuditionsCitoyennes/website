// Absolute base URLs for whatever Mapbox fetches from its workers. Mapbox runs
// its tile requests in a `blob:` worker, where a relative URL has no base to
// resolve against: a `/api/dem/…` template fails every tile with "Failed to
// parse URL" before it reaches the network. Every base URL handed to Mapbox
// goes through here. Pure: no imports, no DOM (the origin is passed in).

/** `base` resolved against `origin` (an empty base is the origin itself), with
 *  ONE trailing `/` removed so `${absoluteBase(…)}/api/…` never doubles it.
 *  Never throws: on an origin that cannot serve as a base (`"null"` in a
 *  sandboxed iframe, `file:`) or a malformed base, `base` comes back unchanged,
 *  which leaves the caller as it was before rather than breaking its module. */
export function absoluteBase(base: string, origin: string): string {
  try {
    const href = new URL(base || "/", origin).href;
    return href.endsWith("/") ? href.slice(0, -1) : href;
  } catch {
    return base;
  }
}

/** The API's base from `VITE_API_URL`: unset means the local API, while an
 *  EMPTY value (staging, behind the site's own /api proxy) means the page's
 *  origin, so the `??` keeps it rather than falling back. */
export function apiBase(env: string | undefined, origin: string): string {
  return absoluteBase(env ?? "http://localhost:3000", origin);
}
