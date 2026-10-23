import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { adminClient } from "../../lib/supabase";

// The test outbox (EMAIL_MODE=outbox: staging, local development — never
// production): the emails the API kept instead of sending them, for the site
// to show its testers. Registered only in that mode, so a production API
// answers 404 here — which is also how the site knows to show no outbox.

const LIST_COLUMNS = "id, created_at, source, recipients, subject, viewer, user_id";
const idSchema = z.string().uuid();

export default async function outboxRoutes(app: FastifyInstance) {
  app.addHook("onSend", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
  });

  // The latest emails, newest first, without their bodies.
  app.get("/", async (_req, reply) => {
    const { data, error } = await adminClient
      .from("captured_emails")
      .select(LIST_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) return reply.internalServerError(error.message);
    return { emails: data };
  });

  app.get<{ Params: { id: string } }>("/:id", async (req, reply) => {
    if (!idSchema.safeParse(req.params.id).success) return reply.notFound();
    const { data, error } = await adminClient
      .from("captured_emails")
      .select(`${LIST_COLUMNS}, body_html, body_text`)
      .eq("id", req.params.id)
      .maybeSingle();
    if (error) return reply.internalServerError(error.message);
    if (!data) return reply.notFound();
    return data;
  });
}
