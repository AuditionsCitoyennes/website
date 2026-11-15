// The map page's code asked for from the HTML (the build's part of
// shared/boot/mapPreload.ts): which built files the map page needs beyond the
// entry, and the small inline script that asks for them before the entry
// module runs, on the map page alone.
//
// The site serves one index.html for every path, so the HTML cannot carry the
// map's files as plain <link> tags: the home page and the legal pages would
// download the map too. The script reads the path and adds the links itself.
//
// Measured on the audit's weak phone (2026-11-12, `exp-boot.md` §3, "chunk
// preload only"): the list 0.1 s and the France plateau 0.16 s sooner, the
// first paint 0.17 s later (the map's code shares the link with the entry).
// The low-priority variant (fetchpriority=low) was worse on every mark and is
// not offered; neither is asking for the first data from the HTML (0.4 s
// worse alone).
//
// Pure, no browser and no Vite import: read by vite.config.ts at build time
// and by node (mapPreloadPlan.test.ts).

export type MapPreload = "html" | "page";

/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_MAP_PRELOAD: MapPreload = "html";
export const MAP_PRELOADS: readonly MapPreload[] = ["html", "page"];

/** The localStorage key of the DEV switch. */
export const MAP_PRELOAD_KEY = "ac:map-preload";

/** The paths of the map page (shared/routes: ROUTE.temoignages) whose first
 *  load asks for the map's code from the HTML. "/analyses" is a redirect to it
 *  (app/router/routes.ts). */
export const MAP_PAGE_PATH = /^\/(temoignages|analyses)\/?$/;

/** The source modules whose chunks start the map page (the lazy route
 *  component and the explorer it lends the stage to). */
export const MAP_PAGE_MODULES = /\/(StagePage|TemoignagesExplorer)\.vue$/;

/** A built chunk as the plan reads it (Rollup's / Rolldown's OutputChunk). */
export interface PlanChunk {
  fileName: string;
  isEntry: boolean;
  facadeModuleId: string | null;
  /** The chunks it imports statically. */
  imports: readonly string[];
  /** The stylesheets Vite attached to it. */
  css: readonly string[];
}

/** The files to ask for: the map page's chunks (or those of `modules`: the
 *  home page's, shared/boot/homeBootPlan.ts) and everything they import
 *  statically that the entry does not already load, then their stylesheets;
 *  URLs from the site's root, in a stable order. */
export function mapPreloadFiles(
  chunks: readonly PlanChunk[],
  modules: RegExp = MAP_PAGE_MODULES,
): { js: string[]; css: string[] } {
  const byFile = new Map(chunks.map((c) => [c.fileName, c]));
  const closure = (start: readonly string[]) => {
    const seen = new Set<string>();
    const walk = (f: string) => {
      if (seen.has(f) || !byFile.has(f)) return;
      seen.add(f);
      for (const i of byFile.get(f)!.imports) walk(i);
    };
    start.forEach(walk);
    return seen;
  };
  const entry = closure(chunks.filter((c) => c.isEntry).map((c) => c.fileName));
  const page = closure(
    chunks.filter((c) => modules.test(c.facadeModuleId ?? "")).map((c) => c.fileName),
  );
  const js = [...page].filter((f) => !entry.has(f)).sort();
  const entryCss = new Set([...entry].flatMap((f) => byFile.get(f)!.css));
  const css = [...new Set(js.flatMap((f) => byFile.get(f)!.css))]
    .filter((f) => !entryCss.has(f))
    .sort();
  return { js: js.map((f) => `/${f}`), css: css.map((f) => `/${f}`) };
}

/**
 * The inline script: on the map page, when the mode is "html", a
 * <link rel=modulepreload> per script and a <link rel=preload as=style> per
 * stylesheet, both `crossorigin` as Vite's own preload helper asks for them
 * (which then finds them and asks again for none). `testTools`: the build
 * reads the DEV switch (MAP_PRELOAD_KEY); any other build has the default
 * baked in and reads no storage.
 */
export function mapPreloadScript(
  files: { js: readonly string[]; css: readonly string[] },
  testTools: boolean,
): string {
  if (!files.js.length && !files.css.length) return "";
  const mode = testTools
    ? `var m=null;try{m=localStorage.getItem(${JSON.stringify(MAP_PRELOAD_KEY)})}catch(e){}` +
      `if(${JSON.stringify(MAP_PRELOADS)}.indexOf(m)<0)m=${JSON.stringify(DEFAULT_MAP_PRELOAD)};`
    : `var m=${JSON.stringify(DEFAULT_MAP_PRELOAD)};`;
  return (
    `(function(){${mode}` +
    `if(m!=="html"||!${MAP_PAGE_PATH.toString()}.test(location.pathname))return;` +
    `var h=document.head,a=function(r,f,s){var l=document.createElement("link");` +
    `l.rel=r;if(s)l.as=s;l.crossOrigin="";l.href=f;h.appendChild(l)};` +
    `${JSON.stringify(files.js)}.forEach(function(f){a("modulepreload",f)});` +
    `${JSON.stringify(files.css)}.forEach(function(f){a("preload",f,"style")})})();`
  );
}
