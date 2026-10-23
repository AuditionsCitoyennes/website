import { ref } from "vue";

// The test outbox (staging and local development; see features/outbox): no
// email leaves those sites, the API keeps them and the site shows them. What
// the rest of the site tells it lives here: which browser acted, and when
// something it did may have sent an email. Every caller checks __OUTBOX__
// first, so that a build without the outbox drops all of this.

const VIEWER_KEY = "ac-outbox-viewer";
const ADDRESSES_KEY = "ac-outbox-addresses";

let viewer: string | null = null;

/** This browser's random outbox id, sent with every request that may send an email. */
export function outboxViewer(): string {
  if (viewer) return viewer;
  try {
    viewer = localStorage.getItem(VIEWER_KEY);
    if (!viewer) {
      viewer = crypto.randomUUID();
      localStorage.setItem(VIEWER_KEY, viewer);
    }
  } catch {
    // Storage refused (private window…): one id for this page's life.
    viewer ??= crypto.randomUUID();
  }
  return viewer;
}

/** Bumped when something this browser did may have sent an email: the outbox looks again. */
export const outboxNudge = ref(0);

/** The addresses typed into this browser's sign-up / password forms. */
export function outboxAddresses(): string[] {
  try {
    const stored = JSON.parse(localStorage.getItem(ADDRESSES_KEY) ?? "[]");
    return Array.isArray(stored) ? stored.filter((a) => typeof a === "string") : [];
  } catch {
    return [];
  }
}

/**
 * An address was just typed into an auth form: Supabase Auth's emails to it
 * (sign-up confirmation, password reset…) come from Auth, not from a request
 * of this browser, so the outbox counts them as this browser's by address.
 */
export function noteOutboxAddress(email: string): void {
  const address = email.trim().toLowerCase();
  const addresses = [address, ...outboxAddresses().filter((a) => a !== address)].slice(0, 20);
  try {
    localStorage.setItem(ADDRESSES_KEY, JSON.stringify(addresses));
  } catch {
    /* not remembered: these emails show under "Tous" only */
  }
  outboxNudge.value++;
}
