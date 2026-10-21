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
import { parisLocalToIso, looseDateOrNull } from "../src/lib/time.js";

describe("parisLocalToIso", () => {
  it("interprets GDN local datetimes as Europe/Paris (winter, +01:00)", () => {
    expect(parisLocalToIso("2019-01-15 18:30:00")).toBe("2019-01-15T18:30:00.000+01:00");
  });

  it("handles summer time (+02:00)", () => {
    expect(parisLocalToIso("2019-07-15 18:30:00")).toBe("2019-07-15T18:30:00.000+02:00");
  });

  it("returns null for empty or malformed input", () => {
    expect(parisLocalToIso(null)).toBeNull();
    expect(parisLocalToIso("")).toBeNull();
    expect(parisLocalToIso("pas une date")).toBeNull();
  });
});

describe("looseDateOrNull", () => {
  it("keeps the declared precision", () => {
    expect(looseDateOrNull("2019")).toBe("2019");
    expect(looseDateOrNull("2019-03")).toBe("2019-03");
    expect(looseDateOrNull("2019-03-21")).toBe("2019-03-21");
  });

  it("returns null for junk", () => {
    expect(looseDateOrNull("printemps 2019")).toBeNull();
    expect(looseDateOrNull(null)).toBeNull();
  });
});
