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
// The invitation is a soft violet glow around the button, breathing three
// times after the page shows, then still (AppHeader.vue). The animation moves
// only the opacity of a layer of its own (no layout, no paint once started)
// and ends: a still invitation costs nothing. Under « réduire les
// animations » the still look at once.
//
// Loadable under node (testifyNudge.test.ts). The header (app/), the form and
// the verification page (features/testify) read it: it lives in shared/.

import { ref } from "vue";

/** The device's record: the date of its last testimony. */
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

/** Whether the invitation shows: the last testimony (ms, or null), and now
 *  (ms). */
export function nudgeDue(last: number | null, now: number): boolean {
  if (last === null || last > now + FUTURE_SLACK_MS) return true;
  return now - last >= CALM_MS;
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

/** The API's refusal of a second testimony within the week from one address
 *  (apps/api/src/modules/online-testimonies/routes.ts, "weeklyQuota": a 429
 *  whose message names the week). Told apart from the other 429, « momentanément
 *  saturé », by its words: the API gives no code of its own. */
export function isWeeklyQuotaRefusal(status: number, message: string): boolean {
  return status === 429 && /par semaine/.test(message);
}

/** A testimony was sent (or validated) from this device: kept, the button calm. */
export function noteTestimony(now: number = Date.now()) {
  lastTestimonyAt.value = now;
  store(LAST_TESTIMONY_KEY, new Date(now).toISOString());
}
