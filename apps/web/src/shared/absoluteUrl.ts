// Absolute base URLs for whatever is fetched from a worker. Mapbox runs its
// tile requests in a `blob:` worker, where a relative URL has no base to
// resolve against: a relative template fails every tile with "Failed to parse
// URL" before it reaches the network (the plateau's own `ac-dem://` tiles
// never reach it: the page answers them). Every base URL handed to Mapbox, and
// the outline files' base, must go through here; the TEST_TOOLS `?pmtiles=` probe is the exception: it
// takes its URL as typed, so type an absolute one. Pure: no imports, no DOM
// (the origin is passed in).

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
