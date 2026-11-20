// The map page's code asked for from the HTML (mapPreloadPlan.ts), run with
// `node --import tsx --test` (root "test:scripts"): the files picked from a
// build (the map page's chunks and their static imports, less the entry's,
// then their stylesheets), and the inline script run in a stub page: links
// on the map page alone, as Vite's helper makes them, no storage read.

import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { MAP_PAGE_PATH, mapPreloadFiles, mapPreloadScript, type PlanChunk } from "./mapPreloadPlan";

const chunk = (
  fileName: string,
  imports: string[] = [],
  more: Partial<PlanChunk> = {},
): PlanChunk => ({ fileName, isEntry: false, facadeModuleId: null, imports, css: [], ...more });

const BUILD: PlanChunk[] = [
  chunk("assets/index-A.js", ["assets/vue-B.js", "assets/helper-C.js"], {
    isEntry: true,
    facadeModuleId: "/w/src/main.ts",
    css: ["assets/index-A.css"],
  }),
  chunk("assets/vue-B.js"),
  chunk("assets/helper-C.js"),
  chunk("assets/StagePage-D.js", ["assets/vue-B.js"], {
    facadeModuleId: "/w/src/features/map-stage/StagePage.vue",
    css: ["assets/StagePage-D.css"],
  }),
  chunk(
    "assets/TemoignagesExplorer-E.js",
    ["assets/mapbox-gl-F.js", "assets/vue-B.js", "assets/filters-G.js"],
    {
      facadeModuleId: "/w/src/features/temoignages/TemoignagesExplorer.vue",
      css: ["assets/TemoignagesExplorer-E.css", "assets/index-A.css"],
    },
  ),
  chunk("assets/mapbox-gl-F.js"),
  chunk("assets/filters-G.js", ["assets/helper-C.js"], { css: ["assets/filters-G.css"] }),
  chunk("assets/AdminPage-H.js", ["assets/vue-B.js"], {
    facadeModuleId: "/w/src/features/admin/pages/AdminPage.vue",
  }),
];

test("the map page's chunks and their imports, less the entry's, then their stylesheets", () => {
  assert.deepEqual(mapPreloadFiles(BUILD), {
    js: [
      "/assets/StagePage-D.js",
      "/assets/TemoignagesExplorer-E.js",
      "/assets/filters-G.js",
      "/assets/mapbox-gl-F.js",
    ],
    css: ["/assets/StagePage-D.css", "/assets/TemoignagesExplorer-E.css", "/assets/filters-G.css"],
  });
  // A build without the map page's chunks asks for nothing, and writes no script.
  const none = mapPreloadFiles(BUILD.filter((c) => !/Stage|Temoignages/.test(c.fileName)));
  assert.deepEqual(none, { js: [], css: [] });
  assert.equal(mapPreloadScript(none), "");
});

test("the map page's paths, and no other", () => {
  for (const p of ["/temoignages", "/temoignages/", "/analyses"])
    assert.ok(MAP_PAGE_PATH.test(p), p);
  for (const p of ["/", "/temoignages-x", "/auth", "/admin", "/x/temoignages", "/soutenir"]) {
    assert.ok(!MAP_PAGE_PATH.test(p), p);
  }
});

interface Link {
  rel: string;
  as?: string;
  crossOrigin?: string;
  href: string;
}

/** The script run in a stub page at `path`, with `stored` as the kept switch. */
function run(script: string, path: string, stored: string | null | Error): Link[] {
  const links: Link[] = [];
  let reads = 0;
  runInNewContext(script, {
    location: { pathname: path },
    localStorage: {
      getItem: () => {
        reads++;
        if (stored instanceof Error) throw stored;
        return stored;
      },
    },
    document: {
      head: { appendChild: (l: Link) => links.push(l) },
      createElement: () => ({}) as Link,
    },
  });
  return Object.assign(links, { reads });
}

const FILES = mapPreloadFiles(BUILD);

test("on the map page the script asks for each file, as Vite's preload helper does", () => {
  const links = run(mapPreloadScript(FILES), "/temoignages", null);
  assert.deepEqual(
    links.map((l) => ({ ...l })),
    [
      ...FILES.js.map((href) => ({ rel: "modulepreload", crossOrigin: "", href })),
      ...FILES.css.map((href) => ({ rel: "preload", as: "style", crossOrigin: "", href })),
    ],
  );
});

test("elsewhere it asks for nothing, and it reads no storage", () => {
  for (const path of ["/", "/auth", "/admin", "/soutenir"]) {
    assert.equal(run(mapPreloadScript(FILES), path, null).length, 0, path);
  }
  const links = run(mapPreloadScript(FILES), "/temoignages", "page");
  assert.equal(links.length, FILES.js.length + FILES.css.length);
  assert.equal((links as unknown as { reads: number }).reads, 0);
});
