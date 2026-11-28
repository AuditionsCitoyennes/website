// What the site knows of a signed-in account before the Supabase client is
// there (authPresence.ts), run with `node --import tsx --test` (root
// "test:scripts"): supabase-js's storage keys and nothing else; the returns of
// Supabase Auth (email links, Google, a code, errors) read out of an address,
// and no ordinary address touched.

import assert from "node:assert/strict";
import { test } from "node:test";
import { isAuthStorageKey, mayHaveSession, readAuthReturn } from "./authPresence";

test("supabase-js's session and PKCE keys, and no other key", () => {
  for (const k of [
    "sb-papnqtvugzqtllcwigfi-auth-token",
    "sb-127-auth-token",
    "sb-localhost-auth-token",
    "sb-127-auth-token-code-verifier",
  ]) {
    assert.ok(isAuthStorageKey(k), k);
  }
  for (const k of [
    "",
    null,
    undefined,
    "sb-auth-token",
    "ac:glass",
    "ac:tier-measured",
    "sb--auth-token",
    "sb-127-auth-token-x",
    "xsb-127-auth-token",
    "theme",
  ]) {
    assert.ok(!isAuthStorageKey(k), String(k));
  }
});

test("a session may exist with a kept key, whatever the address", () => {
  assert.ok(!mayHaveSession([]));
  assert.ok(!mayHaveSession(["ac:glass", "theme"]));
  assert.ok(mayHaveSession(["theme", "sb-127-auth-token"]));
  assert.ok(mayHaveSession(new Set(["sb-x-auth-token-code-verifier"])));
});

test("a session in the fragment: its two tokens and what the link was for", () => {
  // An email link (sign-up confirmation, recovery, email change).
  assert.deepEqual(
    readAuthReturn(
      "",
      "#access_token=aaa&expires_at=1&expires_in=3600&refresh_token=rrr&sb=&token_type=bearer&type=recovery",
    ),
    {
      ret: { kind: "session", accessToken: "aaa", refreshToken: "rrr", type: "recovery" },
      search: "",
      hash: "",
    },
  );
  // A provider sign-in: no type, and the provider's own tokens are not read.
  const google = readAuthReturn(
    "",
    "#access_token=aaa&provider_token=ppp&provider_refresh_token=qqq&refresh_token=rrr&token_type=bearer",
  );
  assert.deepEqual(google.ret, {
    kind: "session",
    accessToken: "aaa",
    refreshToken: "rrr",
    type: null,
  });
  assert.equal(JSON.stringify(google).includes("ppp"), false);
  assert.equal(JSON.stringify(google).includes("qqq"), false);
  assert.equal(google.hash, "");
});

test("a session is never read from the query, and half a session is none", () => {
  for (const [search, hash] of [
    ["?access_token=aaa&refresh_token=rrr&type=recovery", ""],
    ["", "#access_token=aaa&type=magiclink"],
    ["", "#refresh_token=rrr"],
    ["", "#provider_token=ppp"],
    ["?access_token=aaa", "#refresh_token=rrr"],
  ]) {
    const read = readAuthReturn(search, hash);
    assert.deepEqual(read.ret, { kind: "unused" }, `${search}${hash}`);
    assert.equal(read.search, "", `${search}${hash}`);
    assert.equal(read.hash, "", `${search}${hash}`);
  }
});

test("a refusal, in the fragment or the query, with Auth's code when it gives one", () => {
  assert.deepEqual(
    readAuthReturn(
      "",
      "#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid",
    ),
    { ret: { kind: "error", code: "otp_expired" }, search: "", hash: "" },
  );
  // A provider sign-in that did not complete: Auth says it in both places.
  assert.deepEqual(
    readAuthReturn(
      "?error=server_error&error_code=unexpected_failure&error_description=x",
      "#error=server_error&error_code=unexpected_failure&error_description=x",
    ),
    { ret: { kind: "error", code: "unexpected_failure" }, search: "", hash: "" },
  );
  assert.deepEqual(readAuthReturn("?error=access_denied&error_description=x", "").ret, {
    kind: "error",
    code: "access_denied",
  });
});

test("the first of an email change's two confirmations is a notice", () => {
  assert.deepEqual(
    readAuthReturn("", "#message=Confirmation+link+accepted.+Please+proceed&sb=").ret,
    { kind: "notice" },
  );
});

test("a code or a token hash is taken out and not used; the page's own query stays", () => {
  assert.deepEqual(readAuthReturn("?code=abc", ""), {
    ret: { kind: "unused" },
    search: "",
    hash: "",
  });
  assert.deepEqual(readAuthReturn("?tab=inscription&code=abc&type=signup", "#contenu"), {
    ret: { kind: "unused" },
    search: "?tab=inscription",
    hash: "#contenu",
  });
  assert.deepEqual(readAuthReturn("?token_hash=abc&type=recovery&analyses=1", ""), {
    ret: { kind: "unused" },
    search: "?analyses=1",
    hash: "",
  });
});

test("an ordinary address is no return and is left as it is", () => {
  for (const [search, hash] of [
    ["", ""],
    ["?analyses=1", ""],
    ["?tab=inscription", ""],
    ["", "#auditions-publiques"],
    ["", "#"],
    ["?q=code&type=x", "#type"],
    ["?error=1", "#error"],
  ]) {
    assert.deepEqual(readAuthReturn(search, hash), { ret: null, search, hash }, `${search}${hash}`);
  }
});
