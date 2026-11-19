// Whether the header's « Témoigner » invites a little more: a visitor who has
// not sent a testimony from this browser for a week (or ever) sees it glow;
// after a testimony is sent (or validated from its email link) it stays calm
// for a week — the API's own pace, « un témoignage par semaine et par
// adresse ».
//
// The only record is the date of the last testimony, kept on this device
// (localStorage "ac-last-testimony", an ISO date): nothing is sent anywhere,
// nothing ties it to an email or an account. Blocked storage (a private
// window) keeps the date for the page alone.
//
// Two switches, compared live in the builds with the testing tools (the dev
// server and staging, __TEST_TOOLS__), kept in localStorage and drawn as the
// DEV dialog's rows « Bouton Témoigner » and « Style de l'invitation ». No
// reload: the header follows them at once.
//
// `ac:testify-nudge`: "auto" (the default: the week's rule above), "toujours"
// (always the invitation) or "jamais" (never: the plain button of before).
//
// `ac:testify-look`, the invitation's look, always the site's violet:
// - "halo" (the default): a soft violet glow around the button, breathing
//   three times after the page shows, then still;
// - "anneau": a thin violet ring around it, from which a wider ring spreads
//   and fades three times, then the thin ring alone;
// - "point": a small violet dot on its corner, breathing three times, then
//   still.
// The animations move only the opacity and the scale of a layer of their own
// (no layout, no paint once started) and end: a still invitation costs
// nothing. Under « réduire les animations » the still look at once
// (AppHeader.vue).
//
// Production has neither key nor row: the DEFAULT_* below.
//
// Loadable under node (testifyNudge.test.ts). The header (app/), the form and
// the verification page (features/testify) and the DEV dialog
// (features/temoignages) all read it: it lives in shared/.

import { ref } from "vue";

export type TestifyNudge = "auto" | "toujours" | "jamais";
export type TestifyLook = "halo" | "anneau" | "point";

/** The modes of a build without the testing tools, and the switches' defaults. */
export const DEFAULT_TESTIFY_NUDGE: TestifyNudge = "auto";
export const DEFAULT_TESTIFY_LOOK: TestifyLook = "halo";

export const TESTIFY_NUDGES: readonly TestifyNudge[] = ["auto", "toujours", "jamais"];
export const TESTIFY_LOOKS: readonly TestifyLook[] = ["halo", "anneau", "point"];

/** The device's record: the date of its last testimony (not a testing switch). */
export const LAST_TESTIMONY_KEY = "ac-last-testimony";

/** How long the button stays calm after a testimony. */
export const CALM_MS = 7 * 24 * 60 * 60 * 1000;

/** A record further ahead than this is a clock that was wrong: read as none. */
const FUTURE_SLACK_MS = 24 * 60 * 60 * 1000;

/** A kept date (ISO), in ms; anything else is null. */
export function parseLastTestimony(raw: string | null): number | null {
  if (!raw) return null;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : null;
}

/** The record of this device, null when there is none (or no storage). */
export function storedLastTestimony(): number | null {
  try {
    return parseLastTestimony(localStorage.getItem(LAST_TESTIMONY_KEY));
  } catch {
    return null;
  }
}

/** Whether the invitation shows: the switch, the last testimony (ms, or
 *  null), and now (ms). */
export function nudgeDue(mode: TestifyNudge, last: number | null, now: number): boolean {
  if (mode === "toujours") return true;
  if (mode === "jamais") return false;
  if (last === null || last > now + FUTURE_SLACK_MS) return true;
  return now - last >= CALM_MS;
}

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
    /* storage blocked (a private window): it lasts for this page */
  }
}

/** The date of the last testimony from this device (ms), or null. */
export const lastTestimonyAt = ref<number | null>(storedLastTestimony());

// Another tab of this site sent one: this one calms down too.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === LAST_TESTIMONY_KEY || e.key === null)
      lastTestimonyAt.value = storedLastTestimony();
  });
}

/** A testimony was sent (or validated) from this device: kept, the button calm. */
export function noteTestimony(now: number = Date.now()) {
  lastTestimonyAt.value = now;
  store(LAST_TESTIMONY_KEY, new Date(now).toISOString());
}

/** The modes now (refs: the header and the DEV dialog follow them). A build
 *  without the testing tools reads no key: the defaults. */
export const testifyNudge = ref<TestifyNudge>(
  __TEST_TOOLS__
    ? stored("ac:testify-nudge", TESTIFY_NUDGES, DEFAULT_TESTIFY_NUDGE)
    : DEFAULT_TESTIFY_NUDGE,
);
export const testifyLook = ref<TestifyLook>(
  __TEST_TOOLS__
    ? stored("ac:testify-look", TESTIFY_LOOKS, DEFAULT_TESTIFY_LOOK)
    : DEFAULT_TESTIFY_LOOK,
);

/** Another rule: kept, and in force at once. */
export function setTestifyNudge(mode: TestifyNudge) {
  if (!__TEST_TOOLS__) return;
  testifyNudge.value = mode;
  store("ac:testify-nudge", mode);
}

/** Another look: kept, and in force at once. */
export function setTestifyLook(look: TestifyLook) {
  if (!__TEST_TOOLS__) return;
  testifyLook.value = look;
  store("ac:testify-look", look);
}
