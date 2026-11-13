// When the Supabase client is downloaded (authPresence.ts, authClientSwitch.ts),
// run with `node --import tsx --test` (root "test:scripts"): supabase-js's
// storage keys and nothing else, the returns of Supabase Auth (email links,
// Google, PKCE, errors) and no ordinary address, then the switch's default
// and its read.

import assert from "node:assert/strict";
import { test } from "node:test";
import { isAuthReturn, isAuthStorageKey, mayHaveSession } from "./authPresence";

const g = globalThis as unknown as { __TEST_TOOLS__: boolean; localStorage?: unknown };
g.__TEST_TOOLS__ = false;
const sw = await import("./authClientSwitch");

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

test("the returns of Supabase Auth, in the fragment or the query", () => {
  // Implicit flow: sign-up confirmation, magic link, Google, password recovery.
  assert.ok(isAuthReturn("", "#access_token=x&expires_in=3600&refresh_token=y&type=signup"));
  assert.ok(isAuthReturn("", "#access_token=x&refresh_token=y&type=recovery"));
  assert.ok(isAuthReturn("", "#access_token=x&type=magiclink"));
  // An expired or used link.
  assert.ok(
    isAuthReturn("", "#error=access_denied&error_code=otp_expired&error_description=Email+link"),
  );
  assert.ok(isAuthReturn("?error=server_error&error_description=x", ""));
  // PKCE and verify-by-token.
  assert.ok(isAuthReturn("?code=abc", ""));
  assert.ok(isAuthReturn("?token_hash=abc&type=recovery", ""));
});

test("an ordinary address is no return", () => {
  for (const [search, hash] of [
    ["", ""],
    ["?analyses=1", ""],
    ["?tab=signup", ""],
    ["", "#contenu"],
    ["", "#"],
    ["?q=code", "#type"],
  ]) {
    assert.ok(!isAuthReturn(search, hash), `${search}${hash}`);
  }
});

test("a session may exist with a kept key or with a return, not otherwise", () => {
  assert.ok(!mayHaveSession([], "", ""));
  assert.ok(!mayHaveSession(["ac:glass", "theme"], "?analyses=1", ""));
  assert.ok(mayHaveSession(["theme", "sb-127-auth-token"], "", ""));
  assert.ok(mayHaveSession(new Set(["sb-x-auth-token-code-verifier"]), "", ""));
  assert.ok(mayHaveSession([], "", "#access_token=x&type=recovery"));
});

test("the switch: « demande » by default, read only with the testing tools", () => {
  assert.equal(sw.DEFAULT_AUTH_CLIENT, "demande");
  assert.deepEqual([...sw.AUTH_CLIENTS], ["demande", "demarrage"]);
  assert.equal(sw.authClient, "demande");
  const store = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => store.get(k) ?? null };
  try {
    assert.equal(sw.storedAuthClient(), "demande");
    store.set("ac:auth-client", "demarrage");
    assert.equal(sw.storedAuthClient(), "demarrage");
    store.set("ac:auth-client", "boot");
    assert.equal(sw.storedAuthClient(), "demande");
  } finally {
    delete g.localStorage;
  }
});
