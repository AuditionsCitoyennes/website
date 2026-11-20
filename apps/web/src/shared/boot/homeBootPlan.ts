// The home page's first render, from the HTML (the build's part of
// shared/boot/homeBoot.ts): a small inline script that runs before the
// stylesheet is applied and before the entry module. On every page, the
// theme's class is put on <html> by the HTML itself (the same rule as
// shared/ui/theme/useTheme.ts, which then finds it there), so the first paint
// is in the visitor's theme, not light then dark. On the home page ("/")
// alone: the empty page is painted in the hero's dark ground
// (HOME_SHELL_CLASS, index.html's inline style) until the home page renders,
// and the home page's code (its chunk and its stylesheet) is asked for beside
// the entry instead of after it.
//
// The site serves one index.html for every path, so the links are added by
// the script, on "/" alone.
//
// Pure, no browser and no Vite import: read by vite.config.ts at build time
// and by node (homeBootPlan.test.ts).

import { mapPreloadFiles, type PlanChunk } from "./mapPreloadPlan";

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

/**
 * The inline script. `files`: the home page's chunks and stylesheets
 * (homePreloadFiles).
 */
export function homeBootScript(files: { js: readonly string[]; css: readonly string[] }): string {
  return (
    `(function(){var d=document.documentElement,` +
    `g=function(k){try{return localStorage.getItem(k)}catch(e){return null}};` +
    // The theme: useTheme.ts's rule (dark unless "light" was chosen).
    `var t=g("theme");d.classList.toggle("dark",t?t==="dark":true);` +
    `if(!${HOME_PAGE_PATH.toString()}.test(location.pathname))return;` +
    `var h=document.head,a=function(r,f,s,c){var l=document.createElement("link");` +
    `l.rel=r;if(s)l.as=s;if(c)l.crossOrigin="";l.href=f;h.appendChild(l);return l};` +
    `d.classList.add(${JSON.stringify(HOME_SHELL_CLASS)});` +
    `${JSON.stringify(files.js)}.forEach(function(f){a("modulepreload",f,0,1)});` +
    `${JSON.stringify(files.css)}.forEach(function(f){a("preload",f,"style",1)})` +
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
