// The home page's first render, from the HTML (the build's part of
// shared/boot/homeBoot.ts): a small inline script that runs before the
// stylesheet is applied and before the entry module, compared live in the
// builds with the testing tools through two DEV switches.
//
// `ac:home-boot` (« Accueil »):
// - "tot" (the default): on every page, the theme's class is put on <html>
//   by the HTML itself (the same rule as shared/ui/theme/useTheme.ts, which
//   then finds it there), so the first paint is in the visitor's theme, not
//   light then dark. On the home page ("/") alone: the empty page is painted
//   in the hero's dark ground (HOME_SHELL_CLASS, index.html's inline style)
//   until the home page renders, and the home page's code (its chunk and its
//   stylesheet) is asked for beside the entry instead of after it.
// - "ancien": as before. The class comes with the entry module, the page is
//   blank until the home page's code has come after the entry's.
//
// `ac:hero` (« Photo de l'accueil »): the hero photograph (features/home/
// homeImages.ts, heroSources):
// - "portrait" (the default): a portrait screen (a phone, a tablet held
//   upright) gets a copy of the photograph cut to its shape, the same centre,
//   at a quality a little lower (55 in place of 75): about 240 kB on a phone
//   in place of 760 kB. Wide screens get today's copies.
// - "html": the same, and the HTML asks for the photograph at once (with a
//   connection opened to the photo's host) on the home page, before the
//   entry module: the photo comes sooner, but shares the link with the code.
//   An experiment, off: not measured yet.
// - "ancien": as before, one landscape copy for every screen (the 2 560 px
//   one on most phones).
//
// The site serves one index.html for every path, so the links are added by
// the script, on "/" alone. Production has neither key nor switch: the
// defaults are baked into the script.
//
// Pure, no browser and no Vite import: read by vite.config.ts at build time
// and by node (homeBootPlan.test.ts).

import { mapPreloadFiles, type PlanChunk } from "./mapPreloadPlan";

export type HomeBoot = "tot" | "ancien";
/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_HOME_BOOT: HomeBoot = "tot";
export const HOME_BOOTS: readonly HomeBoot[] = ["tot", "ancien"];
export const HOME_BOOT_KEY = "ac:home-boot";

export type Hero = "portrait" | "html" | "ancien";
/** The mode of a build without the testing tools, and the switch's default. */
export const DEFAULT_HERO: Hero = "portrait";
export const HEROES: readonly Hero[] = ["portrait", "html", "ancien"];
export const HERO_KEY = "ac:hero";

/** The home page's path (shared/routes: ROUTE.home). */
export const HOME_PAGE_PATH = /^\/$/;
/** The source module whose chunk is the home page (features/home/index.ts). */
export const HOME_PAGE_MODULES = /\/HomePage\.vue$/;
/** The class the script puts on <html> on the home page: index.html's inline
 *  style paints the still empty page in the hero's ground; HomePage removes
 *  it once mounted. */
export const HOME_SHELL_CLASS = "ac-home-shell";
/** The hero's ground, under the photograph (HeroSection.vue's .hero), and the
 *  shell's (index.html). */
export const HERO_GROUND = "hsl(260 30% 8%)";

/** A responsive image as <picture> and <link rel=preload> both describe it. */
export interface ImageSource {
  /** A <source> for the screens whose width / height is at most this ratio
   *  (null: the <img> itself, the fallback). Sources come narrowest first. */
  maxAspect: readonly [number, number] | null;
  srcset: string;
  sizes: string;
}

/** The home page's own files beyond the entry's. */
export function homePreloadFiles(chunks: readonly PlanChunk[]) {
  return mapPreloadFiles(chunks, HOME_PAGE_MODULES);
}

/** The media query of a <source>. */
export const pictureMedia = (s: ImageSource): string | null =>
  s.maxAspect ? `(max-aspect-ratio: ${s.maxAspect[0]}/${s.maxAspect[1]})` : null;

/** Just over w/h, as a media query's ratio (whole numbers). */
const justOver = ([w, h]: readonly [number, number]) => `${w * 1000 + 1}/${h * 1000}`;

/**
 * The preload's media of each source: the screens for which <picture> picks
 * that source (the first whose media matches), so that exactly one link
 * applies on any screen. A source's own ratio, above the one before it; the
 * fallback, above the last one.
 */
export function preloadMedia(sources: readonly ImageSource[]): (string | null)[] {
  return sources.map((s, i) => {
    const before = i > 0 ? sources[i - 1].maxAspect : null;
    const above = before ? `(min-aspect-ratio: ${justOver(before)})` : null;
    const own = pictureMedia(s);
    return [above, own].filter(Boolean).join(" and ") || null;
  });
}

/** A storage read of the script: the kept value of `key` among `allowed`,
 *  else `fallback`; in a build without the testing tools, `fallback` baked in. */
function choice(
  name: string,
  key: string,
  allowed: readonly string[],
  fallback: string,
  testTools: boolean,
) {
  return testTools
    ? `var ${name}=g(${JSON.stringify(key)});` +
        `if(${JSON.stringify(allowed)}.indexOf(${name})<0)${name}=${JSON.stringify(fallback)};`
    : `var ${name}=${JSON.stringify(fallback)};`;
}

/**
 * The inline script. `files`: the home page's chunks and stylesheets
 * (homePreloadFiles); `hero`: the photograph's sources in "portrait"
 * (heroSources), `heroOrigin` their host; `testTools`: the build reads the
 * two DEV switches, any other build has the defaults baked in.
 */
export function homeBootScript(input: {
  files: { js: readonly string[]; css: readonly string[] };
  hero: readonly ImageSource[];
  heroOrigin: string | null;
  testTools: boolean;
}): string {
  const { files, hero, heroOrigin, testTools } = input;
  const media = preloadMedia(hero);
  const heroLinks = hero.map((s, i) => [s.srcset, s.sizes, media[i] ?? ""]);
  return (
    `(function(){var d=document.documentElement,` +
    `g=function(k){try{return localStorage.getItem(k)}catch(e){return null}};` +
    choice("b", HOME_BOOT_KEY, HOME_BOOTS, DEFAULT_HOME_BOOT, testTools) +
    choice("p", HERO_KEY, HEROES, DEFAULT_HERO, testTools) +
    // The theme: useTheme.ts's rule (dark unless "light" was chosen).
    `if(b==="tot"){var t=g("theme");d.classList.toggle("dark",t?t==="dark":true)}` +
    `if(!${HOME_PAGE_PATH.toString()}.test(location.pathname))return;` +
    `var h=document.head,a=function(r,f,s,c){var l=document.createElement("link");` +
    `l.rel=r;if(s)l.as=s;if(c)l.crossOrigin="";l.href=f;h.appendChild(l);return l};` +
    `if(b==="tot"){d.classList.add(${JSON.stringify(HOME_SHELL_CLASS)});` +
    `${JSON.stringify(files.js)}.forEach(function(f){a("modulepreload",f,0,1)});` +
    `${JSON.stringify(files.css)}.forEach(function(f){a("preload",f,"style",1)})}` +
    // The photograph's links: "html" is a DEV choice, so a build without the
    // testing tools (whose `p` is baked to the default) leaves them out.
    (testTools && heroLinks.length
      ? `if(p==="html"){` +
        (heroOrigin ? `a("preconnect",${JSON.stringify(heroOrigin)});` : "") +
        `${JSON.stringify(heroLinks)}.forEach(function(s){var l=document.createElement("link");` +
        `l.rel="preload";l.as="image";l.setAttribute("imagesrcset",s[0]);` +
        `l.setAttribute("imagesizes",s[1]);if(s[2])l.media=s[2];` +
        `l.setAttribute("fetchpriority","high");h.appendChild(l)})}`
      : "") +
    `})();`
  );
}

/**
 * index.html with the inline script placed right after `<meta charset>`, so
 * the charset declaration stays within the document's first 1024 bytes (the
 * HTML spec's rule); with no charset, first in <head>.
 */
export function afterCharset(html: string, script: string): string {
  const tag = `<script>${script}</script>`;
  const charset = /<meta\s+charset=[^>]*>/i.exec(html);
  if (charset) {
    const at = charset.index + charset[0].length;
    const line = html.slice(html.lastIndexOf("\n", charset.index) + 1, charset.index);
    const indent = /^[ \t]*$/.test(line) ? line : "";
    return `${html.slice(0, at)}\n${indent}${tag}${html.slice(at)}`;
  }
  return html.replace(/<head[^>]*>/i, (head) => `${head}${tag}`);
}
