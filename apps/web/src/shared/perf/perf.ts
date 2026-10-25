// The map's performance probes (docs/map-roadmap-2026-10-25.md, phase 0), in
// the builds with the testing tools only (__TEST_TOOLS__, vite.config: the dev
// server and staging). Production has none of it: `perfOn` is false there,
// every function returns at once and the minifier drops the rest.
//
// Four interactions are timed from the user's act to the frame that shows its
// result, as performance.mark / performance.measure pairs named `ac:<kind>`
// (so DevTools' and Safari's timelines show them too):
//   select-plateau    a unit selected (a row, a pin, its territory, a crumb) →
//                     the first frame the plateau is drawn at full rise
//   scope-mask        the scope written → the grey re-cut around it
//   drill-boundaries  a unit selected → its outline has every geometry it will
//                     get (its own, its children's, its neighbours')
//   lieu-pins         a lieu opened → the dots of the lieux around it placed
// The steps in between — the DEM POST, the mesh rebuilds, earcut, the mask's
// setData, the lid's snapshot, the slabs, the hierarchy and the other Vue
// derivations — are spans (`perfSpan`, `perfNote`), attributed to every
// interaction they fall inside. The network's share comes from the Resource
// Timing entries of the window (main-thread requests: the API's; mapbox's
// worker fetches are not seen). Frames over 50 ms come from a
// `long-animation-frame` observer (Chrome, with the scripts it blames),
// `longtask` where that one is missing, and, where neither exists (Safari), a
// requestAnimationFrame delta loop that only runs while an interaction is open.
//
// In the console: `__acPerf.last()`, `__acPerf.table()`, `__acPerf.dump()`
// (JSON — what a report wants), `__acPerf.reset()`. One line is printed per
// interaction as it ends.

export const perfOn: boolean = __TEST_TOOLS__;

export type PerfKind = "select-plateau" | "scope-mask" | "drill-boundaries" | "lieu-pins";
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
export interface PerfInteraction {
  kind: PerfKind;
  id: string;
  t0: number;
  t1: number | null;
  ms: number | null;
  status: "open" | "done" | "superseded";
  detail: Detail;
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

const LONG_MS = 50;
const KEEP = { interactions: 200, spans: 4000, frames: 2000, tasks: 2000 };

const open: PerfInteraction[] = [];
const done: PerfInteraction[] = [];
const spans: PerfSpan[] = [];
const frames: FrameEntry[] = [];
const tasks: TaskEntry[] = [];
let hasLoaf = false;
let hasLongTask = false;
/** The open select-plateau interaction, read by every frame drawn (perfFrame). */
let pendingPlateau: PerfInteraction | null = null;

const noop = () => {};
const now = () => performance.now();
function cap<T>(arr: T[], n: number) {
  if (arr.length > n) arr.splice(0, arr.length - n);
}

/** An interaction begins: whatever was open under the same kind is superseded. */
export function perfBegin(kind: PerfKind, id: string, detail: Detail = {}) {
  if (!perfOn) return;
  const t = now();
  for (const it of [...open]) if (it.kind === kind) close(it, t, "superseded");
  const it: PerfInteraction = {
    kind,
    id,
    t0: t,
    t1: null,
    ms: null,
    status: "open",
    detail,
    spans: {},
    frames: { count: 0, longest: 0, total: 0 },
    tasks: { count: 0, longest: 0 },
    net: {},
    scripts: [],
  };
  open.push(it);
  if (kind === "select-plateau") pendingPlateau = it;
  try {
    performance.mark(`ac:${kind}:start`, { detail: { id } });
  } catch {
    /* an old User Timing: no detail */
  }
  armRafFallback();
}

/** An interaction ends — the one open under `kind` (and `id`, when given). */
export function perfEnd(kind: PerfKind, id?: string, detail: Detail = {}) {
  if (!perfOn) return;
  const it = open.find((x) => x.kind === kind && (id === undefined || x.id === id));
  if (!it) return;
  Object.assign(it.detail, detail);
  close(it, now(), "done");
}

/** Whether an interaction of `kind` is open (to skip work only a probe needs). */
export function perfOpen(kind: PerfKind): boolean {
  return perfOn && open.some((x) => x.kind === kind);
}

/** A step begins; the function returned ends it (with more detail, if any). */
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

/**
 * Every frame drawn, from the map's frame bus: the plateau standing at full
 * rise for the unit selected ends its select-plateau interaction. Nothing is
 * read when none is open.
 */
export function perfFrame(scopeId: string, rise: number, drawn: boolean) {
  const it = pendingPlateau;
  if (!it || !drawn || rise < 0.999 || scopeId !== it.id) return;
  Object.assign(it.detail, { rise: Math.round(rise * 1000) / 1000 });
  close(it, now(), "done");
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

function close(it: PerfInteraction, t1: number, status: "done" | "superseded") {
  const at = open.indexOf(it);
  if (at >= 0) open.splice(at, 1);
  if (pendingPlateau === it) pendingPlateau = null;
  it.t1 = t1;
  it.ms = Math.round((t1 - it.t0) * 10) / 10;
  it.status = status;
  attribute(it);
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
  if (status === "done") console.info(line(it));
}

/** What fell inside the interaction's window: spans, frames, tasks, requests. */
function attribute(it: PerfInteraction) {
  const t0 = it.t0;
  const t1 = it.t1 ?? now();
  for (const s of spans) {
    if (s.t0 < t0 - 1 || s.t0 > t1) continue;
    const a = (it.spans[s.name] ??= { n: 0, ms: 0, max: 0 });
    a.n++;
    a.ms += s.ms;
    a.max = Math.max(a.max, s.ms);
  }
  for (const k of Object.keys(it.spans)) {
    it.spans[k].ms = Math.round(it.spans[k].ms * 10) / 10;
    it.spans[k].max = Math.round(it.spans[k].max * 10) / 10;
  }
  const bySrc = new Map<string, number>();
  for (const f of frames) {
    // A frame that began a little before the act and ran into it counts.
    if (f.t0 + f.ms < t0 || f.t0 > t1) continue;
    it.frames.count++;
    it.frames.longest = Math.max(it.frames.longest, f.ms);
    it.frames.total += f.ms;
    for (const s of f.scripts) bySrc.set(s.src, (bySrc.get(s.src) ?? 0) + s.ms);
  }
  it.frames.longest = Math.round(it.frames.longest);
  it.frames.total = Math.round(it.frames.total);
  it.scripts = [...bySrc]
    .map(([src, ms]) => ({ src, ms: Math.round(ms) }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 8);
  for (const k of tasks) {
    if (k.t0 + k.ms < t0 || k.t0 > t1) continue;
    it.tasks.count++;
    it.tasks.longest = Math.max(it.tasks.longest, Math.round(k.ms));
  }
  for (const r of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
    const end = r.responseEnd || r.startTime + r.duration;
    if (end < t0 || r.startTime > t1) continue;
    const key = netKind(r.name);
    const a = (it.net[key] ??= { n: 0, ms: 0, kb: 0 });
    a.n++;
    a.ms += r.duration;
    a.kb += (r.transferSize || r.encodedBodySize || 0) / 1024;
  }
  for (const k of Object.keys(it.net)) {
    it.net[k].ms = Math.round(it.net[k].ms);
    it.net[k].kb = Math.round(it.net[k].kb);
  }
}

/** What a request fetched, from its URL. */
function netKind(url: string): string {
  if (/\/api\/dem\/[^/]+\/\d+\/\d+\/\d+/.test(url)) return "dem.tiles";
  if (/\/api\/dem\/?(\?|$)/.test(url)) return "dem.post";
  if (url.includes("/api/boundaries/departement/")) return "boundaries.departement";
  if (url.includes("/api/boundaries/communes")) return "boundaries.communes";
  if (url.includes("/api/boundaries/")) return "boundaries.levels";
  if (url.includes("/api/map")) return "api.map";
  if (url.includes("/api/")) return "api.other";
  if (/mapbox\.com/.test(url)) return "mapbox";
  if (/\.pmtiles(\?|$)/.test(url)) return "pmtiles";
  return "other";
}

const fmt = (ms: number) => `${Math.round(ms)} ms`;
/** The one console line per interaction. */
function line(it: PerfInteraction): string {
  const parts = [`[perf] ${it.kind} ${it.id}: ${fmt(it.ms ?? 0)}`];
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

/** The script's file, for blame: path without origin or query, mapbox-gl named as one. */
function scriptSrc(s: LoafScript): string {
  const u = s.sourceURL || s.invoker || "";
  if (!u) return "(unknown)";
  if (/mapbox-gl/.test(u)) return "mapbox-gl";
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
  if (open.length || t < rafUntil) rafId = requestAnimationFrame(rafTick);
  else rafId = 0;
}
function armRafFallback() {
  if (hasLoaf || hasLongTask) return;
  rafUntil = now() + 2000;
  if (!rafId) {
    rafLast = 0;
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
    /** Interactions ended, oldest first. */
    interactions: () => [...done],
    open: () => [...open],
    last: (kind?: PerfKind) => [...done].reverse().find((it) => !kind || it.kind === kind) ?? null,
    spans: () => [...spans],
    frames: () => ({
      count: frames.length,
      longest: Math.round(Math.max(0, ...frames.map((f) => f.ms))),
      total: Math.round(frames.reduce((a, f) => a + f.ms, 0)),
      entries: [...frames],
    }),
    table: () => console.table(done.map(summary)),
    /** Everything, as JSON (what a report pastes). */
    dump: () => ({
      ua: navigator.userAgent,
      dpr: window.devicePixelRatio,
      viewport: [window.innerWidth, window.innerHeight],
      frameSource,
      interactions: done,
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
