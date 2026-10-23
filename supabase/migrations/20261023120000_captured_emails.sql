-- The test outbox (decided 2026-10-23): on staging and in local development
-- the API sends no email at all (EMAIL_MODE=outbox), it keeps each one here,
-- and the site shows them to its testers, links clickable — the witness's
-- verification email, the sign-up confirmation, whatever their actions sent.
-- Production never writes to this table: the API refuses to start there in
-- outbox mode. It exists everywhere so that every database keeps the same
-- schema; on production it stays empty.
--
-- Only the API reads or writes it, with the service role: no policy, and
-- nothing granted to the public roles.
create table public.captured_emails (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  -- What sent it: "api" (the API's own emails) or "auth:<type>" (Supabase
  -- Auth's, through the Send Email hook: auth:signup, auth:recovery…).
  source text not null,
  recipients text[] not null,
  subject text not null,
  body_html text,
  body_text text,
  -- The browser whose action sent it (its random X-Outbox-Viewer id), and the
  -- signed-in user, when known: what "mine" means in the outbox.
  viewer text,
  user_id uuid
);

create index captured_emails_created_at_idx on public.captured_emails (created_at desc);

alter table public.captured_emails enable row level security;
revoke all on public.captured_emails from anon, authenticated;
