// A small in-memory, fixed-window rate limiter — for the one public form that
// sends emails to addresses typed by strangers. Per process: enough for a
// single API instance; a shared store would be needed beyond that.

interface Window {
  until: number;
  count: number;
}

const windows = new Map<string, Window>();
// Bounded, so a flood of new addresses can neither grow it without end nor
// make each request pay for scanning it.
const MAX_KEYS = 50_000;
let lastPrune = 0;

function hit(w: Window, max: number): boolean {
  if (w.count >= max) return false;
  w.count++;
  return true;
}

/**
 * Counts one more hit for `key`; false once it has had `max` hits within the
 * current `windowMs`.
 */
export function allowHit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const w = windows.get(key);
  if (w && w.until > now) return hit(w, max);
  // A new window goes to the end: the map stays ordered by window start, so
  // the oldest are evicted first.
  windows.delete(key);
  windows.set(key, { until: now + windowMs, count: 1 });
  if (now - lastPrune > 60_000) {
    lastPrune = now;
    for (const [k, v] of windows) if (v.until <= now) windows.delete(k);
  }
  while (windows.size > MAX_KEYS) windows.delete(windows.keys().next().value!);
  return true;
}

/** One limit a request is counted against: `n` more hits on `key`, at most `max` per `windowMs`. */
export interface HitRule {
  key: string;
  n: number;
  max: number;
  windowMs: number;
}

/**
 * Counts the hits of every rule, all or none: 0 when they all fit in their
 * current windows (then counted), else how many ms until the latest of the
 * refusing windows ends (nothing counted).
 */
export function takeHits(rules: readonly HitRule[]): number {
  const now = Date.now();
  let waitMs = 0;
  for (const r of rules) {
    const w = windows.get(r.key);
    const used = w && w.until > now ? w.count : 0;
    if (used + r.n > r.max) waitMs = Math.max(waitMs, w && w.until > now ? w.until - now : 0);
    // More than a whole window allows: refused for a window.
    if (r.n > r.max) waitMs = Math.max(waitMs, r.windowMs);
  }
  if (waitMs > 0) return waitMs;
  for (const r of rules) {
    for (let i = 0; i < r.n; i++) allowHit(r.key, r.max, r.windowMs);
  }
  return 0;
}

// The site-wide ceiling lives apart: a flood of keys must never evict it.
const global: Window = { until: 0, count: 0 };

/** One more hit on the site-wide ceiling: false once `max` within `windowMs`. */
export function allowGlobalHit(max: number, windowMs: number): boolean {
  const now = Date.now();
  if (global.until <= now) {
    global.until = now + windowMs;
    global.count = 0;
  }
  return hit(global, max);
}

/**
 * The key a visitor is counted under: their IPv4 address, or the /64 of their
 * IPv6 one (a single connection usually holds a whole /64).
 */
export function clientKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(":")) return ip;
  // Spelled out in full first, so one /64 has one key however it is written.
  const address = ip.split("%")[0].toLowerCase();
  const [head, tail] = address.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups =
    tail === undefined
      ? front
      : [...front, ...Array(8 - front.length - back.length).fill("0"), ...back];
  return `${groups
    .slice(0, 4)
    .map((g) => (parseInt(g, 16) || 0).toString(16))
    .join(":")}::/64`;
}
