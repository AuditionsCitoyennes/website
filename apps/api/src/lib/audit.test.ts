import { strict as assert } from "node:assert";
import { after, beforeEach, test } from "node:test";
import type { FastifyBaseLogger } from "fastify";
import { FakeDb, fakeEnv, fakeToken, installFakes, type Row } from "../testing/fakes";

// With the service key configured, every audit entry is written with it,
// whichever client the caller hands over: the database takes any entry from
// the server, and only two kinds from a signed-in account.

fakeEnv("/nonexistent");
const db = new FakeDb();
const restore = installFakes({ db });
after(restore);

const ACTOR = "00000000-0000-4000-8000-0000000000aa";
const written: Row[] = [];
db.rpcs.insert_audit_log = (args) => {
  written.push(args);
  return null;
};
beforeEach(() => {
  written.length = 0;
  db.requests.length = 0;
});

const warnings: unknown[] = [];
const log = { warn: (...args: unknown[]) => warnings.push(args) } as unknown as FastifyBaseLogger;

const { AUDIT_TEXT_MAX, boundedMetadata, logAudit } = await import("./audit");
const { clientForToken, publicClient } = await import("./supabase");

const keysUsed = () =>
  db.requests.filter((r) => r.url.pathname.endsWith("/rpc/insert_audit_log")).map((r) => r.apikey);

test("an admin's action is logged with the service key, not the admin's token", async () => {
  await logAudit(clientForToken(fakeToken(ACTOR)), log, {
    actorId: ACTOR,
    action: "audition_created",
    targetType: "audition",
    targetId: "00000000-0000-4000-8000-000000000001",
    metadata: { title: "Audition du marché" },
  });
  assert.deepEqual(keysUsed(), ["service"]);
  assert.deepEqual(written, [
    {
      p_user_id: ACTOR,
      p_action: "audition_created",
      p_target_type: "audition",
      p_target_id: "00000000-0000-4000-8000-000000000001",
      p_metadata: { title: "Audition du marché" },
    },
  ]);
});

test("a witness's action, with no actor, is logged with the service key too", async () => {
  await logAudit(publicClient, log, {
    actorId: null,
    action: "testimony_verified",
    targetType: "testimony",
    targetId: "00000000-0000-4000-8000-000000000002",
  });
  assert.deepEqual(keysUsed(), ["service"]);
  assert.equal(written[0].p_user_id, null);
  assert.deepEqual(written[0].p_metadata, {});
});

test("a refused entry is logged as a warning and never thrown", async () => {
  warnings.length = 0;
  db.refuse = () => ({ status: 403, code: "42501", message: "refused" });
  try {
    await logAudit(publicClient, log, {
      actorId: ACTOR,
      action: "audition_deleted",
      targetType: "audition",
      targetId: "00000000-0000-4000-8000-000000000003",
    });
  } finally {
    db.refuse = () => null;
  }
  assert.equal(warnings.length, 1);
  assert.equal(written.length, 0);
});

test("a text of the metadata longer than the API's own limit is cut, the rest is kept as is", () => {
  const long = "é".repeat(20_000);
  const bounded = boundedMetadata({
    title: long,
    location: "Place du marché",
    date: "2026-11-27",
    testimonies: 3,
    emptied: true,
    absent: undefined,
    nothing: null,
    fields: ["title", long],
    nested: { name: long },
  }) as Record<string, unknown>;
  const cut = `${"é".repeat(AUDIT_TEXT_MAX - 1)}…`;
  assert.deepEqual(bounded, {
    title: cut,
    location: "Place du marché",
    date: "2026-11-27",
    testimonies: 3,
    emptied: true,
    absent: undefined,
    nothing: null,
    fields: ["title", cut],
    nested: { name: cut },
  });
  assert.equal(boundedMetadata("a".repeat(AUDIT_TEXT_MAX)), "a".repeat(AUDIT_TEXT_MAX));
  assert.equal(boundedMetadata(undefined), undefined);
});

test("a cut never leaves half of a character behind", () => {
  // The pair sits across the cut: its first half goes with it.
  const text = `${"a".repeat(AUDIT_TEXT_MAX - 2)}😀${"a".repeat(10)}`;
  assert.equal(boundedMetadata(text), `${"a".repeat(AUDIT_TEXT_MAX - 2)}…`);
  // The pair ends right at the cut: it stays whole.
  const whole = `${"a".repeat(AUDIT_TEXT_MAX - 3)}😀${"a".repeat(10)}`;
  assert.equal(boundedMetadata(whole), `${"a".repeat(AUDIT_TEXT_MAX - 3)}😀…`);
});

test("an entry about an audition with an oversized title is written, shortened", async () => {
  await logAudit(publicClient, log, {
    actorId: ACTOR,
    action: "audition_deleted",
    targetType: "audition",
    targetId: "00000000-0000-4000-8000-000000000004",
    metadata: { title: "T".repeat(40_000), location: "L".repeat(40_000), testimonies: 2 },
  });
  assert.equal(written.length, 1);
  const metadata = written[0].p_metadata as { title: string; location: string };
  assert.equal(metadata.title.length, AUDIT_TEXT_MAX);
  assert.equal(metadata.location.length, AUDIT_TEXT_MAX);
  assert.ok(JSON.stringify(metadata).length < 2048);
});
