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
import {
  scrubText,
  scrubGdnRecord,
  EMAIL_PLACEHOLDER,
  PHONE_PLACEHOLDER,
  type ScrubStats,
} from "../src/lib/scrub.js";

describe("scrubText — emails", () => {
  it.each([
    "contact@mairie-exemple.fr",
    "jean.dupont+gdn@gmail.com",
    "prenom.nom@sous.domaine.asso.fr",
  ])("removes %s", (email) => {
    const out = scrubText(`Contact : ${email} pour s'inscrire.`);
    expect(out).not.toContain(email);
    expect(out).toContain(EMAIL_PLACEHOLDER);
  });
});

describe("scrubText — French phone numbers", () => {
  it.each([
    "0612345678",
    "06 12 34 56 78",
    "06.12.34.56.78",
    "06-12-34-56-78",
    "+33612345678",
    "+33 6 12 34 56 78",
    "01 42 76 40 40",
  ])("removes %s", (phone) => {
    const out = scrubText(`Inscription au ${phone} avant vendredi.`);
    expect(out).not.toContain(phone);
    expect(out).toContain(PHONE_PLACEHOLDER);
  });

  it("counts what it removes", () => {
    const stats: ScrubStats = { emails: 0, phones: 0 };
    scrubText("a@b.fr et c@d.fr, tel 0612345678", stats);
    expect(stats.emails).toBe(2);
    expect(stats.phones).toBe(1);
  });

  it("leaves ordinary text, dates and postcodes untouched", () => {
    const text =
      "Réunion le 15/01/2019 à 18h30, salle des fêtes, 45000 Orléans. 250 participants attendus.";
    expect(scrubText(text)).toBe(text);
  });

  it("does not eat digits inside longer numbers (SIRET…)", () => {
    const text = "SIRET 78467169500087 de l'association";
    expect(scrubText(text)).toBe(text);
  });
});

describe("scrubGdnRecord", () => {
  const record = {
    id: "ev-1",
    title: "Réunion citoyenne",
    body: "<p>Inscription : orga@example.org ou 06 12 34 56 78</p>",
    fullAddress: "12 rue de la République 69001 Lyon",
    authorId: "user-secret-123",
    authorType: "Citoyen / Citoyenne",
    authorZipCode: "69001",
    url: "https://granddebat.fr/events/ev-1",
  };

  it("scrubs free text but keeps address, url and zipcode intact", () => {
    const out = scrubGdnRecord(record);
    expect(out.body).not.toContain("orga@example.org");
    expect(out.body).not.toContain("06 12 34 56 78");
    expect(out.fullAddress).toBe(record.fullAddress);
    expect(out.url).toBe(record.url);
    expect(out.authorZipCode).toBe("69001");
  });

  it("drops authorId by default", () => {
    const out = scrubGdnRecord(record);
    expect(out).not.toHaveProperty("authorId");
    expect(out).not.toHaveProperty("author_ref");
  });

  it("replaces authorId with a stable keyed pseudonym when a secret is provided", () => {
    const a = scrubGdnRecord(record, { hmacSecret: "s3cret" });
    const b = scrubGdnRecord(record, { hmacSecret: "s3cret" });
    const other = scrubGdnRecord({ ...record, authorId: "user-other" }, { hmacSecret: "s3cret" });
    expect(a).not.toHaveProperty("authorId");
    expect(a.author_ref).toBe(b.author_ref);
    expect(a.author_ref).not.toBe(other.author_ref);
    expect(String(a.author_ref)).not.toContain("user-secret-123");
  });

  it("scrubs nested structures (cr-ril responses)", () => {
    const out = scrubGdnRecord({
      id: "cr-1",
      responses: [{ value: "Me joindre au 0612345678 ou toto@mail.fr" }],
    });
    const value = (out.responses as { value: string }[])[0].value;
    expect(value).toContain(PHONE_PLACEHOLDER);
    expect(value).toContain(EMAIL_PLACEHOLDER);
  });
});
