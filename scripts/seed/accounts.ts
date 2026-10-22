// Creates the test accounts of a seeded database, through the Auth admin API
// (never in SQL, so no password ever sits in the repository):
//
//   superadmin@example.org   super_admin
//   admin@example.org        admin
//   inscription@example.org  confirmed, no role: a registration waiting for approval
//   non-confirme@example.org never confirmed its email (not listed as pending)
//
//   npm run db:accounts      local stack: URL and key from `supabase status`;
//                            the password is SEED_PASSWORD, or a random one printed once
//   SUPABASE_PROJECT_REF=<ref> SEED_PASSWORD=… npm run db:accounts
//                            a hosted project (staging): its service_role key is
//                            read through the logged-in Supabase CLI
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… SEED_PASSWORD=… npm run db:accounts
//                            or everything from the environment
//
// Running it again resets the four accounts' passwords and roles.
// It refuses to touch production.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const PRODUCTION_REF = "nnnhefcdanzxsgnaletc";

interface Account {
  email: string;
  role: "super_admin" | "admin" | null;
  username: string;
  bio?: string;
  confirmed: boolean;
}

const ACCOUNTS: Account[] = [
  { email: "superadmin@example.org", role: "super_admin", username: "superadmin", confirmed: true },
  { email: "admin@example.org", role: "admin", username: "admin", confirmed: true },
  {
    email: "inscription@example.org",
    role: null,
    username: "nouvelle-inscription",
    bio: "Je voudrais aider à organiser des auditions dans mon quartier.",
    confirmed: true,
  },
  { email: "non-confirme@example.org", role: null, username: "non-confirme", confirmed: false },
];

function localStack(): { url: string; key: string } {
  const status = JSON.parse(
    execFileSync("supabase", ["status", "-o", "json"], {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString(),
  ) as Record<string, string>;
  return { url: status.API_URL, key: status.SECRET_KEY ?? status.SERVICE_ROLE_KEY };
}

function hostedProject(ref: string): { url: string; key: string } {
  const keys = JSON.parse(
    execFileSync("supabase", ["projects", "api-keys", "--project-ref", ref, "-o", "json"], {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString(),
  ) as { name: string; type: string; api_key: string }[];
  // The CLI prints the new-style secret key masked; the legacy service_role
  // key comes back whole.
  const serviceRole = keys.find((k) => k.name === "service_role");
  if (!serviceRole) throw new Error(`No service_role key found for project ${ref}`);
  return { url: `https://${ref}.supabase.co`, key: serviceRole.api_key };
}

const ref = process.env.SUPABASE_PROJECT_REF;
if (ref === PRODUCTION_REF) {
  console.error("Refusing to create test accounts on the production project.");
  process.exit(1);
}
const fromEnv = process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY;
const { url, key } = ref
  ? hostedProject(ref)
  : fromEnv
    ? { url: process.env.SUPABASE_URL!, key: process.env.SUPABASE_SERVICE_ROLE_KEY! }
    : localStack();
const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/.test(url);

if (url.includes(PRODUCTION_REF)) {
  console.error("Refusing to create test accounts on the production project.");
  process.exit(1);
}

let password = process.env.SEED_PASSWORD;
if (!password) {
  if (!local) {
    console.error("SEED_PASSWORD is required outside the local stack.");
    process.exit(1);
  }
  password = randomBytes(12).toString("base64url");
}

const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

const { data: list, error: listError } = await admin.auth.admin.listUsers({ perPage: 1000 });
if (listError) throw listError;
const existing = new Map(list.users.map((u) => [u.email, u.id]));

for (const account of ACCOUNTS) {
  const attributes = {
    password,
    email_confirm: account.confirmed,
    user_metadata: { username: account.username, ...(account.bio ? { bio: account.bio } : {}) },
  };
  let id = existing.get(account.email);
  if (id) {
    const { error } = await admin.auth.admin.updateUserById(id, attributes);
    if (error) throw error;
  } else {
    const { data, error } = await admin.auth.admin.createUser({
      email: account.email,
      ...attributes,
    });
    if (error) throw error;
    id = data.user.id;
  }
  // Roles are reset to exactly the account's own (the service key bypasses RLS).
  const { error: clearError } = await admin.from("user_roles").delete().eq("user_id", id);
  if (clearError) throw clearError;
  if (account.role) {
    const { error } = await admin.from("user_roles").insert({ user_id: id, role: account.role });
    if (error) throw error;
  }
  console.log(
    `${account.email.padEnd(26)} ${account.role ?? (account.confirmed ? "pending registration" : "unconfirmed")}`,
  );
}

console.log(
  `\n${local ? "Local stack" : url}: password ${process.env.SEED_PASSWORD ? "from SEED_PASSWORD" : password}`,
);
