// The built site's content security policy, and the headers file it is served
// from. The site's files are served by Cloudflare with the rules of
// dist/_headers; vite.config.ts writes that file at the end of a build: the
// rules of public/_headers, with the policy added to their `/*` block.
//
// The policy names what the pages may load and where they may send requests:
// the site's own files, the inline scripts the build itself wrote into
// index.html (each by the SHA-256 of its text, so no other inline script
// runs), and the few hosts the app talks to. The dev server sends no such
// header.
//
// Build-time only (node:crypto): read by vite.config.ts and by node
// (csp.test.ts), never imported by the app.

import { createHash } from "node:crypto";

/** Cloudflare ignores a line of _headers longer than this, with a warning in
 *  the deploy's log only: a policy that long would silently not be sent. */
export const MAX_HEADER_LINE = 2000;

/** The build settings the policy reads (the VITE_ variables of the same names). */
export interface PolicySettings {
  /** VITE_SUPABASE_URL: sign-in talks to it. */
  supabaseUrl?: string;
  /** VITE_API_URL: empty when the API is the site's own /api. */
  apiUrl?: string;
  /** VITE_MAP_DATA_BASE: unset when the outline files are the site's own. */
  mapDataBase?: string;
  /** VITE_TURNSTILE_SITE_KEY: set when the forms show Cloudflare's challenge. */
  turnstileSiteKey?: string;
}

/** Cloudflare Turnstile's script and frame, allowed only when a site key is set. */
const TURNSTILE = "https://challenges.cloudflare.com";

/** What Mapbox GL asks for: styles, sprites, glyphs and tiles; its usage events. */
const MAPBOX = [
  "https://api.mapbox.com",
  "https://events.mapbox.com",
  "https://*.tiles.mapbox.com",
];

/** The address suggestions of the audition form and of the « Témoigner » form. */
const ADDRESS_SEARCH = ["https://api-adresse.data.gouv.fr", "https://data.geopf.fr"];

/** The photographs of the home page (features/home/homeImages.ts). */
const PHOTOS = ["https://images.unsplash.com", "https://images.pexels.com"];

/**
 * A host a policy source can name: letters, digits, hyphens and dots (a
 * domain name or an IPv4 address). `URL` also accepts hosts holding `;`, `,`
 * or `*`, which a policy reads as the end of a directive, the end of a header
 * value, or any host; and a bracketed IPv6 address, which a policy cannot
 * name at all.
 */
const POLICY_HOST = /^[a-z0-9.-]+$/;

/**
 * The origin of an absolute http(s) URL whose host a policy can name, null
 * for anything else (unset, empty, a path, another scheme, another kind of
 * host). Only what `URL` itself normalised reaches the header, never the
 * setting's own text.
 */
export function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const web = parsed.protocol === "https:" || parsed.protocol === "http:";
    return web && POLICY_HOST.test(parsed.hostname) ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * The text of every inline script of a page, as the browser reads it: line
 * ends as line feeds, a script inside a comment left out (a script with `src`
 * has no text of its own). Comments and scripts are read in the page's order,
 * so a script whose own text holds `<!--` is still read whole.
 */
export function inlineScripts(html: string): string[] {
  const scripts: string[] = [];
  const page = html.replace(/\r\n?/g, "\n");
  for (const [found, attributes = "", text = ""] of page.matchAll(
    /<!--[\s\S]*?-->|<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi,
  )) {
    if (found.startsWith("<!--")) continue;
    if (!/\ssrc\s*=/i.test(attributes) && text !== "") scripts.push(text);
  }
  return scripts;
}

/** A script's source expression for script-src: the SHA-256 of its text. */
export function scriptHash(script: string): string {
  return `'sha256-${createHash("sha256").update(script, "utf8").digest("base64")}'`;
}

/**
 * The policy of the built page `html`. Scripts: the site's own files and the
 * page's inline scripts; nothing is evaluated from text, WebAssembly apart
 * (Mapbox's workers compile the module that shapes right-to-left labels).
 * Styles: the site's stylesheets, and inline styles (Vue's style bindings,
 * Mapbox's own). Requests: the site, Supabase Auth, the API and the map data
 * when they live on another origin, Mapbox, the address search, and `data:`
 * URLs (the plateau's relief tiles are made in the page and handed to Mapbox
 * as such: they reach no network). Workers: the app's own and Mapbox's (a
 * blob), which follow this same policy. No plugin, no frame (Turnstile's when
 * configured), and no other site may frame the pages.
 */
export function contentSecurityPolicy(html: string, settings: PolicySettings): string {
  const turnstile = settings.turnstileSiteKey ? [TURNSTILE] : [];
  const elsewhere = [settings.supabaseUrl, settings.apiUrl, settings.mapDataBase]
    .map(originOf)
    .filter((origin): origin is string => origin !== null);
  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    [
      "script-src",
      ["'self'", "'wasm-unsafe-eval'", ...inlineScripts(html).map(scriptHash), ...turnstile],
    ],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:", ...PHOTOS]],
    ["font-src", ["'self'"]],
    ["connect-src", ["'self'", ...elsewhere, ...MAPBOX, ...ADDRESS_SEARCH, "data:"]],
    ["worker-src", ["'self'", "blob:"]],
    ["child-src", ["'self'", "blob:"]],
    ["frame-src", turnstile.length ? turnstile : ["'none'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ];
  return directives
    .map(([name, sources]) => `${name} ${[...new Set(sources)].join(" ")}`)
    .join("; ");
}

/** How the policy is sent: applied, or only reported in the browser's console. */
export type PolicyMode = "enforce" | "report-only";

/**
 * VITE_CSP: unset or empty applies the policy; "report-only" sends it as
 * Content-Security-Policy-Report-Only, which blocks nothing (the switch for a
 * deploy whose policy turns out too strict). Anything else is refused, so a
 * mistyped value never passes for one of the two.
 */
export function policyMode(value: string | undefined): PolicyMode {
  if (!value) return "enforce";
  if (value === "report-only") return "report-only";
  throw new Error(`VITE_CSP: "report-only" or unset, not "${value}"`);
}

/**
 * dist/_headers: `publicFile` (public/_headers) with the policy added to its
 * `/*` block, and with `noIndex` (staging) the header that keeps the whole
 * site out of search engines. One `/*` block exactly: Cloudflare keeps only
 * the last block of a path, so a second one would drop the first's headers.
 */
export function headersFile(
  publicFile: string,
  { policy, mode, noIndex }: { policy: string; mode: PolicyMode; noIndex: boolean },
): string {
  const lines = publicFile.trimEnd().split("\n");
  const everyPath = lines.flatMap((line, i) => (line.trim() === "/*" ? [i] : []));
  const at = everyPath[0];
  if (at === undefined || everyPath.length !== 1) {
    throw new Error("public/_headers: one `/*` block is expected, to add the policy to");
  }
  const name =
    mode === "report-only" ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";
  const added = [`  ${name}: ${policy}`];
  if (noIndex) added.push("  X-Robots-Tag: noindex, nofollow");
  lines.splice(at + 1, 0, ...added);
  const long = lines.findIndex((line) => line.trim().length > MAX_HEADER_LINE);
  if (long >= 0) {
    throw new Error(
      `_headers line ${long + 1} is longer than ${MAX_HEADER_LINE} characters: Cloudflare would ignore it`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The settings a deployed build (VITE_APP_ENV staging or production) cannot do
 * without, by name. Sign-in needs the Supabase project's URL (an http(s) URL
 * the policy can allow) and its publishable key. The API's address has to be
 * said: empty when the API is the site's own /api, else an http(s) URL the
 * policy can allow; left unset, the app would call the local development
 * address (shared/api/client.ts), which the policy refuses. A build with any
 * other VITE_APP_ENV (local work, CI's plain build) needs none.
 */
export function missingDeploySettings(env: Record<string, string | undefined>): string[] {
  if (env.VITE_APP_ENV !== "staging" && env.VITE_APP_ENV !== "production") return [];
  const missing: string[] = [];
  if (!originOf(env.VITE_SUPABASE_URL)) missing.push("VITE_SUPABASE_URL");
  if (!env.VITE_SUPABASE_PUBLISHABLE_KEY) missing.push("VITE_SUPABASE_PUBLISHABLE_KEY");
  const api = env.VITE_API_URL;
  if (api === undefined || (api !== "" && !originOf(api))) missing.push("VITE_API_URL");
  return missing;
}
