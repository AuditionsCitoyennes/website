// The built site's content security policy and headers file (csp.ts), run
// with `node --import tsx --test` (root "test:scripts"): the hash of a known
// script, the inline scripts found in a built page, the sources that depend on
// a setting, and public/_headers itself as Cloudflare would serve it, path by
// path, once the build has added the policy.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  MAX_HEADER_LINE,
  contentSecurityPolicy,
  headersFile,
  inlineScripts,
  missingDeploySettings,
  originOf,
  policyMode,
  scriptHash,
} from "./csp";
import { afterCharset, homeBootScript } from "./homeBootPlan";
import { mapPreloadScript } from "./mapPreloadPlan";

const PUBLIC_HEADERS = readFileSync(new URL("../../../public/_headers", import.meta.url), "utf8");

/** A page as the build leaves it: the two inline boot scripts and the entry. */
function builtPage() {
  const home = homeBootScript({ js: ["/assets/HomePage-a.js"], css: ["/assets/HomePage-a.css"] });
  const map = mapPreloadScript({
    js: ["/assets/mapbox-gl-b.js"],
    css: ["/assets/StagePage-b.css"],
  });
  const html = afterCharset(
    `<!doctype html>\n<html>\n  <head>\n    <meta charset="UTF-8" />\n` +
      `    <!-- not a script: <script>ignored()</script> -->\n` +
      `    <script type="module" crossorigin src="/assets/index-c.js"></script>\n` +
      `    <script>${map}</script>\n  </head>\n  <body><div id="app"></div></body>\n</html>\n`,
    home,
  );
  return { html, home, map };
}

/** The sources of one directive of a policy. */
function sources(policy: string, directive: string): string[] {
  const found = policy.split("; ").find((d) => d.startsWith(`${directive} `));
  assert.ok(found, `${directive} is in the policy`);
  return found.split(" ").slice(1);
}

/**
 * The headers Cloudflare adds to the answer of `path`, from a _headers file,
 * by its own rules: one block per path pattern (a later block of the same
 * pattern replaces the earlier one), the matching blocks applied in the
 * file's order, each taking off its `! Name` headers and then setting its
 * own, a header set by two blocks being joined with a comma.
 */
function served(file: string, path: string): Record<string, string> {
  const blocks = new Map<string, { set: [string, string][]; unset: string[] }>();
  let block: { set: [string, string][]; unset: string[] } | undefined;
  for (const raw of file.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    assert.ok(line.length <= MAX_HEADER_LINE, "no line Cloudflare would ignore");
    if (line.startsWith("/")) {
      block = { set: [], unset: [] };
      blocks.set(line, block);
    } else if (line.startsWith("! ")) {
      block?.unset.push(line.slice(2).toLowerCase());
    } else {
      const colon = line.indexOf(":");
      block?.set.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
    }
  }
  const headers: Record<string, string> = {};
  const setHere = new Set<string>();
  for (const [pattern, { set, unset }] of blocks) {
    const escaped = pattern.split("*").map((s) => s.replace(/[-/\\^$+?.()|[\]{}]/g, "\\$&"));
    if (!new RegExp(`^${escaped.join(".*")}$`).test(path)) continue;
    for (const name of unset) delete headers[name];
    for (const [name, value] of set) {
      headers[name] = setHere.has(name) && name in headers ? `${headers[name]}, ${value}` : value;
      setHere.add(name);
    }
  }
  return headers;
}

test("a script's source is the SHA-256 of its text, in base64", () => {
  // The digest of "abc" (FIPS 180-2's first test vector).
  assert.equal(scriptHash("abc"), "'sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0='");
  assert.notEqual(scriptHash("abc"), scriptHash("abc "));
});

test("the inline scripts of a built page: the two boot scripts, as written", () => {
  const { html, home, map } = builtPage();
  assert.deepEqual(inlineScripts(html), [home, map]);
  assert.deepEqual(inlineScripts(`<SCRIPT\nsrc = "/a.js"></SCRIPT><script></script>`), []);
  assert.deepEqual(inlineScripts(`<script type="module">a<b</script >`), ["a<b"]);
  // A script that holds a comment opener is read whole; the browser reads line ends as "\n".
  assert.deepEqual(inlineScripts(`<script>a("<!--")</script><!-- x --><script>b()</script>`), [
    `a("<!--")`,
    "b()",
  ]);
  assert.deepEqual(inlineScripts("<script>a()\r\nb()\rc()</script>"), ["a()\nb()\nc()"]);
  assert.deepEqual(inlineScripts(`<script data-src="/a.js">a()</script>`), ["a()"]);
});

test("the policy allows the page's own inline scripts and no other", () => {
  const { html, home, map } = builtPage();
  const policy = contentSecurityPolicy(html, { supabaseUrl: "https://ref.supabase.co" });
  assert.deepEqual(sources(policy, "script-src"), [
    "'self'",
    "'wasm-unsafe-eval'",
    scriptHash(home),
    scriptHash(map),
  ]);
  // No script from text, from an inline attribute, from another host or from a data: URL.
  assert.doesNotMatch(policy, /'unsafe-eval'|script-src[^;]*('unsafe-inline'|https?:|data:|blob:)/);
  assert.deepEqual(sources(policy, "default-src"), ["'self'"]);
  assert.deepEqual(sources(policy, "frame-ancestors"), ["'none'"]);
  assert.deepEqual(sources(policy, "frame-src"), ["'none'"]);
  assert.deepEqual(sources(policy, "object-src"), ["'none'"]);
  assert.deepEqual(sources(policy, "base-uri"), ["'self'"]);
  assert.deepEqual(sources(policy, "form-action"), ["'self'"]);
  assert.deepEqual(sources(policy, "worker-src"), ["'self'", "blob:"]);
});

test("requests: the site, Supabase, Mapbox, the address search; more only when configured", () => {
  const { html } = builtPage();
  const plain = sources(
    contentSecurityPolicy(html, { supabaseUrl: "https://ref.supabase.co/auth/v1", apiUrl: "" }),
    "connect-src",
  );
  assert.deepEqual(plain, [
    "'self'",
    "https://ref.supabase.co",
    "https://api.mapbox.com",
    "https://events.mapbox.com",
    "https://*.tiles.mapbox.com",
    "https://api-adresse.data.gouv.fr",
    "https://data.geopf.fr",
    "data:",
  ]);

  const more = sources(
    contentSecurityPolicy(html, {
      supabaseUrl: "http://127.0.0.1:54321",
      apiUrl: "http://localhost:3000",
      mapDataBase: "https://tiles.example.org/outlines/",
    }),
    "connect-src",
  );
  assert.deepEqual(more.slice(0, 4), [
    "'self'",
    "http://127.0.0.1:54321",
    "http://localhost:3000",
    "https://tiles.example.org",
  ]);

  // A base that is a path of the site, and one origin named twice.
  const same = sources(
    contentSecurityPolicy(html, {
      supabaseUrl: "https://one.example",
      apiUrl: "https://one.example/api",
      mapDataBase: "/map-data/",
    }),
    "connect-src",
  );
  assert.deepEqual(same.slice(0, 3), ["'self'", "https://one.example", "https://api.mapbox.com"]);
});

test("Turnstile's script and frame are allowed only with a site key", () => {
  const { html } = builtPage();
  const off = contentSecurityPolicy(html, { supabaseUrl: "https://ref.supabase.co" });
  assert.doesNotMatch(off, /challenges\.cloudflare\.com/);

  const on = contentSecurityPolicy(html, {
    supabaseUrl: "https://ref.supabase.co",
    turnstileSiteKey: "0x4AAAAAAA",
  });
  assert.equal(sources(on, "script-src").at(-1), "https://challenges.cloudflare.com");
  assert.deepEqual(sources(on, "frame-src"), ["https://challenges.cloudflare.com"]);
  assert.doesNotMatch(on, /0x4AAAAAAA/);
});

test("a setting reaches the policy as an origin, never as its own text", () => {
  assert.equal(originOf("https://ref.supabase.co/x; script-src *"), "https://ref.supabase.co");
  assert.equal(originOf("https://ref.supabase.co\n/*\n  X-Other: 1"), "https://ref.supabase.co");
  for (const none of [undefined, "", "/map-data/", "ref.supabase.co", "javascript:alert(1)"]) {
    assert.equal(originOf(none), null);
  }
  // A host `URL` accepts and a policy would read as something else: the end
  // of a directive, the end of the header's value, any host. And one a policy
  // cannot name.
  for (const host of [
    "https://ref.supabase.co;script-src-elem",
    "https://ref.supabase.co%3bscript-src-elem",
    "http://ref.supabase.co,other",
    "https://*",
    "https://*.supabase.co",
    "https://ref.supabase.co'",
    "http://[::1]:54321",
  ]) {
    assert.equal(originOf(host), null, host);
  }
  assert.equal(originOf("https://REF.Supabase.co:8443/auth"), "https://ref.supabase.co:8443");
  assert.equal(originOf("http://127.0.0.1:54321"), "http://127.0.0.1:54321");
  const elsewhere = contentSecurityPolicy("", {
    supabaseUrl: "https://ref.supabase.co;script-src-elem",
    apiUrl: "http://api.example,other",
    mapDataBase: "https://*",
  });
  assert.doesNotMatch(elsewhere, /script-src-elem|,|https:\/\/\* /);
  assert.equal(sources(elsewhere, "connect-src")[1], "https://api.mapbox.com");
  const policy = contentSecurityPolicy("", { supabaseUrl: "https://a.example/; script-src *" });
  assert.deepEqual(sources(policy, "script-src"), ["'self'", "'wasm-unsafe-eval'"]);
  assert.doesNotMatch(policy, /[\r\n]/);
});

test("VITE_CSP: unset applies the policy, report-only reports, anything else is refused", () => {
  assert.equal(policyMode(undefined), "enforce");
  assert.equal(policyMode(""), "enforce");
  assert.equal(policyMode("report-only"), "report-only");
  assert.throws(() => policyMode("off"), /VITE_CSP/);
  assert.throws(() => policyMode("Report-Only"), /VITE_CSP/);
});

test("the headers file: the policy joins the `/*` block of public/_headers", () => {
  const { html } = builtPage();
  const policy = contentSecurityPolicy(html, { supabaseUrl: "https://ref.supabase.co" });
  const file = headersFile(PUBLIC_HEADERS, { policy, mode: "enforce", noIndex: false });

  for (const path of ["/", "/temoignages", "/audition/abc", "/assets/index-c.js", "//x", "/a/b"]) {
    const headers = served(file, path);
    assert.equal(headers["content-security-policy"], policy, path);
    assert.equal(headers["x-content-type-options"], "nosniff", path);
    assert.equal(headers["x-frame-options"], "DENY", path);
    assert.equal(headers["referrer-policy"], "strict-origin-when-cross-origin", path);
    assert.equal(headers["cross-origin-opener-policy"], "same-origin", path);
    assert.equal(headers["strict-transport-security"], "max-age=86400", path);
    assert.match(headers["permissions-policy"] ?? "", /camera=\(\).*geolocation=\(\)/, path);
    assert.equal(headers["x-robots-tag"], undefined, path);
    assert.equal(headers["content-security-policy-report-only"], undefined, path);
  }
  assert.match(served(file, "/assets/index-c.js")["cache-control"] ?? "", /immutable/);
  assert.equal(served(file, "/")["cache-control"], undefined);
});

test("the headers file: a witness's link sends no referrer; private pages are not indexed", () => {
  const file = headersFile(PUBLIC_HEADERS, {
    policy: "default-src 'self'",
    mode: "enforce",
    noIndex: false,
  });
  const link = served(file, "/verifier/0123abcd");
  assert.equal(link["referrer-policy"], "no-referrer");
  assert.equal(link["x-robots-tag"], "noindex");
  assert.equal(link["x-frame-options"], "DENY");
  assert.equal(link["content-security-policy"], "default-src 'self'");
  for (const path of ["/admin", "/admin/", "/auth", "/auth/x", "/reset-password"]) {
    assert.equal(served(file, path)["x-robots-tag"], "noindex", path);
    assert.equal(served(file, path)["referrer-policy"], "strict-origin-when-cross-origin", path);
  }
  for (const path of ["/", "/audition/abc", "/administration", "/soutenir"]) {
    assert.equal(served(file, path)["x-robots-tag"], undefined, path);
  }
});

test("robots.txt lets a crawler fetch a witness's link, whose noindex header it then reads", () => {
  const robots = readFileSync(new URL("../../../public/robots.txt", import.meta.url), "utf8");
  const disallowed = [...robots.matchAll(/^Disallow:\s*(\S+)/gm)].map(([, path]) => path ?? "");
  assert.deepEqual(disallowed, ["/admin", "/auth", "/reset-password", "/api/"]);
  assert.ok(!disallowed.some((path) => "/verifier/0f8fad5b".startsWith(path)));
});

test("the headers file: report-only and staging's noindex", () => {
  const file = headersFile(PUBLIC_HEADERS, {
    policy: "default-src 'self'",
    mode: "report-only",
    noIndex: true,
  });
  const home = served(file, "/");
  assert.equal(home["content-security-policy"], undefined);
  assert.equal(home["content-security-policy-report-only"], "default-src 'self'");
  assert.equal(home["x-robots-tag"], "noindex, nofollow");
  // Framing stays refused: frame-ancestors does nothing in a report-only policy.
  assert.equal(home["x-frame-options"], "DENY");
  assert.match(served(file, "/admin")["x-robots-tag"] ?? "", /noindex/);
});

test("the headers file: every line fits Cloudflare's limit, or the build stops", () => {
  // The fullest policy: every optional source, and four times today's inline scripts.
  const page = Array.from({ length: 8 }, (_, i) => `<script>boot(${i})</script>`).join("");
  const policy = contentSecurityPolicy(page, {
    supabaseUrl: "https://abcdefghijklmnopqrst.supabase.co",
    apiUrl: "https://api.auditionscitoyennes.example",
    mapDataBase: "https://map-data.auditionscitoyennes.example/outlines/",
    turnstileSiteKey: "0x4AAAAAAA",
  });
  const file = headersFile(PUBLIC_HEADERS, { policy, mode: "report-only", noIndex: true });
  for (const line of file.split("\n")) assert.ok(line.trim().length <= MAX_HEADER_LINE);
  assert.ok(policy.length < MAX_HEADER_LINE - 400, `${policy.length} characters`);

  const tooLong = `default-src 'self' ${"https://a.example ".repeat(120)}`;
  assert.throws(
    () => headersFile(PUBLIC_HEADERS, { policy: tooLong, mode: "enforce", noIndex: false }),
    /longer than 2000/,
  );
});

test("the headers file: one `/*` block, or the build stops", () => {
  const options = { policy: "default-src 'self'", mode: "enforce", noIndex: false } as const;
  assert.throws(
    () => headersFile("/assets/*\n  Cache-Control: no-store\n", options),
    /one `\/\*` block/,
  );
  assert.throws(() => headersFile("/*\n  X-A: 1\n\n/*\n  X-B: 2\n", options), /one `\/\*` block/);
  assert.equal(
    headersFile("/*\n  X-A: 1\n\n\n", options),
    "/*\n  Content-Security-Policy: default-src 'self'\n  X-A: 1\n",
  );
});

test("a staging or production build needs its Supabase and API settings; another build none", () => {
  const set = {
    VITE_SUPABASE_URL: "https://ref.supabase.co",
    VITE_SUPABASE_PUBLISHABLE_KEY: "k",
    VITE_API_URL: "",
  };
  assert.deepEqual(missingDeploySettings({}), []);
  assert.deepEqual(missingDeploySettings({ VITE_APP_ENV: "local" }), []);
  assert.deepEqual(missingDeploySettings({ VITE_APP_ENV: "staging", ...set }), []);
  assert.deepEqual(missingDeploySettings({ VITE_APP_ENV: "production", ...set }), []);
  assert.deepEqual(missingDeploySettings({ VITE_APP_ENV: "production" }), [
    "VITE_SUPABASE_URL",
    "VITE_SUPABASE_PUBLISHABLE_KEY",
    "VITE_API_URL",
  ]);
  assert.deepEqual(
    missingDeploySettings({ VITE_APP_ENV: "staging", ...set, VITE_SUPABASE_PUBLISHABLE_KEY: "" }),
    ["VITE_SUPABASE_PUBLISHABLE_KEY"],
  );
  for (const url of ["ref.supabase.co", "https://ref.supabase.co;script-src-elem"]) {
    assert.deepEqual(
      missingDeploySettings({ VITE_APP_ENV: "staging", ...set, VITE_SUPABASE_URL: url }),
      ["VITE_SUPABASE_URL"],
      url,
    );
  }

  // The API's address: said empty (the site's own /api) or as an http(s) URL.
  const production = { VITE_APP_ENV: "production", ...set };
  assert.deepEqual(
    missingDeploySettings({ ...production, VITE_API_URL: "https://api.example.org" }),
    [],
  );
  for (const url of [undefined, "api.example.org", "/api", "https://api.example.org,other"]) {
    assert.deepEqual(
      missingDeploySettings({ ...production, VITE_API_URL: url }),
      ["VITE_API_URL"],
      String(url),
    );
  }
});
