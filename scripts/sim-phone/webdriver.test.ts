// The WebDriver client against a recording fake fetch: what it sends, how it
// reads W3C answers and errors, and that a session is always deleted, once.
// No network, no simulator.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ELEMENT_KEY,
  newSession,
  SIM_CAPS,
  WebDriverError,
  withSession,
  type Fetch,
} from "./webdriver";

const DRIVER = "http://127.0.0.1:4445";

interface Sent {
  method: string;
  url: string;
  body: unknown;
}

/** A fake driver: `reply` maps a request to [status, value]; every request is recorded. */
function fakeDriver(reply: (r: Sent) => [number, unknown] | undefined = () => undefined) {
  const sent: Sent[] = [];
  const f: Fetch = async (url, init) => {
    const r: Sent = {
      method: init?.method ?? "GET",
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    sent.push(r);
    const own = reply(r);
    if (own) return new Response(JSON.stringify({ value: own[1] }), { status: own[0] });
    if (r.method === "POST" && r.url === `${DRIVER}/session`)
      return new Response(
        JSON.stringify({ value: { sessionId: "s1", capabilities: { browserName: "Safari" } } }),
      );
    return new Response(JSON.stringify({ value: null }));
  };
  return { f, sent };
}

test("newSession posts exactly the simulator capabilities as alwaysMatch", async () => {
  const { f, sent } = fakeDriver();
  const s = await newSession(DRIVER, SIM_CAPS, f);
  assert.equal(s.id, "s1");
  assert.deepEqual(s.capabilities, { browserName: "Safari" });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "POST");
  assert.equal(sent[0].url, `${DRIVER}/session`);
  assert.deepEqual(sent[0].body, {
    capabilities: {
      alwaysMatch: {
        browserName: "Safari",
        platformName: "iOS",
        "safari:useSimulator": true,
        "safari:deviceType": "iPhone",
      },
    },
  });
});

test("execute and executeAsync hit the sync and async endpoints with {script, args}", async () => {
  const { f, sent } = fakeDriver((r) =>
    r.url.endsWith("/execute/sync") ? [200, { error: "a script's own value" }] : undefined,
  );
  const s = await newSession(DRIVER, SIM_CAPS, f);
  // A 200 answer is a value, even one with an `error` field.
  assert.deepEqual(await s.execute("return 1", [2]), { error: "a script's own value" });
  await s.executeAsync("arguments[0](1)");
  assert.equal(sent[1].url, `${DRIVER}/session/s1/execute/sync`);
  assert.deepEqual(sent[1].body, { script: "return 1", args: [2] });
  assert.equal(sent[2].url, `${DRIVER}/session/s1/execute/async`);
  assert.deepEqual(sent[2].body, { script: "arguments[0](1)", args: [] });
});

test("findAll maps the W3C element key", async () => {
  const { f, sent } = fakeDriver((r) =>
    r.url.endsWith("/elements")
      ? [200, [{ [ELEMENT_KEY]: "e1" }, { [ELEMENT_KEY]: "e2" }]]
      : undefined,
  );
  const s = await newSession(DRIVER, SIM_CAPS, f);
  assert.deepEqual(await s.findAll(".unit-row"), ["e1", "e2"]);
  assert.deepEqual(sent[1].body, { using: "css selector", value: ".unit-row" });
  await s.click("e2");
  assert.equal(sent[2].url, `${DRIVER}/session/s1/element/e2/click`);
});

test("a W3C error body throws WebDriverError with its error, message and status", async () => {
  const { f } = fakeDriver((r) =>
    r.url.endsWith("/click") ? [404, { error: "no such element", message: "gone" }] : undefined,
  );
  const s = await newSession(DRIVER, SIM_CAPS, f);
  await assert.rejects(s.click("e9"), (e: unknown) => {
    assert.ok(e instanceof WebDriverError);
    assert.equal(e.error, "no such element");
    assert.equal(e.message, "no such element: gone");
    assert.equal(e.status, 404);
    return true;
  });
});

test("withSession deletes the session once when fn resolves and when it throws", async () => {
  const deletes = (sent: Sent[]) =>
    sent.filter((r) => r.method === "DELETE" && r.url === `${DRIVER}/session/s1`).length;
  const ok = fakeDriver();
  assert.equal(
    await withSession(
      DRIVER,
      async (s) => {
        await s.delete(); // a second delete in finally is not sent
        return 7;
      },
      SIM_CAPS,
      ok.f,
    ),
    7,
  );
  assert.equal(deletes(ok.sent), 1);
  const bad = fakeDriver();
  await assert.rejects(
    withSession(
      DRIVER,
      async () => {
        throw new Error("walk failed");
      },
      SIM_CAPS,
      bad.f,
    ),
    /walk failed/,
  );
  assert.equal(deletes(bad.sent), 1);
});

test("withSession throws fn's error when the delete after it fails too", async () => {
  const { f, sent } = fakeDriver((r) =>
    r.method === "DELETE" && r.url === `${DRIVER}/session/s1`
      ? [404, { error: "invalid session id", message: "crashed" }]
      : undefined,
  );
  const warn = console.warn;
  console.warn = () => {};
  try {
    await assert.rejects(
      withSession(
        DRIVER,
        async () => {
          throw new Error("walk failed: WebContent crashed");
        },
        SIM_CAPS,
        f,
      ),
      /walk failed: WebContent crashed/,
    );
  } finally {
    console.warn = warn;
  }
  assert.equal(sent.filter((r) => r.method === "DELETE").length, 1);
  // With no error of its own, the walk reports the delete's.
  await assert.rejects(
    withSession(DRIVER, async () => 1, SIM_CAPS, f),
    (e: unknown) => e instanceof WebDriverError && e.error === "invalid session id",
  );
});

test("a session not created is thrown, not retried", async () => {
  const { f, sent } = fakeDriver((r) =>
    r.url === `${DRIVER}/session`
      ? [500, { error: "session not created", message: "Allow remote automation" }]
      : undefined,
  );
  await assert.rejects(
    withSession(DRIVER, async () => 1, SIM_CAPS, f),
    (e: unknown) => e instanceof WebDriverError && e.error === "session not created",
  );
  assert.equal(sent.length, 1);
});
