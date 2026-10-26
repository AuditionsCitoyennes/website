// What the parity harness found. Two kinds of difference are allowed, by the
// design's list of deliberate changes (docs/map-phase-1-design-2026-10-26.md
// A21), and listed; anything else fails:
//
//   D1  drafts' testimonies (and audition-less ones) leave N résultats and
//       the theme facet: the old corpus counted them;
//   D3  ties the old order left to the database (two lieux with the same
//       count and the same newest date, two auditions of the same date and
//       rank) are broken by lieu id, then audition id.

import { isDeepStrictEqual } from "node:util";

export type Kind = "D1" | "D3" | "fail";

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

  /**
   * One order: equal; or the same items, in an order that differs only among
   * items whose sort keys (`key`) are equal (D3); else a failure.
   */
  order(
    what: string,
    legacy: string[],
    server: string[],
    key: (id: string) => string,
    detail = "",
  ): void {
    this.checks++;
    if (isDeepStrictEqual(legacy, server)) return;
    const sameSet =
      legacy.length === server.length &&
      new Set(legacy).size === legacy.length &&
      isDeepStrictEqual([...legacy].sort(), [...server].sort());
    if (sameSet && legacy.every((id, i) => key(id) === key(server[i]))) {
      const swapped = legacy.filter((id, i) => id !== server[i]).sort();
      this.add("D3", `${what}: ties reordered (${swapped.join(" ↔ ")})`);
      return;
    }
    const missing = legacy.filter((id) => !server.includes(id));
    const extra = server.filter((id) => !legacy.includes(id));
    this.fail(
      `${what}${detail}: order differs — legacy [${legacy.join(", ")}] server [${server.join(", ")}]` +
        (missing.length ? `; missing ${missing.join(", ")}` : "") +
        (extra.length ? `; extra ${extra.join(", ")}` : ""),
    );
  }

  count(kind: Kind): number {
    return [...this.entries.values()].filter((e) => e.kind === kind).length;
  }

  /** Every difference, by kind, each with the cases it showed in. */
  print(log: (line: string) => void = console.log): void {
    for (const kind of ["D1", "D3", "fail"] as const) {
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
