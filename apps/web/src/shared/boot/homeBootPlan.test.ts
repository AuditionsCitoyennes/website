// The home page's inline script (homeBootPlan.ts) run against a fake page:
// the theme's class as useTheme.ts sets it, the home page's links on "/"
// alone, the photograph's links in "html" alone with exactly one of them for
// any screen shape, the switches read only by a build with the testing tools;
// the hero's sources (features/home/homeImages.ts) and index.html's shell
// colour against the hero's. Run with `node --import tsx --test` (root
// "test:scripts").

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  HERO_GROUND,
  afterCharset,
  HOME_SHELL_CLASS,
  homeBootScript,
  homePreloadFiles,
  pictureMedia,
  preloadMedia,
  type ImageSource,
} from "./homeBootPlan";
import { HERO_IMAGE, PROJECT_IMAGE, heroSources } from "../../features/home/homeImages";

interface FakeLink {
  rel?: string;
  as?: string;
  href?: string;
  media?: string;
  crossOrigin?: string;
  attrs: Record<string, string>;
  setAttribute(k: string, v: string): void;
}

/** Runs the script on a fake page: `path`, the kept values, the storage throwing. */
function run(script: string, path: string, kept: Record<string, string> = {}, blocked = false) {
  const classes = new Set<string>();
  const links: FakeLink[] = [];
  const document = {
    documentElement: {
      classList: {
        toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)),
        add: (c: string) => classes.add(c),
      },
    },
    head: { appendChild: (l: FakeLink) => links.push(l) },
    createElement: (): FakeLink => ({
      attrs: {},
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
    }),
  };
  const localStorage = {
    getItem: (k: string) => {
      if (blocked) throw new Error("blocked");
      return kept[k] ?? null;
    },
  };
  new Function("document", "localStorage", "location", script)(document, localStorage, {
    pathname: path,
  });
  return { classes, links };
}

const files = { js: ["/assets/HomePage-a.js"], css: ["/assets/HomePage-b.css"] };
const hero = heroSources(HERO_IMAGE, "portrait");
const script = (testTools: boolean) =>
  homeBootScript({ files, hero, heroOrigin: "https://images.unsplash.com", testTools });

test("the theme's class is useTheme.ts's: dark unless light was chosen, on every page", () => {
  const theme = readFileSync(new URL("../ui/theme/useTheme.ts", import.meta.url), "utf8");
  assert.match(theme, /localStorage\.getItem\("theme"\)/);
  assert.match(theme, /saved \? saved === "dark" : true/);
  for (const path of ["/", "/temoignages", "/mentions-legales"]) {
    assert.ok(run(script(false), path).classes.has("dark"));
    assert.ok(run(script(false), path, { theme: "dark" }).classes.has("dark"));
    assert.ok(!run(script(false), path, { theme: "light" }).classes.has("dark"));
    assert.ok(run(script(false), path, {}, true).classes.has("dark"), "storage blocked");
  }
});

test("on the home page alone: the shell's class and the home page's code", () => {
  const home = run(script(false), "/");
  assert.ok(home.classes.has(HOME_SHELL_CLASS));
  assert.deepEqual(
    home.links.map((l) => [l.rel, l.href, l.as ?? null, l.crossOrigin]),
    [
      ["modulepreload", "/assets/HomePage-a.js", null, ""],
      ["preload", "/assets/HomePage-b.css", "style", ""],
    ],
  );
  for (const path of ["/temoignages", "/auth", "//", "/index.html"]) {
    const other = run(script(false), path);
    assert.ok(!other.classes.has(HOME_SHELL_CLASS), path);
    assert.equal(other.links.length, 0, path);
  }
});

test("a build without the testing tools reads no switch; one with them does", () => {
  const kept = { "ac:home-boot": "ancien", "ac:hero": "html" };
  const prod = run(script(false), "/", kept);
  assert.ok(prod.classes.has("dark") && prod.classes.has(HOME_SHELL_CLASS));
  assert.ok(!prod.links.some((l) => l.as === "image"));
  assert.doesNotMatch(script(false), /ac:/);
  // « Ancien »: nothing at all (the theme comes with the entry, as before).
  const old = run(script(true), "/", { "ac:home-boot": "ancien" });
  assert.equal(old.classes.size, 0);
  assert.equal(old.links.length, 0);
  // Garbage is the default.
  const garbage = run(script(true), "/", { "ac:home-boot": "x", "ac:hero": "y" });
  assert.ok(garbage.classes.has(HOME_SHELL_CLASS));
  assert.equal(garbage.links.length, 2);
});

test("« Portrait tôt »: a connection to the host and one image link per source, on / only", () => {
  const { links } = run(script(true), "/", { "ac:hero": "html" });
  const images = links.filter((l) => l.as === "image");
  assert.deepEqual(
    links.filter((l) => l.rel === "preconnect").map((l) => l.href),
    ["https://images.unsplash.com"],
  );
  assert.equal(images.length, hero.length);
  const media = preloadMedia(hero);
  images.forEach((l, i) => {
    assert.equal(l.attrs.imagesrcset, hero[i].srcset);
    assert.equal(l.attrs.imagesizes, hero[i].sizes);
    assert.equal(l.attrs.fetchpriority, "high");
    assert.equal(l.media ?? null, media[i]);
  });
  assert.equal(run(script(true), "/temoignages", { "ac:hero": "html" }).links.length, 0);
});

/** Whether a media query of the plan's shapes matches a screen of ratio r. */
function matches(query: string | null, r: number): boolean {
  if (query === null) return true;
  return query.split(" and ").every((part) => {
    const m = /\((min|max)-aspect-ratio: (\d+)\/(\d+)\)/.exec(part)!;
    const v = Number(m[2]) / Number(m[3]);
    return m[1] === "max" ? r <= v : r >= v;
  });
}

test("one preload at most applies to any screen, the source <picture> picks", () => {
  const media = preloadMedia(hero);
  const picked = (r: number) => hero.findIndex((s) => matches(pictureMedia(s), r));
  const applying = (r: number) => media.flatMap((m, i) => (matches(m, r) ? [i] : []));
  // Never two (two downloads); one but in a sliver just over each cut's ratio.
  for (let r = 0.3; r < 3; r += 0.0005) {
    const a = applying(r);
    assert.ok(a.length <= 1, `ratio ${r}`);
    if (a.length) assert.equal(a[0], picked(r), `ratio ${r}`);
    else
      assert.ok(
        [0.5, 0.75].some((v) => r > v && r < v + 0.001),
        `ratio ${r}: none`,
      );
  }
  // Real screens, phones to desktops, on the cut's edges too: exactly one.
  const screens = [
    [360, 740],
    [390, 844],
    [412, 915],
    [360, 640],
    [375, 667],
    [360, 720],
    [768, 1024],
    [810, 1080],
    [600, 800],
    [1024, 768],
    [1440, 900],
    [1920, 1080],
    [400, 800],
  ];
  for (const [w, h] of screens) assert.deepEqual(applying(w / h), [picked(w / h)], `${w}×${h}`);
});

test("the hero's sources: portrait cuts of the same photo, narrowest first, today's last", () => {
  const old = heroSources(HERO_IMAGE, "ancien");
  assert.equal(old.length, 1);
  assert.equal(old[0].maxAspect, null);
  assert.equal(old[0].srcset.split(", ").length, 4);
  assert.match(old[0].srcset, /q=75&w=2560 2560w$/);
  assert.deepEqual(hero.at(-1), old[0]);
  const cuts = hero.slice(0, -1);
  assert.deepEqual(
    cuts.map((s) => s.maxAspect),
    [
      [1, 2],
      [3, 4],
    ],
  );
  for (const s of cuts as Required<ImageSource>[]) {
    const [w, h] = s.maxAspect!;
    for (const c of s.srcset.split(", ")) {
      const m = /^(\S+)\?auto=format&fit=crop&crop=center&q=55&w=(\d+)&h=(\d+) (\d+)w$/.exec(c)!;
      assert.ok(m, c);
      assert.equal(m[1], HERO_IMAGE.src);
      assert.equal(m[2], m[4]);
      assert.equal(Number(m[3]), Math.round((Number(m[2]) * h) / w));
    }
    assert.equal(s.sizes, `calc(100vh * ${w} / ${h})`);
  }
  // A host that cannot cut: today's copies alone.
  assert.equal(heroSources(PROJECT_IMAGE, "portrait").length, 1);
  // Today's copies on a phone took 2 560 px; the 1:2 cut stops at 1 080.
  assert.match(cuts[0].srcset, /w=1080&h=2160 1080w$/);
});

test("the shell's ground in index.html is the hero's", () => {
  const html = readFileSync(new URL("../../../index.html", import.meta.url), "utf8");
  const heroVue = readFileSync(
    new URL("../../features/home/HeroSection.vue", import.meta.url),
    "utf8",
  );
  assert.ok(html.includes(`html.${HOME_SHELL_CLASS} #app:empty`));
  assert.ok(html.includes(`background: ${HERO_GROUND};`));
  assert.ok(heroVue.includes(`background: ${HERO_GROUND};`));
});

test("the home page's files are its chunk's closure beyond the entry's", () => {
  const chunks = [
    {
      fileName: "index.js",
      isEntry: true,
      facadeModuleId: "/src/main.ts",
      imports: ["vue.js"],
      css: ["index.css"],
    },
    { fileName: "vue.js", isEntry: false, facadeModuleId: null, imports: [], css: [] },
    {
      fileName: "HomePage.js",
      isEntry: false,
      facadeModuleId: "/src/features/home/HomePage.vue",
      imports: ["index.js", "answers.js"],
      css: ["HomePage.css"],
    },
    { fileName: "answers.js", isEntry: false, facadeModuleId: null, imports: ["vue.js"], css: [] },
    {
      fileName: "Stage.js",
      isEntry: false,
      facadeModuleId: "/src/x/StagePage.vue",
      imports: [],
      css: [],
    },
  ];
  assert.deepEqual(homePreloadFiles(chunks), {
    js: ["/HomePage.js", "/answers.js"],
    css: ["/HomePage.css"],
  });
});

test("a build without the testing tools carries no photograph links (dead code there)", () => {
  assert.doesNotMatch(script(false), /imagesrcset|preconnect|images\.unsplash/);
  assert.match(script(true), /imagesrcset/);
});

test("the script goes right after <meta charset>, which stays in the first 1024 bytes", () => {
  const html =
    '<!doctype html>\n<html lang="fr">\n  <head>\n    <meta charset="UTF-8" />\n' +
    '    <link rel="stylesheet" href="/a.css">\n  </head>\n</html>';
  const out = afterCharset(html, script(true));
  const charsetAt = out.indexOf("<meta charset");
  assert.ok(charsetAt >= 0 && charsetAt < 1024);
  assert.ok(out.indexOf("<script>") > charsetAt);
  assert.ok(out.indexOf("<script>") < out.indexOf("<link"));
  assert.ok(out.includes(`<script>${script(true)}</script>`));
  // No charset: the script still lands first in <head>.
  const bare = afterCharset("<html><head><title>x</title></head></html>", "S");
  assert.equal(bare, "<html><head><script>S</script><title>x</title></head></html>");
});
