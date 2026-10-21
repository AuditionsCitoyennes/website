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
import { NormalizedEventSchema, toGeoJsonFeature } from "../src/lib/schema.js";

const validEvent = {
  source: "gdn",
  source_id: "12345",
  title: "Réunion locale — Grand Débat",
  description_text: "Débat sur la transition écologique.",
  start_at: "2019-01-15T18:30:00+01:00",
  end_at: "2019-01-15T21:00:00+01:00",
  address_raw: "Salle des fêtes, 12 rue de la République 69001 Lyon",
  street: "12 Rue de la République",
  postcode: "69001",
  city: "Lyon",
  country_code: "FR",
  lat: 45.767,
  lng: 4.834,
  geocode_precision: "housenumber",
  url: "https://granddebat.fr/events/12345",
  license: "Licence Ouverte 2.0",
  attribution: "Source : Données ouvertes du Grand Débat National — extraction du 2026-07-07.",
  retrieved_at: "2026-07-07T10:00:00.000Z",
};

describe("NormalizedEventSchema", () => {
  it("accepts a fully populated row", () => {
    expect(NormalizedEventSchema.safeParse(validEvent).success).toBe(true);
  });

  it("accepts nullable fields and reduced-precision dates (year-only sources)", () => {
    const sparse = {
      ...validEvent,
      description_text: null,
      start_at: "2019",
      end_at: null,
      address_raw: null,
      street: null,
      postcode: null,
      city: null,
      country_code: null,
      lat: null,
      lng: null,
      geocode_precision: "unknown",
      url: null,
    };
    expect(NormalizedEventSchema.safeParse(sparse).success).toBe(true);
  });

  it.each([
    ["lat out of range", { lat: 91 }],
    ["lng out of range", { lng: -181 }],
    ["bad precision", { geocode_precision: "exact" }],
    ["datetime without offset", { start_at: "2019-01-15T18:30:00" }],
    ["not a datetime", { start_at: "15/01/2019" }],
    ["lowercase country code", { country_code: "fr" }],
    ["empty title", { title: "" }],
    ["missing license", { license: "" }],
  ])("rejects %s", (_label, patch) => {
    expect(NormalizedEventSchema.safeParse({ ...validEvent, ...patch }).success).toBe(false);
  });
});

describe("toGeoJsonFeature", () => {
  it("builds a Point feature with [lng, lat] order", () => {
    const feature = toGeoJsonFeature(NormalizedEventSchema.parse(validEvent)) as {
      geometry: { coordinates: [number, number] };
      properties: Record<string, unknown>;
    };
    expect(feature.geometry.coordinates).toEqual([4.834, 45.767]);
    expect(feature.properties.title).toBe(validEvent.title);
    expect(feature.properties).not.toHaveProperty("lat");
  });

  it("returns null when coordinates are missing", () => {
    const noCoords = NormalizedEventSchema.parse({ ...validEvent, lat: null, lng: null });
    expect(toGeoJsonFeature(noCoords)).toBeNull();
  });
});
