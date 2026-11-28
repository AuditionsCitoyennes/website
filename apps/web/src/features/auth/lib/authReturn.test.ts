// What the site does with a return from Supabase Auth (authReturn.ts), run
// with `node --import tsx --test` (root "test:scripts"): the pages that read
// one, and each outcome with the calls it makes of the client — above all,
// that a signed-in account's session is replaced only when the visitor says so.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readAuthReturn, type AuthReturn } from "../../../shared/api/authPresence";
import {
  acceptsAuthReturn,
  isResetPage,
  settleAuthReturn,
  type Account,
  type ReturnDeps,
} from "./authReturn";

const ADMIN: Account = { id: "a1", email: "admin@example.org" };
const OTHER: Account = { id: "b2", email: "autre@example.org" };

const session = (type: string | null = null): AuthReturn => ({
  kind: "session",
  accessToken: "access-of-the-link",
  refreshToken: "refresh-of-the-link",
  type,
});

/** A client that records what is asked of it. */
function client(over: {
  current?: Account | null;
  linkAccount?: Account | null;
  answer?: boolean;
  stored?: Account | null;
  down?: boolean;
}) {
  const calls: string[] = [];
  const deps: ReturnDeps = {
    async current() {
      calls.push("current");
      return over.current ?? null;
    },
    async whoIs(accessToken) {
      calls.push(`whoIs ${accessToken}`);
      if (over.down) throw new Error("Auth cannot be reached");
      return over.linkAccount === undefined ? OTHER : over.linkAccount;
    },
    confirmSwitch(current, incoming) {
      calls.push(`confirm ${current.email} -> ${incoming.email}`);
      return over.answer ?? false;
    },
    async leave() {
      calls.push("leave");
    },
    async store(accessToken, refreshToken) {
      calls.push(`store ${accessToken} ${refreshToken}`);
      return over.stored === undefined ? (over.linkAccount ?? OTHER) : over.stored;
    },
  };
  return { deps, calls };
}

test("a return is read on the admin, sign-in and password pages, and nowhere else", () => {
  for (const path of ["/admin", "/auth", "/reset-password", "/admin/", "/reset-password//"]) {
    assert.ok(acceptsAuthReturn(path), path);
  }
  for (const path of [
    "/",
    "/temoignages",
    "/audition/3f0c8a52-6f0e-4d5b-9a45-0c6d1c2e7b11",
    "/verifier/abc",
    "/admin/double-authentification",
    "/administration",
    "/soutenir",
    "/n-importe-quoi",
  ]) {
    assert.ok(!acceptsAuthReturn(path), path);
  }
  assert.ok(isResetPage("/reset-password"));
  assert.ok(isResetPage("/reset-password/"));
  assert.ok(!isResetPage("/admin"));
});

test("a session landing elsewhere is taken out of the address and never reaches the client", () => {
  // What main.ts does: the address is read and cleaned on every page, the
  // return settled only where acceptsAuthReturn says so.
  const hash = "#access_token=aaa&refresh_token=rrr&provider_token=ppp&type=recovery";
  for (const path of ["/", "/temoignages", "/verifier/abc"]) {
    const read = readAuthReturn("", hash);
    assert.equal(read.ret?.kind, "session");
    assert.equal(`${path}${read.search}${read.hash}`, path);
    assert.ok(!acceptsAuthReturn(path));
  }
});

test("nobody signed in: the link's session is kept, with what the link was for", async () => {
  const { deps, calls } = client({ current: null, linkAccount: OTHER });
  assert.deepEqual(await settleAuthReturn(session("signup"), deps), {
    outcome: "signed-in",
    account: OTHER,
    type: "signup",
  });
  // Auth is not asked who the link is: there is no session to protect.
  assert.deepEqual(calls, ["current", "store access-of-the-link refresh-of-the-link"]);
});

test("the same account signed in: its session is renewed without a question", async () => {
  const { deps, calls } = client({ current: ADMIN, linkAccount: ADMIN });
  assert.deepEqual(await settleAuthReturn(session("email_change"), deps), {
    outcome: "signed-in",
    account: ADMIN,
    type: "email_change",
  });
  assert.deepEqual(calls, [
    "current",
    "whoIs access-of-the-link",
    "store access-of-the-link refresh-of-the-link",
  ]);
});

test("another account signed in, the visitor declines: nothing is touched", async () => {
  const { deps, calls } = client({ current: ADMIN, linkAccount: OTHER, answer: false });
  assert.deepEqual(await settleAuthReturn(session("recovery"), deps), {
    outcome: "kept",
    account: ADMIN,
  });
  assert.deepEqual(calls, [
    "current",
    "whoIs access-of-the-link",
    "confirm admin@example.org -> autre@example.org",
  ]);
});

test("another account signed in, the visitor accepts: the first is left, then the link's is kept", async () => {
  const { deps, calls } = client({ current: ADMIN, linkAccount: OTHER, answer: true });
  assert.deepEqual(await settleAuthReturn(session("recovery"), deps), {
    outcome: "signed-in",
    account: OTHER,
    type: "recovery",
  });
  assert.deepEqual(calls, [
    "current",
    "whoIs access-of-the-link",
    "confirm admin@example.org -> autre@example.org",
    "leave",
    "store access-of-the-link refresh-of-the-link",
  ]);
});

test("tokens Auth does not know leave a signed-in session as it is", async () => {
  const { deps, calls } = client({ current: ADMIN, linkAccount: null });
  assert.deepEqual(await settleAuthReturn(session(), deps), { outcome: "refused" });
  assert.deepEqual(calls, ["current", "whoIs access-of-the-link"]);
});

test("tokens Auth refuses, nobody signed in: refused", async () => {
  const { deps } = client({ current: null, stored: null });
  assert.deepEqual(await settleAuthReturn(session(), deps), { outcome: "refused" });
});

test("Auth cannot be asked: the signed-in session stays, nothing is stored", async () => {
  const { deps, calls } = client({ current: ADMIN, down: true });
  assert.deepEqual(await settleAuthReturn(session(), deps), { outcome: "unreachable" });
  assert.deepEqual(calls, ["current", "whoIs access-of-the-link"]);
});

test("a refusal, a notice and unused parameters ask nothing of the client", async () => {
  const { deps, calls } = client({ current: ADMIN });
  assert.deepEqual(await settleAuthReturn({ kind: "error", code: "otp_expired" }, deps), {
    outcome: "refused",
  });
  assert.deepEqual(await settleAuthReturn({ kind: "notice" }, deps), { outcome: "notice" });
  assert.deepEqual(await settleAuthReturn({ kind: "unused" }, deps), { outcome: "nothing" });
  assert.deepEqual(calls, []);
});
