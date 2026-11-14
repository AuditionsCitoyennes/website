// The home page's first render and its photograph, compared live in the
// builds with the testing tools (the dev server and staging, __TEST_TOOLS__),
// kept in localStorage and drawn as the DEV dialog's « Accueil » and « Photo de
// l'accueil » rows. What each value does: homeBootPlan.ts.
//
// `ac:home-boot` is read by the HTML's inline script alone (this module only
// shows and sets it): a change applies on the next load, so switching reloads
// the page. `ac:hero` is read by the script too ("html") and by the hero
// (features/home/HeroSection.vue, through `hero` below). The dev server has no
// built files: it asks for nothing early, whatever the choice. Production has
// neither key nor switch: the defaults.

import {
  DEFAULT_HERO,
  DEFAULT_HOME_BOOT,
  HERO_KEY,
  HEROES,
  HOME_BOOT_KEY,
  HOME_BOOTS,
  HOME_SHELL_CLASS,
  type Hero,
  type HomeBoot,
} from "./homeBootPlan";

export { DEFAULT_HERO, DEFAULT_HOME_BOOT, HEROES, HOME_BOOTS, type Hero, type HomeBoot };

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return (allowed as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked (a private window): the script reads the default */
  }
}

/** This page load's modes. */
export const homeBoot: HomeBoot = __TEST_TOOLS__
  ? stored(HOME_BOOT_KEY, HOME_BOOTS, DEFAULT_HOME_BOOT)
  : DEFAULT_HOME_BOOT;
export const hero: Hero = __TEST_TOOLS__ ? stored(HERO_KEY, HEROES, DEFAULT_HERO) : DEFAULT_HERO;

/** Another mode: kept, and the page loaded again with it. */
export function setHomeBoot(mode: HomeBoot) {
  if (!__TEST_TOOLS__ || mode === homeBoot) return;
  store(HOME_BOOT_KEY, mode);
  window.location.reload();
}

/** Another mode: kept, and the page loaded again with it. */
export function setHero(mode: Hero) {
  if (!__TEST_TOOLS__ || mode === hero) return;
  store(HERO_KEY, mode);
  window.location.reload();
}

/** The home page is in: the shell's ground is no longer wanted (a later
 *  page waiting for its code is never painted in the hero's ground). */
export function endHomeShell() {
  document.documentElement.classList.remove(HOME_SHELL_CLASS);
}
