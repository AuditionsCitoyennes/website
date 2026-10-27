// `npm run dev` against the local Supabase stack, whatever apps/*/.env say:
// the URL and keys come from `supabase status` (start it with npm run db:start),
// and the email and AI keys are blanked so nothing leaves the machine. Emails,
// the API's and Supabase Auth's (through its Send Email hook, set up in
// supabase/config.toml), land in the site's test outbox.

import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";

let status: Record<string, string>;
try {
  status = JSON.parse(
    execFileSync("supabase", ["status", "-o", "json"], {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString(),
  );
} catch {
  console.error("The local Supabase stack is not running: npm run db:start");
  process.exit(1);
}

// The local stack's own hook secret, as config.toml gives it to Auth.
const hookSecret = /\[auth\.hook\.send_email\][^[]*?secrets = "([^"]+)"/.exec(
  readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8"),
)?.[1];

const publishable = status.PUBLISHABLE_KEY ?? status.ANON_KEY;
const secret = status.SECRET_KEY ?? status.SERVICE_ROLE_KEY;

const child = spawn("npm", ["run", "dev"], {
  stdio: "inherit",
  env: {
    ...process.env,
    SUPABASE_URL: status.API_URL,
    SUPABASE_ANON_KEY: publishable,
    SUPABASE_SERVICE_ROLE_KEY: secret,
    VITE_SUPABASE_URL: status.API_URL,
    VITE_SUPABASE_PUBLISHABLE_KEY: publishable,
    APP_ENV: "local",
    // The map from the stored places, kept by the placement job: a local
    // stack is where both are tried.
    MAP_SOURCE: "db",
    PLACEMENT_JOB: "true",
    EMAIL_MODE: "outbox",
    SEND_EMAIL_HOOK_SECRET: hookSecret ?? "",
    RESEND_API_KEY: "",
    ANTHROPIC_API_KEY: "",
  },
});
child.on("exit", (code) => process.exit(code ?? 0));
