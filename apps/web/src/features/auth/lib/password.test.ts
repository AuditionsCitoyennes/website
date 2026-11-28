// The rule for a new password (password.ts), run with `node --import tsx
// --test` (root "test:scripts"): the schema the forms check with and the
// checklist they show say the same thing.

import assert from "node:assert/strict";
import { test } from "node:test";
import { PASSWORD_MIN_LENGTH, PASSWORD_REQUIREMENTS, passwordSchema } from "./password";

const accepted = (p: string) => passwordSchema.safeParse(p).success;
const listed = (p: string) => PASSWORD_REQUIREMENTS.every((r) => r.test(p));

test("twelve characters at least, with a lower case, an upper case and a digit", () => {
  assert.equal(PASSWORD_MIN_LENGTH, 12);
  assert.ok(accepted("Abcdefghijk1"));
  assert.ok(accepted("Un-mot-de-passe-long-2026"));
  for (const refused of [
    "",
    "Abcdefg1",
    "Abcdefghij1",
    "abcdefghijk1",
    "ABCDEFGHIJK1",
    "Abcdefghijkl",
  ]) {
    assert.ok(!accepted(refused), refused);
  }
});

test("the first message names the length", () => {
  const result = passwordSchema.safeParse("Abc1");
  assert.ok(!result.success);
  assert.equal(
    result.error.issues[0].message,
    "Le mot de passe doit contenir au moins 12 caractères",
  );
});

test("72 bytes at most: an accented letter counts for two", () => {
  assert.ok(accepted("A1" + "a".repeat(70)));
  assert.ok(!accepted("A1" + "a".repeat(71)));
  assert.ok(accepted("Aa1" + "é".repeat(34)));
  assert.ok(!accepted("Aa1" + "é".repeat(35)));
});

test("the checklist under the field agrees with the schema", () => {
  assert.match(PASSWORD_REQUIREMENTS[0].label, /12 caractères/);
  for (const p of [
    "Abcdefghijk1",
    "Abcdefghij1",
    "abcdefghijk1",
    "ABCDEFGHIJK1",
    "Abcdefghijkl",
    "",
  ]) {
    assert.equal(listed(p), accepted(p), p);
  }
});
