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

const { logAudit } = await import("./audit");
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
