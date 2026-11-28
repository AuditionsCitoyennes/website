// Whether a session owes its second factor (secondFactor.ts), and the token
// claims it reads (tokenClaims.ts), run with `node --import tsx --test` (root
// "test:scripts").

import assert from "node:assert/strict";
import { test } from "node:test";
import { owesSecondFactor } from "./secondFactor";
import { tokenClaims } from "./tokenClaims";

/** An access token as Auth shapes one (unsigned: the site never checks it). */
const token = (claims: unknown) =>
  `${Buffer.from('{"alg":"ES256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;

const factor = (status: string) => ({ id: "f1", factor_type: "totp", status });
const session = (aal: string | undefined, factors?: { status: string }[] | null) => ({
  access_token: token({ sub: "u1", aal }),
  user: { factors },
});

test("a confirmed factor is owed until the session's token says the second level", () => {
  assert.equal(owesSecondFactor(session("aal1", [factor("verified")])), true);
  assert.equal(owesSecondFactor(session("aal2", [factor("verified")])), false);
  assert.equal(owesSecondFactor(session(undefined, [factor("verified")])), true);
});

test("nothing is owed without a confirmed factor, or without a session", () => {
  assert.equal(owesSecondFactor(null), false);
  assert.equal(owesSecondFactor(undefined), false);
  assert.equal(owesSecondFactor(session("aal1")), false);
  assert.equal(owesSecondFactor(session("aal1", null)), false);
  assert.equal(owesSecondFactor(session("aal1", [])), false);
  assert.equal(owesSecondFactor(session("aal1", [factor("unverified")])), false);
});

test("one confirmed factor among several is enough", () => {
  assert.equal(owesSecondFactor(session("aal1", [factor("unverified"), factor("verified")])), true);
});

test("a token that cannot be read counts as the first level", () => {
  const unreadable = { access_token: "not-a-token", user: { factors: [factor("verified")] } };
  assert.equal(owesSecondFactor(unreadable), true);
  assert.equal(owesSecondFactor({ ...unreadable, user: { factors: [] } }), false);
});

test("the claims of a token: its middle part, whatever its padding and alphabet", () => {
  assert.deepEqual(tokenClaims(token({ aal: "aal2", amr: [{ method: "totp" }] })), {
    aal: "aal2",
    amr: [{ method: "totp" }],
  });
  // Payloads of every length modulo 4, and characters whose base64url form
  // uses « - » and « _ ».
  for (const email of ["a@b.fr", "ab@b.fr", "abc@b.fr", "abcd@b.fr", "ÿþ?>~@b.fr"]) {
    assert.equal(tokenClaims(token({ email, aal: "aal1" }))?.aal, "aal1");
  }
});

test("no claims for anything that is not a token", () => {
  for (const not of [
    null,
    undefined,
    "",
    "abc",
    "a.b.c",
    "a..c",
    token("text"),
    token([1]),
    token(null),
  ]) {
    assert.equal(tokenClaims(not), null);
  }
});
