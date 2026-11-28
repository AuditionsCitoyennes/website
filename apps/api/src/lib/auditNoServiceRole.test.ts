import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import type { FastifyBaseLogger } from "fastify";
import { FakeDb, fakeEnv, fakeToken, installFakes } from "../testing/fakes";

// Without the service key (a developer's setup), an audit entry is written
// with the client the caller hands over: there is no other.

fakeEnv("/nonexistent", { SUPABASE_SERVICE_ROLE_KEY: "" });
const db = new FakeDb();
const restore = installFakes({ db });
after(restore);
db.rpcs.insert_audit_log = () => null;

const log = { warn: () => {} } as unknown as FastifyBaseLogger;

test("the entry goes out with the caller's own client", async () => {
  const { logAudit } = await import("./audit");
  const { clientForToken } = await import("./supabase");
  const actor = "00000000-0000-4000-8000-0000000000aa";
  const token = fakeToken(actor);
  await logAudit(clientForToken(token), log, {
    actorId: actor,
    action: "account_deleted",
    targetType: "user",
    targetId: actor,
  });
  const calls = db.requests.filter((r) => r.url.pathname.endsWith("/rpc/insert_audit_log"));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].apikey, "anon");
});
