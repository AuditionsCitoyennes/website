/*
 * Auditions Citoyennes — data ingestion pipeline
 * Copyright (C) 2026 Auditions Citoyennes
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or (at your
 * option) any later version. This program is distributed WITHOUT ANY WARRANTY;
 * see the GNU Affero General Public License for more details:
 * <https://www.gnu.org/licenses/>.
 */
import { describe, expect, it } from "vitest";
import { parseJsonObjectStream, type ParseFailure } from "../src/lib/gdnParser.js";

async function collect(lines: string[]) {
  const failures: ParseFailure[] = [];
  const values: unknown[] = [];
  for await (const parsed of parseJsonObjectStream(lines, (f) => failures.push(f))) {
    values.push(parsed.value);
  }
  return { values, failures };
}

describe("parseJsonObjectStream (tolerant GDN array parser)", () => {
  it("parses a well-formed one-object-per-line JSON array", async () => {
    const { values, failures } = await collect([
      "[",
      '{"id":"a","title":"Réunion 1"},',
      '{"id":"b","title":"Réunion 2"},',
      '{"id":"c","title":"Réunion 3"}',
      "]",
    ]);
    expect(failures).toHaveLength(0);
    expect(values).toEqual([
      { id: "a", title: "Réunion 1" },
      { id: "b", title: "Réunion 2" },
      { id: "c", title: "Réunion 3" },
    ]);
  });

  it("parses when the array framing shares lines with objects", async () => {
    const { values, failures } = await collect(['[{"id":"a"},', '{"id":"b"}]']);
    expect(failures).toHaveLength(0);
    expect(values).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("skips a malformed line and keeps parsing the rest of the file", async () => {
    const { values, failures } = await collect([
      "[",
      '{"id":"a","body":"ok"},',
      '{"id":"broken","body":"missing quote}, oops',
      '{"id":"b","body":"still ok"},',
      '{"id":"c","body":"fine"}',
      "]",
    ]);
    expect(failures.length).toBeGreaterThanOrEqual(1);
    const ids = values.map((v) => (v as { id: string }).id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("c");
    expect(ids).not.toContain("broken");
  });

  it("handles objects pretty-printed across several lines", async () => {
    const { values, failures } = await collect([
      "[",
      "{",
      '  "id": "a",',
      '  "nested": { "startAt": "2019-01-15 18:30:00" }',
      "},",
      '{"id":"b"}',
      "]",
    ]);
    expect(failures).toHaveLength(0);
    expect(values).toEqual([{ id: "a", nested: { startAt: "2019-01-15 18:30:00" } }, { id: "b" }]);
  });

  it("is not confused by braces and brackets inside strings", async () => {
    const { values, failures } = await collect([
      '{"id":"a","body":"un texte avec { des accolades } et [crochets] et \\"guillemets\\""}',
    ]);
    expect(failures).toHaveLength(0);
    expect(values).toEqual([
      { id: "a", body: 'un texte avec { des accolades } et [crochets] et "guillemets"' },
    ]);
  });

  it("reports an unterminated object at end of file as a failure", async () => {
    const { values, failures } = await collect(['{"id":"a"},', '{"id":"b","body":"tronqué']);
    expect(values).toEqual([{ id: "a" }]);
    expect(failures.length).toBeGreaterThanOrEqual(1);
  });
});
