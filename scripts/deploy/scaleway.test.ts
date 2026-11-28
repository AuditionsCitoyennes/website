// scripts/deploy/scaleway.sh against a stand-in for Scaleway's API on this
// machine (SCW_API_URL), with made-up values: what the container is asked to
// be, and where the key and the secret values travel — on no command line
// (a curl shim on PATH records every argument list) and in no error line. The
// stand-in takes the fields the Containers API v1 names and refuses any
// other, as an API may. No network beyond 127.0.0.1.
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
// What the stand-in's container is: whether it accepts HTTPS only (as the
// last accepted write set it), and its state.
let httpsOnly = false;
let containerState: { status: string; error_message?: string } = { status: "ready" };
// A stand-in that accepts the HTTPS-only setting without applying it.
let keepsPlainHttp = false;
let api = "";

// The fields of CreateContainerRequest and UpdateContainerRequest in
// Scaleway's SDK for the Containers API v1 (api/container/v1). The two name
// the HTTPS-only setting differently.
const SHARED_FIELDS = [
  "environment_variables",
  "secret_environment_variables",
  "min_scale",
  "max_scale",
  "memory_limit_bytes",
  "mvcpu_limit",
  "timeout",
  "privacy",
  "description",
  "image",
  "protocol",
  "port",
  "sandbox",
  "local_storage_limit_bytes",
  "scaling_option",
  "liveness_probe",
  "startup_probe",
  "tags",
  "private_network_id",
  "command",
  "args",
];
const CREATE_FIELDS = new Set([...SHARED_FIELDS, "namespace_id", "name", "https_connections_only"]);
const UPDATE_FIELDS = new Set([...SHARED_FIELDS, "https_connection_only"]);

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = "";
  req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
  req.on("end", () => {
    const url = new URL(req.url ?? "/", "http://stand-in");
    const key = req.headers["x-auth-token"];
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    seen.push({
      method: req.method ?? "",
      path: url.pathname,
      key: typeof key === "string" ? key : undefined,
      body,
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
    const created = p.endsWith("/containers") && req.method === "POST";
    const updated = p.endsWith("/containers/c1") && req.method === "PATCH";
    if (created || updated) {
      if (updated && patchAnswer) return json(patchAnswer.status, patchAnswer.body);
      const fields = created ? CREATE_FIELDS : UPDATE_FIELDS;
      const unknown = Object.keys(body ?? {}).filter((name) => !fields.has(name));
      if (unknown.length > 0) {
        return json(400, {
          type: "invalid_arguments",
          message: "invalid argument(s)",
          details: unknown.map((name) => ({ argument_name: name, reason: "unknown" })),
        });
      }
      const setting = body?.[created ? "https_connections_only" : "https_connection_only"];
      if (typeof setting === "boolean" && !keepsPlainHttp) httpsOnly = setting;
      return json(200, { id: "c1" });
    }
    if (p.endsWith("/containers/c1")) {
      return json(200, {
        id: "c1",
        ...containerState,
        public_endpoint: api,
        https_connections_only: httpsOnly,
      });
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

/** The stand-in as a deploy finds it: a container or none, plain HTTP still accepted. */
function standIn(existing: boolean): void {
  containerExists = existing;
  patchAnswer = null;
  httpsOnly = false;
  containerState = { status: "ready" };
  keepsPlainHttp = false;
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

test("deploy: a new container is the image asked for, over HTTPS only, without empty settings", async () => {
  standIn(false);
  const r = await run("deploy", CONTAINER_ENV);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), api);
  const created = seen.find((call) => call.method === "POST" && call.path.endsWith("/containers"));
  assert.ok(created?.body);
  assert.equal(created.body.image, IMAGE);
  assert.equal(created.body.https_connections_only, true);
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

test("deploy: an existing container is updated to the same, under the update's own field name", async () => {
  standIn(true);
  const r = await run("deploy", CONTAINER_ENV);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), api);
  const updated = seen.find((call) => call.method === "PATCH");
  assert.ok(updated?.body);
  assert.equal(updated.path.endsWith("/containers/c1"), true);
  assert.equal(updated.body.image, IMAGE);
  assert.equal(updated.body.https_connection_only, true);
  assert.deepEqual(updated.body.environment_variables, { APP_ENV: "staging" });
  assert.ok(!seen.some((call) => call.method === "POST"));
});

test("deploy: a container that still accepts plain HTTP afterwards fails the deploy", async () => {
  standIn(true);
  keepsPlainHttp = true;
  const r = await run("deploy", CONTAINER_ENV);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /::error::the container still accepts plain HTTP/);
});

test("a refused update: one line with the type and the argument names, no value given back", async () => {
  standIn(true);
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

test("a refusal that gives a value back escaped, in its message or an argument name: replaced all the same", async () => {
  standIn(true);
  // The same JSON text written two other ways: "/" as "\/", and every third
  // character as \uXXXX.
  const slashes = SERVICE_ROLE.replaceAll("/", "\\/");
  const codes = [...SERVICE_ROLE]
    .map((c, i) => (i % 3 === 0 ? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}` : c))
    .join("");
  patchAnswer = {
    status: 400,
    body: `{"type":"invalid_arguments","message":"cannot store ${slashes}","details":[{"argument_name":"secret_environment_variables.${codes}"}]}`,
  };
  const r = await run("deploy", CONTAINER_ENV);
  assert.equal(r.status, 1);
  assert.match(
    r.stderr,
    /answered 400: \{"type":"invalid_arguments","message":"cannot store \*\*\*"/,
  );
  assert.match(r.stderr, /"arguments":\["secret_environment_variables\.\*\*\*"\]/);
  assert.ok(!r.stderr.includes(SERVICE_ROLE));
});

test("a refusal that is not JSON: its status, none of its text", async () => {
  standIn(true);
  patchAnswer = { status: 502, body: `<html>upstream said ${SERVICE_ROLE}</html>` };
  const r = await run("deploy", CONTAINER_ENV);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /answered 502: an answer that is not JSON/);
  assert.ok(!r.stderr.includes("upstream said"));
  assert.ok(!r.stderr.includes(SERVICE_ROLE));
});

test("a container in error: Scaleway's message on one line, no value given back", async () => {
  standIn(true);
  containerState = {
    status: "error",
    error_message: `start failed with SUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE}\n::warning::a second line`,
  };
  const r = await run("deploy", CONTAINER_ENV);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "");
  const lines = r.stderr.split("\n").filter((line) => line.startsWith("::"));
  assert.deepEqual(lines, [
    '::error::container error: "start failed with SUPABASE_SERVICE_ROLE_KEY=***\\n::warning::a second line"',
  ]);
});
