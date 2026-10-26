// What the parity harness found. Two kinds of difference are allowed, by the
// design's list of deliberate changes (docs/map-phase-1-design-2026-10-26.md
// A21), and listed; anything else fails:
//
//   D1   drafts' testimonies (and audition-less ones) leave N résultats and
//        the theme facet: the old corpus counted them;
//   D14  a row the old app inserted or moved (place_stale) is read at its
//        stored place until the placement job's next pass, where /api/map
//        files it by its name at once.
//
// Orders have no allowance: the RPCs reproduce today's ties (A18), so any
// reorder fails.

import { isDeepStrictEqual } from "node:util";

export type Kind = "D1" | "D14" | "fail";

interface Entry {
  kind: Kind;
  what: string;
  cases: string[];
}

export class Report {
  private entries = new Map<string, Entry>();
  checks = 0;
  /** The filter case being compared (named in every entry). */
  current = "";

  add(kind: Kind, what: string): void {
    const key = `${kind}\u0000${what}`;
    const e = this.entries.get(key);
    if (e) {
      if (!e.cases.includes(this.current)) e.cases.push(this.current);
    } else this.entries.set(key, { kind, what, cases: [this.current] });
  }

  fail(what: string): void {
    this.add("fail", what);
  }

  /** One value: equal, or a failure showing both. */
  eq(what: string, legacy: unknown, server: unknown): boolean {
    this.checks++;
    if (isDeepStrictEqual(legacy, server)) return true;
    this.fail(`${what}: legacy ${show(legacy)} ≠ server ${show(server)}`);
    return false;
  }

  /** One order: the same ids in the same order, else a failure naming what moved. */
  order(what: string, legacy: string[], server: string[]): boolean {
    this.checks++;
    if (isDeepStrictEqual(legacy, server)) return true;
    const missing = legacy.filter((id) => !server.includes(id));
    const extra = server.filter((id) => !legacy.includes(id));
    const first = legacy.findIndex((id, i) => id !== server[i]);
    const at = first < 0 ? legacy.length : first;
    this.fail(
      `${what}: order differs from #${at} — legacy [${legacy.join(", ")}] server [${server.join(", ")}]` +
        (missing.length ? `; missing ${missing.join(", ")}` : "") +
        (extra.length ? `; extra ${extra.join(", ")}` : ""),
    );
    return false;
  }

  count(kind: Kind): number {
    return [...this.entries.values()].filter((e) => e.kind === kind).length;
  }

  /** Every difference, by kind, each with the cases it showed in. */
  print(log: (line: string) => void = console.log): void {
    for (const kind of ["D1", "D14", "fail"] as const) {
      const list = [...this.entries.values()].filter((e) => e.kind === kind);
      if (!list.length) continue;
      log(
        kind === "fail"
          ? `\nUnexpected differences (${list.length}):`
          : `\nAllowed differences, ${kind} (${list.length}):`,
      );
      for (const e of list) {
        const cases =
          e.cases.length > 3
            ? `${e.cases.slice(0, 3).join(", ")} +${e.cases.length - 3}`
            : e.cases.join(", ");
        log(`  [${kind}] ${e.what}   (${cases})`);
      }
    }
  }

  toJSON() {
    return { checks: this.checks, differences: [...this.entries.values()] };
  }
}

function show(v: unknown): string {
  const s = JSON.stringify(v, (_k, x) => (x instanceof Int32Array ? [...x] : x));
  return s === undefined ? String(v) : s.length > 400 ? `${s.slice(0, 400)}…` : s;
}
