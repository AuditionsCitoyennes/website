// Performance probes, in the builds with the testing tools only
// (__TEST_TOOLS__, vite.config: the dev server and staging). `perfOn` is false
// in production: every call site is gated on it, so the minifier drops the
// calls and their arguments, this module's install never runs, and the built
// chunk carries no observer, no mark, no `__acPerf` (checked by grepping the
// production chunk for `__acPerf`, `ac:` and `PerformanceObserver`).
//
// The engine is generic: an interaction is a kind (any string) and an id,
// begun at the user's act and ended at the frame that shows its result; the
// steps between are spans. What the kinds mean, and what the network and
// script names are, belong to the feature that measures — the map registers
// its vocabulary from features/map/dev (perfVocabulary). Every interaction is
// a performance.mark / performance.measure pair named `ac:<kind>`, so
// DevTools' and Safari's timelines show them too.
//
// Attribution (which spans, long frames, tasks and requests fell inside an
// interaction) is computed when it is READ — `__acPerf.last()`, `table()`,
// `dump()` — never when the interaction closes: the observers deliver their
// entries in a later task, so the frame that ends an interaction is only known
// a moment after it ended. The console line is printed on a short delay for
// the same reason. Long frames come from `long-animation-frame` where Chrome
// provides it (with the scripts it blames), `longtask` otherwise, and on
// Safari a requestAnimationFrame delta loop that only runs while an
// interaction is open. An interaction nothing ends times out after 10 s.
//
// In the console: `__acPerf.last()`, `__acPerf.table()`, `__acPerf.dump()`
// (JSON — what a report wants), `__acPerf.reset()`.

export const perfOn: boolean = __TEST_TOOLS__;

export type PerfKind = string;
type Detail = Record<string, unknown>;

export interface PerfSpan {
  name: string;
  t0: number;
  ms: number;
  detail?: Detail;
}
interface FrameEntry {
  t0: number;
  ms: number;
  blocking: number;
  scripts: { src: string; fn: string; ms: number }[];
}
interface TaskEntry {
  t0: number;
  ms: number;
}
/** An interaction as recorded: the act, its end, nothing derived. */
interface Interaction {
  kind: PerfKind;
  id: string;
  t0: number;
  t1: number | null;
  status: "open" | "done" | "superseded" | "timeout";
  detail: Detail;
}
/** An interaction as read: what fell inside its window. */
export interface PerfInteraction extends Interaction {
  ms: number;
  /** The spans that began inside the window, summed by name. */
  spans: Record<string, { n: number; ms: number; max: number }>;
  /** The frames over 50 ms inside the window (long-animation-frame, or the fallback). */
  frames: { count: number; longest: number; total: number };
  /** The tasks over 50 ms inside the window (longtask), where supported. */
  tasks: { count: number; longest: number };
  /** Main-thread requests that ended inside the window, by what they fetched. */
  net: Record<string, { n: number; ms: number; kb: number }>;
  /** What long-animation-frame blames, by script file (Chrome only). */
  scripts: { src: string; ms: number }[];
}

/** What a feature registers: how to name a request's kind and a script. */
export interface PerfVocabulary {
  /** The kind of a main-thread request, from its URL (null: the default naming). */
  net?: (url: string) => string | null;
  /** The name of a script a long frame blames, from its URL (null: the path). */
  script?: (url: string) => string | null;
}

const LONG_MS = 50;
const TIMEOUT_MS = 10_000;
/** The console line waits this long for the observers' entries (a frame's blame can lag a second). */
const LINE_DELAY_MS = 1000;
const KEEP = { interactions: 200, spans: 4000, frames: 2000, tasks: 2000 };

/** The open interactions, one per kind (a new one supersedes the old). */
const open = new Map<PerfKind, Interaction>();
const done: Interaction[] = [];
const spans: PerfSpan[] = [];
const frames: FrameEntry[] = [];
const tasks: TaskEntry[] = [];
let hasLoaf = false;
let hasLongTask = false;
let vocabulary: PerfVocabulary = {};
/** An interaction's attribution as settled a second after it closed: the
 *  spans and frames arrays keep filling (every long frame of a free pan is
 *  kept), so an old interaction read late would otherwise see its window
 *  emptied by the caps. */
const settled = new WeakMap<Interaction, PerfInteraction>();

const noop = () => {};
const now = () => performance.now();
function cap<T>(arr: T[], n: number) {
  if (arr.length > n) arr.splice(0, arr.length - n);
}

/** A feature's names for requests and scripts (the map's: features/map/dev). */
export function perfVocabulary(v: PerfVocabulary) {
  if (!perfOn) return;
  vocabulary = { ...vocabulary, ...v };
}

/** An interaction begins: whatever was open under the same kind is superseded. */
export function perfBegin(kind: PerfKind, id: string, detail: Detail = {}) {
  if (!perfOn) return;
  const t = now();
  const prev = open.get(kind);
  if (prev) close(prev, t, "superseded");
  const it: Interaction = { kind, id, t0: t, t1: null, status: "open", detail };
  open.set(kind, it);
  try {
    performance.mark(`ac:${kind}:start`, { detail: { id } });
  } catch {
    /* an old User Timing: no detail */
  }
  armTimeout();
  armRafFallback();
}

/** An interaction ends — the one open under `kind` (and `id`, when given). */
export function perfEnd(kind: PerfKind, id?: string, detail: Detail = {}) {
  if (!perfOn) return;
  const it = open.get(kind);
  if (!it || (id !== undefined && it.id !== id)) return;
  Object.assign(it.detail, detail);
  close(it, now(), "done");
}

/** The id of the interaction open under `kind`, or null: cheap enough for a
 *  per-frame check (the map's frame bus ends select-plateau from it). */
export function perfPending(kind: PerfKind): string | null {
  return open.get(kind)?.id ?? null;
}

/** A step begins; the function returned ends it (with more detail, if any).
 *  Call sites gate on `perfOn` so production builds nothing. */
export function perfSpan(name: string, detail?: Detail): (more?: Detail) => void {
  if (!perfOn) return noop;
  const t0 = now();
  return (more) => {
    const ms = now() - t0;
    pushSpan({ name, t0, ms, detail: more ? { ...detail, ...more } : detail });
  };
}

/** A step already measured (`ms` long, ending now). */
export function perfNote(name: string, ms: number, detail?: Detail) {
  if (!perfOn) return;
  pushSpan({ name, t0: now() - ms, ms, detail });
}

function pushSpan(s: PerfSpan) {
  spans.push(s);
  cap(spans, KEEP.spans);
  try {
    performance.measure(`ac:${s.name}`, { start: s.t0, end: s.t0 + s.ms, detail: s.detail });
  } catch {
    /* an old User Timing: the span is kept here only */
  }
}

function close(it: Interaction, t1: number, status: "done" | "superseded" | "timeout") {
  if (open.get(it.kind) === it) open.delete(it.kind);
  it.t1 = t1;
  it.status = status;
  done.push(it);
  cap(done, KEEP.interactions);
  try {
    performance.measure(`ac:${it.kind}`, {
      start: it.t0,
      end: t1,
      detail: { id: it.id, status, ...it.detail },
    });
  } catch {
    /* an old User Timing */
  }
  // The observers' entries for the closing frame arrive in a later task: the
  // attribution is settled, and the line printed, a second on.
  setTimeout(() => {
    const a = attributed(it);
    settled.set(it, a);
    if (status !== "superseded") console.info(line(a));
  }, LINE_DELAY_MS);
}

// An interaction nothing ends (a plateau that never reaches full rise, a
// boundary that never arrives) closes as a timeout, so the open list — and
// the rAF fallback loop — never grow without end.
let timeoutTimer = 0;
function armTimeout() {
  if (timeoutTimer) return;
  timeoutTimer = window.setTimeout(sweepTimeouts, TIMEOUT_MS + 20);
}
function sweepTimeouts() {
  timeoutTimer = 0;
  const t = now();
  for (const it of [...open.values()]) if (t - it.t0 >= TIMEOUT_MS) close(it, t, "timeout");
  if (open.size) armTimeout();
}

/** What fell inside the interaction's window: spans, frames, tasks, requests
 *  (as settled a second after it closed, once that has happened). */
function attributed(it: Interaction): PerfInteraction {
  const done = settled.get(it);
  if (done) return done;
  const t0 = it.t0;
  const t1 = it.t1 ?? now();
  const out: PerfInteraction = {
    ...it,
    ms: Math.round((t1 - t0) * 10) / 10,
    spans: {},
    frames: { count: 0, longest: 0, total: 0 },
    tasks: { count: 0, longest: 0 },
    net: {},
    scripts: [],
  };
  for (const s of spans) {
    if (s.t0 < t0 - 1 || s.t0 > t1) continue;
    const a = (out.spans[s.name] ??= { n: 0, ms: 0, max: 0 });
    a.n++;
    a.ms += s.ms;
    a.max = Math.max(a.max, s.ms);
  }
  for (const k of Object.keys(out.spans)) {
    out.spans[k].ms = Math.round(out.spans[k].ms * 10) / 10;
    out.spans[k].max = Math.round(out.spans[k].max * 10) / 10;
  }
  const bySrc = new Map<string, number>();
  for (const f of frames) {
    // A frame that began a little before the act and ran into it counts.
    if (f.t0 + f.ms < t0 || f.t0 > t1) continue;
    out.frames.count++;
    out.frames.longest = Math.max(out.frames.longest, f.ms);
    out.frames.total += f.ms;
    for (const s of f.scripts) bySrc.set(s.src, (bySrc.get(s.src) ?? 0) + s.ms);
  }
  out.frames.longest = Math.round(out.frames.longest);
  out.frames.total = Math.round(out.frames.total);
  out.scripts = [...bySrc]
    .map(([src, ms]) => ({ src, ms: Math.round(ms) }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 8);
  for (const k of tasks) {
    if (k.t0 + k.ms < t0 || k.t0 > t1) continue;
    out.tasks.count++;
    out.tasks.longest = Math.max(out.tasks.longest, Math.round(k.ms));
  }
  for (const r of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
    const end = r.responseEnd || r.startTime + r.duration;
    if (end < t0 || r.startTime > t1) continue;
    const key = vocabulary.net?.(r.name) ?? (r.name.includes("/api/") ? "api" : "other");
    const a = (out.net[key] ??= { n: 0, ms: 0, kb: 0 });
    a.n++;
    a.ms += r.duration;
    a.kb += (r.transferSize || r.encodedBodySize || 0) / 1024;
  }
  for (const k of Object.keys(out.net)) {
    out.net[k].ms = Math.round(out.net[k].ms);
    out.net[k].kb = Math.round(out.net[k].kb);
  }
  return out;
}

const fmt = (ms: number) => `${Math.round(ms)} ms`;
/** The one console line per interaction. */
function line(it: PerfInteraction): string {
  if (it.status === "timeout")
    return `[perf] ${it.kind} ${it.id}: timeout (nothing ended it in ${fmt(it.ms)})`;
  const parts = [`[perf] ${it.kind} ${it.id}: ${fmt(it.ms)}`];
  const fr = it.frames;
  if (fr.count) {
    parts.push(`${fr.count} long frame${fr.count > 1 ? "s" : ""} (max ${fmt(fr.longest)})`);
  } else if (hasLoaf || !hasLongTask) {
    parts.push("no long frame");
  }
  if (it.tasks.count && !hasLoaf) {
    parts.push(`${it.tasks.count} long tasks (max ${fmt(it.tasks.longest)})`);
  }
  const sp = Object.entries(it.spans)
    .sort((a, b) => b[1].ms - a[1].ms)
    .map(([k, v]) => `${k} ${Math.round(v.ms)}${v.n > 1 ? `×${v.n}` : ""}`);
  if (sp.length) parts.push(sp.join(" · "));
  const net = Object.entries(it.net)
    .filter(([k]) => k !== "other")
    .map(([k, v]) => `${k} ${v.n}× ${v.ms} ms ${v.kb} KB`);
  if (net.length) parts.push(`net: ${net.join(", ")}`);
  if (it.scripts.length) {
    parts.push(`scripts: ${it.scripts.map((s) => `${s.src} ${s.ms}`).join(", ")}`);
  }
  return parts.join(" — ");
}

// ---- Long frames -----------------------------------------------------------------

interface LoafScript {
  sourceURL?: string;
  sourceFunctionName?: string;
  invoker?: string;
  duration: number;
}
interface LoafEntry extends PerformanceEntry {
  blockingDuration?: number;
  scripts?: LoafScript[];
}

/** The script's file, for blame: the feature's name for it, else its path
 *  without origin or query. */
function scriptSrc(s: LoafScript): string {
  const u = s.sourceURL || s.invoker || "";
  if (!u) return "(unknown)";
  const named = vocabulary.script?.(u);
  if (named) return named;
  try {
    const p = new URL(u, location.href).pathname;
    return p.replace(/^\/src\//, "").replace(/^\/node_modules\/\.vite\/deps\//, "deps/");
  } catch {
    return u;
  }
}

function observe(type: string, cb: (entries: PerformanceEntryList) => void): boolean {
  try {
    if (!PerformanceObserver.supportedEntryTypes.includes(type)) return false;
    const o = new PerformanceObserver((list) => cb(list.getEntries()));
    o.observe({ type, buffered: true });
    return true;
  } catch {
    return false;
  }
}

// Where no observer tells, a requestAnimationFrame loop measures the gaps
// between frames — only while an interaction is open, and a moment after.
let rafId = 0;
let rafLast = 0;
let rafUntil = 0;
function rafTick(t: number) {
  if (rafLast && t - rafLast > LONG_MS) {
    frames.push({ t0: rafLast, ms: t - rafLast, blocking: t - rafLast - 16, scripts: [] });
    cap(frames, KEEP.frames);
  }
  rafLast = t;
  if (open.size || t < rafUntil) rafId = requestAnimationFrame(rafTick);
  else rafId = 0;
}
function armRafFallback() {
  if (hasLoaf || hasLongTask) return;
  rafUntil = now() + 2000;
  if (!rafId) {
    // Seeded with the act's own time: the first frame measured is the one the
    // act ran in, which is the frame an interaction ended in the same task shows.
    rafLast = now();
    rafId = requestAnimationFrame(rafTick);
  }
}

// ---- Install: the observers and window.__acPerf ------------------------------------

function install() {
  const w = window as unknown as { __acPerf?: unknown };
  if (w.__acPerf) return; // HMR re-evaluating the module
  hasLoaf = observe("long-animation-frame", (entries) => {
    for (const e of entries as LoafEntry[]) {
      if (e.duration < LONG_MS) continue;
      frames.push({
        t0: e.startTime,
        ms: e.duration,
        blocking: e.blockingDuration ?? 0,
        scripts: (e.scripts ?? []).map((s) => ({
          src: scriptSrc(s),
          fn: s.sourceFunctionName ?? "",
          ms: s.duration,
        })),
      });
    }
    cap(frames, KEEP.frames);
  });
  hasLongTask = observe("longtask", (entries) => {
    for (const e of entries) tasks.push({ t0: e.startTime, ms: e.duration });
    cap(tasks, KEEP.tasks);
  });
  try {
    performance.setResourceTimingBufferSize(3000);
    performance.addEventListener("resourcetimingbufferfull", () => {
      performance.clearResourceTimings();
    });
  } catch {
    /* no Resource Timing */
  }
  const frameSource = hasLoaf ? "long-animation-frame" : hasLongTask ? "longtask" : "raf-delta";
  const summary = (it: PerfInteraction) => ({
    kind: it.kind,
    id: it.id,
    ms: it.ms,
    status: it.status,
    longFrames: it.frames.count,
    longest: it.frames.longest,
    spans: Object.entries(it.spans)
      .sort((a, b) => b[1].ms - a[1].ms)
      .map(([k, v]) => `${k} ${Math.round(v.ms)}${v.n > 1 ? `×${v.n}` : ""}`)
      .join(" · "),
  });
  w.__acPerf = {
    on: true,
    /** How long frames are counted here. */
    frameSource,
    /** Interactions ended, oldest first, attributed now. */
    interactions: () => done.map(attributed),
    open: () => [...open.values()].map(attributed),
    last: (kind?: PerfKind) => {
      const it = [...done].reverse().find((x) => !kind || x.kind === kind);
      return it ? attributed(it) : null;
    },
    spans: () => [...spans],
    frames: () => ({
      count: frames.length,
      longest: Math.round(Math.max(0, ...frames.map((f) => f.ms))),
      total: Math.round(frames.reduce((a, f) => a + f.ms, 0)),
      entries: [...frames],
    }),
    table: () => console.table(done.map((it) => summary(attributed(it)))),
    /** Everything, as JSON (what a report pastes). */
    dump: () => ({
      ua: navigator.userAgent,
      dpr: window.devicePixelRatio,
      viewport: [window.innerWidth, window.innerHeight],
      frameSource,
      interactions: done.map(attributed),
      frames: { count: frames.length, longest: Math.max(0, ...frames.map((f) => f.ms)) },
    }),
    reset: () => {
      done.length = 0;
      spans.length = 0;
      frames.length = 0;
      tasks.length = 0;
      performance.clearResourceTimings();
      performance.clearMarks();
      performance.clearMeasures();
    },
  };
}

if (perfOn) install();
