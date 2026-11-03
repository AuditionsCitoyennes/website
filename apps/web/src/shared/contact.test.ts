// The prefilled emails of the legal pages and the « Signaler » links
// (contact.ts). Run with `node --import tsx --test` (root "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTACT_EMAIL, mailto, reportHref } from "./contact";

/** The subject and body a mail client reads from a `mailto:` link. */
function read(href: string) {
  const url = new URL(href);
  return {
    to: url.pathname,
    subject: url.searchParams.get("subject"),
    body: url.searchParams.get("body"),
  };
}

test("mailto encodes accents, spaces and line breaks", () => {
  const mail = read(mailto("a@b.fr", "Droit de réponse", "Ligne 1\nLigne 2 & suite"));
  assert.equal(mail.to, "a@b.fr");
  assert.equal(mail.subject, "Droit de réponse");
  assert.equal(mail.body, "Ligne 1\nLigne 2 & suite");
});

test("mailto without a body has no body parameter", () => {
  assert.ok(!mailto("a@b.fr", "Sujet").includes("body="));
});

test("a report names the testimony and the page it was seen on", () => {
  const mail = read(
    reportHref({ id: "t-42", person_name: "Anonyme" }, "https://example.org/audition/a-7"),
  );
  assert.equal(mail.to, CONTACT_EMAIL);
  assert.equal(mail.subject, "Signalement d'un témoignage");
  assert.match(mail.body ?? "", /Anonyme \(n° t-42\)/);
  assert.match(mail.body ?? "", /Page : https:\/\/example\.org\/audition\/a-7/);
});
