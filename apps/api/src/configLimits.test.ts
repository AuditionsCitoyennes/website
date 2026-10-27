import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// RATE_LIMITS=relaxed multiplies the limits by 100 for a load campaign, on
// staging only: the API refuses to start with it anywhere else.

const apiDir = fileURLToPath(new URL("..", import.meta.url));

/** The factor a fresh process reads from this environment, or its exit. */
function boot(env: Record<string, string>) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      'const c = await import("./src/config.ts"); console.log("factor", c.rateLimitFactor);',
    ],
    {
      cwd: apiDir,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        // A local apps/api/.env must not decide: every key the check reads is set.
        DOTENV_CONFIG_PATH: "/nonexistent",
        SUPABASE_URL: "http://supabase.test",
        SUPABASE_ANON_KEY: "anon",
        EMAIL_MODE: "log",
        ...env,
      },
    },
  );
}

test("RATE_LIMITS=relaxed is refused in production and locally", () => {
  for (const APP_ENV of ["production", "local"]) {
    const r = boot({ APP_ENV, RATE_LIMITS: "relaxed" });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /RATE_LIMITS/);
  }
});

test("RATE_LIMITS=relaxed on staging: ×100; normal: ×1", () => {
  const relaxed = boot({ APP_ENV: "staging", RATE_LIMITS: "relaxed" });
  assert.equal(relaxed.status, 0, relaxed.stderr);
  assert.match(relaxed.stdout, /factor 100/);
  const normal = boot({ APP_ENV: "production" });
  assert.equal(normal.status, 0, normal.stderr);
  assert.match(normal.stdout, /factor 1\b/);
});
