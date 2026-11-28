// The API client's refusals (client.ts), run with `node --import tsx --test`
// (root "test:scripts"): what an answer's refusal carries (text, status, wait,
// code), and the paths that are not sent because the browser would ask for
// another one than the page wrote.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, apiFetch, isSendablePath, onSecondFactorWanted, refusalFrom } from "./client";

const ID = "3f0c8a52-6f0e-4d5b-9a45-0c6d1c2e7b11";

const answer = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    statusText: "Reason",
    headers,
  });

test("a refusal carries the body's text, its code, the status and the wait asked", async () => {
  const refusal = await refusalFrom(
    answer(
      401,
      {
        statusCode: 401,
        error: "Unauthorized",
        message: "Reconnectez-vous",
        code: "recent_sign_in_required",
      },
      { "Retry-After": "12" },
    ),
  );
  assert.ok(refusal instanceof ApiError);
  assert.equal(refusal.message, "Reconnectez-vous");
  assert.equal(refusal.status, 401);
  assert.equal(refusal.code, "recent_sign_in_required");
  assert.equal(refusal.retryAfter, 12);
});

test("a refusal without a code, with a hand-rolled body, or with no readable body", async () => {
  assert.equal((await refusalFrom(answer(404, { message: "Introuvable" }))).code, null);
  assert.equal(
    (await refusalFrom(answer(400, { error: "Jeton invalide" }))).message,
    "Jeton invalide",
  );
  assert.equal((await refusalFrom(answer(502, "<html>"))).message, "Reason");
  assert.equal((await refusalFrom(answer(500, "null"))).message, "Reason");
  // Only a string is a text or a code.
  const odd = await refusalFrom(answer(403, { message: { a: 1 }, code: 42 }));
  assert.equal(odd.message, "Reason");
  assert.equal(odd.code, null);
});

test("`mfa_required` tells the listener; no other refusal does", async () => {
  let told = 0;
  onSecondFactorWanted(() => told++);
  try {
    await refusalFrom(answer(403, { message: "Accès réservé", code: "forbidden" }));
    await refusalFrom(answer(403, { message: "Accès réservé" }));
    assert.equal(told, 0);
    const refusal = await refusalFrom(
      answer(403, { message: "Second facteur", code: "mfa_required" }),
    );
    assert.equal(refusal.code, "mfa_required");
    assert.equal(told, 1);
  } finally {
    onSecondFactorWanted(null);
  }
});

test("the paths the pages build are sent", () => {
  for (const path of [
    "/api/me",
    "/api/auditions/admin/list",
    `/api/auditions/${ID}`,
    `/api/admin/auditions/${ID}`,
    `/api/testimonies/${ID}/analyze`,
    `/api/verify/${ID}`,
    "/api/places?unit=FR&q=Saint-Pierre%2Fet%20Miquelon&themes=a%3Fb",
    "/api/places/lieu?unit=69123&filters=%7B%22q%22%3A%22..%2F..%22%7D",
    "/api/outbox/12",
  ]) {
    assert.ok(isSendablePath(path), path);
  }
});

test("a path the browser would read as another one is not sendable", () => {
  for (const path of [
    // Dot segments, written plainly or encoded, anywhere in the path.
    `/api/admin/auditions/../../auditions/${ID}?x`,
    "/api/verify/../health?x=1",
    "/api/verify/..",
    "/api/verify/.",
    "/api/verify/%2e%2e/health",
    "/api/verify/.%2E/health",
    "/api/auditions/./admin/list",
    // A backslash is a slash to a browser; an encoded slash, to some servers.
    "/api/verify/..\\health",
    "/api/verify/a%5Cb",
    "/api/verify/..%2Fhealth",
    "/api/verify/a%2fb",
    // Another host, an empty identifier, a fragment.
    "//127.0.0.1:4079/x",
    "/api/admin/auditions/..//127.0.0.1:4079/x?y",
    "/api/auditions/",
    "/api/auditions//testimonies",
    `/api/auditions/${ID}#x`,
    `/api/auditions/${ID}?a=1#x`,
    // Characters a browser drops or cannot read.
    "/api/verify/.\t./health",
    "/api/verify/.\n./health",
    "/api/verify/%zz",
    "/api/verify/abc ",
    "api/me",
    "",
  ]) {
    assert.ok(!isSendablePath(path), JSON.stringify(path));
  }
});

test("such a path is refused before anything is sent", async () => {
  const realFetch = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = (() => {
    sent++;
    return Promise.reject(new Error("no request expected"));
  }) as typeof fetch;
  try {
    for (const method of ["GET", "POST", "DELETE"]) {
      await assert.rejects(
        apiFetch(`/api/admin/auditions/../../auditions/${ID}?x`, { method, auth: true }),
        (e: unknown) => e instanceof ApiError && e.status === 400 && e.code === null,
      );
    }
    assert.equal(sent, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
