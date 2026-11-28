// scripts/deploy/scaleway.sh against a stand-in for Scaleway's API on this
// machine (SCW_API_URL), with made-up values: what the container is asked to
// be, and where the key and the secret values travel — on no command line
// (a curl shim on PATH records every argument list) and in no error line. No
// network beyond 127.0.0.1.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./scaleway.sh", import.meta.url));
const KEY = "made-up-key-3f6c1d52-9a41-4f0e-8b77-0c1e5a2d9e10";
const SERVICE_ROLE = "made-up-secret-value-Zk3/x+Q9=";
const VERSION = "0123456789abcdef0123456789abcdef01234567";
const IMAGE = `rg.fr-par.scw.cloud/toy/api@sha256:${"ab".repeat(32)}`;

interface Seen {
  method: string;
  path: string;
  key: string | undefined;
  body: Record<string, unknown> | null;
}

const tmp = mkdtempSync(join(tmpdir(), "ac-scaleway-test-"));
const bin = join(tmp, "bin");
const curlLog = join(tmp, "curl-arguments.log");
let seen: Seen[] = [];
// What the stand-in answers a PATCH of the container with (default: accepted).
let patchAnswer: { status: number; body: string } | null = null;
let containerExists = false;
let api = "";

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://stand-in");
    const key = req.headers["x-auth-token"];
    seen.push({
      method: req.method ?? "",
      path: url.pathname,
      key: typeof key === "string" ? key : undefined,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
    });
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    const p = url.pathname;
    if (p === "/health") return json(200, { version: VERSION });
    if (p.endsWith("/registry/v1/regions/fr-par/namespaces")) {
      return json(200, {
        namespaces: [{ id: "r1", name: "toy", endpoint: "rg.fr-par.scw.cloud/toy" }],
      });
    }
    if (p.endsWith("/containers/v1/regions/fr-par/namespaces")) {
      return json(200, { namespaces: [{ id: "n1", name: "staging" }] });
    }
    if (p.endsWith("/containers") && req.method === "GET") {
      return json(200, { containers: containerExists ? [{ id: "c1", name: "toy-api" }] : [] });
    }
    if (p.endsWith("/containers") && req.method === "POST") return json(200, { id: "c1" });
    if (p.endsWith("/containers/c1") && req.method === "PATCH") {
      if (patchAnswer) return json(patchAnswer.status, patchAnswer.body);
      return json(200, { id: "c1" });
    }
    if (p.endsWith("/containers/c1")) {
      return json(200, { id: "c1", status: "ready", public_endpoint: api });
    }
    json(404, { message: "not found", type: "not_found" });
  });
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // A curl that writes its arguments down, then is the real one.
  const real = spawnSync("bash", ["-c", "command -v curl"], { encoding: "utf8" }).stdout.trim();
  assert.ok(real, "curl is needed for this test");
  mkdirSync(bin);
  const shim = join(bin, "curl");
  writeFileSync(
    shim,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${curlLog}"\nexec "${real}" "$@"\n`,
  );
  chmodSync(shim, 0o755);
});
after(() => {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  curlArguments: string;
}

/** Runs the script (the stand-in answers from this process, so not spawnSync). */
function run(command: string, env: Record<string, string> = {}): Promise<Run> {
  seen = [];
  rmSync(curlLog, { force: true });
  const base: Record<string, string | undefined> = { ...process.env };
  // Nothing of the caller's own deploy settings reaches the container asked for.
  for (const k of Object.keys(base)) {
    if (k.startsWith("ENV_") || k.startsWith("SECRET_") || k.startsWith("SCW_")) delete base[k];
  }
  const child = spawn("bash", [SCRIPT, command], {
    env: {
      ...base,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      SCW_API_URL: api,
      SCW_SECRET_KEY: KEY,
      SCW_PROJECT_ID: "project",
      SCW_REGION: "fr-par",
      REGISTRY_NAMESPACE: "toy",
      CONTAINERS_NAMESPACE: "staging",
      CONTAINER_NAME: "toy-api",
      IMAGE,
      VERSION,
      MIN_SCALE: "1",
      MAX_SCALE: "1",
      MEMORY_MB: "512",
      ...env,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  return new Promise((resolve) => {
    child.on("close", (status) => {
      const curlArguments = existsSync(curlLog) ? readFileSync(curlLog, "utf8") : "";
      resolve({ status, stdout, stderr, curlArguments });
    });
  });
}

const CONTAINER_ENV = {
  ENV_APP_ENV: "staging",
  ENV_ADMIN_MFA: "",
  SECRET_SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE,
  SECRET_TURNSTILE_SECRET_KEY: "",
};

test("registry: the endpoint, asked with the key in a header that is on no command line", async () => {
  const r = await run("registry");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "rg.fr-par.scw.cloud/toy");
  assert.ok(seen.length > 0);
  for (const call of seen) assert.equal(call.key, KEY);
  assert.ok(r.curlArguments.includes("/registry/v1/"), "the shim saw the calls");
  assert.ok(!r.curlArguments.includes(KEY));
});

test("deploy: the container is the image asked for, over HTTPS only, without empty settings", async () => {
  containerExists = false;
  patchAnswer = null;
  const r = await run("deploy", CONTAINER_ENV);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), api);
  const created = seen.find((call) => call.method === "POST" && call.path.endsWith("/containers"));
  assert.ok(created?.body);
  assert.equal(created.body.image, IMAGE);
  assert.equal(created.body.http_option, "redirected");
  assert.equal(created.body.name, "toy-api");
  assert.deepEqual(created.body.environment_variables, { APP_ENV: "staging" });
  assert.deepEqual(created.body.secret_environment_variables, {
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE,
  });
  for (const call of seen.filter((c) => c.path !== "/health")) assert.equal(call.key, KEY);
  assert.ok(!r.curlArguments.includes(KEY));
  assert.ok(!r.curlArguments.includes(SERVICE_ROLE));
  assert.ok(!(r.stdout + r.stderr).includes(KEY));
  assert.ok(!(r.stdout + r.stderr).includes(SERVICE_ROLE));
});

test("a refused update: one line with the type and the argument names, no value given back", async () => {
  containerExists = true;
  patchAnswer = {
    status: 400,
    body: JSON.stringify({
      type: "invalid_arguments",
      message: `invalid argument(s): ${"x".repeat(180)} ${SERVICE_ROLE} sent with ${KEY}`,
      details: [
        {
          argument_name: "secret_environment_variables",
          reason: "constraint",
          help_message: `got ${SERVICE_ROLE}`,
        },
      ],
    }),
  };
  const r = await run("deploy", CONTAINER_ENV);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  const errors = r.stderr.split("\n").filter((line) => line.startsWith("::error::"));
  assert.equal(errors.length, 1, r.stderr);
  assert.match(errors[0], /Scaleway PATCH .*\/containers\/c1 answered 400/);
  assert.match(errors[0], /invalid_arguments/);
  assert.match(errors[0], /secret_environment_variables/);
  assert.ok(!r.stderr.includes("help_message"));
  assert.ok(!r.stderr.includes("got "));
  // The values are replaced before the message is cut: no part of one is left.
  assert.ok(!r.stderr.includes(SERVICE_ROLE.slice(0, 12)));
  assert.ok(!r.stderr.includes(KEY.slice(0, 12)));
  assert.ok(!r.curlArguments.includes(KEY));
  assert.ok(!r.curlArguments.includes(SERVICE_ROLE));
});

test("a refusal that is not JSON: its status, none of its text", async () => {
  containerExists = true;
  patchAnswer = { status: 502, body: `<html>upstream said ${SERVICE_ROLE}</html>` };
  const r = await run("deploy", CONTAINER_ENV);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /answered 502: an answer that is not JSON/);
  assert.ok(!r.stderr.includes("upstream said"));
  assert.ok(!r.stderr.includes(SERVICE_ROLE));
});
